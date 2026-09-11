-- 004_trade_reserves_and_ohlc.sql
--
-- Adds the post-trade curve state to `trades`, and a candle view built on it.
--
--   trades.virtual_usdc_reserves    numeric
--   trades.virtual_token_reserves   numeric
--   view  token_candles_1m
--
-- Safe to run on a live database: additive, nothing dropped or rewritten, re-runnable.
-- Does NOT touch tokens_with_volume, so 003's grants are unaffected.
--
--
-- ═══ WHY THE CHART CANNOT USE EXECUTION PRICE ════════════════════════════════
--
-- This is the whole reason the migration exists, and it was found by deriving price from
-- the trade rows we already had:
--
--     block       side   usdc      tokens    price
--     59446076    BUY    2.0000    153147    $1.306e-5
--     59446082    SELL   0.1881     76573    $2.457e-6
--     59446156    BUY    2.0000    153147    $1.306e-5
--     59446162    SELL   0.1881     76573    $2.457e-6
--
-- A 5.3x sawtooth between ADJACENT trades at the SAME reserve level. That is not the
-- market -- it is the snipe tax and the fees. `usdc_amount / token_amount` is the
-- effective EXECUTION price including tax, so charting it draws the fee schedule rather
-- than the price.
--
-- And it is worst exactly where it matters most: the snipe tax opens at 9800 bps, so
-- every new token's chart would begin with an enormous spike that means nothing. Nobody
-- looking at it would know why.
--
-- ⚠ THE CHART PLOTS CURVE MID-PRICE, DERIVED FROM RESERVES. Never usdc/token.
--
--     mid_price = virtual_usdc_reserves / virtual_token_reserves
--
-- That is the price the curve itself is at, tax-free and fee-free, which is what a
-- candle is supposed to show.
--
--
-- ═══ WHY THE RESERVES MUST BE STORED PER TRADE ═══════════════════════════════
--
-- `tokens` holds only the CURRENT reserves. Once a second trade lands, the state at the
-- first is gone forever -- it cannot be recovered from the row, and re-deriving it would
-- mean replaying every trade through the curve formula, which is CLAUDE.md §1.3's
-- explicit "never re-derive the curve math".
--
-- The indexer already reads `curves(token)` after every trade (updateReservesFromChain).
-- These two columns are written from THAT read. No extra RPC call.
--
-- ⚠ CORRECTED 11 September 2026: "after every trade" was not reliably true until then. The
-- read carried no blockTag, so it returned the curve at whatever block was LATEST when the
-- indexer reached the log -- after any later trade in the same poll, or hours later in a
-- catch-up. Measured: 26 of 27 rows right; one GP4265 buy (block 60267961) held the state
-- after the NEXT trade. That row has been repaired to the chain's state at its own block.
--
-- WHAT IS TRUE NOW: the read is pinned to the trade's own block (readCurveAtBlock in
-- src/index.js), so from that fix forward these columns hold the BLOCK-LEVEL post-trade
-- state -- the curve at the end of the trade's block.
--
-- THE LIMIT, which the frozen contract gives no way around: two trades on one token in the
-- SAME block share that block's end state. The Trade event carries no reserves, so nothing
-- can separate them. None of the 27 rows stored at the time shared a block.
-- `indexer/scripts/verify-trade-reserves.js --live` checks every row against the chain.
--
--
-- ═══ WHY EMPTY BUCKETS ARE NOT A GAP TO FILL ═════════════════════════════════
--
-- On a bonding curve, price is a pure function of reserves, and reserves change ONLY
-- when someone trades. So between trades the price is not unknown or interpolated -- it
-- is EXACTLY constant.
--
-- A minute with no trades is therefore a real candle with O=H=L=C at the last price, and
-- that is a true statement rather than a smoothing artefact. The forward-fill below is
-- arithmetic, not estimation. (Confirmed against pump.fun, whose own API exposes the same
-- virtual/real reserve pair: they are not doing anything clever either, because there is
-- nothing clever to do.)

BEGIN;

-- ── 1. post-trade curve state ────────────────────────────────────────────────
--
-- Nullable: NULL means "recorded before this migration", and the candle view skips those
-- rows rather than inventing a price for them. numeric, not bigint -- virtual token
-- reserves are ~1e27 and overflow bigint.
ALTER TABLE public.trades
  ADD COLUMN IF NOT EXISTS virtual_usdc_reserves  numeric;

ALTER TABLE public.trades
  ADD COLUMN IF NOT EXISTS virtual_token_reserves numeric;

-- The candle view groups by token and time bucket.
CREATE INDEX IF NOT EXISTS trades_token_blocktime_idx
  ON public.trades (token_address, block_time);

COMMIT;

