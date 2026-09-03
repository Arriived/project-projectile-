// Slippage tolerance: presets, bounds, and the two thresholds.
//
// Pure. Feeds `minOutFromQuote` in lib/quotes.ts unchanged -- this module decides the
// tolerance, it does not touch quote math. Quotes still come from `quoteBuy`/`quoteSell`
// on the contract (CLAUDE.md §1.3) and nothing here re-derives any of it.

/** Basis points. 100 = 1%. */
export const SLIPPAGE_PRESETS_BPS = [50n, 100n, 200n, 500n] as const;

export const DEFAULT_SLIPPAGE_BPS = 100n; // 1%, the value that was hardcoded before this.

/**
 * ⚠ WARN ABOVE 5%.
 *
 * 5% is the highest preset, so crossing it is the moment the user leaves the range the
 * interface vouches for. It is also already loose for this curve: a $500 buy at launch
 * moves the price ~18.55% (CLAUDE.md §11.4), so 5% tolerance on a normal-sized trade is
 * well beyond ordinary execution noise and is only reached deliberately.
 *
 * A warning, not a block: a user racing a launch may genuinely want it, and an interface
 * stricter than the contract is the failure mode §11.14 records for the symbol-length rule.
 */
export const SLIPPAGE_WARN_ABOVE_BPS = 500n; // 5%

/**
 * ⚠ REFUSE ABOVE 50%.
 *
 * At more than 50% the floor accepts less than half the quoted output, which is not a
 * slippage tolerance any more -- it is "accept any price" wearing a number. That state is
 * already explicitly forbidden one layer down: `minOutFromQuote` refuses to return zero
 * (lib/quotes.ts) precisely because `minOut = 0` hands the trade an unbounded downside on
 * a curve this thin.
 *
 * The bonding curve is what makes it worse than on a normal AMM. During the snipe window
 * the tax runs to 9800 bps and the published table decays per SECOND, so the output a
 * quote promises and the output a transaction gets can differ enormously inside one block.
 * A >50% floor during that window is a transaction the contract will execute happily and
 * the user cannot afford.
 *
 * 50% is deliberately far above any legitimate need rather than tuned: the aim is to stop
 * a typo (a stray zero turning 5 into 50, or 500) and a copied-from-somewhere setting,
 * not to second-guess a trader inside the sanctioned range.
 */
export const SLIPPAGE_MAX_BPS = 5_000n; // 50%

export type SlippageIssue =
  | { kind: "empty" }
  | { kind: "notANumber" }
  | { kind: "negative" }
  | { kind: "tooHigh"; maxPct: number } // refused
  | { kind: "high"; pct: number }; // warned, still usable

/** Whether an issue blocks the trade, as opposed to advising against it. */
export function slippageBlocks(issue: SlippageIssue | null): boolean {
  return issue !== null && issue.kind !== "high";
}

/**
 * Whether this tolerance needs an explicit acknowledgement before a trade can be sent.
 *
 * ⚠ A PASSIVE WARNING IS THE WRONG INSTRUMENT FOR A 10x TYPO. Fixing the ceiling to
 * refuse at 50% closes one boundary, but the band below it still reaches values nobody
 * types on purpose, and a message rendered beside a still-enabled button is exactly what
 * a user in a hurry clicks past. Above the warn threshold the user now has to say so.
 *
 * Deliberately NOT a second refusal: a creator racing a launch may genuinely want 8%, and
 * an interface stricter than the contract is the failure recorded for the symbol-length
 * rule. The cost is one extra interaction on a rare deliberate case, against a silent
 * mis-fill on a common accidental one.
 */
export function requiresAcknowledgement(bps: bigint): boolean {
  return bps > SLIPPAGE_WARN_ABOVE_BPS;
}

/**
 * Parse a custom percentage into basis points.
 *
 * Returns bps when usable (INCLUDING when it merely warns) and null when refused, so a
 * caller cannot accidentally trade on a refused value: there is no number to reach for.
 */
export function parseSlippagePct(raw: string): { bps: bigint | null; issue: SlippageIssue | null } {
  const s = raw.trim();
  if (!s) return { bps: null, issue: { kind: "empty" } };

  // Accept a comma decimal separator: half the configured locales type it that way, and
  // rejecting it would read as "your number is invalid" for a correctly-typed number.
  const n = Number(s.replace(",", "."));
  if (!Number.isFinite(n)) return { bps: null, issue: { kind: "notANumber" } };
  if (n < 0) return { bps: null, issue: { kind: "negative" } };

  // Round to the nearest bp. 0.005% and finer is below what the contract can express.
  const bps = BigInt(Math.round(n * 100));

  // ⚠ >=, NOT >. The ceiling was justified as "stop a stray zero -- 5 becomes 50",
  // and with a strict > the value 50 itself was PERMITTED: the exact typo the ceiling
  // existed to catch went through with only a passive warning. Nothing legitimate needs
  // exactly 50%, and by this module's own reasoning 50% is already the point where the
  // floor stops meaning anything. The boundary now matches the justification.
  if (bps >= SLIPPAGE_MAX_BPS) {
    return { bps: null, issue: { kind: "tooHigh", maxPct: Number(SLIPPAGE_MAX_BPS) / 100 } };
  }
  // Zero is allowed through as a value but is hostile in practice -- it demands the exact
  // quoted output and reverts on any movement. Treated as usable rather than refused
  // because it fails SAFELY (the trade reverts; nothing is lost but gas).
  if (bps > SLIPPAGE_WARN_ABOVE_BPS) {
    return { bps, issue: { kind: "high", pct: Number(bps) / 100 } };
  }
  return { bps, issue: null };
}

export function bpsToPctLabel(bps: bigint): string {
  const pct = Number(bps) / 100;
  return Number.isInteger(pct) ? `${pct}%` : `${pct}%`;
}

// ── persistence ───────────────────────────────────────────────────────────────
//
// ⚠ sessionStorage, NOT localStorage, and that is the whole decision.
//
// The brief allows persisting across navigations within a session and requires saying so
// before persisting across a browser restart. sessionStorage is exactly that line: it
// survives every in-app navigation and every reload of the tab, and is gone when the tab
// closes. So a user who set 5% to chase one launch does not find it silently still set
// tomorrow, which is the case where a forgotten setting costs money.
//
// It also fails safe when unavailable (private mode, storage disabled): every access is
// wrapped, and a failure yields the 1% default rather than throwing.

const STORAGE_KEY = "ballista.slippageBps";

export function loadSlippageBps(): bigint {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_SLIPPAGE_BPS;
    const v = BigInt(raw);
    // A stored value outside bounds is discarded, not clamped: it can only come from
    // tampering or a version skew, and silently trading on a repaired value is worse than
    // reverting to the default.
    if (v < 0n || v >= SLIPPAGE_MAX_BPS) return DEFAULT_SLIPPAGE_BPS;
    return v;
  } catch {
    return DEFAULT_SLIPPAGE_BPS;
  }
}

export function saveSlippageBps(bps: bigint): void {
  try {
    sessionStorage.setItem(STORAGE_KEY, bps.toString());
  } catch {
    /* storage unavailable; the choice simply does not persist */
  }
}
