// Candles for the price chart.
//
// ── THE PRICE IS THE CURVE'S MID, NEVER THE EXECUTION PRICE ──────────────────
//
// The candle views derive price from `virtual_usdc_reserves / virtual_token_reserves`
// per trade (migrations 004 and 008). It must never be swapped for
// `usdc_amount / token_amount`.
//
// Measured on real rows before 004 existed: adjacent buys and sells at the SAME reserve
// level differed by 5.3x, because execution price includes the snipe tax and the fees.
// Charting that draws the fee schedule rather than the market, and it is worst at t=0
// where the tax opens at 9800 bps -- every new token's chart would have begun with an
// enormous spike that means nothing.
//
// With reserves, the same two trades sit 0.4% apart. That is the curve actually moving.
//
// ── EMPTY MINUTES ARE NOT GAPS ───────────────────────────────────────────────
//
// On a bonding curve, price is a pure function of reserves and reserves change ONLY when
// someone trades. Between trades the price is EXACTLY constant, so carrying the last
// close forward is arithmetic, not interpolation, and a flat candle is a true statement.

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import type { Address } from "viem";
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "../config";
import { useSecondClock } from "./useSecondClock";

/** A lightweight-charts line point. `time` is a UNIX second. */
export type PricePoint = { time: number; value: number };

/** One OHLC bucket. Times are UNIX seconds, matching PricePoint. */
export type Candle = { time: number; open: number; high: number; low: number; close: number };

/**
 * The timeframes offered. 1S reads `token_candles_1s`; every coarser timeframe is
 * aggregated from `token_candles_1m` here.
 */
export const TIMEFRAMES = [
  { id: "1S", seconds: 1 },
  { id: "1M", seconds: 60 },
  { id: "5M", seconds: 300 },
  { id: "1H", seconds: 3600 },
  { id: "6H", seconds: 21600 },
  { id: "1D", seconds: 86400 },
  { id: "ALL", seconds: 0 },
] as const;

export type TimeframeId = (typeof TIMEFRAMES)[number]["id"];

/**
 * Aggregate 1-minute candles into a coarser bucket.
 *
 * Open is the FIRST bucket's open, close the LAST bucket's close, high/low the extremes --
 * the only correct way to merge OHLC. Averaging any of them would invent a price that
 * never existed.
 */
export function aggregateCandles(candles: Candle[], bucketSeconds: number): Candle[] {
  if (bucketSeconds <= 60 || candles.length === 0) return candles;
  const sorted = [...candles].sort((a, b) => a.time - b.time);
  const out: Candle[] = [];
  let cur: Candle | null = null;
  let curKey = -1;
  for (const c of sorted) {
    const key = Math.floor(c.time / bucketSeconds) * bucketSeconds;
    if (cur === null || key !== curKey) {
      if (cur) out.push(cur);
      cur = { time: key, open: c.open, high: c.high, low: c.low, close: c.close };
      curKey = key;
    } else {
      cur.high = Math.max(cur.high, c.high);
      cur.low = Math.min(cur.low, c.low);
      cur.close = c.close;
    }
  }
  if (cur) out.push(cur);
  return out;
}

/**
 * Fill buckets with no trade by carrying the last close forward as a flat candle.
 *
 * ── ⚠ WHY CARRY FORWARD RATHER THAN LEAVE A GAP ──────────────────────────────
 *
 * On a bonding curve the price is a PURE FUNCTION OF RESERVES, and reserves change only
 * when someone trades. So between two trades the price is not unknown -- it is exactly
 * constant, and we know it. Carrying the close forward is arithmetic, not interpolation,
 * and a flat candle there is a true statement.
 *
 * A genuine gap would claim "we do not know", which is false. Compressing the axis to
 * trade-time was rejected outright: it would make three trades spread over a week look
 * identical to three trades in a minute, and "is this token alive" is the single question
 * a launchpad chart has to answer honestly.
 *
 * ⚠ This does NOT make sparse data look busy, and it is not meant to. The mitigation for
 * a sea of flat candles is the TIMEFRAME, not the fill: the same three trades that are
 * hundreds of doji at 1M are a handful of real candles at 6H. That is why the default
 * timeframe is chosen from the data span rather than pinned at 1M.
 */
