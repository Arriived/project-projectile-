// Locale-aware number formatting.
//
// ── TWO AXES, DELIBERATELY SEPARATE ───────────────────────────────────────────
//
// 1. COMPACT vs EXACT (A7). Compact notation is for display estimates only. A number the
//    user ACTS ON -- the slippage floor, the amount they typed, the settled amount, the
//    gas reserve -- must be exact, because a rounded version of a floor is a number the
//    contract will not honour. `168.27M` is a fine market cap and a lie as a minimum
//    received. Every function below says which it is in its NAME; there is no shared
//    entry point where the caller can forget.
//
// 2. NO CURRENCY STYLE (A6). Every figure on this site is USDC, not dollars. Intl's
//    `style: "currency", currency: "USD"` renders `$2.48K` in English and `US$2480` in
//    zh-Hans -- and neither is accurate, because the contract holds USDC and on Arc it is
//    also the gas token. So: plain locale-aware number formatting, and the caller appends
//    an explicit USDC label. The unit is not a currency symbol's job here.
//
// ── WHY Intl AT ALL ───────────────────────────────────────────────────────────
//
// Measured with full ICU. Plain thousands grouping is IDENTICAL in all three locales
// (123,456,789 everywhere), so the myriad system is a COMPACT-notation phenomenon:
//
//   en 1.23K / 123.46M / 1.23T   zh 1234 / 1.23亿 / 1.23万亿   ko 1.23천 / 1.23억 / 1.23조
//
// zh has no unit below 万, so 1234 stays "1234" where English says "1.23K". A hand-rolled
// K/M/B/T ladder is therefore wrong in two of the three configured locales.

import { formatUnits } from "viem";
import { INTL_TAG, type Locale } from "./locales.ts";
// Explicit .ts extensions: Vite resolves either form, Node's ESM resolver does not, and
// these modules are imported directly by scripts/ under --experimental-strip-types.
import { LAUNCH_TOKEN_DECIMALS, USDC_ERC20_DECIMALS } from "../chain.ts";

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

/** Threshold below which compact notation is pointless. */
const COMPACT_FLOOR = 1000;

/**
 * Below this, USDC renders in full rather than compacted.
 *
 * 10,000 rather than COMPACT_FLOOR's 1,000, because compact notation was destroying the
 * only differences that existed. Measured on live data: four tokens with market caps of
 * 2002.11, 2002.40, 2002.40 and 2002.11 USDC all rendered as "2K", so a grid of cards
 * claimed four identical tokens when they were not. 9,999 rendered as "10K".
 *
 * A launch curve opens around 2,000 USDC, so the entire early life of every token sits
 * inside the band compact notation flattens -- which is exactly the band a trader is
 * scanning. Above 10K the compaction earns its place.
 *
 * Note this also agrees with zh-Hans, which has no unit below 万 (10,000) and therefore
 * renders these values in full anyway.
 */
const USDC_COMPACT_FLOOR = 10_000;

// ── EXACT: for numbers the user acts on ────────────────────────────────────────

/**
 * USDC, exact, never compacted. 6 decimals.
 *
 * `dp` defaults to 2 for readability, but a caller showing a floor or a reserve should
 * pass enough digits to represent it honestly -- rounding a minimum-received DOWN is safe,
 * rounding it UP would display a floor the contract will not meet.
 */
export function formatUsdcExact(locale: Locale, usdc6: bigint, dp = 2): string {
  return nf(locale, { minimumFractionDigits: dp, maximumFractionDigits: dp }).format(
    Number(formatUnits(usdc6, USDC_ERC20_DECIMALS))
  );
}

/**
 * A launch token, exact, never compacted. 18 decimals -- never 6 (trap 4).
 *
 * Launch balances are enormous (a real holder in R15 held 471 trillion), so full
 * precision to 18dp would be unreadable AND misleading about what matters. Grouped to a
 * whole number with up to 4 decimals: exact in the sense that matters -- no order of
 * magnitude is hidden behind a "M" or a "亿".
 */
