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
--   node indexer/scripts/verify-anon-access.js      (expects 12/12)
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
FROM unnest(ARRAY['tokens_with_volume','token_candles_1m','token_candles_1s']) AS v

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
FROM unnest(ARRAY['tokens','trades','tokens_with_volume','token_candles_1m','token_candles_1s']) AS g(obj)

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
-- ── 6b. the VIEWS carry SELECT and nothing else ──────────────────────────────
--
-- Supabase grants INSERT/UPDATE/DELETE/TRUNCATE/REFERENCES/TRIGGER by default on every new
-- object in public. Migration 000 revokes those on the base TABLES; the views were created
-- afterwards and kept all six until 007. The grouped views are not auto-updatable (GROUP BY, window
-- functions) so it was not exploitable -- but the grant layer is meant to be the first
-- barrier, and the next view might be a simple one.
--
-- ⚠ BOTH DIRECTIONS ARE ASSERTED. Checking only that the writes are gone would pass on a
-- database where SELECT was revoked too -- which returns zero rows with NO ERROR and looks
-- exactly like launch day.
SELECT 'view grant: anon CAN SELECT ' || v,
       has_table_privilege('anon', 'public.' || v, 'SELECT')
FROM unnest(ARRAY['tokens_with_volume','token_candles_1m','token_candles_1s']) AS v

UNION ALL
SELECT 'view grant: anon CANNOT ' || p.priv || ' ' || p.obj,
       NOT has_table_privilege('anon', 'public.' || p.obj, p.priv)
FROM (VALUES
  ('tokens_with_volume','INSERT'),('tokens_with_volume','UPDATE'),('tokens_with_volume','DELETE'),
  ('tokens_with_volume','TRUNCATE'),('tokens_with_volume','REFERENCES'),('tokens_with_volume','TRIGGER'),
  ('token_candles_1m','INSERT'),('token_candles_1m','UPDATE'),('token_candles_1m','DELETE'),
  ('token_candles_1m','TRUNCATE'),('token_candles_1m','REFERENCES'),('token_candles_1m','TRIGGER'),
  ('token_candles_1s','INSERT'),('token_candles_1s','UPDATE'),('token_candles_1s','DELETE'),
  ('token_candles_1s','TRUNCATE'),('token_candles_1s','REFERENCES'),('token_candles_1s','TRIGGER')
) AS p(obj,priv)

UNION ALL
-- ── 7. applied-state ─────────────────────────────────────────────────────────
SELECT 'migration recorded: ' || v,
       EXISTS (SELECT 1 FROM public.schema_migrations WHERE version = v)
FROM unnest(ARRAY['000','001','002','003','004','005','006','007','008']) AS v

ORDER BY 2, 1;   -- FALSE rows sort first, so any failure is at the top.
