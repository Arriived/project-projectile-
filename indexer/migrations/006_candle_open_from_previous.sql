-- 006_candle_open_from_previous.sql
--
-- Give every trade a candle with a BODY, by taking its open from the previous trade's
-- stored reserves.
--
-- ── THE BUG ───────────────────────────────────────────────────────────────────
--
-- `trades.virtual_*_reserves` are the POST-trade curve state. The 004 view priced every
-- trade at that one number and then aggregated per bucket:
--
--   open  = first mid_price in the bucket
--   close = last  mid_price in the bucket
--   high  = max, low = min
--
-- For a bucket holding ONE trade -- which is almost every bucket on a bonding curve --
-- open = high = low = close. The candle has no body. It renders as a flat dash, and a
-- chart of flat dashes is a line drawn expensively.
--
-- That is not what a trade is. A trade SWEEPS a price range: it starts at the curve price
-- before it executed and ends at the price after. pump.fun's candles have bodies for
-- exactly this reason, not because their buckets are busier than ours.
--
-- ── THE FIX, AND WHAT IT DOES NOT DO ──────────────────────────────────────────
--
-- The pre-trade price is already stored -- it is the PREVIOUS trade's post-trade price.
-- So `lag()` over (token, block_number, id) recovers it with no new columns and no new
-- indexer work.
--
-- ⚠ NO CURVE MATH IS RE-DERIVED HERE, and that is deliberate. CLAUDE.md §1.3 is explicit
-- that the curve has been re-derived incorrectly more than once, including a frontend
-- version that overstated output by 98.96x at t=0. This view reads two adjacent stored
-- rows and subtracts nothing. If the reserves are right, the candle is right.
--
-- ⚠ ORDERING IS block_number THEN id, NEVER block_time. Arc's sub-second blocks share
-- timestamps, so ordering by time would shuffle trades within a block and hand a candle
-- the wrong neighbour. Bucketing still uses block_time -- that is what a minute IS -- but
-- sequence never does.
--
-- ⚠ THE FIRST TRADE OF A TOKEN HAS NO PREDECESSOR. `lag()` yields NULL and it is
-- COALESCEd back to its own price, so that one candle is still a dash. That is honest: no
-- pre-trade price was ever stored for it, and the alternative -- computing the launch
-- price from the curve constants -- is precisely the re-derivation the rule above forbids.
-- It affects exactly one candle per token, at the far left of the chart.

BEGIN;

DROP VIEW IF EXISTS public.token_candles_1m;

CREATE VIEW public.token_candles_1m
WITH (security_invoker = true) AS
WITH priced AS (
  SELECT
      tr.token_address,
      date_trunc('minute', tr.block_time) AS bucket,
      tr.block_number,
      tr.id,
      -- Curve mid-price in USDC per whole token, AFTER this trade. USDC is 6dp, launched
      -- tokens are 18dp, so the 1e12 rescales the ratio into a per-token price.
      (tr.virtual_usdc_reserves / tr.virtual_token_reserves) * 1000000000000.0 AS close_price,
      tr.usdc_amount / 1000000.0 AS usdc_volume
    FROM public.trades tr
   WHERE tr.block_time IS NOT NULL
     AND tr.virtual_token_reserves IS NOT NULL
     AND tr.virtual_token_reserves > 0
     AND tr.virtual_usdc_reserves IS NOT NULL
),
swept AS (
  SELECT
      p.*,
      -- The price this trade STARTED from: the previous trade's post-trade price.
      -- COALESCE to its own close for the first trade of a token (see the header).
      COALESCE(
        lag(p.close_price) OVER (
          PARTITION BY p.token_address
          ORDER BY p.block_number ASC, p.id ASC
        ),
        p.close_price
      ) AS open_price
    FROM priced p
)
SELECT
    token_address,
    bucket,
    -- The bucket opens where its FIRST trade started sweeping, not where that trade ended.
    (array_agg(open_price  ORDER BY block_number ASC,  id ASC))[1]  AS open,
    -- ⚠ High and low span BOTH ends of every sweep in the bucket. Taking max/min of the
    -- close alone would clip the wick on the side the price came from, which is how a
    -- candle ends up smaller than the move it represents.
    GREATEST(max(open_price), max(close_price))                     AS high,
    LEAST(min(open_price), min(close_price))                        AS low,
    (array_agg(close_price ORDER BY block_number DESC, id DESC))[1] AS close,
    sum(usdc_volume)                                                AS volume_usdc,
    count(*)                                                        AS trade_count
  FROM swept
 GROUP BY token_address, bucket;

-- ⚠ RE-GRANT. DROP VIEW discards the grant, and this view is SECURITY INVOKER: without
-- it the anon role gets ZERO ROWS AND NO ERROR, the chart renders empty, and an empty
-- chart is also exactly what a token with no trades legitimately looks like. This is the
-- single most repeated trap in this schema.
GRANT SELECT ON public.token_candles_1m TO anon, authenticated;

-- ── applied-state stamp ──────────────────────────────────────────────────────
--
-- Guarded with to_regclass so this file can be applied in any order relative to 005.
DO $$
BEGIN
  IF to_regclass('public.schema_migrations') IS NOT NULL THEN
    INSERT INTO public.schema_migrations (version) VALUES ('006')
    ON CONFLICT (version) DO NOTHING;
  END IF;
END $$;

COMMIT;
