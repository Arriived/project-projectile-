-- 003_list_page_columns.sql
--
-- Adds the columns the list page needs so that C2 (recent-buys ordering), C3 (collision
-- disclosure) and the 24h/7d volume windows arrive in ONE query instead of being derived
-- client-side or disabled outright.
--
-- Adds to tokens_with_volume:
--   last_buy_block, last_buy_at,
--   volume_24h_usdc, volume_7d_usdc, volume_all_usdc,
--   curve_token_supply, market_cap_usdc,
--   symbol_collision_count, name_collision_count
--
-- Adds two stored columns:
--   trades.block_time   -- see THE BUG below; this is the load-bearing part
--   tokens.curve_token_supply
--
-- Safe to run on a live database: additive on tables, and the view is recreated with
-- every column it had before plus the new ones. Re-runnable.
--
--
-- ═══ THE BUG THIS MIGRATION EXISTS AROUND ════════════════════════════════════
--
-- `trades.created_at` is the INDEXER'S INSERT TIME, not the block time. The indexer's
-- insert (src/index.js, handleTrade) does not supply it, so it defaults server-side to
-- now() at the moment the row is written.
--
-- That is not a theoretical distinction. Measured against live data on 30 August 2026,
-- comparing every trade row's created_at to the actual timestamp of its block:
--
--     block       created_at                block timestamp           drift
--     59446076    2026-08-29T14:54:35Z      2026-08-29T13:37:04Z      1.3 h
--     59458963    2026-08-30T22:21:12Z      2026-08-29T15:29:51Z     30.9 h
--     59459652    2026-08-30T22:21:15Z      2026-08-29T15:35:58Z     30.8 h
--
-- The 30-hour rows are trades the indexer ingested during a catch-up after being down.
-- They were stamped with the moment they were INGESTED. So at the time of writing, the
-- EXISTING volume_1h_usdc column reports 31-hour-old trades as one-hour volume, and the
-- list page renders that as live activity.
--
-- Building 24h and 7d windows on created_at would inherit exactly that failure, and it is
-- the specific failure mode that makes a window worse than no window: it looks live and
-- is not. Any backfill, any restart after downtime, any re-index re-stamps history as
-- "just now".
--
-- So the windows are computed on COALESCE(block_time, created_at):
--
--   * block_time is the truth and comes from the chain.
--   * created_at is the fallback for rows written before this migration, which keeps the
--     view working rather than blanking history.
--
-- ⚠ THE WINDOWS REMAIN APPROXIMATE UNTIL block_time IS POPULATED FOR EVERY ROW. The
--   indexer change and the backfill script ship alongside this file; until both have run,
--   the frontend must keep saying the windows are approximate. Do not remove that hover
--   text on the strength of this migration alone.
--
--
-- ═══ WHY THE VOLUME COLUMNS ARE COMPUTED, NOT STORED ═════════════════════════
--
-- Deliberate, and not an optimisation left on the table. A materialised aggregate that
-- goes stale during a busy launch is worse than no window at all, for the same reason as
-- above: it looks live and is not, and the moment it is most wrong is the moment it
-- matters most. Every volume figure here, and last_buy_block, is evaluated per query
-- against `trades`.
--
-- The cost is one grouped pass over trades per list query. At 10 trade rows that is free;
-- if it ever stops being free the answer is an index or a rollup table with an explicit
-- freshness column, NOT a silently stale number.

BEGIN;

-- ── 1. trades.block_time ─────────────────────────────────────────────────────
--
-- The block's own timestamp, from the chain. Nullable: NULL means "not yet backfilled",
-- which is distinct from any real time, and the view falls back rather than dropping the
-- row.
--
-- NOT a substitute for block_number in ORDERING. Arc produces sub-second blocks and
-- consecutive blocks can share a timestamp, so ordering is still by block_number
-- (CLAUDE.md §9.3). This column exists for TIME WINDOWS, which block numbers cannot
-- answer without a chain lookup.
ALTER TABLE public.trades
  ADD COLUMN IF NOT EXISTS block_time timestamptz;

