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
// Type-only, so `node --experimental-strip-types` erases it and this module stays
// runtime-dependency-free for the verify scripts.
import type { Address } from "viem";

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

/**
 * Every input a quote depends on, reduced to one comparable string.
 *
 * ⚠ THIS IS THE SIGNAL THAT A DISPLAYED QUOTE IS KNOWN-SUPERSEDED, and it exists because
 * of a real production defect. Read CLAUDE.md §12.2 for the incident and the measurement.
 *
 * The panel used to hold three figures refreshed on three different clocks: the curve
 * every 6s, balances every 8s, the quote every 30s. So "In the curve" and "Estimated
 * receive" routinely described the same curve at two different moments, and after any
 * trade -- the user's own or a stranger's -- the estimate kept quoting the old reserves
 * for up to thirty seconds.
 *
 * Measured against the live chain at block 60466878 vs 60466934, same token, same
 * offered amount: 18.419215 USDC then 6.083286 USDC. A quote taken before that
 * intervening sell and displayed after it OVERSTATES the payout by 3.03x, and overstating
 * is the direction that matters -- a seller acts on a number the curve will not honour.
 *
 * WHAT IS IN IT, and why each:
 *   virtual reserves   the curve's price, directly
 *   realUsdcReserves   what the curve can actually pay a seller; drives the clamp
 *   tokenReserves      what it can actually deliver a buyer; drives the clamp
 *   state              ACTIVE / GRADUATION_READY / GRADUATED closes both sides
 *   snipeTaxBps        changes per SECOND for the first seven seconds
 *
 * ⚠ DO NOT reduce this to a block number. A block in which nothing touched this curve
 * does not stale a quote, and invalidating on every block would refetch every ~0.48s
 * forever. The fingerprint changes when the ANSWER would change, which is the property
 * that makes it both correct and cheap.
 *
 * ⚠ DO NOT add a timestamp or anything else that moves on its own. Anything in here that
 * changes without the curve changing turns this into a poll, and a poll is what it
 * replaces.
 *
 * An absent curve returns a distinct marker rather than a fabricated one, so "we do not
 * know the curve" can never compare equal to a real state and quietly reuse a figure.
 */
export function curveQuoteFingerprint(
  curve:
    | {
        virtualUsdcReserves: bigint;
        virtualTokenReserves: bigint;
        realUsdcReserves: bigint;
        tokenReserves: bigint;
        state: number;
      }
    | undefined,
  snipeTaxBps: number | undefined
): string {
  if (!curve) return "curve:unknown";
  return [
    curve.virtualUsdcReserves,
    curve.virtualTokenReserves,
    curve.realUsdcReserves,
    curve.tokenReserves,
    curve.state,
    snipeTaxBps ?? "?",
  ].join(":");
}

/** Which side of the trade a quote describes. */
export type Side = "buy" | "sell";

/** Position of the fingerprint inside the query key. Named so the placeholder cannot
 *  drift from the key it reads. */
export const QUOTE_KEY_FINGERPRINT_INDEX = 4;

/**
 * The cache key for one quote.
 *
 * Exported so the check that proves the isolation property uses THE key builder rather
 * than a retyped copy of its shape. A test that asserts against its own reimplementation
 * of the thing under test proves only that the author can type it twice.
 */
export function quoteQueryKey(
  token: Address | undefined,
  side: Side,
  amount: bigint,
  curveFingerprint: string
): readonly unknown[] {
  return ["quote", token, side, amount.toString(), curveFingerprint];
}

/**
 * Whether a figure already on screen may stay there while a new one loads.
 *
 * ⚠ THIS IS THE DECISION §12.2 TURNS ON, so it is a named pure function rather than an
 * inline lambda: it is the thing the check has to be able to mutate and watch go red.
 *
 *   previous key's fingerprint === current  ->  UNKNOWN-STALE. The amount changed or the
 *                                               poll ticked. Nothing says the curve moved.
 *                                               Keep the figure, dimmed (see Figure).
 *
 *   anything else                           ->  KNOWN-STALE. The reserves, state or tax
 *                                               that produced it are gone. Return
 *                                               undefined, which renders "—".
 *
 * ⚠ The comparison is against the PREVIOUS KEY, never against a remembered variable. A
 * remembered fingerprint can drift out of step with the data it labels; the key cannot,
 * because the cache entry and its key are the same object.
 */
export function carryForwardQuote<T>(
  previousData: T | undefined,
  previousKey: readonly unknown[] | undefined,
  curveFingerprint: string
): T | undefined {
  if (previousData === undefined) return undefined;
  return previousKey?.[QUOTE_KEY_FINGERPRINT_INDEX] === curveFingerprint
    ? previousData
    : undefined;
}

/**
 * How long after creation the snipe tax is still decaying.
 *
 * The published table is `[9800, 9500, 9000, 8000, 6000, 4000, 2000, 0]`, indexed by
 * ELAPSED SECONDS. So the tax changes every second for seven seconds and is then flat
 * forever. `SNIPE_DECAY_SECONDS` is that table's length, plus a second of slack for
 * clock skew between the browser and the chain.
 */
export const SNIPE_DECAY_SECONDS = 9;

/** While the tax is decaying per second, a quote is stale in one second. */
export const QUOTE_POLL_HOT_MS = 1_000;

/**
 * Afterwards the curve only moves when someone trades, so there is nothing to poll FOR.
 * 30s is a liveness floor, not a freshness requirement -- the trade panel re-quotes
 * immediately before signing regardless (trap 6), so a slightly old displayed number can
 * never become a number the contract is asked to honour.
 */
export const QUOTE_POLL_COLD_MS = 30_000;

/**
 * The polling interval for a token created `ageSeconds` ago.
 *
 * ⚠ THE OLD FIXED 4s WAS WRONG IN BOTH DIRECTIONS AT ONCE, which is why this is a
 * function rather than a constant:
 *
 *   - TOO SLOW when it mattered. The tax decays every second for seven seconds; a 4s
 *     poll sampled that curve about twice and missed most of it -- during precisely the
 *     window the snipe tax exists to govern.
 *   - TOO FAST afterwards. A curve that nobody is trading does not change, so a quote
 *     every 4 seconds forever is ~15 RPC calls per minute per open page, bought for
 *     nothing.
 *
 * `undefined` age means "not known yet" and is treated as HOT: over-polling for one tick
 * is cheap, under-polling during the snipe window is the failure this exists to prevent.
 */
export function quotePollIntervalMs(ageSeconds: number | undefined): number {
  if (ageSeconds === undefined) return QUOTE_POLL_HOT_MS;
  return ageSeconds < SNIPE_DECAY_SECONDS ? QUOTE_POLL_HOT_MS : QUOTE_POLL_COLD_MS;
}
