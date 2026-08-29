// Formatting. One place, because the 18-vs-6 split is the trap that keeps recurring.
//
// TRAP 4. Launch tokens are 18 decimals; USDC is 6. "USDC is 6 decimals" is a standing
// rule in CLAUDE.md and `6` is scattered through the old frontend, so 6 is the number
// that comes to hand -- and passing it where 18 belongs renders a balance a TRILLION
// times too large. Both decimal figures were read off the chain, not inferred.
//
// Every function here names the unit it takes. `usdc6`, `token18`. A bare `format(v)`
// would reintroduce exactly the ambiguity this file exists to remove.

import { formatUnits } from "viem";
import { LAUNCH_TOKEN_DECIMALS, USDC_ERC20_DECIMALS } from "../chain";

/** USDC, from 6dp base units. */
export function fmtUsdc(usdc6: bigint, dp = 2): string {
  const n = Number(formatUnits(usdc6, USDC_ERC20_DECIMALS));
  return n.toLocaleString(undefined, { minimumFractionDigits: dp, maximumFractionDigits: dp });
}

/** USDC with a $ and adaptive precision, for headline figures. */
export function fmtUsd(usdc6: bigint): string {
  const n = Number(formatUnits(usdc6, USDC_ERC20_DECIMALS));
  if (n === 0) return "$0";
  if (n < 0.01) return `$${n.toFixed(6)}`;
  if (n < 1000) return `$${n.toFixed(2)}`;
  return `$${compact(n)}`;
}

/** A launch token balance, from 18dp base units. */
export function fmtToken(token18: bigint, dp = 4): string {
  const n = Number(formatUnits(token18, LAUNCH_TOKEN_DECIMALS));
  if (n === 0) return "0";
  if (n >= 1000) return compact(n);
  return n.toLocaleString(undefined, { maximumFractionDigits: dp });
}

function compact(n: number): string {
  if (n >= 1e12) return `${(n / 1e12).toFixed(2)}T`;
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(2)}K`;
  return n.toFixed(2);
}

export function fmtPct(pct: number, dp = 2): string {
  return `${pct.toFixed(dp)}%`;
}

export function fmtBps(bps: number): string {
  return `${(bps / 100).toFixed(bps % 100 === 0 ? 0 : 2)}%`;
}

export function shortAddress(addr: string): string {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

/**
 * Relative age from an ISO string or epoch seconds.
 *
 * Uses wall-clock difference for DISPLAY only. Ordering anywhere in this app must use
 * blockNumber then logIndex, never timestamps (trap 13): Arc's sub-second blocks share
 * timestamps, so timestamp ordering silently produces out-of-order trades.
 */
export function relativeAge(when: string | number | bigint): string {
  const then =
    typeof when === "string" ? new Date(when).getTime() : Number(when) * 1000;
  const secs = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (secs < 60) return `${secs}s`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h`;
  return `${Math.floor(secs / 86400)}d`;
}

/**
 * Sanitises a symbol or name for display.
 *
 * `createToken` validates NOTHING -- no length check, no emptiness check, on either field
 * (rule 9). So a symbol can be empty, 200 characters, or full of RTL overrides and
 * combining marks that break layout or spoof another token. Phase 6 tests exactly this.
 *
 * Bidirectional control characters are stripped rather than escaped: they are invisible
 * and their entire purpose here would be to make one token render as another.
 */
export function safeText(s: string | null | undefined, maxLen = 64): string {
  if (!s) return "";
  const stripped = s.replace(/[‪-‮⁦-⁩‎‏]/g, "");
  const collapsed = stripped.replace(/\s+/g, " ").trim();
  return collapsed.length > maxLen ? `${collapsed.slice(0, maxLen)}…` : collapsed;
}