export function formatTokenExact(locale: Locale, token18: bigint): string {
  return nf(locale, { maximumFractionDigits: 4 }).format(
    Number(formatUnits(token18, LAUNCH_TOKEN_DECIMALS))
  );
}

// ── COMPACT: display estimates only ────────────────────────────────────────────

/** USDC as a headline display figure. Compact above 1000. NOT for anything acted on. */
export function formatUsdcCompact(locale: Locale, usdc6: bigint): string {
  const n = Number(formatUnits(usdc6, USDC_ERC20_DECIMALS));
  if (n === 0) return nf(locale, { maximumFractionDigits: 2 }).format(0);
  // Sub-cent values need real digits: a launch price is ~0.0000025 USDC and "0.00" is a
  // lie about a token that costs something.
  if (Math.abs(n) < 0.01) {
    return nf(locale, { minimumFractionDigits: 2, maximumFractionDigits: 8 }).format(n);
  }
  if (Math.abs(n) < USDC_COMPACT_FLOOR) {
    return nf(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n);
  }
  return nf(locale, { notation: "compact", maximumFractionDigits: 2 }).format(n);
}

/** A launch token as a display figure. Compact above 1000. NOT for anything acted on. */
export function formatTokenCompact(locale: Locale, token18: bigint): string {
  const n = Number(formatUnits(token18, LAUNCH_TOKEN_DECIMALS));
  if (n === 0) return nf(locale, {}).format(0);
  if (Math.abs(n) < COMPACT_FLOOR) return nf(locale, { maximumFractionDigits: 4 }).format(n);
  return nf(locale, { notation: "compact", maximumFractionDigits: 2 }).format(n);
}

// ── percentages and time ───────────────────────────────────────────────────────

export function formatPct(locale: Locale, pct: number, dp = 2): string {
  return nf(locale, {
    style: "percent",
    minimumFractionDigits: dp,
    maximumFractionDigits: dp,
  }).format(pct / 100);
}

export function formatBps(locale: Locale, bps: number): string {
  return formatPct(locale, bps / 100, bps % 100 === 0 ? 0 : 2);
}

/**
 * Relative age, for DISPLAY only.
 *
 * Ordering anywhere in this app uses blockNumber then logIndex, never timestamps
 * (trap 13): Arc's sub-second blocks share timestamps.
 */
export function formatAge(locale: Locale, when: string | number | bigint): string {
  const then = typeof when === "string" ? new Date(when).getTime() : Number(when) * 1000;
  const secs = Math.max(0, Math.floor((Date.now() - then) / 1000));
  // numeric: "always", NOT "auto". They differ in exactly one case that matters here:
  // "auto" renders -1 day as "yesterday" instead of "1d ago", which is how a launchpad
  // ends up showing a token age as prose. Every other step already read correctly.
  const rtf = new Intl.RelativeTimeFormat(INTL_TAG[locale], { numeric: "always", style: "narrow" });
  if (secs < 60) return rtf.format(-secs, "second");
  if (secs < 3600) return rtf.format(-Math.floor(secs / 60), "minute");
  if (secs < 86400) return rtf.format(-Math.floor(secs / 3600), "hour");
  return rtf.format(-Math.floor(secs / 86400), "day");
}

/**
 * A file size, for DISPLAY only.
 *
 * Binary units (KiB steps) because that is what a size cap is expressed in and what an
 * operating system's file dialog shows, so a creator comparing our message against their
 * own file listing sees the same number rather than a 5% discrepancy they cannot explain.
 *
 * Locale-aware via `nf` like every other figure here: the decimal separator differs, and
 * a hand-rolled `toFixed(1)` would render "1.5 MB" to a reader expecting "1,5 MB".
 */
export function formatBytes(locale: Locale, bytes: number): string {
  const units = ["B", "KB", "MB", "GB"];
  let n = Math.max(0, bytes);
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  // Whole bytes never want a decimal; everything above does, but only one.
  const dp = i === 0 ? 0 : n < 10 ? 1 : 0;
  return `${nf(locale, { minimumFractionDigits: dp, maximumFractionDigits: dp }).format(n)} ${units[i]}`;
}