export function forwardFillCandles(
  candles: Candle[],
  untilSeconds: number,
  bucketSeconds: number,
  maxCandles = 600
): Candle[] {
  if (candles.length === 0) return [];
  const sorted = [...candles].sort((a, b) => a.time - b.time);
  const start = sorted[0].time;
  const end = Math.max(untilSeconds, sorted[sorted.length - 1].time);
  const span = end - start;
  // Widen the step rather than truncate the range: a chart that silently drops its own
  // history is the same class of lie as a stale volume window.
  const step = Math.max(bucketSeconds, Math.ceil(span / maxCandles / bucketSeconds) * bucketSeconds);

  const out: Candle[] = [];
  let idx = 0;
  let last = sorted[0].open;
  for (let t = Math.floor(start / step) * step; t <= end; t += step) {
    let bucket: Candle | null = null;
    while (idx < sorted.length && sorted[idx].time < t + step) {
      const c = sorted[idx];
      bucket = bucket
        ? { time: t, open: bucket.open, high: Math.max(bucket.high, c.high), low: Math.min(bucket.low, c.low), close: c.close }
        : { time: t, open: c.open, high: c.high, low: c.low, close: c.close };
      idx++;
    }
    if (bucket) {
      out.push(bucket);
      last = bucket.close;
    } else {
      // No trade in this bucket: a flat candle at the carried price. Honest, and visually
      // quiet rather than absent.
      out.push({ time: t, open: last, high: last, low: last, close: last });
    }
  }
  return out;
}

/**
 * The finest timeframe whose filled series is not mostly empty.
 *
 * With three trades over two days, 1M produces ~2900 candles of which 3 have bodies. That
 * reads as a broken feed. Picking the first timeframe where traded buckets are a
 * meaningful share of the total shows the same data as a chart rather than as noise.
 */
export function defaultTimeframe(candles: Candle[], nowSeconds: number): TimeframeId {
  if (candles.length === 0) return "1H";
  const first = Math.min(...candles.map((c) => c.time));
  const span = Math.max(60, nowSeconds - first);
  for (const tf of TIMEFRAMES) {
    if (tf.seconds === 0) continue;
    const buckets = span / tf.seconds;
    if (buckets <= 180) return tf.id;
  }
  return "1D";
}

type CandleRow = {
  bucket: string;
  open: number | string;
  high: number | string;
  low: number | string;
  close: number | string;
  trade_count: number;
};

const BUCKET_SECONDS = 60;

/**
 * Fill every minute between the first and last point by carrying the close forward.
 *
 * Bounded by `maxPoints` so a token launched weeks ago cannot generate a series large
 * enough to stall the tab: at one point per minute a fortnight is ~20,000 points, and the
 * chart cannot show that many pixels anyway. When the bound binds, the SPACING widens
 * rather than the range shortening -- a chart that silently truncates its own history is
 * the same class of lie as a stale volume window.
 */
export function forwardFill(
  points: PricePoint[],
  untilSeconds: number,
  maxPoints = 3000
): PricePoint[] {
  if (points.length === 0) return [];
  const sorted = [...points].sort((a, b) => a.time - b.time);
  const start = sorted[0].time;
  const end = Math.max(untilSeconds, sorted[sorted.length - 1].time);

  const span = end - start;
  const step = Math.max(BUCKET_SECONDS, Math.ceil(span / maxPoints / BUCKET_SECONDS) * BUCKET_SECONDS);

  const out: PricePoint[] = [];
  let idx = 0;
  let last = sorted[0].value;
  for (let t = start; t <= end; t += step) {
    // Advance through every real point at or before this tick, so a step wider than one
    // minute still lands on the LATEST price rather than skipping trades.
    while (idx < sorted.length && sorted[idx].time <= t) {
      last = sorted[idx].value;
      idx++;
    }
    out.push({ time: t, value: last });
  }
  return out;
}

