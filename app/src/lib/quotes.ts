// Quote handling. The arithmetic here is only the parts the CONTRACT does not do.
//
// ── TRAP 1: NEVER RE-DERIVE THE CURVE ─────────────────────────────────────────
//
// There is no curve math in this file and there must never be. The deleted JS
// re-implementation took `buyFeeBps` and had NO snipe-tax parameter, while buy() charges
// `c.buyFeeBps + taxBps`. Measured against the live deployment it OVERSTATED tokens
// received by 98.96x at t=0, 11x at t=1, 5.2x at t=2. Overstating is the dangerous
// direction: minTokensOut is derived from the quote, so the floor sat ~97x above anything
// achievable and EVERY buy in the opening seconds would have reverted.
//
// `quoteBuy` and `quoteSell` are view functions ON the contract. They apply the live tax,
// the partial-fill clamp and current reserves, and cannot drift, because they are the
// contract.

/** Shape returned by `quoteBuy(token, usdcIn)`. */
export type BuyQuote = {
  tokensOut: bigint;
  newVirtualUsdc: bigint;
  newVirtualToken: bigint;
  actualUsdcIn: bigint;
  actualFee: bigint;
};

/** Shape returned by `quoteSell(token, tokensIn)`. */
export type SellQuote = {
  actualTokensIn: bigint;
  newVirtualUsdc: bigint;
  newVirtualToken: bigint;
  usdcOutGross: bigint;
  fee: bigint;
};

/**
 * TRAP 2. `quoteSell` returns GROSS and FEE separately; `sell()` compares `minUsdcOut`
 * against the NET figure. Quoting gross sets an unreachable floor and reverts every sell.
 *
 * This function exists so the subtraction happens in exactly one place with the reason
 * attached, rather than being open-coded at each call site where one omission is silent.
 */
export function sellNetOut(q: SellQuote): bigint {
  return q.usdcOutGross - q.fee;
}

/**
 * TRAP 5. Minimum-received: slippage applied to the QUOTE'S OWN output, never to a figure
 * derived from what the user offered. Never zero.
 *
 * The subtlety, and it is the whole trap. `quoteBuy` returns `tokensOut` paired with
 * `actualUsdcIn` -- and when the partial-fill clamp binds, `actualUsdcIn` is LESS than the
 * amount offered and `tokensOut` is already the clamped output. So the quote has done the
 * clamping for you.
 *
 * The wrong implementation is to take the rate and multiply it back up by the offered
 * amount, on the assumption the whole order fills. Near graduation it does not: the curve
 * fills what it has, the contract delivers the smaller amount, and a floor built from the
 * full offer cannot be met. A trade that should have partially settled reverts instead --
 * and it reverts precisely on the buys that would have completed a graduation.
 *
 * `minOutForOfferedAmount` below is that wrong version, kept only so the test can show
 * this one is not it.
 *
 * Zero is never returned. `minOut = 0` is "accept any price", which on a curve this thin
 * -- a $500 buy takes ~21% of supply -- is how a user gets a number they would never have
 * agreed to.
 */
export function minOutFromQuote(quotedOut: bigint, slippageBps: bigint): bigint {
  if (quotedOut === 0n) return 0n;
  const withSlippage = (quotedOut * (10_000n - slippageBps)) / 10_000n;
  // Never zero for a real quote: one unit is still a floor, and it is what stops
  // "accept anything" from being submitted on the user's behalf.
  return withSlippage > 0n ? withSlippage : 1n;
}

/**
 * The WRONG way, exported only so a test can demonstrate the difference.
 *
 * Scales the quoted rate up to the full offered amount, which over-states the floor
 * whenever the clamp binds. Never call this from application code.
 */
export function minOutForOfferedAmount(
  quotedOut: bigint,
  actualIn: bigint,
  offeredIn: bigint,
  slippageBps: bigint
): bigint {
  if (quotedOut === 0n || actualIn === 0n) return 0n;
  const scaledToFullOffer = (quotedOut * offeredIn) / actualIn;
  return (scaledToFullOffer * (10_000n - slippageBps)) / 10_000n;
}

/**
 * TRAP 3. Price impact from a PROBE QUOTE, never from `currentPrice()`.
 *
 * `currentPrice()` returns `virtualUsdcReserves * 1e18 / virtualTokenReserves`, which at
 * launch scale evaluates to the integer **2**. Any impact derived from it rounds to
 * 0.00%, so the headline number the page is required to show would silently read zero on
 * a curve where a $500 buy moves the price ~20%. Measured, not reasoned about.
 *
 * The sanctioned method compares the rate this trade gets against the rate a negligible
 * trade gets, both from `quoteBuy`, in tokens-per-USDC where the magnitudes are large
 * enough to keep precision.
 *
 * @returns percent, or null when it cannot be computed honestly
 */
export function impactPct(
  quotedOut: bigint,
  quotedIn: bigint,
  probeOut: bigint,
  probeIn: bigint
): number | null {
  if (quotedOut === 0n || quotedIn === 0n) return null;
  if (probeOut === 0n || probeIn === 0n) return null;
  const marginal = (probeOut * 1_000_000n) / probeIn;
  const effective = (quotedOut * 1_000_000n) / quotedIn;
  if (marginal === 0n) return null;
  if (effective >= marginal) return 0;
  return Number(((marginal - effective) * 10_000n) / marginal) / 100;
}

/** 0.01 USDC — small enough to read as the marginal rate, large enough to keep precision. */
export const IMPACT_PROBE_USDC6 = 10_000n;

/**
 * TRAP 6. Did the trade settle at the quoted amount?
 *
 * The snipe tax decays per second and the clamp can bind between quote and execution, so
 * the received amount can differ from the quote. The page must show what the RECEIPT
 * says, never the quote, and this makes the divergence explicit rather than silently
 * papering over it.
 */
export function quoteDivergencePct(quoted: bigint, actual: bigint): number | null {
  if (quoted === 0n) return null;
  const diff = actual > quoted ? actual - quoted : quoted - actual;
  return Number((diff * 10_000n) / quoted) / 100;
}
