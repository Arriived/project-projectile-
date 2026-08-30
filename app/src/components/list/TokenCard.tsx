// A card. The unit of the list page.
//
// Top to bottom: square image, Graduated pill on graduated cards only, name, $SYMBOL
// beneath in a lighter weight, market cap (plus FDV for graduated), a progress bar with
// its percentage at the right end for live, and a footer of truncated address left, age
// right.
//
// THE ADDRESS IS ON EVERY CARD AND IS NOT OPTIONAL. `symbolLockDuration` is 0 on the live
// deployment and name uniqueness was never enforced at all, so two tokens can carry the
// same name and ticker in the same block. The address is the only identifier that cannot
// be copied.
//
// Every figure here is `~`: it comes from the indexer, which serialises uint256 as JSON
// numbers and truncates them before JavaScript sees them (trap 21). Nothing on this card
// is acted on -- clicking it opens the token page, which reads the chain.

import { Link } from "react-router-dom";
import { useT } from "../../i18n";
import { TokenImage } from "../token/TokenImage";
import { shortAddress, safeText } from "../../lib/format";
import { approxMarketCapUsdc6, approxProgressBps, type ListToken } from "../../lib/tokenList";

/**
 * The `~` that prefixes every indexer-sourced figure, carrying its own explanation.
 *
 * This replaced a line of body copy at the foot of the list ("~ figures come from the
 * indexer and are approximate..."). The disclosure still has to exist -- trap 21 is real
 * and these numbers are genuinely rounded before the browser sees them -- but it is a
 * footnote, not a paragraph a trader reads past on every visit. Whoever wants it hovers.
 *
 * `title` rather than a custom tooltip so it works without JS and is reachable by
 * keyboard focus; `abbr` is the element that actually means "expandable short form".
 */
function Approx() {
  const { t } = useT();
  return (
    <abbr className="approx" title={t("list.approxTooltip")}>
      ~
    </abbr>
  );
}

export function TokenCard({
  token,
  curveSupply,
  degraded,
}: {
  token: ListToken;
  curveSupply: bigint;
  /** Chain-fallback mode: identity only, so figures are omitted rather than zeroed. */
  degraded?: boolean;
}) {
  const { t, fmt } = useT();

  // safeText strips bidirectional control characters. createToken validates nothing, so a
  // name can carry RTL overrides whose only purpose is to make one token render as
  // another -- which on a list of cards is exactly where it would work.
  const name = safeText(token.name, 40) || t("token.unnamed");
  const symbol = safeText(token.symbol, 16);

  const mcap = approxMarketCapUsdc6(token, curveSupply);
  const pct = approxProgressBps(token) / 100;

  return (
    <Link to={`/t/${token.address}`} className="tcard">
      <div className="tcard-img">
        <TokenImage uri={token.metadataUri ?? undefined} alt={name} square />
        {/* Graduated cards get a pill; live ones get nothing. "Live" is the default state
            and a pill for it is noise. */}
        {token.graduated && <span className="tcard-pill">{t("list.graduatedHeading")}</span>}
      </div>

      <div className="tcard-body">
        <div className="tcard-name">{name}</div>
        <div className="tcard-symbol">
          {symbol ? `$${symbol}` : t("token.noSymbol")}
          {/* Rule 2, hard requirement. Both tokens in a collision are flagged -- which of
              two identical tickers is "the real one" is not ours to assert. */}
          {token.symbolCollision && (
            <span className="tcard-dup" title={t("list.duplicateSymbolNote")}>
              {t("list.duplicateSymbol")}
            </span>
          )}
        </div>

        {degraded ? (
          <div className="tcard-figs hint">{t("common.unavailable")}</div>
        ) : token.graduated ? (
          <div className="tcard-figs">
            <span>
              {t("list.marketCap")} <Approx />
              {fmt.usdcCompact(mcap)}
            </span>
            <span className="hint">
              {t("list.fdv")} <Approx />
              {fmt.usdcCompact(mcap)}
            </span>
          </div>
        ) : (
          <>
            <div className="tcard-figs">
              <span>
                {t("list.marketCap")} <Approx />
                {fmt.usdcCompact(mcap)}
              </span>
            </div>
            <div className="tcard-progress">
              <div className="tcard-track">
                <div className="tcard-fill" style={{ width: `${Math.min(100, pct)}%` }} />
              </div>
              <span className="tcard-pct">{fmt.pct(pct, 1)}</span>
            </div>
          </>
        )}

        <div className="tcard-foot">
          <span className="mono">{shortAddress(token.address)}</span>
          <span className="hint">{token.createdAt ? fmt.age(token.createdAt) : "—"}</span>
        </div>
      </div>
    </Link>
  );
}
