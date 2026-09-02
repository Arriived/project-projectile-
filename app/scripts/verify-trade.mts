// Walks the trade-logic traps: gas reserve, affordability, minOut, price impact, the
// gross/net sell distinction, and the curve-state gate.
//
// Every row here corresponds to a numbered trap in REACT_REBUILD.md or a rule in
// FRONTEND_BUILD_V2.md, and each one has already cost this project something real.
//
// Run: npm run verify:trade
//
// Red-proofs, each hitting a different row:
//   a) in quotes.ts make minOutFromQuote return 0 for a real quote -> T5d fails
//   b) in quotes.ts have minOutFromQuote delegate to minOutForOfferedAmount -> T5c fails
//   c) in curve.ts make GRADUATION_READY tradable -> T8a fails
//   d) in gas.ts drop the exit-reserve check from checkAffordability -> T9h fails
//      (NOT T9c -- T9c is caught by an earlier branch and survives that mutation,
//       which is exactly how T9h came to exist)

import {
  GAS_RESERVE_UNITS,
  GAS_LIMIT_UNITS_FOR_PRECHECK,
  gasLimitFor,
  availableToTrade6,
  checkAffordability,
  reserveCostWei,
} from "../src/lib/gas.ts";
import { sellNetOut, minOutFromQuote, minOutForOfferedAmount, impactPct, quoteDivergencePct, sellAmountForPercent, SELL_PERCENTS } from "../src/lib/quotes.ts";
import { tradeGate, graduationProgressBps, CurveState } from "../src/lib/curve.ts";
import { snipeSchedule } from "../src/lib/snipe.ts";

