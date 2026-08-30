// Section 1 — identity.
//
// The FULL contract address is always visible and copyable. Not truncated behind a
// tooltip, not in a drawer. Rule 2: `symbolLockDuration` is 0 on the live deployment and
// name uniqueness was never enforced at all, so two tokens can share a symbol in the same
// block. The address is the only identifier that cannot be copied, which makes it the
// only one worth trusting.

import { useState } from "react";
import type { Address } from "viem";
import type { TokenData } from "../../hooks/useCurve";
import { EXPLORER_URL } from "../../config";
import { safeText } from "../../lib/format";
import { useT } from "../../i18n";
import { symbolIsWatchable, MAX_WATCHABLE_SYMBOL_LENGTH } from "../../hooks/useWatchAsset";
import { TokenImage } from "./TokenImage";

export function TokenIdentity({ token, data }: { token: Address; data: TokenData }) {
  const { t } = useT();
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(token);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked; the address is on screen in full regardless */
    }
  };

  // safeText strips bidirectional control characters. createToken validates nothing, so
  // a name can carry RTL overrides whose only purpose here would be to make one token
  // render as another.
  const name = safeText(data.name, 64) || t("token.unnamed");
  const symbol = safeText(data.symbol, 24) || t("token.noSymbol");

  return (
    <section className="card identity">
      <TokenImage uri={data.metadataURI} alt={name} size={72} />

      <div className="identity-text">
        <h1 className="identity-name">{name}</h1>
        <div className="identity-symbol">${symbol}</div>

        <div className="identity-addr">
          {/* Full, not truncated. This is the point of the section. */}
          <code className="mono">{token}</code>
          <button className="btn btn-tiny" onClick={copy}>
            {copied ? t("common.copied") : t("common.copy")}
          </button>
          <a
            className="btn btn-tiny btn-ghost"
            href={`${EXPLORER_URL}/address/${token}`}
            target="_blank"
            rel="noreferrer"
          >
            {t("token.verifiedContract")}
          </a>
        </div>

        {/* A symbol the wallet cannot one-click-add is worth saying once, here, rather
            than leaving the "Add to wallet" button to fail silently later. */}
        {data.symbol && !symbolIsWatchable(data.symbol) && (
          <p className="identity-warn">
            {t("token.symbolTooLong", {
              length: data.symbol.length,
              max: MAX_WATCHABLE_SYMBOL_LENGTH,
            })}
          </p>
        )}
      </div>
    </section>
  );
}
