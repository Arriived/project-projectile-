// Section 5 — the trust panel.
//
// Every figure is read PER TOKEN from `curves()` (trap 18). Fees are snapshotted at
// creation and the defaults are owner-settable at any time, so a global figure would be
// wrong for any token launched before a change.
//
// "Creator bought X% at launch" is NOT optional and NOT collapsed. The 2.5% cap limits
// only the PRIVILEGED launch-buy path -- nothing stops a creator buying more from a
// second address -- so disclosure is the actual protection, not the cap (CLAUDE.md §7A).

import type { TokenData } from "../../hooks/useCurve";
import { fmtBps, shortAddress } from "../../lib/format";
import { EXPLORER_URL } from "../../config";

const BURN_ADDRESS = "0x000000000000000000000000000000000000dEaD";

export function TrustPanel({ data }: { data: TokenData }) {
  const { curve } = data;
  if (!curve) return null;

  const lpBurned = curve.lpRecipient.toLowerCase() === BURN_ADDRESS.toLowerCase();

  // Creator's launch buy as a share of curve supply. The denominator is read from
  // CURVE_TOKEN_SUPPLY() rather than hardcoded: the 807M/193M split is load-bearing for
  // the flash-loan bound (CLAUDE.md §1.2), and a constant copied into the frontend would
  // silently diverge from the contract if it ever moved. Undefined until it loads --
  // shown as "…" rather than as a confident 0, which would read as "creator bought
  // nothing" on a token where they bought plenty.
  const creatorBps =
    data.curveSupply && data.curveSupply > 0n
      ? Number((curve.creatorLaunchPurchased * 10_000n) / data.curveSupply)
      : null;

  return (
    <section className="card">
      <h2 className="card-title">What the contract guarantees</h2>

      <dl className="kv">
        <dt>Buy fee</dt>
        <dd>
          {fmtBps(curve.buyFeeBps)}{" "}
          <span className="hint">
            ({fmtBps(curve.creatorBuyFeeBps)} of it to the creator)
          </span>
        </dd>

        <dt>Sell fee</dt>
        <dd>
          {fmtBps(curve.sellFeeBps)}{" "}
          <span className="hint">
            ({fmtBps(curve.creatorSellFeeBps)} of it to the creator)
          </span>
        </dd>

        <dt>Creator bought at launch</dt>
        <dd>
          {creatorBps === null ? (
            <>…</>
          ) : creatorBps === 0 ? (
            <>Nothing — the creator did not use their launch allocation.</>
          ) : (
            <strong>{(creatorBps / 100).toFixed(2)}% of curve supply</strong>
          )}
          <div className="hint">
            This covers only the creator’s privileged untaxed buy. It is not a cap on what
            they hold — nothing stops anyone buying more from another address.
          </div>
        </dd>

        <dt>LP at graduation</dt>
        <dd>
          {lpBurned ? (
            <>
              <strong>Auto-burned</strong>{" "}
              <span className="hint">sent to {shortAddress(BURN_ADDRESS)}, unrecoverable</span>
            </>
          ) : (
            <>
              <strong>Sent to {shortAddress(curve.lpRecipient)}</strong>
              <div className="hint">
                Not burned. This LP is held by an address, not destroyed — a different
                claim, and a different trust assumption.
              </div>
            </>
          )}
        </dd>

        <dt>Creator</dt>
        <dd className="mono small">
          <a href={`${EXPLORER_URL}/address/${curve.creator}`} target="_blank" rel="noreferrer">
            {curve.creator}
          </a>
        </dd>

        <dt>Mint</dt>
        <dd>
          <strong>None.</strong> Supply is fixed at creation; the token has no mint
          function.
        </dd>
      </dl>
    </section>
  );
}
