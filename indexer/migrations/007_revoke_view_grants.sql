-- 007_revoke_view_grants.sql
--
-- Strip Supabase's default ACL from the two views, leaving SELECT only.
--
-- ── WHAT WAS FOUND ────────────────────────────────────────────────────────────
--
-- Supabase grants INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES and TRIGGER to `anon` and
-- `authenticated` on every new object in the public schema. Migration 000 revokes those on
-- the BASE TABLES, so a write there fails at the grant layer independently of RLS -- two
-- independent barriers, which CLAUDE.md records as settled.
--
-- The views were created afterwards and never got that treatment. Inspected on the live
-- database, `token_candles_1m` and `tokens_with_volume` each carried all six.
--
-- ⚠ NOT CURRENTLY EXPLOITABLE, AND THAT IS NOT THE POINT. Both views use GROUP BY and
-- window functions, so neither is auto-updatable and Postgres rejects writes regardless of
-- the grant. The principle is that the grant layer is supposed to be the first barrier,
-- and the next view added might be a simple one that IS auto-updatable -- at which point
-- the default ACL becomes a write path nobody added deliberately.
--
-- ── WHY THIS FILE EXISTS WHEN THE LIVE DATABASE IS ALREADY FIXED ──────────────
--
-- It was fixed by hand in the dashboard. A dashboard fix does not reproduce: a fresh
-- production database bootstrapped on 16 September gets the permissive defaults again,
-- and nothing would say so.
--
-- ⚠ REVOKE ALL THEN GRANT SELECT, not individual REVOKEs. An enumerated list can only
-- revoke the privileges known when it was written; `ALL` also removes whatever Supabase
-- adds to its defaults later.
--
-- ⚠ THE OVER-REVOKE FAILURE IS SILENT AND LOOKS LIKE SUCCESS. Dropping SELECT too would
-- make both views return ZERO ROWS WITH NO ERROR -- and an empty token list is also
-- exactly what launch day legitimately looks like. That is why the GRANT is not optional
-- and why VERIFY-SCHEMA.sql asserts SELECT is present as well as asserting the others are
-- absent. Verify with the ANON key; the service key bypasses RLS and cannot see it.

BEGIN;

REVOKE ALL ON public.token_candles_1m FROM anon, authenticated;
REVOKE ALL ON public.tokens_with_volume FROM anon, authenticated;

GRANT SELECT ON public.token_candles_1m TO anon, authenticated;
GRANT SELECT ON public.tokens_with_volume TO anon, authenticated;

-- ── applied-state stamp ──────────────────────────────────────────────────────
--
-- Guarded with to_regclass so this file can be applied in any order relative to 005,
-- matching 005 and 006.
DO $$
BEGIN
  IF to_regclass('public.schema_migrations') IS NOT NULL THEN
    INSERT INTO public.schema_migrations (version) VALUES ('007')
    ON CONFLICT (version) DO NOTHING;
  END IF;
END $$;

COMMIT;
