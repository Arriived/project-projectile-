// App shell and routes.
//
// The token page is at /t/:address and is DEEP-LINKABLE. A launchpad whose token pages
// are not shareable URLs is broken -- sharing a token is the primary way anyone arrives.

import { Routes, Route, Link, Navigate } from "react-router-dom";
import { WalletBar } from "./components/WalletBar";
import { TokenPage } from "./routes/TokenPage";
import { useChain } from "./providers/ChainProvider";
import { arc } from "./chain";

export function App() {
  const { guard, inAutoPrompt } = useChain();

  // Suppressed while the automatic prompt is open: the user is mid-fix with a wallet
  // popup in front of them, and alarming them about the state that popup exists to
  // resolve is noise.
  const showBanner = guard.status !== "disconnected" && !guard.canTransact && !inAutoPrompt;

  return (
    <div className="page">
      <header className="topbar">
        <Link to="/" className="brand">
          Ballista <span className="brand-sub">Arc Testnet</span>
        </Link>
        <nav className="nav">
          <Link to="/">Explore</Link>
        </nav>
        <WalletBar />
      </header>

      {showBanner && (
        <div className="banner banner-warn" role="alert">
          <strong>
            {guard.status === "wrong"
              ? `Your wallet is on chain ${guard.chainId}, not ${arc.name}.`
              : "Your wallet's network could not be confirmed."}
          </strong>{" "}
          Nothing can be signed until it is switched. Everything on the page is read from{" "}
          {arc.name} directly and is unaffected.
          {/* Wallets scope networks PER SITE. MetaMask's main selector can read
              "Ethereum" while this origin is permitted something else, and it is the
              per-site one that governs what gets signed. That mismatch cost a full
              debugging round. */}
          <span className="banner-aside">
            Seeing a different network in your wallet? Check the network it lists for{" "}
            <strong>this site</strong>, not the main selector — wallets can scope networks
            per site, and the per-site one is what counts here.
          </span>
        </div>
      )}

      <Routes>
        <Route path="/t/:address" element={<TokenPage />} />
        {/* Phase 3. Until it exists, / redirects nowhere useful, so it says so. */}
        <Route
          path="/"
          element={
            <main className="main">
              <p className="phase-note">
                <strong>Phase 2.</strong> The token page is built and live at{" "}
                <code>/t/:address</code>. The list page is Phase 3 and is not built yet —
                open a token by address to see the page.
              </p>
            </main>
          }
        />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </div>
  );
}
