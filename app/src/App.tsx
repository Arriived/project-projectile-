// Phase 1 shell: connect a wallet, switch to Arc, and prove a read against the frozen
// factory. Nothing else -- no token page, no list, no trading.

import { WalletBar } from "./components/WalletBar";
import { FactoryReadProof } from "./components/FactoryReadProof";
import { useChain } from "./providers/ChainProvider";
import { arc } from "./chain";

export function App() {
  const { guard, inAutoPrompt } = useChain();

  // The banner is suppressed while the automatic prompt is open. The user is mid-fix and
  // has a wallet popup in front of them; alarming them about the state that popup exists
  // to resolve is noise, and if they accept they should never have seen it at all.
  const showBanner = guard.status !== "disconnected" && !guard.canTransact && !inAutoPrompt;

  return (
    <div className="page">
      <header className="topbar">
        <div className="brand">
          Ballista <span className="brand-sub">Arc Testnet</span>
        </div>
        <WalletBar />
      </header>

      {/* Stated in the body, not only in the header bar. A warning that lives only in a
          corner is one a user scrolls past -- and by Phase 2 this sits above a buy
          button. Reads are unaffected (they are pinned to Arc) and stay visible, because
          showing correct chain data is not the same as letting someone act on it. */}
      {showBanner && (
        <div className="banner banner-warn" role="alert">
          <strong>
            {guard.status === "wrong"
              ? `Your wallet is on chain ${guard.chainId}, not ${arc.name}.`
              : "Your wallet's network could not be confirmed."}
          </strong>{" "}
          Nothing can be signed until it is switched. The data below is read from{" "}
          {arc.name} directly and is unaffected.
        </div>
      )}

      <main className="main">
        <p className="phase-note">
          <strong>Phase 1 scaffold.</strong> Wallet connection, chain switching, and a
          live read against the deployed factory. Trading is not built yet.
        </p>
        <FactoryReadProof />
      </main>
    </div>
  );
}
