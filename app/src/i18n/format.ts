// Locale-aware number, currency and date formatting.
//
// ── WHY THIS IS NOT "TRANSLATED STRINGS PLUS toFixed()" ───────────────────────
//
// Measured with Node's full-ICU, not recalled:
//
//   plain grouping   en 123,456,789  |  zh 123,456,789  |  ko 123,456,789
//   COMPACT          en 1.23K        |  zh 1234         |  ko 1.23천
//                    en 123.46M      |  zh 1.23亿       |  ko 1.23억
//                    en 1.23T        |  zh 1.23万亿     |  ko 1.23조
//
// Two things fall out of that. Plain thousands grouping is the SAME in all three, so the
// common belief that Chinese groups by 万 in ordinary numbers is wrong -- it is compact
// notation where the myriad system appears. And compact notation differs so much that a
// hand-rolled K/M/B/T ladder (which this file replaces) is simply wrong in zh and ko:
// zh has no unit at all below 万, so 1234 renders as "1234" where English says "1.23K".
//
// Intl handles all of it. Nothing here re-implements grouping.
//
// Amounts are passed as BIGINT base units with their decimals, never as pre-formatted
// strings, so each locale renders from the raw value.

import { formatUnits } from "viem";
import { INTL_TAG, type Locale } from "./locales.ts";
// Explicit .ts extensions: Vite resolves either form, but Node's ESM resolver does not,
// and these modules are imported directly by scripts/ under --experimental-strip-types.
// Keeping them node-resolvable is what makes the formatting layer testable without a
// bundler -- the same lesson that split lib/arcGuard.ts out of its React hook.
import { LAUNCH_TOKEN_DECIMALS, USDC_ERC20_DECIMALS } from "../chain.ts";

// Intl formatters are expensive to construct and are reused per (locale, options) pair.
const cache = new Map<string, Intl.NumberFormat>();
function nf(locale: Locale, opts: Intl.NumberFormatOptions): Intl.NumberFormat {
  const key = `${locale}|${JSON.stringify(opts)}`;
  let f = cache.get(key);
  if (!f) {
    f = new Intl.NumberFormat(INTL_TAG[locale], opts);
    cache.set(key, f);
  }
  return f;
}

/**
 * Number -> string. `bigint` base units are converted through viem's formatUnits first so
 * the decimal placement is exact, then handed to Intl as a Number for presentation only.
 *
 * The Number conversion loses precision above 2^53, which is fine HERE because this is
 * the display layer: every value the user acts on is kept as bigint right up to the point
 * it is rendered. That boundary is deliberate and is the reason this function takes base
 * units rather than a pre-divided float.
 */
function toNumber(base: bigint, decimals: number): number {
  return Number(formatUnits(base, decimals));
}

export function formatUsdc(locale: Locale, usdc6: bigint, dp = 2): string {
  return nf(locale, { minimumFractionDigits: dp, maximumFractionDigits: dp }).format(
    toNumber(usdc6, USDC_ERC20_DECIMALS)
  );
}

/**
 * A headline USD figure. Compact above 1000 so a market cap fits on one line -- and
 * compact is exactly where the locale difference lives, so this must go through Intl.
 */
export function formatUsd(locale: Locale, usdc6: bigint): string {
  const n = toNumber(usdc6, USDC_ERC20_DECIMALS);
  if (n === 0) return nf(locale, { style: "currency", currency: "USD" }).format(0);
  // Sub-cent values need real digits, not "$0.00" -- launch prices are ~0.0000025 USDC.
  if (Math.abs(n) < 0.01) {
    return nf(locale, {
      style: "currency",
      currency: "USD",
      minimumFractionDigits: 2,
      maximumFractionDigits: 8,
    }).format(n);
  }
  if (Math.abs(n) < 1000) {
    return nf(locale, { style: "currency", currency: "USD" }).format(n);
  }
  return nf(locale, {
    style: "currency",
    currency: "USD",
    notation: "compact",
    maximumFractionDigits: 2,
  }).format(n);
}

/** A launch-token balance. 18 decimals -- never 6 (trap 4). */
export function formatToken(locale: Locale, token18: bigint): string {
  const n = toNumber(token18, LAUNCH_TOKEN_DECIMALS);
  if (n === 0) return nf(locale, {}).format(0);
  if (Math.abs(n) < 1000) return nf(locale, { maximumFractionDigits: 4 }).format(n);
  return nf(locale, { notation: "compact", maximumFractionDigits: 2 }).format(n);
}

/** A percentage. `pct` is already a percentage (15.65 means 15.65%). */
export function formatPct(locale: Locale, pct: number, dp = 2): string {
  return nf(locale, {
    style: "percent",
    minimumFractionDigits: dp,
    maximumFractionDigits: dp,
  }).format(pct / 100);
}

/** Basis points as a percentage. 100 bps -> 1%. */
export function formatBps(locale: Locale, bps: number): string {
  return formatPct(locale, bps / 100, bps % 100 === 0 ? 0 : 2);
}

/**
 * Relative age, for DISPLAY only.
 *
 * Ordering anywhere in this app uses blockNumber then logIndex, never timestamps
 * (trap 13): Arc's sub-second blocks share timestamps, so timestamp ordering silently
 * produces out-of-order trades.
 */
export function formatAge(locale: Locale, when: string | number | bigint): string {
  const then = typeof when === "string" ? new Date(when).getTime() : Number(when) * 1000;
  const secs = Math.max(0, Math.floor((Date.now() - then) / 1000));
  const rtf = new Intl.RelativeTimeFormat(INTL_TAG[locale], { numeric: "auto", style: "narrow" });
  if (secs < 60) return rtf.format(-secs, "second");
  if (secs < 3600) return rtf.format(-Math.floor(secs / 60), "minute");
  if (secs < 86400) return rtf.format(-Math.floor(secs / 3600), "hour");
  return rtf.format(-Math.floor(secs / 86400), "day");
}
