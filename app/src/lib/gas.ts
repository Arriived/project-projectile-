// Gas reserve and gas limit. Two different numbers, deliberately not derived from each
// other.
//
// On Arc, gas and settlement are the SAME balance (rule 3), so every unit reserved is a
// unit the user cannot trade with. The old frontend sent a hardcoded 600,000 limit
// against a buy that really consumed 194,372; a reserve sized from that limit withholds
// ~2.4x what is needed.
//
// Both numbers come from scripts/measure-gas.mts, run against real receipts.

/**
 * Multiplier on `eth_estimateGas` for the transaction LIMIT.
 *
 * RAISED FROM 1.5 TO 3.0 (A3), because 1.5 was far thinner than it reads.
 *
 * Measured: estimateGas returned 143,576 against 194,372 actually consumed -- the estimate
 * came in 26% BELOW reality, so the ratio to cover is already 1.354. At x1.5 the real
 * headroom over a known-good buy is about 11%, not 50%. And no measured buy triggered
 * GRADUATION, which does strictly more work than anything in the sample: it seeds a pool,
 * moves the LP, and writes the one-way state transition.
 *
 * The asymmetry is total. Unused gas is REFUNDED, so an oversized limit costs nothing but
 * a slightly higher balance bar; an undersized one fails the single most important
 * transaction in the product, and fails it on the buy that completes a graduation.
 *
 * x3.0 gives ~120% headroom over the measured worst ratio. The cost is that a wallet
 * checks `balance >= gasLimit * maxFeePerGas` before signing, so the limit does raise the
 * floor to transact -- which is why GAS_LIMIT_UNITS_FOR_PRECHECK below uses the SAME
 * multiplier, rather than the affordability check and the sent limit disagreeing.
 */
export const GAS_LIMIT_MULTIPLIER_X10 = 30n; // x3.0

export function gasLimitFor(estimate: bigint): bigint {
  return (estimate * GAS_LIMIT_MULTIPLIER_X10) / 10n;
}

/**
 * Gas units withheld from "available to trade", so the user can always get OUT.
 *
 * Measured, not chosen: worst observed sell 119,254 + first-time approve 47,110 =
 * 166,364, plus 50%.
 *
 * It is sized on the EXIT because that is rule 3's actual failure -- a holder left with
 * 471 trillion tokens and 0.0016 USDC who could not afford to sell. And the exit is TWO
 * transactions for a first-time seller: LFX1.sell() takes tokens with
 * `safeTransferFrom(msg.sender, ...)` (LFX1.sol:577), so an approve must land first. A
 * reserve covering only the sell strands exactly the user it exists to protect.
 *
 * Held in GAS UNITS rather than USDC so it tracks the fee: at Arc's 20,000 Gwei ceiling
 * this same reserve is worth ~5 USDC, and a figure fixed in USDC would be wrong by 1000x
 * exactly when the network is busy.
 */
export const GAS_RESERVE_UNITS = 249_546n;

/**
 * Worst-case gas for ONE trade, for the pre-submit affordability check.
 *
 * The real limit is `estimate x 3` computed at send time, but affordability is checked
 * before any estimate exists. This is the measured worst buy (194,372) under the same
 * multiplier, so the check and the transaction agree rather than the check passing a
 * trade the wallet then refuses to sign.
 */
export const GAS_LIMIT_UNITS_FOR_PRECHECK = (194_372n * GAS_LIMIT_MULTIPLIER_X10) / 10n;

/**
 * What the reserve costs at a given price, in USDC wei (18dp native accounting).
 * Priced at send time, never cached.
 */
export function reserveCostWei(maxFeePerGas: bigint, units = GAS_RESERVE_UNITS): bigint {
  return units * maxFeePerGas;
}

/**
 * Balance minus the gas reserve, floored at zero.
 *
 * `balance6` and the result are in the 6-decimal ERC-20 view, which is what a user sees
 * and what trade amounts are denominated in. The reserve is computed in 18dp native and
 * converted DOWN, so rounding always favours keeping more back rather than less --
 * under-reserving is the failure that strands someone.
 */
export function availableToTrade6(balance6: bigint, maxFeePerGas: bigint): bigint {
  const reserveWei = reserveCostWei(maxFeePerGas);
  // 18dp -> 6dp, rounding UP so a sub-unit remainder is still withheld.
  const reserve6 = (reserveWei + 999_999_999_999n) / 1_000_000_000_000n;
  return balance6 > reserve6 ? balance6 - reserve6 : 0n;
}

export type Affordability =
  | { ok: true }
  /** Enough for the trade but not for the trade PLUS its gas. */
  | { ok: false; reason: "gas"; shortfall6: bigint }
  /** Not enough for the trade itself. */
  | { ok: false; reason: "balance"; shortfall6: bigint }
  /** Holds something, but not enough to transact at all. */
  | { ok: false; reason: "dust"; shortfall6: bigint };

/**
 * Can this trade actually be submitted?
 *
 * ARITHMETIC, never a revert string (rule 4 / trap 10). Zero8 changed the node's
 * insufficient-balance wording on 3 September, and a frontend that parses it does not
 * throw when the text moves -- it silently stops warning, and the user discovers the
 * problem by losing a transaction.
 *
 * @param balance6  wallet USDC, 6dp
 * @param spend6    the trade amount, 6dp (0 for a sell, which spends only gas)
 * @param gasCostWei estimated gas cost of THIS operation, 18dp
 */
export function checkAffordability(
  balance6: bigint,
  spend6: bigint,
  gasCostWei: bigint,
  reserveUnits = GAS_RESERVE_UNITS,
  maxFeePerGas = 0n
): Affordability {
  const gasCost6 = (gasCostWei + 999_999_999_999n) / 1_000_000_000_000n;

  // Cannot cover even the gas for one operation.
  if (balance6 < gasCost6) {
    return { ok: false, reason: "dust", shortfall6: gasCost6 - balance6 };
  }
  if (balance6 < spend6) {
    return { ok: false, reason: "balance", shortfall6: spend6 - balance6 };
  }
  // The one Arc forces on us: affordable on its own, unaffordable with its own gas.
  if (balance6 < spend6 + gasCost6) {
    return { ok: false, reason: "gas", shortfall6: spend6 + gasCost6 - balance6 };
  }
  // And it must not spend down past the exit reserve.
  if (maxFeePerGas > 0n) {
    const reserve6 =
      (reserveUnits * maxFeePerGas + 999_999_999_999n) / 1_000_000_000_000n;
    if (balance6 - spend6 - gasCost6 < reserve6) {
      return {
        ok: false,
        reason: "gas",
        shortfall6: reserve6 - (balance6 - spend6 - gasCost6),
      };
    }
  }
  return { ok: true };
}
