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
import { shortAddress } from "../../lib/format";
import { AddressText } from "../AddressText";
import { useT } from "../../i18n";
import { EXPLORER_URL } from "../../config";

/**
 * A1. `lpRecipient` is a PER-CURVE SNAPSHOT taken at creation, not a global setting.
 *
 * There is a global owner setter (setLpRecipient) and an immutable per-curve snapshot.
 * One setter call splits the token population permanently: curves created before it burn,
 * curves after it do not, and neither can be migrated (CLAUDE.md §1.8). So a hardcoded
 * "LP Auto-Burned" would be a claim the contract may not honour for some tokens, with
 * nothing on screen distinguishing them.
 *
 * This reads curve.lpRecipient -- the snapshot for the VIEWED token -- and renders from
 * what it finds. Burned when it is the dead address; otherwise the actual recipient
 * address, unlabelled. No "Locked" label is invented for an address that cannot be
 * classified: "locked" is a claim about a contract we have not inspected, and the honest
 * move is to show the address and let the reader judge.
 */
const BURN_ADDRESS = "0x000000000000000000000000000000000000dEaD";

export function TrustPanel({ data }: { data: TokenData }) {
  const { t, fmt } = useT();
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
      <h2 className="card-title">{t("trust.title")}</h2>

      <dl className="kv">
        {/* Buy fee / sell fee moved to the trade panel, under "Estimated receive" -- a
            platform constant identical for every token belongs beside the trade it
            actually affects, not on a panel a viewer reads once. See TradePanel.tsx. */}
        <dt>{t("trust.creatorBought")}</dt>
        <dd>
          {creatorBps === null ? (
            <>…</>
          ) : creatorBps === 0 ? (
            <>
              {t("trust.creatorBoughtNone")}
              <span className="hint"> {t("trust.creatorBoughtNoneNote")}</span>
            </>
          ) : (
            <strong>{t("trust.creatorBoughtPct", { pct: fmt.pct(creatorBps / 100) })}</strong>
          )}
          <div className="hint">{t("trust.creatorBoughtNote")}</div>
        </dd>

        <dt>{t("trust.lpAtGraduation")}</dt>
        <dd>
          {lpBurned ? (
            <>
              <strong>{t("trust.lpBurned")}</strong>{" "}
              <span className="hint">
                {t("trust.lpBurnedNote", { address: shortAddress(curve.lpRecipient) })}
              </span>
            </>
          ) : (
            <>
              <strong>{t("trust.lpSentTo", { address: shortAddress(curve.lpRecipient) })}</strong>
              <div className="hint">{t("trust.lpSentNote")}</div>
            </>
          )}
        </dd>

        <dt>{t("trust.creator")}</dt>
        <dd className="small">
          {/* Was a bare <a> with no copy affordance: the only way to get this off a phone
              was to hand-select 42 characters wrapped over four lines, and on iOS a
              long-press on a link copies the HREF, not the address. See lib/address.ts. */}
          <AddressText
            address={curve.creator}
            href={`${EXPLORER_URL}/address/${curve.creator}`}
          />
        </dd>

        <dt>{t("trust.mint")}</dt>
        <dd>
{t("trust.mintNone")}
        </dd>
      </dl>
    </section>
  );
}