// Shared empty results. A fresh `[]` per call is a new identity per render, and PriceChart
// rebuilt its series whenever an input's identity changed.
const EMPTY_POINTS: PricePoint[] = [];
const EMPTY_CANDLES: Candle[] = [];

export type CandleResult = {
  points: PricePoint[];
  /** Raw 1-minute OHLC, unfilled. The chart aggregates and fills per timeframe. */
  candles: Candle[];
  /** Raw one-second OHLC from token_candles_1s, newest 601 non-empty buckets. */
  secondCandles: Candle[];
  /**
   * The clock the fills ran to: UNIX seconds, advanced on each second boundary.
   * PriceChart fills to the same value, so the chart and this hook read one clock.
   */
  now: number;
  /** The token has NEVER traded. The flat line is its launch price and that is the truth. */
  isFlatLaunch: boolean;
  /**
   * The token HAS traded, but none of it is chartable.
   *
   * ⚠ A DIFFERENT STATEMENT FROM isFlatLaunch, and conflating them is a lie the chart
   * tells confidently. Trades recorded before migration 004 carry no reserve snapshot, so
   * their price cannot be recovered -- re-deriving it would mean re-implementing the curve
   * math. Saying "no trades yet" about a token that has been traded is worse than saying
   * nothing, because it is checkable and wrong.
   */
  isHistoryUnchartable: boolean;
  isLoading: boolean;
  isError: boolean;
};

/**
 * @param launchPrice USDC per whole token, derived from the token's CURRENT virtual
 *   reserves. For an untraded curve those are still the launch reserves, which is what
 *   makes the flat line correct rather than invented.
 * @param createdAtSeconds when the token was created, so a flat line has a left edge.
 */
