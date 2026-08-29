// Token image with a neutral placeholder.
//
// The spec is explicit: a broken-image icon reads as a broken site. Metadata URIs are
// creator-supplied and unvalidated by the contract, so they can 404, return HTML, point
// at ipfs:// which the browser cannot fetch, or simply be absent. All of those land on
// the placeholder rather than a broken glyph.

import { useState } from "react";

/** ipfs:// is not a scheme browsers fetch. Route it through a gateway. */
function resolveUri(uri: string | undefined): string | null {
  if (!uri) return null;
  const trimmed = uri.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("ipfs://")) {
    return `https://ipfs.io/ipfs/${trimmed.slice(7)}`;
  }
  // Only http(s) and data: are loadable. Anything else (javascript:, file:, a bare
  // string) is treated as absent rather than handed to the browser.
  if (/^(https?:|data:image\/)/i.test(trimmed)) return trimmed;
  return null;
}

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
  const src = resolveUri(uri);

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
