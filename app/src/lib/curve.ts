// Curve state and progress.
//
// TRAP 8 lives here: sells are closed in GRADUATION_READY, not only in GRADUATED. Gating
// on a boolean `graduated` flag leaves a live-looking Sell button on a curve that will
// revert, which is the shape rule 1.4 exists to prevent -- both sides close the instant
// the trigger fires, so nobody can sell into the reserves the pool is about to be seeded
// from.

/** Mirrors `enum CurveState { ACTIVE, GRADUATION_READY, GRADUATED }` in LFX1.sol. */
export const CurveState = {
  ACTIVE: 0,
  GRADUATION_READY: 1,
  GRADUATED: 2,
} as const;

export type CurveStateValue = (typeof CurveState)[keyof typeof CurveState];

export type TradeGate =
  | { canBuy: true; canSell: true; reason: null }
  | { canBuy: false; canSell: false; reason: string };

/**
 * What the user may do, and if nothing, WHY.
 *
 * The reason string is not decoration. A curve parked at GRADUATION_READY has reserves
 * intact and is retryable, but both sides are closed -- a user who is simply told "no"
 * assumes the site is broken or their funds are gone. Rule 1.4 accepts that holders
 * genuinely cannot exit in this state; the least we owe them is an explanation.
 */
export function tradeGate(state: number): TradeGate {
  switch (state) {
    case CurveState.ACTIVE:
      return { canBuy: true, canSell: true, reason: null };
    case CurveState.GRADUATION_READY:
      return {
        canBuy: false,
        canSell: false,
        reason:
          "This curve has hit its graduation threshold and is awaiting graduation. Buying and selling are both closed until it completes — reserves are intact and the move to the pool is permissionless, so anyone can trigger it.",
      };
    case CurveState.GRADUATED:
      return {
        canBuy: false,
        canSell: false,
        reason: "This token has graduated. Trading has moved to the DEX pool.",
      };
    default:
      // Fail closed on a state we do not recognise rather than assuming it is tradable.
      return {
        canBuy: false,
        canSell: false,
        reason: `Unrecognised curve state (${state}). Trading is disabled as a precaution.`,
      };
  }
}

/**
 * Progress toward graduation, in basis points, clamped to [0, 10000].
 *
 * Computed from `realUsdcReserves` against the per-curve threshold, both read from the
 * chain -- never from the indexer, whose reserve fields arrive as truncated JSON numbers
 * (trap 21).
 *
 * `poolBoost` is deliberately NOT counted. It is added to the pool's USDC side at
 * graduation but must never count toward the threshold (CLAUDE.md §7A), and showing a
 * progress bar that includes it would promise a graduation that is further away than it
 * looks.
 */
export function graduationProgressBps(realUsdcReserves: bigint, threshold: bigint): number {
  if (threshold === 0n) return 10_000;
  if (realUsdcReserves >= threshold) return 10_000;
  const bps = (realUsdcReserves * 10_000n) / threshold;
  return Number(bps);
}
