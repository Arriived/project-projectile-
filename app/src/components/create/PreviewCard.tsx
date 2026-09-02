// The live preview on the create form.
//
// Fills what was otherwise a bare right-hand column, and does one useful thing: it shows
// the creator the artefact they are about to make, before the fee is spent and before the
// symbol is immutable. `createToken` validates nothing, so this is the last point at which
// a typo is free.
//
// ⚠ EVERY NUMBER HERE COMES FROM THE CONTRACT, NOT FROM CONSTANTS. The graduation
// threshold and the snipe schedule are owner-settable and snapshotted per token at
// creation, so a hardcoded "8,000 USDC" would be a promise this page cannot keep. When a
// value has not loaded yet it renders as "—" rather than a plausible default: a preview
// that invents the terms is worse than one that admits it is still reading them.

import { useT } from "../../i18n";
import { TokenImage } from "../token/TokenImage";
import { safeText } from "../../lib/format";

export function PreviewCard({
  name,
  symbol,
  imageUri,
  description,
  creationFee,
  graduationThreshold,
  snipeWindowSeconds,
}: {
  name: string;
  symbol: string;
  imageUri: string;
  description: string;
  creationFee: bigint | undefined;
  graduationThreshold: bigint | undefined;
  snipeWindowSeconds: number | undefined;
}) {
  const { t, fmt } = useT();

  // safeText strips bidirectional control characters here too. A creator pasting a name
  // with an RTL override should see what everyone else will see, not what their own
  // clipboard renders.
  const shownName = safeText(name, 40) || t("create.previewName");
  const shownSymbol = safeText(symbol, 16) || t("create.previewSymbol");

  return (
    <aside className="preview">
      <h2 className="preview-h">{t("create.previewHeading")}</h2>

      <div className="tcard preview-card">
        <div className="tcard-img">
          <TokenImage uri={imageUri || undefined} alt={shownName} square />
        </div>
        <div className="tcard-body">
          <div className="tcard-name">{shownName}</div>
          <div className="tcard-symbol">${shownSymbol}</div>
          {description.trim() && <p className="preview-desc">{safeText(description, 160)}</p>}
        </div>
      </div>

      <dl className="preview-terms">
        <div>
          <dt>{t("create.feeLabel")}</dt>
          <dd>{creationFee !== undefined ? `${fmt.usdcExact(creationFee)} USDC` : "—"}</dd>
        </div>
        <div>
          <dt>{t("create.previewThreshold")}</dt>
          <dd>
            {graduationThreshold !== undefined
              ? `${fmt.usdcCompact(graduationThreshold)} USDC`
              : "—"}
          </dd>
        </div>
        <div>
          <dt>{t("create.previewSnipe")}</dt>
          <dd>
            {snipeWindowSeconds !== undefined
              ? t("create.previewSnipeValue", { seconds: snipeWindowSeconds })
              : "—"}
          </dd>
        </div>
      </dl>

      <p className="hint preview-note">{t("create.previewNote")}</p>
    </aside>
  );
}
