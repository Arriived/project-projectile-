// Section 3 — price, market cap, and progress toward graduation.
//
// The progress figure comes from `graduationProgressBps(token)` ON THE CONTRACT, not from
// arithmetic here. Same rule as quotes: the contract exposes it, so call it. The local
// helper in lib/curve.ts exists only for the list page, where per-token calls are not
// affordable and the indexer's approximate figures are display-only (trap 21).
//
// poolBoost is deliberately excluded from progress. It is added to the pool's USDC side
// at graduation but must NEVER count toward the threshold (CLAUDE.md §7A), and a bar that
// counted it would promise a graduation that is further away than it looks.

import type { TokenData } from "../../hooks/useCurve";
import { marketCapUsdc6 } from "../../hooks/useCurve";
import { fmtUsd, fmtUsdc } from "../../lib/format";
import { CurveState } from "../../lib/curve";
import { EXPLORER_URL } from "../../config";

export function PriceAndProgress({ data }: { data: TokenData }) {
  const { curve, totalSupply, progressBps } = data;
  if (!curve) return null;

  const mcap =
    totalSupply !== undefined ? marketCapUsdc6(curve, totalSupply) : undefined;

  const graduated = curve.state === CurveState.GRADUATED;
  const pct = progressBps !== undefined ? progressBps / 100 : null;

  return (
    <section className="card">
      <div className="stat-row">
        <div className="stat">
          <div className="stat-label">Market cap</div>
          <div className="stat-value">{mcap === undefined ? "…" : fmtUsd(mcap)}</div>
        </div>
        <div className="stat">
          <div className="stat-label">In the curve</div>
          <div className="stat-value">{fmtUsd(curve.realUsdcReserves)}</div>
        </div>
        <div className="stat">
          <div className="stat-label">Threshold</div>
          <div className="stat-value">{fmtUsd(curve.graduationThresholdUsdc)}</div>
        </div>
      </div>

      {graduated ? (
        <p className="graduated-note">
          <strong>Graduated.</strong> Trading has moved to the DEX pool.{" "}
          <a href={`${EXPLORER_URL}/address/${curve.token}`} target="_blank" rel="noreferrer">
            View the token on the explorer ↗
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
          <span className="progress-pct">{pct === null ? "…" : `${pct.toFixed(1)}%`}</span>
        </div>
      )}

      {curve.poolBoostEnabled && curve.poolBoost > 0n && (
        <p className="hint">
          Pool boost: {fmtUsdc(curve.poolBoost)} USDC will be added to the pool at
          graduation. It does not count toward the threshold above, and no holder receives
          it — it makes the pool deeper.
        </p>
      )}
    </section>
  );
}
