// /about — the landing page, ported into the app.
//
// The app now holds the apex; this is where the landing page's content lives. Structure,
// copy and visual treatment are the original's. Three things were corrected in the port
// rather than carried across:
//
//   1. NO UNISWAP VERSION. The original said "Uniswap v4" in five places -- meta
//      description, hero copy, section 04 body, the fourth graduation step, and the
//      footer chips. Mainnet ships the V2 router with LP burned to 0x...dEaD; V4 is
//      post-launch via the 24h router timelock (CLAUDE.md §6). A public, checkable claim
//      the deployed contract contradicts is the worst failure available to a project whose
//      stated moat is verifiability -- so scripts/verify-claims.mts now fails the build on
//      one rather than relying on anyone re-reading five files.
//
//   2. THE COUNTDOWN IS PINNED TO UTC. `new Date("September 16, 2026 23:00:00")` parses as
//      LOCAL time, so the same page counted to a different instant for every visitor. The
//      23:00 was also unsourced -- Circle published a date, not a time -- so a specific
//      hour was precision we do not have. Midnight UTC, and the zone is on screen.
//
//   3. THERE IS A TERMINAL STATE. The original rendered 00:00:00:00 indefinitely once it
//      reached zero, on the single day it most needed to say something else.
//
// The reveal-on-scroll treatment is kept, gated on prefers-reduced-motion.

import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useT } from "../i18n";

/** X, Telegram and Discord, carried from the landing page's nav and footer. */
const SOCIALS = [
  { key: "x", label: "X ↗", href: "https://x.com/BallistaTrading" },
  { key: "tg", label: "TG ↗", href: "https://t.me/BallistaTrading" },
  { key: "dc", label: "DISCORD ↗", href: "https://discord.gg/84dy2rAXCd" },
] as const;

/**
 * Arc mainnet, 16 September 2026, as an explicit UTC instant.
 *
 * CLAUDE.md records the date as confirmed, external and immovable. It records no time,
 * and neither does Circle. Midnight UTC is the honest reading of a date-only
 * announcement; the label says UTC so nobody has to guess which midnight.
 */
const MAINNET_UTC = Date.UTC(2026, 8, 16, 0, 0, 0); // month is 0-indexed: 8 = September

function remaining(nowMs: number) {
  const ms = MAINNET_UTC - nowMs;
  if (ms <= 0) return null;
  const s = Math.floor(ms / 1000);
  return {
    d: Math.floor(s / 86400),
    h: Math.floor((s % 86400) / 3600),
    m: Math.floor((s % 3600) / 60),
    s: s % 60,
  };
}

/** Reveal on scroll, disabled outright when the reader asks for reduced motion. */
function useReveal<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  const [shown, setShown] = useState(false);

  useEffect(() => {
    const reduced =
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (reduced || !ref.current) {
      setShown(true);
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            setShown(true);
            io.disconnect();
          }
        }
      },
      { threshold: 0.12 }
    );
    io.observe(ref.current);
    return () => io.disconnect();
  }, []);

  return { ref, className: shown ? "reveal visible" : "reveal" };
}

function Section({
  n,
  eyebrow,
  title,
  body,
  children,
  id,
}: {
  n: string;
  eyebrow: string;
  title: string;
  body: string;
  children?: React.ReactNode;
  id?: string;
}) {
  const reveal = useReveal<HTMLDivElement>();
  return (
    <section className="lp-section" id={id}>
      <div className="lp-grid">
        <div className="lp-number">{n}</div>
        <div ref={reveal.ref} className={`lp-content ${reveal.className}`}>
          <div className="eyebrow">{eyebrow}</div>
          <h2 className="lp-title">{title}</h2>
          <p className="lp-desc">{body}</p>
          {children}
        </div>
      </div>
    </section>
  );
}

