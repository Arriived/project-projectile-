// wagmi configuration.
//
// Phase 1 is injected wallets only. WalletConnect is deliberately deferred: rule 8 /
// trap 17 record that Arc is not in the WalletConnect chain registry, so every mobile
// user hits a `wallet_addEthereumChain` prompt on first connect, and that needs handling
// in the connect step rather than appearing mid-trade. It also needs a projectId we do
// not have yet. Adding the connector without that work would produce exactly the
// unlabelled mid-flow popup the rule exists to prevent.

import { createConfig, http } from "wagmi";
import { injected, metaMask } from "wagmi/connectors";
import { arc } from "./chain";

export const config = createConfig({
  chains: [arc],
  connectors: [
    // `shimDisconnect` keeps an explicit disconnect from being undone by the page
    // reloading and the wallet reporting itself still authorised.
    injected({ shimDisconnect: true }),

    // Added for DIAGNOSIS, not yet chosen as the default. Real MetaMask reported
    // `"Injected" does not support programmatic chain switching`, which is wagmi's
    // SwitchChainNotSupportedError -- raised when the connector held in state has no
    // switchChain method. The generic injected() connector defines one, so the suspicion
    // is that state holds a stripped persistence shell rather than a live connector
    // (createConfig persists connections as { id, name, type, uid }, methods removed).
    //
    // metaMask() talks to MetaMask through its own SDK and declares capabilities
    // explicitly. Whether that actually helps is an empirical question, so both are
    // listed and /?diag can connect through either and compare. Ordering matters: the
    // app's WalletBar uses connectors[0], so injected() stays first and default
    // behaviour is unchanged until the diagnosis says otherwise.
    metaMask(),
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
