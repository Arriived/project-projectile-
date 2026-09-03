// App shell and routes.
//
// The token page is at /t/:address and is DEEP-LINKABLE. A launchpad whose token pages
// are not shareable URLs is broken -- sharing a token is the primary way anyone arrives.

import { Routes, Route, Link, Navigate, useLocation } from "react-router-dom";
import { WalletBar } from "./components/WalletBar";
import { useTheme } from "./providers/ThemeProvider";
import { TokenPage } from "./routes/TokenPage";
import { About } from "./routes/About";
import { Create } from "./routes/Create";
import { TokenList } from "./routes/TokenList";
import { useChain } from "./providers/ChainProvider";
import { arc } from "./chain";
import { useT } from "./i18n";

export function App() {
  const { t } = useT();
  const { guard, inAutoPrompt } = useChain();
  const { pathname } = useLocation();

  // Suppressed while the automatic prompt is open: the user is mid-fix with a wallet
  // popup in front of them, and alarming them about the state that popup exists to
  // resolve is noise.
  const showBanner = guard.status !== "disconnected" && !guard.canTransact && !inAutoPrompt;

  return (
    <div className="page">
      <header className="topbar">
        <Link to="/" className="brand">
          Ballista{" "}
          {/* ⚠ THE NETWORK INDICATOR MUST SURVIVE THE MOBILE BREAKPOINT. It was hidden
              outright at <=560px to recover header height, on the reasoning that the
              wallet pill already states the network -- but that pill only exists once a
              wallet is CONNECTED. An unconnected visitor on a phone had nothing telling
              them this is testnet, and after 16 September a mainnet deployment exists
              alongside this one. A testnet factory with a similar name is already
              recorded as an impersonation vector.

              So the label shortens rather than disappearing: the full chain name on
              desktop, its distinguishing last word on mobile. Both are DERIVED from
              arc.name, never hardcoded, so this cannot end up claiming the wrong network
              on a chain switch -- and if the name has no second word the short form is
              simply the name itself. */}
          <span className="brand-sub">
            <span className="brand-sub-full">{arc.name}</span>
            <span className="brand-sub-short">{arc.name.split(" ").slice(-1)[0]}</span>
          </span>
        </Link>
        {/* Thin nav: Explore and About only. No Forum -- comments are per-token and
            later, never a global one. No Analytics -- a real surface, but not before
            mainnet. */}
        <nav className="nav">
          <Link to="/" className={pathname === "/" ? "on" : undefined}>
            {t("common.explore")}
          </Link>
          <Link to="/about" className={pathname === "/about" ? "on" : undefined}>
            {t("common.about")}
          </Link>
        </nav>
        <ThemeToggle />
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
        <Route path="/create" element={<Create />} />
        <Route path="/about" element={<About />} />
        <Route path="/" element={<TokenList />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </div>
  );
}

/**
 * Light/dark toggle, beside Connect.
 *
 * Icon-only and 34px so it costs no header height -- the bar is already 61px on mobile and
 * that was hard-won. aria-label rather than a visible word for the same reason.
 */
function ThemeToggle() {
  const { theme, toggle } = useTheme();
  return (
    <button
      type="button"
      className="theme-toggle"
      onClick={toggle}
      aria-label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
      title={theme === "dark" ? "Light" : "Dark"}
    >
      {theme === "dark" ? "☀" : "☾"}
    </button>
  );
}