-- The windows filter on it and the recent-buys ordering scans it per token.
CREATE INDEX IF NOT EXISTS trades_token_block_idx
  ON public.trades (token_address, block_number DESC);

CREATE INDEX IF NOT EXISTS trades_block_time_idx
  ON public.trades (block_time);

-- ── 2. tokens.curve_token_supply ───────────────────────────────────────────────────
--
-- Stored rather than hardcoded in the frontend, for the same reason creator_launch_bps
-- is (migration 002): the indexer reads it from the contract, so it cannot drift from
-- what the chain says the way a constant in a TypeScript file can.
--
-- ⚠ WHICH SUPPLY THIS IS, AND WHY IT IS THE CURVE SUPPLY. The contract exposes:
--
--     CURVE_TOKEN_SUPPLY   807,000,000e18   sold through the bonding curve
--     LP_TOKEN_RESERVE     193,000,000e18   held back to seed the pool at graduation
--     TOTAL_TOKEN_SUPPLY   1,000,000,000e18 the sum
--
-- This column holds CURVE_TOKEN_SUPPLY, and the name says so.
--
-- Market cap is price x CIRCULATING supply. During the curve phase the 193M LP reserve
-- is held by the factory and cannot be sold into the curve -- it is not circulating, and
-- pricing it as though it were overstates every market cap by 1000/807 = 1.24x. On a
-- product whose stated moat is verifiability, an inflated headline number is the wrong
-- thing to be wrong about.
--
-- ⚠ GRADUATED TOKENS ARE A DIFFERENT QUESTION AND THIS COLUMN DOES NOT ANSWER IT. After
-- graduation the 193M IS in the pool and IS tradeable, so the circulating figure and the
-- fully-diluted figure genuinely diverge -- and the card renders both MC and FDV. This
-- column is the curve-phase denominator; anything wanting a post-graduation circulating
-- supply must derive it separately rather than reusing this. Flagged, not solved.
ALTER TABLE public.tokens
  ADD COLUMN IF NOT EXISTS curve_token_supply numeric;

-- No backfill from SQL. NULL means "not yet observed by the indexer", which the view
-- renders as a NULL market cap rather than zero -- a zero market cap is a claim, NULL is
-- the absence of one. Rows settle on the next sync of that token.

COMMIT;

