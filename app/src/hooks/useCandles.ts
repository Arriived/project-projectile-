// Candles for the price chart.
//
// ── THE PRICE IS THE CURVE'S MID, NEVER THE EXECUTION PRICE ──────────────────
//
// `token_candles_1m` derives price from `virtual_usdc_reserves / virtual_token_reserves`
// per trade (migration 004). It must never be swapped for `usdc_amount / token_amount`.
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

import { useQuery } from "@tanstack/react-query";
import type { Address } from "viem";
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "../config";

/** A lightweight-charts line point. `time` is a UNIX second. */
export type PricePoint = { time: number; value: number };

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

export type CandleResult = {
  points: PricePoint[];
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
    queryFn: async (): Promise<{ points: PricePoint[]; hasTrades: boolean }> => {
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
        points: rows.map((r) => ({
          time: Math.floor(new Date(r.bucket).getTime() / 1000),
          value: Number(r.close),
        })),
        hasTrades,
      };
    },
  });

  const now = Math.floor(Date.now() / 1000);
  const traded = q.data?.points ?? [];
  const hasTrades = q.data?.hasTrades ?? false;

  // ⚠ A TOKEN WITH NO TRADES STILL HAS A PRICE, and this is the case that matters most:
  // it is EVERY brand-new token, which is exactly when a creator and their first buyers
  // are looking. An empty panel there reads as a broken product at the moment of highest
  // scrutiny. The curve defines a price from its opening reserves whether or not anyone
  // has traded, so the honest render is a flat line from creation to now.
  if (traded.length === 0) {
    if (launchPrice === undefined || createdAtSeconds === undefined) {
      return {
        points: [],
        isFlatLaunch: false,
        isHistoryUnchartable: false,
        isLoading: q.isLoading,
        isError: q.isError,
      };
    }
    return {
      points: forwardFill([{ time: createdAtSeconds, value: launchPrice }], now),
      isFlatLaunch: !hasTrades,
      isHistoryUnchartable: hasTrades,
      isLoading: q.isLoading,
      isError: q.isError,
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
    points: forwardFill(seeded, now),
    isFlatLaunch: false,
    isHistoryUnchartable: false,
    isLoading: q.isLoading,
    isError: q.isError,
  };
}
