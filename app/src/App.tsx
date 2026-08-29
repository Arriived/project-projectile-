// Phase 1 shell: connect a wallet, switch to Arc, and prove a read against the frozen
// factory. Nothing else -- no token page, no list, no trading.

import { WalletBar } from "./components/WalletBar";
import { FactoryReadProof } from "./components/FactoryReadProof";
import { useArcGuard } from "./hooks/useArcGuard";
import { arc } from "./chain";

export function App() {
  const guard = useArcGuard();

  return (
    <div className="page">
      <header className="topbar">
        <div className="brand">
          Ballista <span className="brand-sub">Arc Testnet</span>
        </div>
        <WalletBar />
      </header>

      {/* The wrong-network state is stated in the body, not only in the header bar.
          A warning that lives only in a corner is a warning a user scrolls past --
          and by Phase 2 this banner is what sits above a buy button. Reads are
          unaffected (they are pinned to Arc) and stay visible, because showing
          correct chain data is not the same as letting someone act on it. */}
      {guard.status !== "disconnected" && !guard.canTransact && (
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
