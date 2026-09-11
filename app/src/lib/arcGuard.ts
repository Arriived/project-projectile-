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

// ── BUG 3: the RETURN TYPE of eth_chainId is not what EIP-1193 says ───────────
//
// The probe used to be `Number.parseInt(hex, 16)` on the raw answer, on the strength of
// EIP-695, which defines the result as a QUANTITY -- a `0x`-prefixed hex string. Injected
// wallets do return that. WalletConnect returns a NUMBER, and answers the call itself
// rather than forwarding it to the wallet (@walletconnect/universal-provider 2.24.0,
// dist/index.js, verbatim):
//
//     case"eth_chainId":return parseInt(this.getDefaultChain());
//
// `getDefaultChain()` returns a DECIMAL string, so the provider hands back the number
// 5042002. `Number.parseInt(5042002, 16)` coerces that back to the string "5042002" and
// reads it as hex: 84156418, which is 0x5042002 -- Arc's decimal digits re-read as hex.
// The guard then saw wagmi on Arc and the probe on 84156418, returned `wrong`, and
// DISABLED CREATE AND TRADE for every WalletConnect session. On mainnet the same line
// gives Number.parseInt(5042, 16) = 20546.
//
// Nothing was wrong with the derivation in chain.ts, and 84156418 appears nowhere in the
// repo, because it was computed rather than written. That is why it stayed unexplained:
// grepping for a bad VALUE finds nothing when the value is produced by an operation.
//
// The rule this encodes: normalise ONCE, here, and treat anything we cannot justify as
// absent rather than guessing at it.

/**
 * Turn a provider's `eth_chainId` answer into a chain id, or `undefined`.
 *
 * Accepts the two shapes that actually occur:
 *   - a `0x`-prefixed hex string  (EIP-695; injected wallets)
 *   - a number                    (WalletConnect's UniversalProvider)
 *
 * Everything else is `undefined`, which the guard reads as "not established" and refuses
 * on. That deliberately includes an UNPREFIXED string: "5042002" is both valid hex and
 * valid decimal, so reading it either way is the guess that caused this bug, and EIP-695
 * requires the prefix anyway. A bigint is excluded for the same reason -- no provider we
 * use returns one, and inventing a conversion for a shape we have never observed is how
 * the next wrong guess gets made.
 *
 * Failing closed here costs a banner saying the network is unconfirmed. Guessing costs a
 * chain id that is confidently wrong, which is what this replaces.
 */
export function normaliseChainId(raw: unknown): number | undefined {
  let n: number;

  if (typeof raw === "number") {
    n = raw;
  } else if (typeof raw === "string") {
    // Anchored, so trailing junk is rejected rather than silently truncated:
    // Number.parseInt("0x4cef52zzz", 16) is 5042002, which would launder a malformed
    // answer into a confident one.
    if (!/^0[xX][0-9a-fA-F]+$/.test(raw.trim())) return undefined;
    n = Number.parseInt(raw.trim(), 16);
  } else {
    return undefined;
  }

  // NaN, Infinity, a fraction, zero or a negative are all "not a chain id". The upper
  // bound is Number.isSafeInteger: past 2**53 the value cannot round-trip, and a chain id
  // we cannot represent exactly must not be compared for equality against arc.id.
  if (!Number.isSafeInteger(n) || n <= 0) return undefined;
  return n;
}

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
