// Phase 1 shell: connect a wallet, switch to Arc, and prove a read against the frozen
// factory. Nothing else -- no token page, no list, no trading.

import { WalletBar } from "./components/WalletBar";
import { FactoryReadProof } from "./components/FactoryReadProof";

export function App() {
  return (
    <div className="page">
      <header className="topbar">
        <div className="brand">
          Ballista <span className="brand-sub">Arc Testnet</span>
        </div>
        <WalletBar />
      </header>

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