-- ═══ 2. The candle view ══════════════════════════════════════════════════════
--
-- One-minute buckets. Coarser intervals are derived by re-bucketing this in the query
-- rather than by adding more views, so there is one definition of price.
--
-- ⚠ BUCKETS ON block_time, NEVER created_at. created_at is the indexer's INSERT time and
--   carried up to 30.9 HOURS of drift on real rows (see 003). Bucketing on it would put
--   the ingest schedule on the chart's x-axis instead of the chain's.
--
-- ⚠ ORDERING WITHIN A BUCKET IS BY block_number, NEVER block_time. Arc produces
--   sub-second blocks and consecutive blocks can share a timestamp (CLAUDE.md §9.3), so
--   first_value/last_value ordered by time would pick an arbitrary row among ties.
--   Ordering by (block_number, id) is total.

DROP VIEW IF EXISTS public.token_candles_1m;

CREATE VIEW public.token_candles_1m
WITH (security_invoker = true) AS
WITH priced AS (
  SELECT
      tr.token_address,
      date_trunc('minute', tr.block_time) AS bucket,
      tr.block_number,
      tr.id,
      -- Curve mid-price in USDC per whole token. USDC is 6dp, launched tokens are 18dp,
      -- so the 1e12 rescales the ratio into a per-token price.
      (tr.virtual_usdc_reserves / tr.virtual_token_reserves) * 1000000000000.0 AS mid_price,
      tr.usdc_amount / 1000000.0 AS usdc_volume
    FROM public.trades tr
   WHERE tr.block_time IS NOT NULL
     AND tr.virtual_token_reserves IS NOT NULL
     AND tr.virtual_token_reserves > 0
     AND tr.virtual_usdc_reserves IS NOT NULL
)
SELECT
    token_address,
    bucket,
    (array_agg(mid_price ORDER BY block_number ASC,  id ASC))[1] AS open,
    max(mid_price)                                               AS high,
    min(mid_price)                                               AS low,
    (array_agg(mid_price ORDER BY block_number DESC, id DESC))[1] AS close,
    sum(usdc_volume)                                             AS volume_usdc,
    count(*)                                                     AS trade_count
  FROM priced
 GROUP BY token_address, bucket;

-- ⚠ REQUIRED. A view created without a grant returns ZERO ROWS to anon and raises NO
-- ERROR, and the service-role key cannot detect it because service-role bypasses RLS.
-- Same trap as 003; see the long note in 000_base_schema.sql.
GRANT SELECT ON public.token_candles_1m TO anon, authenticated;

-- ═══ Verification, with the ANON key ═════════════════════════════════════════
--
--   SELECT token_address, bucket, open, high, low, close, trade_count
--     FROM public.token_candles_1m ORDER BY bucket;
--
-- Expect one row per token per minute that contained a trade. A NON-ZERO row count is
-- the check that matters -- zero rows with HTTP 200 means the grant did not land.
--
-- Sanity: open/high/low/close for a single-trade bucket must all be EQUAL. If they
-- differ, the price is being taken from usdc_amount/token_amount somewhere rather than
-- from the reserves, and the sawtooth is back.
--
--   SELECT count(*) FILTER (WHERE virtual_token_reserves IS NULL) AS pre_004,
--          count(*) FILTER (WHERE virtual_token_reserves IS NOT NULL) AS usable
--     FROM public.trades;
--
-- Rows written before 004 have no reserves and are invisible to the chart. They are not
-- backfillable: the curve state at that block is not recoverable from the row, and
-- re-deriving it would mean re-implementing the curve math (CLAUDE.md §1.3). The chart
-- simply starts from the first trade indexed after this migration.
--
-- ═══ FORWARD-FILL BELONGS IN THE QUERY, NOT HERE ═════════════════════════════
--
-- This view emits only buckets that CONTAIN a trade. A continuous series is produced by
-- carrying `close` forward across empty buckets, which the client does when building the
-- series (or a generate_series LEFT JOIN can do server-side if it ever needs to).
--
-- It is deliberately not baked in: a view that emitted a row per minute forever would
-- generate unbounded rows for a token nobody has traded since launch, and the emptiness
-- is information the caller may want to see.
--
-- ═══ Rollback ════════════════════════════════════════════════════════════════
--
--   BEGIN;
--   DROP VIEW IF EXISTS public.token_candles_1m;
--   DROP INDEX IF EXISTS public.trades_token_blocktime_idx;
--   ALTER TABLE public.trades DROP COLUMN IF EXISTS virtual_usdc_reserves;
--   ALTER TABLE public.trades DROP COLUMN IF EXISTS virtual_token_reserves;
--   COMMIT;
--
-- The indexer writes both columns. Dropping them without reverting src/index.js makes
-- every subsequent trade insert fail on the missing column rather than degrade.

-- ── applied-state stamp ──────────────────────────────────────────────────────
--
-- ⚠ GUARDED with to_regclass, so this file can be applied in ANY order relative to
-- 005 (which creates the table). An unguarded INSERT would make every migration below
-- 005 fail on a database that has not reached 005 yet -- turning a tracking convenience
-- into a hard ordering dependency, which is the opposite of what it is for.
DO $$
BEGIN
  IF to_regclass('public.schema_migrations') IS NOT NULL THEN
    INSERT INTO public.schema_migrations (version) VALUES ('004')
    ON CONFLICT (version) DO NOTHING;
  END IF;
END $$;
