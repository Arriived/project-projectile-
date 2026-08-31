-- 003_ROLLBACK.sql
--
-- Undoes 003_list_page_columns.sql. Run this if 003 goes wrong.
--
-- ⚠ READ THIS FIRST: WHY THE ROLLBACK IS ITSELF THE DANGEROUS PART
--
-- The failure 003 is most likely to cause is NOT a syntax error -- it is a view that
-- exists, returns zero rows to anon, and raises no error. tokens_with_volume is
-- SECURITY INVOKER, so the caller needs its own SELECT right; DROP VIEW discards the
-- grant, and a recreate that forgets to restore it produces an empty token list on a
-- site that looks completely healthy. The service-role key CANNOT detect this, because
-- service-role bypasses RLS and returns rows either way.
--
-- So this file ends with the GRANT, and so does 003. If you take one thing from this
-- file: a recreate without a re-GRANT is the bug, in both directions.
--
--
-- ═══ WHICH SECTION TO RUN ════════════════════════════════════════════════════
--
-- SECTION 1 alone is almost always what you want. It restores the previous view and its
-- grant, which puts the list page back exactly as it was. The two columns 003 added stay
-- behind, unreferenced and harmless -- they cost nothing and dropping them THROWS AWAY
-- the block_time values the backfill fetched from the chain.
--
-- SECTION 2 is the full undo including the columns. Only run it if you intend to abandon
-- 003 entirely. Order matters and is not optional: Postgres refuses DROP COLUMN while a
-- view references the column, so section 1 MUST run first.
--
--
-- ═══ SECTION 1 — restore the previous view and its grant ═════════════════════
--
-- The view body below is transcribed VERBATIM from 000_base_schema.sql -- extracted
-- programmatically rather than retyped, so it cannot have drifted from the definition it
-- claims to restore. It is the pre-003 view: 24 columns, ending at lp_recipient, with
-- volume_1h_usdc computed over trades.created_at.
--
-- Note what restoring this brings BACK: the 1-hour window returns to filtering on
-- created_at, which is ingest time, so it will once again report trades as recent that
-- are not. That is the pre-existing behaviour, not a new fault -- but it is the reason
-- 003 exists, so roll back knowing you are restoring that too.

DROP VIEW IF EXISTS public.tokens_with_volume;

CREATE VIEW public.tokens_with_volume
WITH (security_invoker = true) AS
SELECT t.contract_address,
    t.chain_id,
    t.creator_address,
    t.name,
    t.symbol,
    t.metadata_uri,
    t.description,
    t.logo_url,
    t.buy_fee_bps,
    t.sell_fee_bps,
    t.graduation_threshold_usdc,
    t.real_usdc_reserves,
    t.token_reserves,
    t.virtual_usdc_reserves,
    t.virtual_token_reserves,
    t.graduated,
    t.graduated_at,
    t.verification_status,
    t.created_at,
    COALESCE(v.volume_1h_usdc, 0::numeric) AS volume_1h_usdc,
    -- APPENDED. The original view predates migrations 001 and 002 and omitted these, so a
    -- frontend reading the view could not show the curve state or the creator's launch
    -- purchase. The creator disclosure is a HARD requirement -- FRONTEND_BUILD_V2 and
    -- CLAUDE.md 7A both state the 2.5% cap limits only the privileged path and does not cap
    -- total creator holdings, which makes disclosure the actual protection.
    t.state,
    t.creator_launch_purchased,
    t.creator_launch_bps,
    t.lp_recipient
   FROM public.tokens t
     LEFT JOIN ( SELECT trades.token_address,
            sum(trades.usdc_amount) / 1000000.0 AS volume_1h_usdc
           FROM public.trades
          WHERE trades.created_at > (now() - '01:00:00'::interval)
          GROUP BY trades.token_address) v ON v.token_address = t.contract_address;

-- ⚠ NOT OPTIONAL. DROP VIEW above discarded the grant. Without this line the view exists
-- and returns ZERO ROWS to anon with NO ERROR -- see the note at the top.
GRANT SELECT ON public.tokens_with_volume TO anon, authenticated;

-- The table policies from 000_base_schema.sql are untouched by 003 and by this rollback.
-- They are re-asserted here only because they are cheap and idempotent, and because a
-- half-restored permission state is the thing hardest to notice.
GRANT SELECT ON public.tokens, public.trades TO anon, authenticated;


-- ═══ VERIFY, WITH THE ANON KEY ═══════════════════════════════════════════════
--
--   node indexer/scripts/verify-anon-access.js
--
-- Expect 11/11 and a NON-ZERO row count. Zero rows with HTTP 200 means the grant did not
-- land. Do not use the service-role key to check this; it cannot see the failure.


-- ═══ SECTION 2 — the full undo, columns included ═════════════════════════════
--
-- ⚠ DESTRUCTIVE. trades.block_time holds timestamps fetched from the chain by
--   scripts/backfill-block-time.js. Dropping the column throws them away, and getting
--   them back means re-reading every block over the public RPC again.
--
-- Run ONLY after section 1, and only to abandon 003 entirely.
--
--   BEGIN;
--   DROP INDEX IF EXISTS public.trades_token_block_idx;
--   DROP INDEX IF EXISTS public.trades_block_time_idx;
--   ALTER TABLE public.trades DROP COLUMN IF EXISTS block_time;
--   ALTER TABLE public.tokens DROP COLUMN IF EXISTS curve_token_supply;
--   COMMIT;
--
-- The indexer writes both columns (src/index.js). If you drop them without reverting
-- that code, every subsequent insert fails on the missing column rather than degrading
-- -- so revert the indexer in the same change, or leave the columns in place.
