// wagmi configuration.
//
// ── NO GENERIC INJECTED CONNECTOR AS A REAL OPTION ────────────────────────────
//
// `injected()` binds to `window.ethereum`, which is CONTESTED when more than one wallet
// extension is installed. Measured on a real machine with MetaMask and Phantom: two
// providers announced via EIP-6963, `window.ethereum` carried a contested `providers[]`,
// and the two answered `eth_chainId` DIFFERENTLY -- Phantom 0x1, MetaMask 0x4cef52. The
// chain guard was therefore reading one wallet while the user watched another, which is
// why neither the automatic prompt nor the switch button worked.
//
// The fix is EIP-6963 discovery, which wagmi does by default
// (`multiInjectedProviderDiscovery`, true unless disabled). It builds one connector per
// announced wallet, each bound to that wallet's own provider object:
//
//     injected({ target: { ...info, id: info.rdns, provider } })
//
// so `connector.getProvider()` returns the same wallet the connection is bound to.
// lib/wallets.ts drops the generic connector from the UI whenever any discovered wallet
// exists -- see there for why it is kept in the config at all.
//
// WalletConnect is still deferred: rule 8 / trap 17 record that Arc is not in the
// WalletConnect chain registry, so every mobile user hits a `wallet_addEthereumChain`
// prompt on first connect, and that needs handling in the connect step rather than
// appearing mid-trade. It also needs a projectId we do not have.

import { createConfig, http } from "wagmi";
import { injected } from "wagmi/connectors";
import { arc } from "./chain";

export const config = createConfig({
  chains: [arc],

  // Explicit, though it is the default: this is the mechanism the fix depends on, and a
  // future edit turning it off would silently restore the contested-provider bug.
  multiInjectedProviderDiscovery: true,

  connectors: [
    // LAST-RESORT FALLBACK ONLY, and hidden by lib/wallets.ts whenever any EIP-6963
    // wallet is discovered. It exists for a wallet too old to announce itself, where
    // `window.ethereum` is uncontested by definition because nothing else is there to
    // contest it. Never offer this alongside named wallets: "Injected" tells a user
    // nothing about which extension they would get.
    //
    // `shimDisconnect` keeps an explicit disconnect from being undone by the page
    // reloading and the wallet reporting itself still authorised.
    injected({ shimDisconnect: true }),
  ],

  transports: {
    // JSON-RPC batching is left OFF, which is viem's default for http().
    //
    // CLAUDE.md carries a standing rule that "Arc RPC requires batchMaxCount: 1". That
    // was measured on 29 August 2026 to be at least not universally true any more -- a
    // 2-request batch to this host returned HTTP 200 with both results. But the rule was
    // recorded without its evidence, only one batch size was tested, none of it under
    // load, and rate limiting on this endpoint is documented as real and severe. The
    // safe posture is free here, so take it.
    [arc.id]: http(undefined, { batch: false }),
  },
});

declare module "wagmi" {
  interface Register {
    config: typeof config;
  }
}
