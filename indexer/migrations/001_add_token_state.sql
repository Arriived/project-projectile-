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

-- ── applied-state stamp ──────────────────────────────────────────────────────
--
-- ⚠ GUARDED with to_regclass, so this file can be applied in ANY order relative to
-- 005 (which creates the table). An unguarded INSERT would make every migration below
-- 005 fail on a database that has not reached 005 yet -- turning a tracking convenience
-- into a hard ordering dependency, which is the opposite of what it is for.
DO $$
BEGIN
  IF to_regclass('public.schema_migrations') IS NOT NULL THEN
    INSERT INTO public.schema_migrations (version) VALUES ('001')
    ON CONFLICT (version) DO NOTHING;
  END IF;
END $$;