export function useCandles(
  token: Address | undefined,
  launchPrice: number | undefined,
  createdAtSeconds: number | undefined
): CandleResult {
  const ready = !!SUPABASE_URL && !!SUPABASE_ANON_KEY && !!token;

  const q = useQuery({
    queryKey: ["candles", token],
    enabled: ready,
    refetchInterval: 30_000,
    staleTime: 15_000,
    queryFn: async (): Promise<{ points: PricePoint[]; candles: Candle[]; hasTrades: boolean }> => {
      const res = await fetch(
        `${SUPABASE_URL}/rest/v1/token_candles_1m` +
          `?select=bucket,open,high,low,close,trade_count` +
          `&token_address=eq.${token}&order=bucket.asc&limit=5000`,
        {
          headers: {
            apikey: SUPABASE_ANON_KEY!,
            Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
          },
        }
      );
      if (!res.ok) throw new Error(`candles ${res.status}`);
      const rows = (await res.json()) as CandleRow[];
      // ⚠ The OHLC was ALREADY being fetched and thrown away -- the select has carried
      // open/high/low since 004 and only `close` reached the chart. Candlesticks were a
      // series change, not a data change.
      const candleRows: Candle[] = rows.map((r) => ({
        time: Math.floor(new Date(r.bucket).getTime() / 1000),
        open: Number(r.open),
        high: Number(r.high),
        low: Number(r.low),
        close: Number(r.close),
      }));

      // Whether ANY trade exists, chartable or not. One extra request, and it is what
      // separates "nobody has traded this" from "we cannot chart what happened".
      let hasTrades = rows.length > 0;
      if (!hasTrades) {
        try {
          const tr = await fetch(
            `${SUPABASE_URL}/rest/v1/trades?select=id&token_address=eq.${token}&limit=1`,
            {
              headers: {
                apikey: SUPABASE_ANON_KEY!,
                Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
              },
            }
          );
          if (tr.ok) hasTrades = ((await tr.json()) as unknown[]).length > 0;
        } catch {
          // Unknown is treated as "no trades", which is the claim we can at least
          // partially support -- the alternative invents a history.
        }
      }

      return {
        candles: candleRows,
        points: rows.map((r) => ({
          time: Math.floor(new Date(r.bucket).getTime() / 1000),
          value: Number(r.close),
        })),
        hasTrades,
      };
    },
  });

  const secondQ = useQuery({
    queryKey: ["candles-1s", token],
    enabled: ready,
    refetchInterval: 1_000,
    staleTime: 500,
    queryFn: async (): Promise<Candle[]> => {
      const res = await fetch(
        `${SUPABASE_URL}/rest/v1/token_candles_1s` +
          `?select=bucket,open,high,low,close,trade_count` +
          `&token_address=eq.${token}&order=bucket.desc&limit=601`,
        {
          headers: {
            apikey: SUPABASE_ANON_KEY!,
            Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
          },
        }
      );
      if (!res.ok) throw new Error(`one-second candles ${res.status}`);
      const rows = (await res.json()) as CandleRow[];
      return rows.reverse().map((r) => ({
        time: Math.floor(new Date(r.bucket).getTime() / 1000),
        open: Number(r.open),
        high: Number(r.high),
        low: Number(r.low),
        close: Number(r.close),
      }));
    },
  });

  // ⚠ ONE SHARED CLOCK AND A MEMOISED RESULT. This read Date.now() and built fresh arrays on
  // every call, so PriceChart got new inputs on every render of the page -- and rebuilt the
  // whole chart for them. The result now changes only when the data, the launch price or the
  // second changes. See CLAUDE.md §23.
  const now = useSecondClock();
  const { data } = q;
  const isLoading = q.isLoading || secondQ.isLoading;
  const isError = q.isError || secondQ.isError;

  return useMemo((): CandleResult => {
    const traded = data?.points ?? EMPTY_POINTS;
    const hasTrades = data?.hasTrades ?? false;

    // ⚠ A TOKEN WITH NO TRADES STILL HAS A PRICE, and this is the case that matters most:
    // it is EVERY brand-new token, which is exactly when a creator and their first buyers
    // are looking. An empty panel there reads as a broken product at the moment of highest
    // scrutiny. The curve defines a price from its opening reserves whether or not anyone
    // has traded, so the honest render is a flat line from creation to now.
    if (traded.length === 0) {
      if (launchPrice === undefined || createdAtSeconds === undefined) {
        return {
          candles: EMPTY_CANDLES,
          secondCandles: EMPTY_CANDLES,
          points: EMPTY_POINTS,
          isFlatLaunch: false,
          isHistoryUnchartable: false,
          isLoading,
          isError,
          now,
        };
      }
      return {
        candles: EMPTY_CANDLES,
        secondCandles: EMPTY_CANDLES,
        points: forwardFill([{ time: createdAtSeconds, value: launchPrice }], now),
        isFlatLaunch: !hasTrades,
        isHistoryUnchartable: hasTrades,
        isLoading,
        isError,
        now,
      };
    }

    // Anchor the series at creation so the first trade is visibly a MOVE from the launch
    // price rather than the chart's origin. Without this, a token's first buy looks like
    // its starting point and the opening move is invisible.
    const seeded =
      createdAtSeconds !== undefined && launchPrice !== undefined && createdAtSeconds < traded[0].time
        ? [{ time: createdAtSeconds, value: launchPrice }, ...traded]
        : traded;

    return {
      candles: data?.candles ?? EMPTY_CANDLES,
      secondCandles: secondQ.data ?? EMPTY_CANDLES,
      points: forwardFill(seeded, now),
      isFlatLaunch: false,
      isHistoryUnchartable: false,
      isLoading,
      isError,
      now,
    };
  }, [data, secondQ.data, isLoading, isError, launchPrice, createdAtSeconds, now]);
}
