// Section 3 — price, market cap, and progress toward graduation.
//
// The progress figure comes from `graduationProgressBps(token)` ON THE CONTRACT, not from
// arithmetic here. Same rule as quotes: the contract exposes it, so call it.
//
// poolBoost is deliberately excluded from progress. It is added to the pool's USDC side
// at graduation but must NEVER count toward the threshold (CLAUDE.md §7A), and a bar that
// counted it would promise a graduation that is further away than it looks.
//
// Every figure is formatted through the i18n layer, not toFixed(). Compact notation is
// where locales genuinely diverge -- en "123.46M", zh "1.23亿", ko "1.23억" -- so a
// hand-rolled K/M/B/T ladder would be wrong in two of the three configured locales.

import type { TokenData } from "../../hooks/useCurve";
import { marketCapUsdc6 } from "../../hooks/useCurve";
import { CurveState } from "../../lib/curve";
import { EXPLORER_URL } from "../../config";
import { useT } from "../../i18n";

export function PriceAndProgress({ data }: { data: TokenData }) {
  const { t, fmt } = useT();
  const { curve, totalSupply, progressBps } = data;
  if (!curve) return null;

  const mcap = totalSupply !== undefined ? marketCapUsdc6(curve, totalSupply) : undefined;
  const graduated = curve.state === CurveState.GRADUATED;
  const pct = progressBps !== undefined ? progressBps / 100 : null;

  return (
    <section className="card">
      {/* auto-fit grid, not a flex row: it holds 3 figures at 390px in two columns and
          absorbs a 4th or 5th on desktop without a breakpoint. The price-change slot the
          brief asked to leave open needs no markup here -- one more <div className="stat">
          and the grid re-flows. Nothing is rendered for it now: a dash or a placeholder
          would be a claim the data cannot back. */}
      <div className="stat-strip">
        {/* ⚠ NO MARKET CAP ONCE GRADUATED, AND NO NUMBER IN ITS PLACE.
            `graduate()` zeroes tokenReserves and realUsdcReserves (LFX1.sol:677-678) but
            NOT the virtual reserves, and marketCapUsdc6 divides the virtual pair. So this
            figure freezes at the final curve price and never moves again, while the real
            price is whatever the pool says.

            The value is REMOVED rather than relabelled. A number sitting in the market-cap
            slot, in the same type, beside live figures, is read as a market cap however it
            is captioned -- the same way the "~" marker fails to stop people acting on
            indexer figures. There is nothing to misread if there is no number.

            The real fix is reading the pool price, which is a feature and deliberately not
            done here. Until then the page says where the price lives instead of guessing
            at it. */}
        <div className="stat">
          <div className="stat-label">{t("price.marketCap")}</div>
          {graduated ? (
            <div className="stat-note">{t("price.marketCapGraduated")}</div>
          ) : (
            <div className="stat-value">{mcap === undefined ? "…" : `${fmt.usdcCompact(mcap)} USDC`}</div>
          )}
        </div>
        <div className="stat">
          <div className="stat-label">{t("price.inTheCurve")}</div>
          {/* Genuinely zero after graduation -- the contract zeroes it -- so the figure is
              true and is left alone. The graduated note below explains where it went. */}
          <div className="stat-value">{`${fmt.usdcCompact(curve.realUsdcReserves)} USDC`}</div>
        </div>
        <div className="stat">
          <div className="stat-label">{t("price.threshold")}</div>
          <div className="stat-value">{`${fmt.usdcCompact(curve.graduationThresholdUsdc)} USDC`}</div>
        </div>
        {!graduated && (
          <div className="stat">
            <div className="stat-label">{t("price.progressLabel")}</div>
            {/* Same source as the bar below -- graduationProgressBps() on the CONTRACT,
                never arithmetic here. */}
            <div className="stat-value">{pct === null ? "…" : fmt.pct(pct, 1)}</div>
          </div>
        )}
      </div>

      {graduated ? (
        <p className="graduated-note">
          <strong>{t("price.graduated")}</strong> {t("price.graduatedBody")}{" "}
          <a href={`${EXPLORER_URL}/address/${curve.token}`} target="_blank" rel="noreferrer">
            {t("price.viewOnExplorer")}
          </a>
        </p>
      ) : (
        <div className="progress-wrap">
          <div className="progress-track">
            <div
              className="progress-fill"
              style={{ width: `${Math.min(100, pct ?? 0)}%` }}
              role="progressbar"
              aria-valuenow={pct ?? 0}
              aria-valuemin={0}
              aria-valuemax={100}
            />
          </div>
          <span className="progress-pct">{pct === null ? "…" : fmt.pct(pct, 1)}</span>
        </div>
      )}

      {/* ⚠ A BAR AND A PERCENTAGE WITH NO MECHANISM IS A NUMBER NOBODY CAN ACT ON. This
          says what graduation IS. Written to pass verify:claims rather than around it:
          Uniswap is named WITHOUT a version (mainnet ships V2; V4 is post-launch via the
          router timelock) and the LP is described as BURNED, never "locked" -- locked is a
          different claim needing a locker contract that does not exist. */}
      {!graduated && <p className="hint grad-note">{t("price.graduationExplainer")}</p>}

      {curve.poolBoostEnabled && curve.poolBoost > 0n && (
        <p className="hint">{t("price.poolBoost", { amount: fmt.usdcExact(curve.poolBoost) })}</p>
      )}
    </section>
  );
}
