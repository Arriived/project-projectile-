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
 * TRAP 3 + A2. Price impact from a PROBE QUOTE, never from `currentPrice()`.
 *
 * ── WHICH DEFINITION, AND WHY ─────────────────────────────────────────────────
 *
 * The probe method yields ONE ratio (marginal rate / effective rate) and the formula
 * chooses which side of it to report. For the same $500 buy, measured live:
 *
 *   token shortfall  1 - (trade rate / probe rate) = 15.65%
 *   PRICE MOVE       (probe rate / trade rate) - 1 = 18.55%
 *
 * They are exact reciprocals, not two measurements. (A third number, 20.9%, circulates in
 * CLAUDE.md §1.3 -- that is the SHARE OF CURVE SUPPLY the trade consumes, not an impact
 * figure at all, and must not be confused with either.)
 *
 * This returns PRICE MOVE. Three reasons, in order of weight:
 *
 *  1. The safer misreading. If a user reads 15.65% as "the price moved 15.65%" they
 *     UNDERSTATE their cost. If they read 18.55% as "I get 18.55% fewer tokens" they
 *     OVERSTATE it. For a warning, erring high is the correct direction.
 *  2. It matches the ~19% CLAUDE.md §8 already records, so the docs and the UI agree.
 *     Doc/UI drift on a headline number is a failure this project has repeatedly paid for.
 *  3. "Impact" conventionally names how far the price moved, not how many fewer units
 *     arrived.
 *
 * The number is labelled on screen with what it measures, because either figure is
 * defensible and neither is self-describing.
 *
 * ── WHY NOT currentPrice() ────────────────────────────────────────────────────
 *
 * `currentPrice()` returns `virtualUsdcReserves * 1e18 / virtualTokenReserves`, which at
 * launch scale evaluates to the integer **2**. Any impact derived from it rounds to
 * 0.00%, so the headline number this page is required to show would silently read zero on
 * a curve where a $500 buy moves the price ~19%. Measured, not reasoned about.
 *
 * The sanctioned method compares the rate this trade gets against the rate a negligible
 * trade gets, both from `quoteBuy`, in tokens-per-USDC where the magnitudes are large
 * enough to keep precision.
 *
 * @returns percent, or null when it cannot be computed honestly. NEVER 0 for a
 *          degenerate input -- 0 would render "0.00% impact" on a curve that moves ~19%,
 *          which is the exact currentPrice() failure this method replaces.
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
  if (marginal === 0n || effective === 0n) return null;
  if (effective >= marginal) return 0;
  // PRICE MOVE: (marginal / effective) - 1. Divided by `effective`, not `marginal` --
  // that single denominator is the entire difference between 18.55% and 15.65%.
  return Number(((marginal - effective) * 10_000n) / effective) / 100;
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

/**
 * How many tokens to sell for a given percentage of a holding.
 *
 * ⚠ THIS EXISTS BECAUSE THE SELL INPUT WAS IN RAW TOKEN AMOUNTS. Reported from a real
 * session: a holder with ~2,000,000 tokens typed "4", sold four tokens, and received
 * 0.00 USDC. Nobody sizes a sell in token counts -- they think "half". A buy is priced in
 * dollars because you are spending dollars; a sell is priced in percent because you are
 * disposing of a position.
 *
 * ⚠ 100% RETURNS THE EXACT BALANCE. A "sell everything" that leaves 3 wei behind is a
 * position the holder cannot clear and a row that never disappears from their wallet.
 *
 * Honest note on the early return: `balance * 100n / 100n` is ALREADY exact in bigint, so
 * that line is defensive rather than load-bearing, and a test cannot distinguish its
 * presence from its absence. Verified by mutation -- removing it changes nothing and the
 * suite stays green. It is kept because it makes the guarantee explicit at the point
 * someone would otherwise reach for a float, which IS the regression that bites: the same
 * function written as `Number(balance) * pct/100` fails S1, S2, S3, S6 and S7.
 *
 * All bigint. A percentage of an 18-decimal balance through Number loses precision above
 * 2^53 and these balances are routinely ~1e24.
 */
export function sellAmountForPercent(balance18: bigint, percent: number): bigint {
  if (balance18 <= 0n) return 0n;
  if (percent >= 100) return balance18;
  if (percent <= 0) return 0n;
  return (balance18 * BigInt(Math.round(percent))) / 100n;
}

/** The percentages offered on the sell side. 100 is last because it is the destructive one. */
export const SELL_PERCENTS = [25, 50, 75, 100] as const;

/**
 * A negligible SELL, for the sell-side impact probe.
 *
 * In tokens, not USDC, because that is what a sell offers. Sized to be economically
 * irrelevant against a 807,000,000-token curve while still large enough that the
 * contract's integer maths returns a non-zero output to divide by.
 */
export const IMPACT_PROBE_TOKENS18 = 10n ** 18n; // one whole token