-- ═══ 3. The view ═════════════════════════════════════════════════════════════
--
-- Recreated in full. Every column it had before is preserved in its original position;
-- the new ones are appended.
--
-- ⚠ SECURITY INVOKER IS DELIBERATE AND MUST NOT BE "FIXED" TO DEFINER. See the long note
--   in 000_base_schema.sql. Under INVOKER the caller needs its own SELECT rights on
--   public.tokens and public.trades; without them the view returns ZERO ROWS AND NO
--   ERROR, the frontend shows an empty list, and nothing looks broken.
--
-- ⚠ DROP VIEW DISCARDS ITS GRANTS. The GRANT at the bottom of this file is not optional
--   boilerplate -- omitting it produces exactly the silent-empty-view failure above, and
--   the service-role key CANNOT detect it because service-role bypasses RLS entirely.
--   Verify with a real anon key after applying.

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
    t.state,
    t.creator_launch_purchased,
    t.creator_launch_bps,
    t.lp_recipient,

    -- ── 003: volume windows ──────────────────────────────────────────────────
    -- All four on the SAME SCALE as volume_1h_usdc: whole USDC, already divided by 1e6.
    -- Adding a raw-6dp-units column alongside these would be a unit drift waiting to
    -- happen, so every volume figure in this view is decimal USDC. Anything reading them
    -- must NOT divide again.
    COALESCE(v.volume_24h_usdc, 0::numeric) AS volume_24h_usdc,
    COALESCE(v.volume_7d_usdc,  0::numeric) AS volume_7d_usdc,
    COALESCE(v.volume_all_usdc, 0::numeric) AS volume_all_usdc,

    -- ── 003: recent buys (C2) ────────────────────────────────────────────────
    -- NULL, not 0, when a token has never been bought. "Never bought" is not "bought at
    -- block 0", and the frontend sorts nulls last on purpose rather than interleaving
    -- them. A 0 here would make a token nobody has touched sort as though it had a real
    -- buy, which is the thing recent-buys ordering exists to prevent.
    v.last_buy_block,
    v.last_buy_at,

    -- ── 003: is this token's window arithmetic EXACT? ─────────────────────────
    --
    -- TRUE when every trade behind the figures above carries a real block_time, so the
    -- windows mean what they say. FALSE when any of them is still falling back to
    -- created_at, which is ingest time and can be 30 hours adrift.
    --
    -- THE POINT OF THIS COLUMN IS THAT IT CLEARS ITSELF. The frontend shows its
    -- "approximate" note when this is false and stops when it is true, per token, with
    -- no flag to flip by hand. A caveat that needs a human to remove it is still on the
    -- page in October saying nothing.
    --
    -- A token with NO trades is exact by vacuous truth: there is nothing to be wrong
    -- about. bool_and over zero rows is NULL, hence the COALESCE.
    COALESCE(v.windows_exact, true) AS volume_windows_exact,

    -- ── 003: supply and market cap ───────────────────────────────────────────
    t.curve_token_supply,

    -- Computed per query from LIVE virtual reserves. NOT stored and NOT materialised:
    -- pinning it would let the pinned value drift from the reserves it claims to
    -- describe, which is the same failure as a stale volume window.
    --
    -- NULL rather than 0 when the inputs are unknown. A zero market cap is a claim about
    -- the token; NULL is the honest absence of one, and the frontend renders it as
    -- "unavailable".
    CASE
      WHEN t.curve_token_supply IS NULL OR t.virtual_token_reserves IS NULL
        OR t.virtual_token_reserves = 0 THEN NULL
      ELSE (t.virtual_usdc_reserves * t.curve_token_supply / t.virtual_token_reserves) / 1000000.0
    END AS market_cap_usdc,

    -- ── 003: collision disclosure (C3 / rule 2) ──────────────────────────────
    --
    -- Window functions, so the count arrives WITH the row and the frontend needs no
    -- second pass. The old client-side scan could only see the rows it had already
    -- fetched, which made it worse than nothing on a paginated list: a collision on page
    -- 4 would CLEAR tokens on page 1 that are in fact impersonated.
    --
    -- 1 means unique (the row counts itself). Anything above 1 is a collision, and BOTH
    -- sides of it carry the same count -- which of two identical tickers is "the real
    -- one" is not ours to assert.
    --
    -- SCOPE: every token, graduated included. The client-side version looked only at live
    -- tokens; that is widened here deliberately, because a graduated token is the most
    -- attractive thing to impersonate -- it succeeded, so people have heard of it.
    --
    -- Empty and NULL identifiers are forced to 1. Without this they all partition
    -- together and every unnamed token reports a collision with every other unnamed
    -- token, which is a false accusation rather than a missed one.
    CASE
      WHEN btrim(COALESCE(t.symbol, '')) = '' THEN 1
      ELSE count(*) OVER (PARTITION BY lower(btrim(t.symbol)))
    END AS symbol_collision_count,

    -- Names are normalised HARDER than symbols: case folded AND all whitespace removed,
    -- so "TxShape", "Txshape" and "Tx Shape" collapse to one key. A reader cannot tell
    -- those apart at a glance, and the whole point of the column is what a reader sees.
    --
    -- Name collision matters at least as much as symbol collision, and arguably more:
    -- symbol has a lock mechanism on chain (symbolLockDuration) which merely happens to
    -- be set to 0, whereas name has NO on-chain protection of any kind and never did.
    CASE
      WHEN btrim(COALESCE(t.name, '')) = '' THEN 1
      ELSE count(*) OVER (
        PARTITION BY regexp_replace(lower(btrim(t.name)), '\s+', '', 'g')
      )
    END AS name_collision_count

   FROM public.tokens t
     LEFT JOIN (
       -- ONE grouped pass over trades supplies every window and the recent-buy pointer.
       -- FILTER rather than four separate subqueries: same result, one scan.
       --
       -- The window predicate is COALESCE(block_time, created_at) -- block_time where the
       -- chain has told us, ingest time where it has not. See THE BUG at the top.
       SELECT tr.token_address,
              sum(tr.usdc_amount) FILTER (
                WHERE COALESCE(tr.block_time, tr.created_at) > now() - '01:00:00'::interval
              ) / 1000000.0 AS volume_1h_usdc,
              sum(tr.usdc_amount) FILTER (
                WHERE COALESCE(tr.block_time, tr.created_at) > now() - '24:00:00'::interval
              ) / 1000000.0 AS volume_24h_usdc,
              sum(tr.usdc_amount) FILTER (
                WHERE COALESCE(tr.block_time, tr.created_at) > now() - '7 days'::interval
              ) / 1000000.0 AS volume_7d_usdc,
              sum(tr.usdc_amount) / 1000000.0 AS volume_all_usdc,
              -- Ordering by BLOCK NUMBER, never by timestamp: Arc's sub-second blocks
              -- share timestamps, so max(block_time) can tie where max(block_number)
              -- cannot (CLAUDE.md §9.3).
              max(tr.block_number) FILTER (WHERE tr.is_buy) AS last_buy_block,
              max(COALESCE(tr.block_time, tr.created_at)) FILTER (WHERE tr.is_buy) AS last_buy_at,
              bool_and(tr.block_time IS NOT NULL) AS windows_exact
         FROM public.trades tr
        GROUP BY tr.token_address
     ) v ON v.token_address = t.contract_address;

