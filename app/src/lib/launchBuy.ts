// The creator launch buy: reachable only as a batch.
//
// ── ⚠ WHY THIS EXISTS: THE FEATURE IS UNREACHABLE BY HAND ─────────────────────
//
// The contract gives the creator an untaxed, creator-only buy inside a window measured in
// SECONDS from creation (LFX1.sol):
//
//   :342  creator: msg.sender
//   :354  creationTimestamp: block.timestamp
//   :477  if (!(msg.sender == c.creator)) revert NotCreator();
//   :478  if (!(block.timestamp <= c.creationTimestamp + c.creatorLaunchWindow))
//              revert LaunchWindowClosed(...);
//
// with `creatorLaunchWindow = 3` seconds. Creating is one signature; using the allocation
// then needs an approval and a buy. A human cannot confirm three MetaMask prompts inside
// three seconds, so every token ever launched reads "Creator bought at launch — Nothing" —
// not because creators declined, but because they were never offered the choice. A
// disclosure that implies a decision nobody could make is worse than no disclosure.
//
// ── ⚠ THE BATCH GENUINELY REACHES THE WINDOW, AND HERE IS WHY ─────────────────
//
// Two facts make it work, and the second is the one that is easy to miss:
//
//  1. ONE TRANSACTION HAS ONE `block.timestamp`. Executed atomically, `createToken` sets
//     `creationTimestamp = block.timestamp` and `creatorLaunchBuy` then tests
//     `block.timestamp <= creationTimestamp + 3` against that same value: `t <= t + 3`.
//     Trivially true, with the entire window still ahead.
//
//  2. ⚠ `creatorLaunchBuy` HAS NO BLOCK-0 RESTRICTION. `buy()` (:510) and `sell()` (:561)
//     both begin `if (!(block.number > c.creationBlock)) revert TradingNotOpenYet();`.
//     `creatorLaunchBuy` does NOT -- verified, zero `creationBlock` references in its body.
//     That exemption is deliberate: the block-0 rule exists to delay SNIPERS, and the
//     creator's privileged path is precisely what it is not meant to delay. Without it a
//     same-block batch would revert and this whole approach would be impossible.
//
// `msg.sender` is the same account for every call in the batch, so `creator` and the
// caller of `creatorLaunchBuy` match whether the account is an EOA under EIP-7702 or a
// smart account.
//
// ⚠ NO CURVE MATH IS RE-DERIVED HERE. The cap is a share of CURVE_TOKEN_SUPPLY, which is a
// constant; the price comes from `quoteBuy` on the contract, as everywhere else.

/**
 * Curve supply, and the cap as a share of it.
 *
 * ⚠ CURVE supply (807M), not TOTAL (1,000M). The 193M LP reserve is not part of what the
 * curve sells, and using the total would understate the cap's share by 1.24x.
 */
export const CURVE_TOKEN_SUPPLY = 807_000_000n * 10n ** 18n;

/** `maxCreatorLaunchBps` on the deployed factory. Read per-token at submit; this is the
 *  default used for the form's own bounds before a read lands. */
export const DEFAULT_MAX_CREATOR_LAUNCH_BPS = 250n; // 2.5%

/** The token cap in wei, from a per-token bps value read off the chain. */
export function launchBuyCapTokens(maxBps: bigint, curveSupply = CURVE_TOKEN_SUPPLY): bigint {
  return (curveSupply * maxBps) / 10_000n;
}

export type LaunchBuyIssue =
  | { kind: "notANumber" }
  | { kind: "negative" }
  | { kind: "exceedsBalance"; needed: bigint; have: bigint };

/**
 * Parse the creator's chosen spend, in USDC (6dp).
 *
 * ⚠ THE AMOUNT IS IN USDC, NOT IN TOKENS OR IN PERCENT, and that is deliberate. The
 * contract's cap is expressed in TOKENS (a share of curve supply) and is enforced by the
 * contract itself -- `creatorLaunchBuy` clamps to `remainingAllowance` (:484-:487) and the
 * partial-fill clamp then fills what is available rather than reverting. So the creator
 * cannot exceed the cap no matter what they type here, and asking them for a token count
 * would mean showing them a number they cannot convert to money at the moment they choose.
 *
 * Zero is not an error: it means "no launch buy", which is the default and the current
 * behaviour of every token launched so far.
 */
export function parseLaunchBuyUsdc(
  raw: string,
  available6: bigint | undefined
): { usdc6: bigint | null; issue: LaunchBuyIssue | null } {
  const s = raw.trim();
  if (!s) return { usdc6: 0n, issue: null };

  const n = Number(s.replace(",", "."));
  if (!Number.isFinite(n)) return { usdc6: null, issue: { kind: "notANumber" } };
  if (n < 0) return { usdc6: null, issue: { kind: "negative" } };

  const usdc6 = BigInt(Math.round(n * 1_000_000));
  if (available6 !== undefined && usdc6 > available6) {
    return { usdc6: null, issue: { kind: "exceedsBalance", needed: usdc6, have: available6 } };
  }
  return { usdc6, issue: null };
}

/**
 * Whether a batched launch buy should be attempted at all.
 *
 * ⚠ CAPABILITY-GATED, WITH THE ORDINARY FLOW AS FALLBACK. Creation must never depend on
 * EIP-5792: a wallet without it still launches tokens, just without the allocation. Gating
 * creation on a batching capability would trade a feature nobody could use for a product
 * some wallets could not use at all, which is a strictly worse trade.
 */
export function canBatchLaunchBuy(input: {
  supportsAtomicBatch: boolean;
  launchBuyUsdc6: bigint | null;
}): boolean {
  return input.supportsAtomicBatch && input.launchBuyUsdc6 !== null && input.launchBuyUsdc6 > 0n;
}

/**
 * Read `wallet_getCapabilities` output for atomic batching on a chain.
 *
 * ⚠ "atomic" MUST BE "supported" OR "ready" -- NOT merely present. EIP-5792 defines the
 * `atomic` capability with a status string, and a wallet that reports `unsupported` will
 * happily accept `wallet_sendCalls` and execute the calls SEQUENTIALLY, in separate
 * transactions and therefore separate blocks. That is the exact failure this feature
 * exists to avoid: the calls would land, the launch buy would revert `LaunchWindowClosed`,
 * and the creator would pay gas for a token they did not get.
 *
 * Unknown shapes return false. A capability we cannot read is not a capability we have.
 */
export function supportsAtomicBatch(caps: unknown, chainId: number): boolean {
  if (caps === null || typeof caps !== "object") return false;
  const perChain = (caps as Record<string, unknown>)[String(chainId)] as
    | Record<string, unknown>
    | undefined;
  if (!perChain || typeof perChain !== "object") return false;
  const atomic = perChain.atomic as { status?: unknown } | undefined;
  if (!atomic || typeof atomic !== "object") return false;
  return atomic.status === "supported" || atomic.status === "ready";
}
