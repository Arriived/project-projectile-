// Which wallet connectors to offer, and why the generic one is dangerous.
//
// ── THE BUG THIS EXISTS TO PREVENT ────────────────────────────────────────────
//
// The app used wagmi's generic `injected()` connector, which binds to
// `window.ethereum`. With two wallet extensions installed, `window.ethereum` is
// CONTESTED -- whichever extension wins the race owns it, and the loser is invisible
// there. Measured on a real machine with MetaMask and Phantom installed: two providers
// announced via EIP-6963, `window.ethereum` carried a contested `providers[]` array, and
// probing the two gave DIFFERENT ANSWERS -- Phantom said 0x1, MetaMask said 0x4cef52.
//
// So the chain guard was reading one wallet while the user was looking at another. That
// is why the automatic prompt never fired (the guard's probe returned a chain from the
// wrong extension) and why the switch failed. It also explains the error message: the
// generic connector is named "Injected", and it was the one being asked to switch.
//
// ── THE PROPERTY THAT FIXES IT ────────────────────────────────────────────────
//
// EIP-6963 gives every wallet its own provider object and a stable `rdns` identifier.
// wagmi discovers them (multiInjectedProviderDiscovery, on by default) and builds one
// connector per wallet:
//
//     injected({ target: { ...info, id: info.rdns, provider } })
//
// That connector is bound to THAT provider object, not to `window.ethereum`. So
// `connector.getProvider()` returns the same wallet the connection is bound to, by
// construction rather than by luck -- which is exactly the property that was missing.
//
// The generic connector is therefore never offered when a discovered one exists.

/** The subset of a wagmi connector this module needs. Keeps the logic testable. */
export type WalletChoice = {
  uid: string;
  id: string;
  name: string;
  icon?: string;
  /** Present only on EIP-6963-discovered connectors. Its absence is the danger signal. */
  rdns?: string | readonly string[];
};

/** wagmi's generic injected connector, the one bound to contested `window.ethereum`. */
export const GENERIC_INJECTED_ID = "injected";

/** WalletConnect. Not an extension, not EIP-6963, and deliberately handled separately. */
export const WALLETCONNECT_ID = "walletConnect";

export function isGenericInjected(c: WalletChoice): boolean {
  return c.id === GENERIC_INJECTED_ID;
}

export function isWalletConnect(c: WalletChoice): boolean {
  return c.id === WALLETCONNECT_ID;
}

/**
 * Was this connector produced by EIP-6963 discovery?
 *
 * `rdns` is the signal, and it is the ONLY honest one: it is present exactly when a wallet
 * announced itself, which is exactly when `window.ethereum` might be contested.
 */
export function isDiscovered(c: WalletChoice): boolean {
  if (c.rdns === undefined) return false;
  return Array.isArray(c.rdns) ? c.rdns.length > 0 : String(c.rdns).length > 0;
}

/**
 * Choose which connectors to present.
 *
 * If ANY EIP-6963 wallet was discovered, the generic connector is dropped entirely:
 * offering it alongside named wallets is offering a coin-flip between them, and a user
 * cannot tell from "Injected" which extension they would get.
 *
 * It survives only when nothing was discovered at all -- a wallet too old to announce
 * EIP-6963. There, `window.ethereum` is uncontested by definition (nothing else is
 * there to contest it), so the hazard does not apply.
 *
 * ── WHY THIS KEYS ON `rdns` AND NOT ON "IS IT THE INJECTED ONE" ────────────────
 *
 * It used to read `connectors.filter(c => !isGenericInjected(c))` and keep the generic
 * one only when that filter came back empty. That was correct while the ONLY connectors
 * were the generic one and discovered wallets -- and it silently breaks the moment a
 * connector exists that is neither.
 *
 * WalletConnect is exactly that connector. Under the old rule, a user with NO extension
 * installed and WalletConnect configured got `[generic, walletConnect]` -> `[walletConnect]`:
 * the last-resort fallback stripped by a connector that says nothing whatsoever about
 * whether `window.ethereum` is contested. An old injected-only wallet would have had no
 * way in, and nothing in the suite would have failed.
 *
 * The suppression is caused by DISCOVERY, so it must be conditioned on discovery.
 * WalletConnect is orthogonal: always offered when configured, never suppressing anything.
 */
export function selectWallets(connectors: readonly WalletChoice[]): WalletChoice[] {
  const anyDiscovered = connectors.some(isDiscovered);
  return anyDiscovered ? connectors.filter((c) => !isGenericInjected(c)) : connectors.slice();
}

/**
 * A human label for the connected wallet.
 *
 * With two extensions installed, "connected" is not enough information: the user needs to
 * know WHICH wallet is connected, because the address and chain they are looking at in
 * one extension may not be the ones the page is bound to. That ambiguity is what produced
 * the original bug, and the UI should not reproduce it.
 */
export function walletLabel(
  c: WalletChoice | undefined,
  /**
   * How to phrase the generic connector. Injected rather than hardcoded so this module
   * stays free of user-facing English and remains testable without an i18n runtime --
   * scripts/verify-wallets.mts calls it with a plain template.
   */
  unidentified: (name: string) => string = (n) => `${n} (unidentified wallet)`
): string {
  if (!c) return "";
  if (isGenericInjected(c)) return unidentified(c.name);
  return c.name;
}
