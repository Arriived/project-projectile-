// /about — the landing page's content, moved inside the app.
//
// ── WHAT THIS FILE IS AND IS NOT ──────────────────────────────────────────────
//
// The original ballista.trading landing page is NOT in this repository and was not
// available on this machine, so its marketing prose, meta tags and favicon set have not
// been ported. What is here is the STRUCTURE plus the three corrections the port was
// required to make, built correctly from the start rather than carried across and fixed:
//
//   1. No Uniswap VERSION is claimed anywhere. Mainnet ships V2 with LP burned to
//      0x...dEaD; V4 is post-launch work via the router timelock. The landing page said
//      "Uniswap v4" in five places. Shipping a public claim the contract contradicts is
//      the worst failure available to this project, so scripts/verify-claims.mts fails
//      the build on any versioned mention rather than relying on anyone remembering.
//   2. The countdown is pinned to an explicit UTC instant, not `new Date("September 16,
//      2026 23:00:00")` -- that parses as LOCAL time, so visitors in different timezones
//      counted to different moments. The 23:00 figure was also unsourced: Circle has
//      published a mainnet DATE and no time. So this counts to 00:00 UTC and says so.
//   3. There is a terminal state. The original rendered 00:00:00:00 forever once it hit
//      zero.

import { Link } from "react-router-dom";
import { useEffect, useState } from "react";
import { useT } from "../i18n";
import { FACTORY_ADDRESS, EXPLORER_URL } from "../config";
import { arc } from "../chain";

/**
 * Arc mainnet, 16 September 2026, pinned to an explicit UTC instant.
 *
 * CLAUDE.md records the date as "confirmed, external, immovable". It does NOT record a
 * time, and Circle has published none -- so a specific hour would be invented precision.
 * Midnight UTC is the honest reading of a date-only announcement, and the label says
 * "UTC" so nobody has to guess which midnight.
 */
const MAINNET_UTC = Date.UTC(2026, 8, 16, 0, 0, 0); // month is 0-indexed: 8 = September

type Remaining = { d: number; h: number; m: number; s: number } | null;

function remaining(nowMs: number): Remaining {
  const ms = MAINNET_UTC - nowMs;
  if (ms <= 0) return null; // terminal state
  const s = Math.floor(ms / 1000);
  return {
    d: Math.floor(s / 86400),
    h: Math.floor((s % 86400) / 3600),
    m: Math.floor((s % 3600) / 60),
    s: s % 60,
  };
}

export function About() {
  const { t } = useT();
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const left = remaining(now);
  const pad = (n: number) => String(n).padStart(2, "0");

  return (
    <main className="main about">
      <section className="about-hero">
        <div className="eyebrow">{t("about.eyebrow")}</div>
        <h1>{t("about.headline")}</h1>
        <p className="about-lede">{t("about.lede")}</p>

        {/* Terminal state, which the original did not have -- at zero it rendered
            00:00:00:00 indefinitely. */}
        {left === null ? (
          <div className="countdown-done">
            <strong>{t("about.launched")}</strong>{" "}
            <Link to="/">{t("about.launchedCta")}</Link>
          </div>
        ) : (
          <div className="countdown" role="timer" aria-live="off">
            <div className="countdown-cells">
              {(
                [
                  ["d", left.d, t("about.days")],
                  ["h", left.h, t("about.hours")],
                  ["m", left.m, t("about.minutes")],
                  ["s", left.s, t("about.seconds")],
                ] as const
              ).map(([k, v, label]) => (
                <div className="countdown-cell" key={k}>
                  <div className="countdown-num">{k === "d" ? v : pad(v)}</div>
                  <div className="eyebrow">{label}</div>
                </div>
              ))}
            </div>
            {/* The timezone is stated. Without it the same page counts to different
                moments for different readers. */}
            <div className="hint countdown-note">{t("about.countdownNote")}</div>
          </div>
        )}
      </section>

      <section className="card">
        <h2 className="card-title">{t("about.howTitle")}</h2>
        <ol className="about-steps">
          <li>{t("about.step1")}</li>
          <li>{t("about.step2")}</li>
          <li>{t("about.step3")}</li>
          {/* No Uniswap VERSION. Mainnet ships V2, LP burned; V4 is post-launch. */}
          <li>{t("about.step4")}</li>
        </ol>
      </section>

      <section className="card">
        <h2 className="card-title">{t("about.verifyTitle")}</h2>
        <p>{t("about.verifyBody")}</p>
        <dl className="kv">
          <dt>{t("about.contract")}</dt>
          <dd className="mono small">
            <a href={`${EXPLORER_URL}/address/${FACTORY_ADDRESS}`} target="_blank" rel="noreferrer">
              {FACTORY_ADDRESS}
            </a>
          </dd>
          <dt>{t("about.network")}</dt>
          <dd className="mono small">
            {arc.name} · {t("about.chainId", { id: arc.id })}
          </dd>
          <dt>{t("about.gasToken")}</dt>
          <dd className="mono small">{t("about.gasTokenValue")}</dd>
        </dl>
      </section>

      <section className="card">
        <h2 className="card-title">{t("about.risksTitle")}</h2>
        <p>{t("about.risksBody")}</p>
      </section>

      <footer className="about-footer eyebrow">
        {/* Was "ARC · USDC · UNISWAP V4". No version. */}
        {t("about.footerChips")}
      </footer>
    </main>
  );
}
