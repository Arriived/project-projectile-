-- APPLY-ALL.sql  —  generated, paste into the Supabase SQL editor
-- Project zohthxhjcvmrziwqaiev  ->  SQL Editor  ->  New query  ->  paste  ->  Run
--
-- Migrations 001 and 002 are ALTER TABLE statements. They need DDL rights, which the
-- service-role key does not carry: it is a PostgREST credential and PostgREST exposes
-- no SQL-execution endpoint. Verified against the live project — the REST root lists
-- tokens, trades, indexer_state and tokens_with_volume, and zero RPC functions.
--
-- Both migrations are additive, idempotent and safe to re-run.

-- 001_add_token_state.sql
--
-- Adds a three-valued `state` column to `tokens`.
--
-- Why: Ballista replaced Ballista's `graduated` bool with a three-state
-- enum (ACTIVE / GRADUATION_READY / GRADUATED). A boolean cannot express the
-- middle state, so a token that has finished its bonding curve and is waiting on
-- the DEX hand-off currently displays exactly like one that is still trading.
-- A user sees a normal, buyable token, tries to buy, and hits a revert with no
-- explanation. This column is what lets the UI say "awaiting graduation" instead.
--
-- The existing `graduated` boolean is kept and kept correct, so anything still
-- reading it keeps working. A trigger enforces that rather than trusting every
-- writer to remember, since a desynced pair is worse than either column alone.
--
-- Safe to run on a live database: additive only, no column is dropped or
-- rewritten, and no existing row loses data. Re-runnable.

BEGIN;

-- 1. The column. Nullable on purpose: NULL means "not yet observed by the
--    indexer", which is distinct from any of the three real states. Rows settle
--    to a non-NULL value the next time the indexer syncs that token.
ALTER TABLE public.tokens
  ADD COLUMN IF NOT EXISTS state text;

-- 2. Constrain it to the three real states (plus NULL). Text rather than
--    smallint so the value is readable in the dashboard and in the frontend
--    without a lookup table; the indexer owns the mapping from the on-chain enum.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'tokens_state_check'
  ) THEN
    ALTER TABLE public.tokens
      ADD CONSTRAINT tokens_state_check
      CHECK (state IS NULL OR state IN ('trading', 'awaiting_graduation', 'graduated'));
  END IF;
END $$;

-- 3. Backfill from the boolean we already have.
--
--    NOTE ON PRECISION: a row with graduated = false becomes 'trading'. Some of
--    those may actually be awaiting_graduation -- the boolean never recorded the
--    difference, so it cannot be recovered from the database alone. This is not a
--    guess that needs correcting by hand: the indexer reads state directly from
--    curves() on the next sync and overwrites it with the truth. Rows are only
--    approximate until then, and only for tokens that are mid-graduation right now.
UPDATE public.tokens
   SET state = CASE WHEN graduated THEN 'graduated' ELSE 'trading' END
 WHERE state IS NULL;

-- 4. Keep `graduated` in sync with `state`, in the database rather than by
--    convention. Only a completed graduation sets the boolean: a token in
--    awaiting_graduation is NOT on a DEX yet, and reporting it as graduated would
--    point holders at a pool that does not exist.
--
--    A NULL state leaves the boolean untouched, so the transitional period where
--    the indexer has not yet caught up cannot flip live rows to false.
CREATE OR REPLACE FUNCTION public.tokens_sync_graduated()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.state IS NOT NULL THEN
    NEW.graduated := (NEW.state = 'graduated');
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS tokens_sync_graduated_trg ON public.tokens;
CREATE TRIGGER tokens_sync_graduated_trg
  BEFORE INSERT OR UPDATE OF state ON public.tokens
  FOR EACH ROW
  EXECUTE FUNCTION public.tokens_sync_graduated();

-- 5. Discovery queries filter on this ("show me everything still trading"), so
--    it earns an index.
CREATE INDEX IF NOT EXISTS tokens_state_idx ON public.tokens (state);

COMMIT;

-- Verification, run separately after the migration:
--
--   SELECT state, graduated, count(*)
--     FROM public.tokens
--    GROUP BY state, graduated
--    ORDER BY state;
--
-- Expect: no row where state = 'graduated' and graduated = false, and none where
-- state <> 'graduated' and graduated = true.
--
-- Rollback, if needed:
--
--   BEGIN;
--   DROP TRIGGER IF EXISTS tokens_sync_graduated_trg ON public.tokens;
--   DROP FUNCTION IF EXISTS public.tokens_sync_graduated();
--   DROP INDEX IF EXISTS tokens_state_idx;
--   ALTER TABLE public.tokens DROP CONSTRAINT IF EXISTS tokens_state_check;
--   ALTER TABLE public.tokens DROP COLUMN IF EXISTS state;
--   COMMIT;
--
-- The `graduated` boolean is untouched by the rollback and remains authoritative.


