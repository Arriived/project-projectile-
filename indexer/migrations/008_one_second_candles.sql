-- 008_one_second_candles.sql
--
-- Adds the one-second candle surface used during a launch's opening seconds.
-- The indexer runtime already writes every required value; this is a database-only view.
--
-- Arc block timestamps have one-second resolution even though blocks arrive roughly every
-- 530 ms. Consecutive blocks can therefore share a timestamp. Bucketing on block_time is
-- still exact for a 1S chart, while ordering must remain (block_number, id) so tied block
-- timestamps never make open/close arbitrary.

BEGIN;

DROP VIEW IF EXISTS public.token_candles_1s;

CREATE VIEW public.token_candles_1s
WITH (security_invoker = true) AS
WITH priced AS (
  SELECT
      tr.token_address,
      date_trunc('second', tr.block_time) AS bucket,
      tr.block_number,
      tr.id,
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
    (array_agg(open_price  ORDER BY block_number ASC,  id ASC))[1]  AS open,
    GREATEST(max(open_price), max(close_price))                     AS high,
    LEAST(min(open_price), min(close_price))                        AS low,
    (array_agg(close_price ORDER BY block_number DESC, id DESC))[1] AS close,
    sum(usdc_volume)                                                AS volume_usdc,
    count(*)                                                        AS trade_count
  FROM swept
 GROUP BY token_address, bucket;

-- New public-schema objects inherit Supabase's broad default ACL. Remove every privilege,
-- then restore only the read access the browser needs.
REVOKE ALL ON public.token_candles_1s FROM anon, authenticated;
GRANT SELECT ON public.token_candles_1s TO anon, authenticated;

-- Verification boundary: trades at .999999 and the following whole second must produce
-- different buckets. Trades inside either second share a bucket and are ordered by block/id.
--
-- WITH sample(ts) AS (VALUES
--   ('2026-09-13 12:00:00.999999+00'::timestamptz),
--   ('2026-09-13 12:00:01.000000+00'::timestamptz)
-- )
-- SELECT count(DISTINCT date_trunc('second', ts)) = 2 AS boundary_ok FROM sample;

DO $$
BEGIN
  IF to_regclass('public.schema_migrations') IS NOT NULL THEN
    INSERT INTO public.schema_migrations (version) VALUES ('008')
    ON CONFLICT (version) DO NOTHING;
  END IF;
END $$;

COMMIT;
