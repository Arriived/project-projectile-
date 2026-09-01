// Create-flow logic: validation, the approval amount, and the launch preconditions.
//
// Pure. No React, no network. The rules here are the ones that cost real money to get
// wrong, so they live where a test can reach them rather than inside a form component.

/**
 * ⚠ R13. THE CREATION FEE IS APPROVED FOR AN EXACT AMOUNT. NEVER MaxUint256.
 *
 * `creationFeeUsdc` is one of exactly two values NOT covered by `currentEconomicsHash()`
 * (the other is `launchCooldown`). So the economics-pinning guard that protects every
 * other parameter -- fees, the snipe table, the graduation threshold -- cannot fire on a
 * change to this one.
 *
 * The consequence is concrete and was proven on chain: an owner can raise the creation
 * fee between a creator reading the terms and their transaction landing, the pinned hash
 * is unchanged so `createToken` does not revert, and the creator pays the new fee. A
 * creator who pinned the old terms paid a 1000x fee in exactly that scenario.
 *
 * The creator's APPROVAL is therefore the only bound on that exposure. An exact-amount
 * approval caps the loss at the fee they agreed to; `MaxUint256` removes the cap entirely
 * and hands the owner an unbounded claim on the wallet.
 *
 * This function exists so the amount can never be "convenience-optimised" into an
 * unlimited approve without a test failing.
 */
export function creationFeeApprovalAmount(creationFeeUsdc: bigint): bigint {
  return creationFeeUsdc;
}

/** The sentinel this flow must never approve. Exported so the test can assert against it. */
export const MAX_UINT256 = (1n << 256n) - 1n;

/**
 * Symbols longer than this cannot be added to a wallet in one click.
 *
 * `wallet_watchAsset` (EIP-747) caps the symbol at 11 characters, and MetaMask enforces
 * it. The CONTRACT does not: `createToken` validates nothing about the symbol, so a
 * 30-character symbol launches successfully and then simply cannot be one-click-added.
 *
 * ⚠ WARN, NEVER BLOCK. Refusing a symbol the contract accepts would make this UI stricter
 * than the chain -- someone would launch the same token through the contract directly and
 * our own list would be the only place claiming it was invalid. The honest position is to
 * say what the consequence is and let the creator decide.
 */
export const WATCH_ASSET_SYMBOL_MAX = 11;

export type Severity = "error" | "warning";

export type Issue = {
  field: "name" | "symbol" | "metadataUri";
  severity: Severity;
  /** i18n key. This module owns no user-facing English. */
  key: string;
  params?: Record<string, string | number>;
};

/**
 * Everything wrong with a draft, as a list rather than a first-failure.
 *
 * `error` blocks submission; `warning` does not. The distinction is load-bearing: the
 * only true errors here are things the CONTRACT rejects. Everything else is advice.
 */
export function validateDraft(draft: {
  name: string;
  symbol: string;
  metadataUri: string;
}): Issue[] {
  const issues: Issue[] = [];
  const name = draft.name.trim();
  const symbol = draft.symbol.trim();
  const uri = draft.metadataUri.trim();

  // The contract stores these as strings and does not validate them, but an empty name
  // or symbol produces a token that cannot be identified at all. Blocked here because the
  // resulting token would be unusable rather than merely unwise.
  if (!name) issues.push({ field: "name", severity: "error", key: "create.errNameEmpty" });
  if (!symbol) issues.push({ field: "symbol", severity: "error", key: "create.errSymbolEmpty" });

  if (symbol && symbol.length > WATCH_ASSET_SYMBOL_MAX) {
    issues.push({
      field: "symbol",
      severity: "warning",
      key: "create.warnSymbolLong",
      params: { max: WATCH_ASSET_SYMBOL_MAX, length: symbol.length },
    });
  }

  // Bidirectional control characters exist to make one string render as another. A token
  // list is exactly where that works, so it is surfaced at creation rather than only
  // being stripped at render time.
  if (/[‪-‮⁦-⁩‎‏]/.test(name + symbol)) {
    issues.push({ field: "name", severity: "warning", key: "create.warnBidi" });
  }

  // ipfs:// is not fetchable by a browser; the token page routes it through a gateway,
  // but a creator should know the raw URI will not resolve for anyone reading it directly.
  if (uri && !/^(https?:\/\/|ipfs:\/\/|data:image\/)/i.test(uri)) {
    issues.push({ field: "metadataUri", severity: "warning", key: "create.warnUriScheme" });
  }

  return issues;
}

export function blocksSubmission(issues: Issue[]): boolean {
  return issues.some((i) => i.severity === "error");
}

/** Why the launch button is not available yet, or null when it is. */
export type LaunchBlocker =
  | { kind: "wrongChain" }
  | { kind: "notConnected" }
  | { kind: "cooldown"; secondsRemaining: number }
  | { kind: "insufficientUsdc"; needed: bigint; have: bigint }
  | { kind: "validation" }
  | null;

/**
 * Whether a launch can be attempted, and if not, precisely why.
 *
 * ⚠ THE COOLDOWN IS NOT A SPAM CONTROL AND MUST NOT BE PRESENTED AS ONE. `launchCooldown`
 * is keyed on `msg.sender`, so a second address bypasses it entirely. The 0.5 USDC
 * creation fee is the actual spam control. This check exists so the button explains a
 * revert before it happens, not because it protects anything.
 *
 * ⚠ USDC IS ALSO THE GAS TOKEN. The affordability check must cover the fee PLUS gas out of
 * one balance, which is why `gasReserve` is a required argument rather than an optional
 * refinement -- a creator who can afford exactly the fee cannot afford to send it.
 */
export function launchBlocker(input: {
  isConnected: boolean;
  canTransact: boolean;
  issues: Issue[];
  nowSeconds: number;
  lastLaunchTimestamp: bigint | undefined;
  launchCooldown: bigint | undefined;
  usdcBalance: bigint | undefined;
  creationFee: bigint | undefined;
  gasReserve: bigint;
}): LaunchBlocker {
  if (!input.isConnected) return { kind: "notConnected" };
  if (!input.canTransact) return { kind: "wrongChain" };
  if (blocksSubmission(input.issues)) return { kind: "validation" };

  if (input.lastLaunchTimestamp !== undefined && input.launchCooldown !== undefined) {
    const ready = Number(input.lastLaunchTimestamp) + Number(input.launchCooldown);
    if (input.nowSeconds < ready) {
      return { kind: "cooldown", secondsRemaining: ready - input.nowSeconds };
    }
  }

  if (input.creationFee !== undefined && input.usdcBalance !== undefined) {
    const needed = input.creationFee + input.gasReserve;
    if (input.usdcBalance < needed) {
      return { kind: "insufficientUsdc", needed, have: input.usdcBalance };
    }
  }

  return null;
}
