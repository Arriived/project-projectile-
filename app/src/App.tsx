// App shell and routes.
//
// The token page is at /t/:address and is DEEP-LINKABLE. A launchpad whose token pages
// are not shareable URLs is broken -- sharing a token is the primary way anyone arrives.

import { Routes, Route, Link, Navigate } from "react-router-dom";
import { WalletBar } from "./components/WalletBar";
import { TokenPage } from "./routes/TokenPage";
import { useChain } from "./providers/ChainProvider";
import { arc } from "./chain";
import { useT } from "./i18n";

export function App() {
  const { t } = useT();
  const { guard, inAutoPrompt } = useChain();

  // Suppressed while the automatic prompt is open: the user is mid-fix with a wallet
  // popup in front of them, and alarming them about the state that popup exists to
  // resolve is noise.
  const showBanner = guard.status !== "disconnected" && !guard.canTransact && !inAutoPrompt;

  return (
    <div className="page">
      <header className="topbar">
        <Link to="/" className="brand">
          Ballista <span className="brand-sub">{arc.name}</span>
        </Link>
        <nav className="nav">
          <Link to="/">{t("common.explore")}</Link>
        </nav>
        <WalletBar />
      </header>

      {showBanner && (
        <div className="banner banner-warn" role="alert">
          <strong>
            {guard.status === "wrong"
              ? t("chain.bannerWrong", { chainId: guard.chainId ?? "?", chain: arc.name })
              : t("chain.bannerUnknown")}
          </strong>{" "}
          {t("chain.bannerBody", { chain: arc.name })}
          {/* Wallets scope networks PER SITE. MetaMask's main selector can read
              "Ethereum" while this origin is permitted something else, and it is the
              per-site one that governs what gets signed. That mismatch cost a full
              debugging round. */}
          <span className="banner-aside">{t("chain.bannerPerSite")}</span>
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
                <strong>{t("dev.phase2Title")}</strong> {t("dev.phase2Body")}
              </p>
            </main>
          }
        />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </div>
  );
}
