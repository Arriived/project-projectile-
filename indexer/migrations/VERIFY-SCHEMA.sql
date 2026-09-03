-- VERIFY-SCHEMA.sql — run this against a fresh database after APPLY-ALL.sql.
--
-- Paste into the Supabase SQL editor. Every row it returns is a check; the `ok` column is
-- the answer. A single FALSE means the database is not ready.
--
-- ── ⚠ THIS FILE IS ONLY HALF THE CHECK ───────────────────────────────────────
--
-- This runs as the SQL editor's role, which sees everything. It proves the OBJECTS exist.
-- It CANNOT prove the anon role can read them, and that is the failure that actually
-- reaches users:
--
--   `tokens_with_volume` is SECURITY INVOKER (deliberately — do not "fix" it to DEFINER).
--   The caller therefore needs its own SELECT rights, and without them the view returns
--   ZERO ROWS AND NO ERROR. The frontend shows an empty token list and nothing looks
--   broken — which is also exactly what launch day legitimately looks like.
--
-- The service-role key CANNOT detect this either: it bypasses RLS and returns rows whether
-- or not the grants are right.
--
-- So after this file returns all-true, run the ANON-key half:
--
--   node indexer/scripts/verify-anon-access.js      (expects 11/11)
--
-- See indexer/RUNBOOK.md for the full sequence.

-- ── 1. tables ────────────────────────────────────────────────────────────────
SELECT 'table: ' || t AS check,
       (to_regclass('public.' || t) IS NOT NULL) AS ok
FROM unnest(ARRAY['tokens','trades','indexer_state','schema_migrations']) AS t

UNION ALL
-- ── 2. views ─────────────────────────────────────────────────────────────────
SELECT 'view: ' || v,
       (to_regclass('public.' || v) IS NOT NULL)
FROM unnest(ARRAY['tokens_with_volume','token_candles_1m']) AS v

UNION ALL
-- ── 3. columns every migration adds ──────────────────────────────────────────
-- ⚠ curve_token_supply, NOT total_supply. They are different columns and the difference
-- is a 1.24x market-cap overstatement: the 193M LP reserve is not circulating supply. A
-- superseded APPLY-ALL.sql carried `total_supply` and nothing caught it.
SELECT 'column: ' || c.tbl || '.' || c.col,
       EXISTS (
         SELECT 1 FROM information_schema.columns
         WHERE table_schema='public' AND table_name=c.tbl AND column_name=c.col
       )
FROM (VALUES
  ('tokens','state'),
  ('tokens','creator_launch_purchased'),
  ('tokens','creator_launch_bps'),
  ('tokens','lp_recipient'),
  ('tokens','curve_token_supply'),
  ('trades','block_time'),
  ('trades','virtual_usdc_reserves'),
  ('trades','virtual_token_reserves')
) AS c(tbl,col)

UNION ALL
-- ── 4. RLS is ON for every non-public table ──────────────────────────────────
SELECT 'rls enabled: ' || relname,
       relrowsecurity
FROM pg_class
WHERE relnamespace = 'public'::regnamespace
  AND relname IN ('tokens','trades','indexer_state','schema_migrations')

UNION ALL
-- ── 5. the anon SELECT grants the frontend depends on ────────────────────────
SELECT 'anon SELECT on ' || g.obj,
       has_table_privilege('anon', 'public.' || g.obj, 'SELECT')
FROM unnest(ARRAY['tokens','trades','tokens_with_volume','token_candles_1m']) AS g(obj)

UNION ALL
-- ── 6. anon must NOT be able to write, and must NOT see operational tables ───
-- Two independent barriers protect these: no grant, AND RLS with no policy. This checks
-- the grant layer, which is the one that refuses with 42501 before RLS is consulted.
SELECT 'anon CANNOT ' || p.priv || ' ' || p.obj,
       NOT has_table_privilege('anon', 'public.' || p.obj, p.priv)
FROM (VALUES
  ('tokens','INSERT'),('tokens','UPDATE'),('tokens','DELETE'),
  ('trades','INSERT'),('trades','UPDATE'),('trades','DELETE'),
  ('indexer_state','SELECT'),
  ('schema_migrations','SELECT')
) AS p(obj,priv)

UNION ALL
-- ── 7. applied-state ─────────────────────────────────────────────────────────
SELECT 'migration recorded: ' || v,
       EXISTS (SELECT 1 FROM public.schema_migrations WHERE version = v)
FROM unnest(ARRAY['000','001','002','003','004','005']) AS v

ORDER BY 2, 1;   -- FALSE rows sort first, so any failure is at the top.