-- 002_add_creator_launch_disclosure.sql
--
-- Adds the columns behind "creator bought X% at launch".
--
-- ⚠ MIGRATION 001 IS STILL UNAPPLIED and SUPABASE_URL does not currently resolve.
--    Neither of these has been run against a live database. Apply 001 first: this
--    migration does not depend on it, but running them out of order leaves the
--    `state` column missing while the indexer writes to it, and the indexer's upsert
--    will fail on the missing column rather than degrade.
--
-- Why these columns: the 2.5% cap limits only the PRIVILEGED, untaxed path. It does
-- NOT cap total creator holdings -- nothing stops a creator buying more from another
-- address, and no contract-level rule can detect that. Disclosure is the actual
-- protection, which makes this number the thing that protects buyers.
--
-- It was unrenderable until now for a reason worth recording: the indexer's ABI was
-- hand-maintained and listed the Curve struct as 16 fields while it had grown to 22.
-- ethers decoded it WITHOUT error -- the struct is all-static, so offsets lined up and
-- the extra fields were silently dropped. creatorLaunchPurchased was one of them. The
-- ABI is now generated from the build artifact.
--
-- Safe to run on a live database: additive only, nothing dropped or rewritten, no
-- existing row loses data. Re-runnable.

BEGIN;

-- Raw token amount taken through the privileged launch path, as a string-safe numeric.
-- 1e27-scale values exceed bigint, so numeric rather than bigint.
ALTER TABLE public.tokens
  ADD COLUMN IF NOT EXISTS creator_launch_purchased numeric;

-- The same figure in basis points of CURVE_TOKEN_SUPPLY, which is what the UI renders.
-- Stored rather than computed in the frontend so the denominator comes from the chain
-- (the indexer reads CURVE_TOKEN_SUPPLY from the contract) instead of a hardcoded
-- constant that can drift the way the ABI did.
ALTER TABLE public.tokens
  ADD COLUMN IF NOT EXISTS creator_launch_bps integer;

-- Where the LP position goes at graduation. BURN_ADDRESS means the burn claim holds;
-- anything else means "permanently locked", which is a DIFFERENT trust claim and must
-- not be marketed as the burn one. Snapshotted per token on chain, so this is the value
-- that token launched under, not the current global.
ALTER TABLE public.tokens
  ADD COLUMN IF NOT EXISTS lp_recipient text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'tokens_creator_launch_bps_check'
  ) THEN
    ALTER TABLE public.tokens
      ADD CONSTRAINT tokens_creator_launch_bps_check
      CHECK (creator_launch_bps IS NULL
             OR (creator_launch_bps >= 0 AND creator_launch_bps <= 10000));
  END IF;
END $$;

-- No backfill is possible or attempted. NULL means "not yet observed by the indexer",
-- which is distinct from "the creator bought nothing" -- and the UI must render those
-- differently. Showing "creator bought 0%" for a row the indexer has not synced would
-- be a false reassurance about exactly the thing this column exists to disclose.
-- Rows settle on the next sync of that token.

COMMIT;

-- Verification, run separately:
--
--   SELECT count(*) FILTER (WHERE creator_launch_bps IS NULL)  AS unobserved,
--          count(*) FILTER (WHERE creator_launch_bps IS NOT NULL) AS observed,
--          max(creator_launch_bps) AS max_bps
--     FROM public.tokens;
--
-- max_bps above the configured maxCreatorLaunchBps (250 at time of writing) would mean
-- either the cap moved or the indexer is reading the wrong field -- worth investigating
-- rather than assuming.
--
-- Rollback:
--
--   BEGIN;
--   ALTER TABLE public.tokens DROP CONSTRAINT IF EXISTS tokens_creator_launch_bps_check;
--   ALTER TABLE public.tokens DROP COLUMN IF EXISTS creator_launch_purchased;
--   ALTER TABLE public.tokens DROP COLUMN IF EXISTS creator_launch_bps;
--   ALTER TABLE public.tokens DROP COLUMN IF EXISTS lp_recipient;
--   COMMIT;

-- ─────────────────────────────────────────────────────────────────────────
-- CHECKPOINT RESET — required, and not part of either migration.
--
-- indexer_state currently holds last_processed_block = 53995966, written in July
-- against the ORIGINAL factory (0x63C4c5b7). Left alone, the indexer resumes from
-- there: ~5.4M blocks of history belonging to a contract we no longer use.
-- 59366694 is the deploy block of 0xEDeed1F05D34421Add0F59b7340588ab2BbaC04b.
UPDATE public.indexer_state
   SET last_processed_block = 59366693,   -- one BEFORE the deploy block, so the
       updated_at = now()                 -- deploy block itself is scanned
 WHERE id = 'arc_launch_factory';