export function About() {
  const { t } = useT();
  const [now, setNow] = useState(() => Date.now());
  const heroReveal = useReveal<HTMLDivElement>();
  const futureReveal = useReveal<HTMLDivElement>();

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const left = remaining(now);
  const pad = (n: number) => String(n).padStart(2, "0");

  return (
    <div className="lp">
      {/* HERO */}
      <section className="lp-hero">
        <div className="lp-hero-top">
          <div className="eyebrow">{t("about.heroIndex")}</div>
          <div className="eyebrow lp-hero-loc">
            {t("about.heroLocation")}
            <br />
            {t("about.heroLocation2")}
          </div>
        </div>

        <h1 className="lp-hero-title">{t("about.heroTitle")}</h1>

        <div ref={heroReveal.ref} className={heroReveal.className}>
          <div className="lp-statement">
            {t("about.heroStatement")} <span>{t("about.heroStatementMuted")}</span>
          </div>

          <div className="lp-hero-bottom">
            {/* Was "graduate into Uniswap v4 liquidity". */}
            <p className="lp-hero-copy">{t("about.heroCopy")}</p>
            <Link to="/" className="lp-enter">
              {t("about.enter")}
              <span className="lp-arrow">→</span>
            </Link>
          </div>
        </div>
      </section>

      {/* COUNTDOWN */}
      <section className="lp-countdown-section">
        <div className="lp-countdown-row">
          <div className="eyebrow">{t("about.countdownLabel")}</div>

          {left === null ? (
            <div className="lp-launched">
              <strong>{t("about.launched")}</strong>{" "}
              <Link to="/">{t("about.launchedCta")}</Link>
            </div>
          ) : (
            <div className="lp-countdown" role="timer">
              {pad(left.d)}:{pad(left.h)}:{pad(left.m)}:{pad(left.s)}
            </div>
          )}

          <div className="eyebrow lp-countdown-label">
            {t("about.countdownDate")}
            <br />
            {t("about.countdownZone")}
          </div>
        </div>
        <div className="lp-countdown-note hint">{t("about.countdownNote")}</div>
      </section>

      <Section
        id="launch"
        n="01"
        eyebrow={t("about.s1Eyebrow")}
        title={t("about.s1Title")}
        body={t("about.s1Body")}
      >
        <div className="lp-mech">
          {[
            ["01", t("about.s1Step1"), t("about.s1Step1Detail")],
            ["02", t("about.s1Step2"), t("about.s1Step2Detail")],
            ["03", t("about.s1Step3"), t("about.s1Step3Detail")],
          ].map(([n, name, detail]) => (
            <div className="lp-mech-row" key={n}>
              <span className="lp-mech-n">{n}</span>
              <span className="lp-mech-name">{name}</span>
              <span className="lp-mech-detail">{detail}</span>
            </div>
          ))}
        </div>
      </Section>

      <Section
        id="market"
        n="02"
        eyebrow={t("about.s2Eyebrow")}
        title={t("about.s2Title")}
        body={t("about.s2Body")}
      >
        <div className="lp-market">
          <div className="lp-market-head">
            <span>{t("about.s2LiveLaunches")}</span>
            <span>{t("about.s2Attention")}</span>
          </div>
          {/* The status column (RISING / ACTIVE / EARLY) is REMOVED. Those were three
              states that exist nowhere in the contract and nowhere on the Phase 3 card --
              invented status labels, which is precisely the genus of thing this project
              criticises elsewhere. The bars alone imply nothing false.

              The whole board comes out once the list page is real; it is a placeholder
              for a live surface, and /about will link to / instead. */}
          {[
            ["01", "$ALPHA", 92],
            ["02", "$NOVA", 74],
            ["03", "$VOID", 51],
            ["04", "$ARCX", 29],
          ].map(([n, tok, w]) => (
            <div className="lp-market-item" key={String(n)}>
              <span className="lp-rank">{n}</span>
              <span className="lp-token">{tok}</span>
              <div className="lp-bar">
                <span style={{ width: `${w}%` }} />
              </div>
            </div>
          ))}
        </div>
        {/* The original labelled this too. Kept, and kept prominent: these are invented
            tickers, and an unlabelled mock market on a page about verifiability would
            undo the point of the page. */}
        <p className="eyebrow lp-demo">{t("about.s2Demo")}</p>
      </Section>

      <Section n="03" eyebrow={t("about.s3Eyebrow")} title={t("about.s3Title")} body={t("about.s3Body")} />

      <Section
        id="graduate"
        n="04"
        eyebrow={t("about.s4Eyebrow")}
        title={t("about.s4Title")}
        body={t("about.s4Body")}
      >
        <div className="lp-grad">
          {[
            ["01", t("about.s4Step1")],
            ["02", t("about.s4Step2")],
            ["03", t("about.s4Step3")],
            // Was "Uniswap v4".
            ["04", t("about.s4Step4")],
          ].map(([n, name]) => (
            <div className="lp-grad-step" key={n}>
              <span className="lp-grad-n">{n}</span>
              <span className="lp-grad-name">{name}</span>
            </div>
          ))}
        </div>
      </Section>

      <section className="lp-future">
        <div ref={futureReveal.ref} className={futureReveal.className}>
          <div className="eyebrow">{t("about.futureEyebrow")}</div>
          <h2 className="lp-future-title">{t("about.futureTitle")}</h2>
          <p className="lp-future-desc">{t("about.futureBody")}</p>
        </div>
      </section>

      <footer className="lp-footer">
        <div className="lp-footer-brand">{t("about.heroTitle")}</div>
        {/* Was "ARC · USDC · UNISWAP V4". */}
        <div className="eyebrow">{t("about.footerChips")}</div>
        <div className="lp-footer-links">
          {SOCIALS.map((s) => (
            <a key={s.key} href={s.href} target="_blank" rel="noopener noreferrer">
              {s.label}
            </a>
          ))}
        </div>
      </footer>
    </div>
  );
}
