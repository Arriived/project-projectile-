// The chain-guard decision, as a pure function with no imports.
//
// ── THE BUG THIS EXISTS TO PREVENT ────────────────────────────────────────────
//
// WalletBar originally used wagmi's `useChainId()`. That hook returns
// `config.state.chainId` -- the chain the CONFIG is pointed at, not the chain the WALLET
// is on. And wagmi deliberately refuses to move config state to a chain it does not know
// (@wagmi/core createConfig.js, verbatim):
//
//     // If chain is not configured, then don't switch over to it.
//     const isChainConfigured = chains.getState().some((x) => x.id === chainId);
//     if (!isChainConfigured) return;
//
// Our config lists exactly one chain. So `useChainId()` could ONLY ever return 5042002,
// `chainId === arc.id` was structurally always true, and the wrong-network branch was
// unreachable code. Reproduced with an injected provider on chain 1: the UI showed the
// green "Arc Testnet" pill, no warning, no switch button.
//
// ── WHY IT IS PURE AND LIVES HERE ─────────────────────────────────────────────
//
// Separated from the React hook so the fail-closed truth table can be walked without
// React, a DOM, a wallet, or a test framework -- see scripts/verify-guard.mts. It takes
// `arcId` as a parameter rather than importing the chain, which is what lets it have no
// imports at all.

export type ArcGuard =
  | { status: "disconnected"; canTransact: false; chainId: undefined }
  /** Connected, and BOTH sources agree the chain is Arc. The only transactable state. */
  | { status: "ok"; canTransact: true; chainId: number }
  /** Connected, and the chain is definitely something else. Offer the switch. */
  | { status: "wrong"; canTransact: false; chainId: number }
  /** Connected, but the chain is unconfirmed or the two sources disagree. Not usable. */
  | { status: "unknown"; canTransact: false; chainId: number | undefined };

/**
 * The ONLY input shape yielding `canTransact: true` is the one where both independent
 * sources positively agree on Arc. Every other shape -- including both "we don't know"
 * shapes -- is unusable.
 *
 * That asymmetry is the point: absence of a negative is not confirmation. The original
 * bug was precisely a check that concluded "usable" from having seen nothing wrong.
 */
export function resolveArcGuard({
  isConnected,
  accountChainId,
  probedChainId,
  arcId,
}: {
  isConnected: boolean;
  /** From `useAccount().chainId` -- the CONNECTION's chain. Not `useChainId()`. */
  accountChainId: number | undefined;
  /** Second, independent source: `eth_chainId` asked of the connector's provider. */
  probedChainId: number | undefined;
  arcId: number;
}): ArcGuard {
  if (!isConnected) {
    return { status: "disconnected", canTransact: false, chainId: undefined };
  }

  // Connected but wagmi has not reported a chain. Fail closed.
  if (accountChainId === undefined) {
    return { status: "unknown", canTransact: false, chainId: probedChainId };
  }

  // Definitely not Arc. This is the case useChainId() could never see.
  if (accountChainId !== arcId) {
    return { status: "wrong", canTransact: false, chainId: accountChainId };
  }

  // wagmi says Arc. Require the provider to agree before allowing a transaction.
  if (probedChainId === undefined) {
    return { status: "unknown", canTransact: false, chainId: accountChainId };
  }
  if (probedChainId !== arcId) {
    return { status: "wrong", canTransact: false, chainId: probedChainId };
  }

  return { status: "ok", canTransact: true, chainId: arcId };
}
