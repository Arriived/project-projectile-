// Section 1 — identity.
//
// The FULL contract address is always visible and copyable. Not truncated behind a
// tooltip, not in a drawer. Rule 2: `symbolLockDuration` is 0 on the live deployment and
// name uniqueness was never enforced at all, so two tokens can share a symbol in the same
// block. The address is the only identifier that cannot be copied, which makes it the
// only one worth trusting.

import type { Address } from "viem";
import type { TokenData } from "../../hooks/useCurve";
import { EXPLORER_URL } from "../../config";
import { safeText } from "../../lib/format";
import { useT } from "../../i18n";
import { symbolIsWatchable, MAX_WATCHABLE_SYMBOL_LENGTH } from "../../hooks/useWatchAsset";
import { TokenImage } from "./TokenImage";
import { AddressText } from "../AddressText";
import { resolveLinks, AGGREGATOR_CHAIN_SLUG } from "../../lib/aggregatorLinks";
import { parseTokenMetadata, socialLabel, socialUrl } from "../../lib/metadata";

export function TokenIdentity({ token, data }: { token: Address; data: TokenData }) {
  const { t } = useT();
  // safeText strips bidirectional control characters. createToken validates nothing, so
  // a name can carry RTL overrides whose only purpose here would be to make one token
  // render as another.
  const name = safeText(data.name, 64) || t("token.unnamed");
  const symbol = safeText(data.symbol, 24) || t("token.noSymbol");

  // The field holds inline JSON, not a URI -- see lib/metadata.ts. Parsed once here and
  // used for the description and the socials; the image goes through TokenImage, which
  // parses it itself so the list card gets the same treatment.
  const meta = parseTokenMetadata(data.metadataURI);
  const socials = ([
    ["x", meta.x],
    ["telegram", meta.telegram],
  ] as const)
    .map(([kind, handle]) => ({ kind, url: socialUrl(kind, handle), label: socialLabel(handle) }))
    // ⚠ A handle that fails validation renders NO LINK. Not a sanitised one -- see
    // socialUrl. This is attacker-controlled input from any token creator.
    .filter((sv) => sv.url !== null && sv.label !== null);

  const links = resolveLinks({
    token,
    explorerUrl: EXPLORER_URL,
    // Undefined until a pool exists and Arc has an aggregator slug. Both stay unrendered.
    aggregatorChainSlug: AGGREGATOR_CHAIN_SLUG,
  });

  return (
    <section className="card identity">
      <TokenImage uri={data.metadataURI} alt={name} size={72} />

      <div className="identity-text">
        <h1 className="identity-name">{name}</h1>
        <div className="identity-symbol">${symbol}</div>

        <div className="identity-addr">
          {/* Full, not truncated. This is the point of the section. */}
          <AddressText address={token} />
          {/* Only links that actually resolve are rendered — see lib/aggregatorLinks.ts.
              Today that is the contract alone; pool and the two aggregators appear on
              their own once a pool exists and Arc has an aggregator slug. No dead links,
              and no greyed row of four advertising what the chain cannot do yet. */}
          {socials.map((sv) => (
            <a
              key={sv.kind}
              className="btn btn-tiny btn-ghost"
              href={sv.url!}
              target="_blank"
              rel="noreferrer noopener"
            >
              {sv.kind === "x" ? "X" : "Telegram"} {sv.label}
            </a>
          ))}

          {links.map((l) => (
            <a
              key={l.id}
              className="btn btn-tiny btn-ghost"
              href={l.href}
              target="_blank"
              rel="noreferrer"
            >
              {t(l.labelKey)}
            </a>
          ))}
        </div>

        {/* ⚠ RENDERED AS TEXT. React escapes this, and it must stay that way: the value is
            written by whoever launched the token and is served to everyone who opens the
            page. safeText also strips bidi control characters, which exist to make one
            string render as another. */}
        {meta.description && (
          <p className="identity-desc">{safeText(meta.description, 280)}</p>
        )}

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
