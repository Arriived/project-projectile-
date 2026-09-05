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
  // Path 1: the connector DECLARES rdns. Some connector factories do.
  if (c.rdns !== undefined) {
    const ok = Array.isArray(c.rdns) ? c.rdns.length > 0 : String(c.rdns).length > 0;
    if (ok) return true;
  }

  // ⚠ PATH 2 EXISTS BECAUSE PATH 1 ALONE WAS ALWAYS FALSE IN REAL WAGMI, AND THE TESTS
  // COULD NOT SEE IT.
  //
  // wagmi builds an EIP-6963 connector as (createConfig.js, providerDetailToConnector):
  //
  //     injected({ target: { ...info, id: info.rdns, provider } })
  //
  // and the injected() factory NEVER sets a top-level rdns -- grep it, zero hits. So a
  // discovered MetaMask arrives as { id: "io.metamask", name: "MetaMask", rdns: undefined }.
  // Path 1 therefore returned false for EVERY connector, anyDiscovered was never true, and
  // the generic "Injected" entry was never suppressed. Observed on the live preview:
  // "Injected / WalletConnect / MetaMask / Phantom" -- the exact list this function exists
  // to prevent.
  //
  // The suite stayed green because its fixtures set rdns by hand, so the doubles carried a
  // property the real objects do not. Same shape as the four chain-guard rounds that passed
  // against an injected fake and failed against real MetaMask every time.
  //
  // The honest signal in real wagmi is the ID: a discovered connector's id IS the rdns, a
  // reverse-DNS name that always contains a dot ("io.metamask", "app.phantom"). Every
  // non-discovered id is a bare camelCase word -- "injected", "walletConnect", "metaMask",
  // "coinbaseWallet" -- and none contains a dot.
  return typeof c.id === "string" && c.id.includes(".");
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

/**
 * What kind of entry this is, for the badge next to its name.
 *
 * ⚠ THE BADGE IS DERIVED FROM `isDiscovered`, NOT FROM A NAME OR AN ICON. A wallet is
 * "installed" exactly when it announced itself over EIP-6963 — that is what discovery
 * means, and it is the same signal the dedupe rule turns on. Guessing from the name
 * ("does it say MetaMask?") would be wrong on the one machine that matters: Phantom wins
 * `window.ethereum` in a two-extension environment, so the generic entry named "Injected"
 * may BE Phantom, and a name-based rule would label it MetaMask or mark it installed when
 * we do not know what it is.
 *
 *   "installed"  discovered over EIP-6963. A real extension, present right now, and we
 *                are bound to ITS provider object rather than to contested window.ethereum.
 *   "qr"         WalletConnect. Not installed, not an extension — it pairs by QR or deep
 *                link, and on a phone it is the ONLY path a user has.
 *   "unknown"    the generic injected fallback. Something is at window.ethereum but it did
 *                not announce itself, so we cannot say WHICH wallet it is. Deliberately not
 *                labelled "installed": that would assert an identity we do not have.
 */
export type WalletBadge = "installed" | "qr" | "unknown";

export function walletBadge(c: WalletChoice): WalletBadge {
  if (isWalletConnect(c)) return "qr";
  if (isDiscovered(c)) return "installed";
  return "unknown";
}

/**
 * A one- or two-character stand-in when a wallet ships no icon.
 *
 * ⚠ Built from the NAME, which is wallet-supplied and therefore attacker-influenced in
 * principle: any extension may announce itself with any `name`. It is rendered as text
 * content, never as markup or a URL, and clipped to two characters, so the worst a hostile
 * name can do here is show two odd glyphs. Uses Array.from rather than slice so an emoji
 * or a non-BMP character is not cut in half into a lone surrogate.
 */
export function walletInitials(name: string): string {
  const cleaned = name.replace(/[^\p{L}\p{N}]/gu, "");
  return Array.from(cleaned).slice(0, 2).join("").toUpperCase() || "?";
}
