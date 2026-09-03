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

-- ── applied-state stamp ──────────────────────────────────────────────────────
--
-- ⚠ GUARDED with to_regclass, so this file can be applied in ANY order relative to
-- 005 (which creates the table). An unguarded INSERT would make every migration below
-- 005 fail on a database that has not reached 005 yet -- turning a tracking convenience
-- into a hard ordering dependency, which is the opposite of what it is for.
DO $$
BEGIN
  IF to_regclass('public.schema_migrations') IS NOT NULL THEN
    INSERT INTO public.schema_migrations (version) VALUES ('002')
    ON CONFLICT (version) DO NOTHING;
  END IF;
END $$;
