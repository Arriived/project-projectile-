// Why a network switch failed, when the honest answer is "the wallet never offered it".
//
// ── THE BUG THIS EXISTS TO NAME ───────────────────────────────────────────────
//
// wagmi's WalletConnect connector wraps its whole switch path in a try/catch and rethrows
// EVERYTHING as `UserRejectedRequestError`
// (@wagmi/connectors/dist/esm/walletConnect.js:286-288). So when the target chain is
// simply absent from the session the wallet approved, the UI says "Network switch
// declined — still on the wrong network" and blames the user for a prompt they never saw.
//
// That cost a full debugging session: a phone connected over WalletConnect, the app read
// chain 1 and chain 84156418, the switch control did nothing, and the error said the user
// had declined. Nobody had declined anything — 5042002 was not in the session's `eip155`
// namespace, so there was no chain to switch to.
//
// ⚠ THE ERROR NAME CANNOT DISCRIMINATE, which is exactly why this takes the session as an
// argument. A genuine rejection and a namespace miss arrive as the identical error type.
// The session's approved chains are the only thing that separates them.

/** The target we always want: Arc. Passed in rather than imported, so this stays pure. */
export type SwitchFailure =
  /** The chain is not in the session at all. The wallet was never asked, and never refused. */
  | { kind: "not-in-session"; target: number; offered: number[] }
  /** The chain WAS available and the user said no. The existing copy is correct here. */
  | { kind: "declined" }
  /** No session to reason about (injected wallet), or an error we cannot classify. */
  | { kind: "unknown" };

/**
 * The `eip155` entry of a WalletConnect v2 session's `namespaces`.
 *
 * ⚠ `chains` IS OPTIONAL IN PRACTICE AND THAT IS NOT A DEFENSIVE FLOURISH. The CAIP-25
 * response only guarantees `accounts`; plenty of wallets return a namespace with no
 * `chains` key at all, and the chain list then has to be derived from the CAIP-10 account
 * strings (`eip155:1:0xabc…`). A reader that trusts `chains` sees an empty list from those
 * wallets and would conclude "nothing is offered" about a perfectly good session.
 */
export type Eip155Namespace = {
  chains?: string[];
  accounts?: string[];
  methods?: string[];
  events?: string[];
};

/**
 * Every chain id the session actually authorises, as numbers.
 *
 * Reads `chains` when present and falls back to the namespace's `accounts`, which always
 * exist. Malformed entries are skipped rather than throwing: this runs while rendering an
 * error message, and a parser that throws there replaces one bad message with no page.
 */
export function sessionChainIds(ns: Eip155Namespace | undefined): number[] {
  if (!ns) return [];
  const out = new Set<number>();

  const take = (caip: string, parts: 2 | 3) => {
    const segs = caip.split(":");
    if (segs.length < parts) return;
    if (segs[0] !== "eip155") return;
    const n = Number(segs[1]);
    // ⚠ Number("") is 0 and Number("0x1") is 1 — neither is a chain id we were given, so
    // require the segment to be plain decimal digits before trusting it.
    if (!/^\d+$/.test(segs[1]) || !Number.isSafeInteger(n) || n <= 0) return;
    out.add(n);
  };

  for (const c of ns.chains ?? []) take(c, 2);
  for (const a of ns.accounts ?? []) take(a, 3);

  return [...out].sort((a, b) => a - b);
}

/**
 * Classify a failed switch.
 *
 * ⚠ ORDER MATTERS. The namespace check comes FIRST, because wagmi has already relabelled a
 * namespace miss as a user rejection — trusting the error name first would classify every
 * one of these as "declined" and reproduce the bug this file exists to fix.
 *
 * `unknown` is returned whenever there is no session to reason about, which keeps injected
 * wallets on the pre-existing behaviour rather than guessing about them.
 */
export function classifySwitchFailure(args: {
  error: { name?: string; message?: string } | null | undefined;
  namespace: Eip155Namespace | undefined;
  targetChainId: number;
}): SwitchFailure {
  const { error, namespace, targetChainId } = args;
  if (!error) return { kind: "unknown" };

  const offered = sessionChainIds(namespace);

  // A session we could read, that does not include the target. This is the informative case
  // and it outranks whatever the error claims to be.
  if (offered.length > 0 && !offered.includes(targetChainId)) {
    return { kind: "not-in-session", target: targetChainId, offered };
  }

  // Either the chain WAS offered (so a rejection is a real rejection), or there is no
  // session at all (injected wallet) and the error name is the best evidence available.
  if (error.name === "UserRejectedRequestError") return { kind: "declined" };

  return { kind: "unknown" };
}

/** `5042002` -> `"0x4cef52"`. For naming the chain the way a wallet displays it. */
export function chainIdHex(id: number): string {
  return `0x${id.toString(16)}`;
}
