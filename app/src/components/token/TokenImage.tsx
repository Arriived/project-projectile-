// Token image with a neutral placeholder.
//
// The spec is explicit: a broken-image icon reads as a broken site. Metadata URIs are
// creator-supplied and unvalidated by the contract, so they can 404, return HTML, point
// at ipfs:// which the browser cannot fetch, or simply be absent. All of those land on
// the placeholder rather than a broken glyph.

import { useState } from "react";
import { resolveMediaUri } from "../../lib/ipfs";

// Gateway resolution and the scheme allowlist moved to lib/ipfs.ts when the create flow
// started PRODUCING ipfs:// URIs (lib/upload.ts). Two copies of a security allowlist is
// one copy too many -- the create-side preview and this render path must agree on
// exactly which schemes are loadable.

export function TokenImage({
  uri,
  alt,
  size = 72,
  square = false,
}: {
  uri: string | undefined;
  alt: string;
  size?: number;
  square?: boolean;
}) {
  const [failed, setFailed] = useState(false);
  const src = resolveMediaUri(uri);

  const style = square
    ? { width: "100%", aspectRatio: "1 / 1" }
    : { width: size, height: size };

  if (!src || failed) {
    return (
      <div className="token-img token-img-placeholder" style={style} aria-label={`${alt} (no image)`}>
        <span>◈</span>
      </div>
    );
  }

  return (
    <img
      className="token-img"
      style={style}
      src={src}
      alt={alt}
      loading="lazy"
      onError={() => setFailed(true)}
    />
  );
}