-- ⚠ REQUIRED. DROP VIEW above discarded the grant; without this the view exists, returns
-- zero rows to anon, and raises no error. The tables' own RLS policies from
-- 000_base_schema.sql are unaffected by this migration and are not re-declared here.
GRANT SELECT ON public.tokens_with_volume TO anon, authenticated;

-- ═══ Verification — run with the ANON key, never the service key ═════════════
--
-- The service-role key bypasses RLS, so it returns rows whether or not the grant above
-- landed and CANNOT detect the failure this migration is most likely to cause.
--
--   node indexer/scripts/verify-anon-access.js
--
-- Expect a non-zero row count and every new column present. A row count of 0 with HTTP
-- 200 and no error is the signature of the missing grant, not of an empty database.
--
-- Sanity checks worth running once:
--
--   -- collisions: every count >= 1, and identical keys agree
--   SELECT name, symbol, symbol_collision_count, name_collision_count
--     FROM public.tokens_with_volume ORDER BY name_collision_count DESC;
--
--   -- market cap is derived from live reserves, not pinned
--   SELECT symbol, virtual_usdc_reserves, virtual_token_reserves, curve_token_supply,
--          market_cap_usdc
--     FROM public.tokens_with_volume WHERE curve_token_supply IS NOT NULL;
--
--   -- how much of the trade history still lacks a real block time
--   SELECT count(*) FILTER (WHERE block_time IS NULL) AS needs_backfill,
--          count(*) FILTER (WHERE block_time IS NOT NULL) AS exact,
--          count(*) AS total
--     FROM public.trades;
--
-- While `needs_backfill` is above zero the 1h/24h/7d windows are APPROXIMATE for any
-- token with unbackfilled trades, and the frontend must say so.
--
-- ═══ Rollback ════════════════════════════════════════════════════════════════
--
--   BEGIN;
--   DROP INDEX IF EXISTS trades_token_block_idx;
--   DROP INDEX IF EXISTS trades_block_time_idx;
--   ALTER TABLE public.trades DROP COLUMN IF EXISTS block_time;
--   ALTER TABLE public.tokens DROP COLUMN IF EXISTS curve_token_supply;
--   COMMIT;
--
-- Then restore the view from 000_base_schema.sql and re-run its GRANT. Dropping the
-- columns without restoring the view leaves a view referencing columns that no longer
-- exist; Postgres will refuse the DROP COLUMN until the view is dropped first.