let failures = 0;
const check = (label: string, pass: boolean, detail = "") => {
  if (!pass) failures++;
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${label}${detail ? `  — ${detail}` : ""}`);
};

const GWEI = 1_000_000_000n;

// ── Trap 9 / rule 3: the gas reserve ────────────────────────────────────────────
console.log("── gas reserve and affordability ──");
{
  const maxFee = 25n * GWEI;
  // 10 USDC balance, 6dp
  const bal = 10_000_000n;
  const avail = availableToTrade6(bal, maxFee);
  check(
    "T9a  available-to-trade is strictly less than balance",
    avail < bal,
    `${bal} -> ${avail} (withheld ${bal - avail})`
  );
  check(
    "T9b  the withheld amount matches the measured reserve at this fee",
    bal - avail === (GAS_RESERVE_UNITS * maxFee + 999_999_999_999n) / 1_000_000_000_000n,
    `${bal - avail} base units`
  );

  // The failure rule 3 was written for: enough for the trade, nothing left to exit with.
  const spendAll = avail + (bal - avail); // i.e. the whole balance
  const r = checkAffordability(bal, spendAll, 200_000n * 25n * GWEI, GAS_RESERVE_UNITS, maxFee);
  check("T9c  spending the entire balance is REFUSED", !r.ok, r.ok ? "" : r.reason);

  // A dust wallet cannot even pay for one operation. The gas cost here is a REAL one:
  // 200,000 units at 25 Gwei = 0.005 USDC. The first version of this row passed
  // 30,000 Gwei as the total cost -- 0.00003 USDC -- which no operation costs, so the
  // dust branch was unreachable and the row was testing nothing.
  const realOpGasWei = 200_000n * 25n * GWEI;
  const dust = checkAffordability(1_000n, 0n, realOpGasWei, GAS_RESERVE_UNITS, maxFee);
  check(
    "T9d  a dust balance is refused with reason 'dust', not 'balance'",
    !dust.ok && dust.reason === "dust",
    dust.ok ? "allowed" : dust.reason
  );

  // Affordable alone, unaffordable with its own gas -- the one Arc forces on us.
  const tight = checkAffordability(1_000_000n, 999_000n, realOpGasWei, GAS_RESERVE_UNITS, maxFee);
  check(
    "T9e  affordable alone but not with its own gas -> refused as 'gas'",
    !tight.ok && tight.reason === "gas",
    tight.ok ? "allowed" : tight.reason
  );

  const fine = checkAffordability(100_000_000n, 1_000_000n, realOpGasWei, GAS_RESERVE_UNITS, maxFee);
  check("T9f  a comfortable trade is allowed", fine.ok);

  // T9h ISOLATES THE EXIT-RESERVE BRANCH, and it exists because T9c did not.
  //
  // T9c spends the ENTIRE balance, which is caught by the earlier "cannot afford its own
  // gas" branch -- so it passed even with the reserve check disabled. Red-proof C found
  // that: 30/30 with the branch commented out. A test passing for the wrong reason is
  // test-shape error 3 in CLAUDE.md §5, and it was in my own work.
  //
  // These numbers clear every earlier branch and fail only on the reserve: 0.01 USDC
  // balance, spend 0.004, gas 0.0005 -> 0.0055 left against a 0.006239 reserve.
  const smallGasWei = 20_000n * 25n * GWEI; // 0.0005 USDC
  const reserveOnly = checkAffordability(10_000n, 4_000n, smallGasWei, GAS_RESERVE_UNITS, maxFee);
  check(
    "T9h  a trade that clears its own gas but breaches the EXIT reserve is refused",
    !reserveOnly.ok && reserveOnly.reason === "gas",
    reserveOnly.ok ? "ALLOWED — the exit reserve is not being enforced" : `refused: ${reserveOnly.reason}`
  );

  // A balance below the reserve leaves nothing tradable, and must not go negative.
  check("T9g  balance under the reserve floors at zero, never negative", availableToTrade6(100n, maxFee) === 0n);
}

console.log("\n── gas limit ──");
// A3. The multiplier must clear the MEASURED estimator error, not just look generous.
// eth_estimateGas returned 143,576 against 194,372 actually consumed -- a 1.354 ratio --
// so x1.5 left ~11% real headroom, not 50%. And no measured buy triggered graduation,
// which does strictly more work than anything in the sample.
check("TL1  limit is 3x the estimate", gasLimitFor(200_000n) === 600_000n, gasLimitFor(200_000n).toString());
check(
  "TL1b the limit clears the measured 143,576 -> 194,372 estimator shortfall with room",
  gasLimitFor(143_576n) > 194_372n * 2n,
  `${gasLimitFor(143_576n)} vs 194,372 consumed (${(Number(gasLimitFor(143_576n)) / 194372).toFixed(2)}x)`
);
check(
  "TL1c the affordability pre-check prices the SAME multiplier as the sent limit",
  GAS_LIMIT_UNITS_FOR_PRECHECK === (194_372n * 30n) / 10n,
  `${GAS_LIMIT_UNITS_FOR_PRECHECK} units`
);
check(
  "TL2  limit is independent of the reserve (not derived from it)",
  gasLimitFor(119_254n) !== GAS_RESERVE_UNITS,
  `limit ${gasLimitFor(119_254n)} vs reserve ${GAS_RESERVE_UNITS}`
);
// A3: the reserve must be UNITS priced at a live fee, never a stored USDC figure. If it
// were stored in USDC it would be wrong by 1000x at Arc's ceiling. Proven by pricing the
// same units at three fees and requiring three different answers.
{
  const GW = 1_000_000_000n;
  const at20 = reserveCostWei(20n * GW);
  const at41 = reserveCostWei(41n * GW);
  const atCeil = reserveCostWei(20_000n * GW);
  check(
    "TL3  the reserve tracks the fee -- 20 / 41 / 20,000 Gwei give three different costs",
    at20 !== at41 && at41 !== atCeil && atCeil > at20 * 500n,
    `${at20} / ${at41} / ${atCeil} wei`
  );
}

// ── Trap 2: sell quotes are gross, sell() compares net ──────────────────────────
console.log("\n── quotes ──");
{
  const q = {
    actualTokensIn: 1_000n,
    newVirtualUsdc: 0n,
    newVirtualToken: 0n,
    usdcOutGross: 1_000_000n,
    fee: 10_000n,
  };
  check("T2   sell net = gross - fee", sellNetOut(q) === 990_000n, sellNetOut(q).toString());
  check("T2b  net is strictly less than gross (an unreachable floor otherwise)", sellNetOut(q) < q.usdcOutGross);
}

// ── Trap 5: minOut sized from the rate, never zero, clamp-safe ──────────────────
{
  // The quote's tokensOut is ALREADY the clamped output paired with actualUsdcIn, so
  // slippage applies to it directly.
  const full = minOutFromQuote(500n, 100n);
  check("T5a  slippage is applied to the quoted output", full === 495n, full.toString());

  // Zero quote must not produce a floor pretending to be one.
  check("T5b  a zero quote yields zero, not a fake floor", minOutFromQuote(0n, 100n) === 0n);

  // THE CLAMP. Offered 1000, but the curve can only take 400, and the quote says so:
  // actualIn 400, out 500. The floor must be met by what the contract will actually
  // deliver (500), not by what the full offer would have bought (1250).
  const clampedQuoteOut = 500n;
  const ours = minOutFromQuote(clampedQuoteOut, 100n);
  const wrong = minOutForOfferedAmount(clampedQuoteOut, 400n, 1_000n, 100n);
  check(
    "T5c  a clamped fill is NOT scaled back up to the offered amount",
    ours <= clampedQuoteOut && wrong > clampedQuoteOut,
    `ours ${ours} (deliverable), naive ${wrong} (exceeds the ${clampedQuoteOut} the contract will deliver -> reverts)`
  );

  // Never zero for a real quote, even at brutal slippage: minOut = 0 is "accept any
  // price", and this curve is thin enough that accepting any price is a real loss.
  const brutal = minOutFromQuote(10n, 9_999n);
  check("T5d  minOut is never zero for a real quote", brutal > 0n, brutal.toString());
}

// ── Trap 3: impact from a probe, and the currentPrice() trap it replaces ────────
{
  // A negligible probe gets a better rate than a large trade.
  const i = impactPct(168_000_000n, 500_000_000n, 4_000n, 10_000n);
  check("T3a  impact is positive when the trade moves the price", i !== null && i > 0, String(i));

  // Same rate -> zero impact, not a rounding artefact.
  const flat = impactPct(1_000n, 1_000n, 10n, 10n);
  check("T3b  identical rates give exactly 0", flat === 0, String(flat));

  // Degenerate inputs must return null, NOT 0. Returning 0 would render "0.00% impact"
  // on a curve where the true figure is ~20% -- silently lying, which is exactly the
  // currentPrice() failure this method exists to avoid.
  check("T3c  a zero quote returns null, never 0", impactPct(0n, 1n, 1n, 1n) === null);
  check("T3d  a zero probe returns null, never 0", impactPct(1n, 1n, 0n, 1n) === null);

  // A2 PINS THE DEFINITION. The probe method yields ONE ratio; the formula picks a side,
  // and the two sides are reciprocals -- 15.65% and 18.55% for the same live $500 buy.
  // We report PRICE MOVE (marginal/effective - 1). Without this row a future edit could
  // flip the denominator and every other impact row would still pass, because they only
  // check sign and degeneracy.
  //
  // Rates chosen so the two definitions are far apart and unmistakable:
  //   marginal 100, effective 80 -> shortfall 20.00%, price move 25.00%
  const pm = impactPct(80n, 1n, 100n, 1n);
  check(
    "T3e  impact is PRICE MOVE (marginal/effective - 1), not token shortfall",
    pm === 25,
    `got ${pm}% (shortfall form would be 20%)`
  );
}

// ── Trap 6: quote vs settlement divergence ──────────────────────────────────────
{
  check("T6a  divergence is reported", quoteDivergencePct(1_000n, 900n) === 10, String(quoteDivergencePct(1_000n, 900n)));
  check("T6b  no divergence reads 0", quoteDivergencePct(1_000n, 1_000n) === 0);
}

// ── Trap 8: sells closed at GRADUATION_READY, not only GRADUATED ────────────────
console.log("\n── curve state ──");
{
  const active = tradeGate(CurveState.ACTIVE);
  check("T8a0 ACTIVE allows both sides", active.canBuy && active.canSell);

  const ready = tradeGate(CurveState.GRADUATION_READY);
  check("T8a  GRADUATION_READY closes BOTH sides", !ready.canBuy && !ready.canSell);
  check("T8b  ...and explains why rather than just refusing", (ready.reason ?? "").length > 40);

  const grad = tradeGate(CurveState.GRADUATED);
  check("T8c  GRADUATED closes both sides", !grad.canBuy && !grad.canSell);

  const weird = tradeGate(99);
  check("T8d  an unrecognised state fails CLOSED", !weird.canBuy && !weird.canSell);
}

// ── graduation progress ─────────────────────────────────────────────────────────
{
  check("TG1  half way reads 5000 bps", graduationProgressBps(4_000_000_000n, 8_000_000_000n) === 5000);
  check("TG2  at or past the threshold clamps to 10000", graduationProgressBps(9_000_000_000n, 8_000_000_000n) === 10000);
  check("TG3  a zero threshold does not divide by zero", graduationProgressBps(0n, 0n) === 10000);
}

// ── snipe tax countdown ─────────────────────────────────────────────────────────
console.log("\n── snipe tax ──");
{
  const table = [9800, 9500, 9000, 8000, 6000, 4000, 2000, 0];
  const created = 1_000_000n;

  const atT1 = snipeSchedule(table, created, created + 1n, 9500);
  check("TS1  mid-table gives the next step", atT1.nextBps === 9000, String(atT1.nextBps));
  check("TS2  and reports the tax as active", atT1.active);

  const exhausted = snipeSchedule(table, created, created + 50n, 0);
  check("TS3  past the table there is nothing to count down to", exhausted.secondsToNextStep === null);
  check("TS4  and the tax is not active", !exhausted.active);

  // The contract is the authority. If our derived value disagrees, suppress the
  // countdown rather than show a schedule contradicting the price actually charged.
  const disagree = snipeSchedule(table, created, created + 1n, 1234);
  check(
    "TS5  disagreement with the contract suppresses the countdown",
    disagree.secondsToNextStep === null && disagree.currentBps === 1234
  );
}

// ── sell sizing (reported from a real session) ──────────────────────────────────
console.log("\n── sell percentages ──");
{
  // The failure this fixes: a holder with ~2,000,000 tokens typed "4" into a raw token
  // box, sold four tokens, and received 0.00 USDC. A sell is sized in percent because
  // nobody holds a position in units.
  const bal = 2_000_000n * 10n ** 18n;

  check("S1  25% is a quarter", sellAmountForPercent(bal, 25) === bal / 4n);
  check("S2  50% is half",      sellAmountForPercent(bal, 50) === bal / 2n);

  // THE ROW THAT MATTERS. "Sell everything" that leaves dust is a position the holder
  // cannot clear and a row that never leaves their wallet. An odd balance is used
  // precisely because it is where percentage arithmetic would round.
  const odd = 123_456_789_987_654_321_123n;
  check(
    "S3  100% returns the EXACT balance, never a rounded one",
    sellAmountForPercent(odd, 100) === odd,
    "no dust left behind on an odd balance"
  );
  check("S4  a zero balance sells zero, not NaN", sellAmountForPercent(0n, 50) === 0n);
  check("S5  0% sells nothing", sellAmountForPercent(bal, 0) === 0n);
  check("S6  above 100% clamps to the balance", sellAmountForPercent(bal, 150) === bal);

  // Precision: these balances are ~1e24, far past Number.MAX_SAFE_INTEGER (~9e15).
  const huge = 987_654_321_123_456_789_987_654_321n;
  check(
    "S7  percentages are bigint -- no float precision loss at 1e27",
    sellAmountForPercent(huge, 50) === huge / 2n,
    "Number() here would silently lose the low digits"
  );
  check("S8  the offered percents end at 100", SELL_PERCENTS[SELL_PERCENTS.length - 1] === 100);
}

const total = 44;
console.log(`\n${total - failures}/${total} checks passed`);
if (failures) process.exit(1);
