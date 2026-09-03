-- 005_schema_migrations.sql
--
-- Applied-state tracking. Until now there was NONE: no table, no log, nothing. A fresh
-- environment had no way to answer "which migrations has this database had?" except by
-- inspecting columns one at a time and inferring — which is exactly how APPLY-ALL.sql came
-- to be missing twelve objects without anyone noticing.
--
-- ── ⚠ THE SECURITY POSTURE IS COPIED FROM indexer_state, DELIBERATELY ─────────
--
-- This repo protects its non-public tables with TWO INDEPENDENT BARRIERS, and the
-- distinction matters because they fail differently:
--
--   1. NO GRANT. anon has no privilege, so a write is refused with `42501 permission
--      denied` BEFORE RLS is ever consulted.
--   2. RLS enabled with NO policy, so even a granted role matches no rows.
--
-- CLAUDE.md records that these are separate, that a `204` (grant held, RLS matched
-- nothing) and a `401`/`42501` (refused outright) are different answers, and that the
-- REVOKE was the fix when anon turned out to hold UPDATE/DELETE grants Supabase had
-- granted by default. `GRANT SELECT` ADDS to whatever is already there — it does not
-- replace it — which is how those grants survived unnoticed in the first place.
--
-- So this table is created the way `indexer_state` is created in 000, and for the same
-- reason: it is operational metadata, not public data. It is NOT added to the anon SELECT
-- grant. Nothing in the frontend reads it, and nothing should — a schema version is a
-- deployment detail, and publishing one tells an attacker exactly which migrations a
-- database is missing.
--
-- ⚠ Writes are expected to come from the SQL editor (or any superuser applying DDL), never
-- through PostgREST. That is not a limitation to work around: the service-role key cannot
-- run DDL at all, so anything applying a migration already has SQL access, and giving
-- PostgREST a write path here would be a new hole for no gain.

BEGIN;

CREATE TABLE IF NOT EXISTS public.schema_migrations (
  -- The numeric prefix of the migration file: '000', '001', ... Text rather than integer
  -- so the leading zero survives and so a future '004a' hotfix has somewhere to go.
  version     text        NOT NULL,
  applied_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (version)
);

COMMENT ON TABLE public.schema_migrations IS
  'Which numbered migrations have been applied. Operational metadata: no anon grant, RLS on with no policy. See 005_schema_migrations.sql.';

-- Barrier 1: no privilege for the public roles.
REVOKE ALL ON public.schema_migrations FROM anon, authenticated;

-- Barrier 2: RLS on, and deliberately NO policy. Even if a grant were added by accident
-- (Supabase's defaults have done exactly that before), there is no policy to match.
ALTER TABLE public.schema_migrations ENABLE ROW LEVEL SECURITY;

-- Backfill what this database already has. Every migration below 005 is additive and
-- idempotent, so recording them here asserts only what the objects themselves show.
--
-- ⚠ Run this ONLY on a database that genuinely has them. On a fresh database this whole
-- file runs as part of APPLY-ALL, where the preceding migrations have just executed.
INSERT INTO public.schema_migrations (version) VALUES
  ('000'), ('001'), ('002'), ('003'), ('004'), ('005')
ON CONFLICT (version) DO NOTHING;

COMMIT;
