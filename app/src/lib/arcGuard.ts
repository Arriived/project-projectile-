// The chain-guard decision, as a pure function with no imports.
//
// ── BUG 1: useChainId reads the CONFIG, not the WALLET ────────────────────────
//
// WalletBar originally used wagmi's `useChainId()`, which returns
// `config.state.chainId`. wagmi deliberately refuses to move config state to a chain it
// does not know (@wagmi/core createConfig.js, verbatim):
//
//     // If chain is not configured, then don't switch over to it.
//     const isChainConfigured = chains.getState().some((x) => x.id === chainId);
//     if (!isChainConfigured) return;
//
// With a single-chain config that made `chainId === arc.id` structurally always true and
// the wrong-network branch unreachable code. Fixed by reading the CONNECTION's chain.
//
// ── BUG 2: reading once and trusting it forever ───────────────────────────────
//
// The first fix still probed `eth_chainId` once on connect and then only on a
// `chainChanged` event. Reproduced with an injected provider: change the chain WITHOUT
// emitting `chainChanged` and the app made ZERO further reads -- the pill stayed green
// and transactable indefinitely while the wallet was on Ethereum Mainnet.
//
// An event you did not observe is not evidence of absence. Relying on `chainChanged`
// means trusting a wallet to tell you something, when the entire point of the guard is
// that a signature must not be offered on an unverified chain. The same defect explains
// "clicking switch turned it green": ANY path that concludes "on Arc" from something
// other than a present-tense reading is fail-open.
//
// ── THE RULE THIS ENCODES ─────────────────────────────────────────────────────
//
// `ok` requires a probe that is (a) present, (b) equal to Arc, and (c) RECENT. Staleness
// is treated exactly like disagreement. A switch handler therefore has no path to green:
// it cannot fabricate a fresh probe, so only the poller can turn the UI usable, and only
// by actually observing Arc. That is why the fix is structural rather than "re-read after
// switching" -- there is nothing left to remember to do.

export type ArcGuard =
  | { status: "disconnected"; canTransact: false; chainId: undefined }
  /** Connected, both sources agree on Arc, and the reading is fresh. Only usable state. */
  | { status: "ok"; canTransact: true; chainId: number }
  /** Connected, and the chain is definitely something else. Offer the switch. */
  | { status: "wrong"; canTransact: false; chainId: number }
  /** Unconfirmed: never probed, probe refused, sources disagree, or the reading is stale. */
  | { status: "unknown"; canTransact: false; chainId: number | undefined };

/**
 * How old a chain reading may be and still authorise a signature.
 *
 * The poller runs well inside this. The bound exists for when polling STOPS: browsers
 * throttle timers in background tabs, so a tab left open behind MetaMask can stop
 * reading, and the user then returns and clicks buy. Under a bound, that window reads as
 * `unknown` and is refused rather than acted on.
 */
export const MAX_PROBE_AGE_MS = 12_000;

export function resolveArcGuard({
  isConnected,
  accountChainId,
  probedChainId,
  probedAt,
  now,
  arcId,
  maxProbeAgeMs = MAX_PROBE_AGE_MS,
}: {
  isConnected: boolean;
  /** From `useAccount().chainId` -- the CONNECTION's chain. Not `useChainId()`. */
  accountChainId: number | undefined;
  /** Second, independent source: `eth_chainId` asked of the connector's provider. */
  probedChainId: number | undefined;
  /** When that probe was taken (ms epoch). Undefined means never. */
  probedAt: number | undefined;
  now: number;
  arcId: number;
  maxProbeAgeMs?: number;
}): ArcGuard {
  if (!isConnected) {
    return { status: "disconnected", canTransact: false, chainId: undefined };
  }

  // Connected but wagmi has not reported a chain. Fail closed.
  if (accountChainId === undefined) {
    return { status: "unknown", canTransact: false, chainId: probedChainId };
  }

  // Definitely not Arc. The case useChainId() could never see.
  if (accountChainId !== arcId) {
    return { status: "wrong", canTransact: false, chainId: accountChainId };
  }

  // wagmi says Arc. It is not enough on its own.
  if (probedChainId === undefined || probedAt === undefined) {
    return { status: "unknown", canTransact: false, chainId: accountChainId };
  }

  // A reading that disagrees wins, however old it is: it is positive evidence of a
  // different chain, whereas staleness is merely absence of evidence.
  if (probedChainId !== arcId) {
    return { status: "wrong", canTransact: false, chainId: probedChainId };
  }

  // Agreement, but the reading has gone stale. Not a lie -- just no longer a fact.
  if (now - probedAt > maxProbeAgeMs) {
    return { status: "unknown", canTransact: false, chainId: accountChainId };
  }

  return { status: "ok", canTransact: true, chainId: arcId };
}

/**
 * Whether to raise the automatic switch prompt on connect.
 *
 * A user who connects on the wrong chain should be offered the switch immediately rather
 * than being made to find a button. Accept it and they never see a wrong-network state at
 * all.
 *
 * Three constraints, and each one is a way this could misbehave:
 *
 *  - **Only on `wrong`, never on `unknown`.** `unknown` means we have not confirmed the
 *    chain yet -- typically the moment after connect, before the first probe returns.
 *    Prompting there would fire a wallet popup because of our own latency, on a user who
 *    may well be on Arc already.
 *
 *  - **Once per connection.** Keyed on connector + address, marked BEFORE the prompt is
 *    raised so a re-render (or React StrictMode's double-invoked effect) cannot raise a
 *    second one. After a rejection we do not try again: the operator's instruction is one
 *    prompt, then let them choose. Reconnecting is the user initiating, not us retrying,
 *    so it earns a fresh prompt.
 *
 *  - **Never while a switch is already in flight.** Otherwise a slow wallet collects a
 *    queue of identical popups.
 */
export function shouldAutoPromptSwitch({
  status,
  connectionKey,
  lastPromptedKey,
  isSwitching,
}: {
  status: ArcGuard["status"];
  /** Stable per connection: connector uid + address. Undefined when disconnected. */
  connectionKey: string | undefined;
  /** The key we last raised a prompt for, or null if none this session. */
  lastPromptedKey: string | null;
  isSwitching: boolean;
}): boolean {
  if (status !== "wrong") return false;
  if (!connectionKey) return false;
  if (isSwitching) return false;
  return lastPromptedKey !== connectionKey;
}
