// Turning an `ipfs://` URI into something a browser can actually load.
//
// Split out of TokenImage because the create flow now produces these URIs (see
// `lib/upload.ts`) and both ends must agree. Pure, no React.
//
// ── WHY A CONFIGURABLE GATEWAY RATHER THAN A CONSTANT ─────────────────────────
//
// We write `ipfs://<cid>` to the chain deliberately, so the token is not chained to one
// company's domain (see `cidToTokenUri`). That decision only pays off if the gateway is
// genuinely swappable at render time -- otherwise the dependency has just moved from the
// chain into a hardcoded string, where it is no easier to change for tokens already
// launched.
//
// ⚠ THE DEFAULT IS A REAL TRADE-OFF, NOT A PLACEHOLDER. `ipfs.io` is a public gateway
// that has to FIND content on the network; freshly-pinned Pinata content can take a
// while to become retrievable through it, and it rate-limits. So the default renders a
// just-uploaded image slowly or not at all, which is exactly the moment a creator is
// looking. Setting VITE_PINATA_GATEWAY to the account's dedicated gateway makes the read
// path hit the same provider that holds the pin, and it starts resolving immediately.
//
// Left optional rather than required because a fresh clone with no Pinata account should
// still render every already-launched token, just less quickly.

const viteEnv: Record<string, string | undefined> =
  (import.meta as unknown as { env?: Record<string, string | undefined> }).env ?? {};

/**
 * Dedicated gateway host, e.g. `example.mypinata.cloud`.
 *
 * PUBLIC BY DESIGN. It is a hostname that appears in every image URL the page renders --
 * there is nothing to keep secret about it, and it is not a credential. It carries a
 * VITE_ prefix for exactly that reason.
 */
export const PINATA_GATEWAY = viteEnv.VITE_PINATA_GATEWAY?.trim().replace(/^https?:\/\//, "").replace(/\/+$/, "");

/** Fallback when no dedicated gateway is configured. See the header for the cost. */
export const FALLBACK_GATEWAY = "ipfs.io";

export function gatewayHost(): string {
  return PINATA_GATEWAY || FALLBACK_GATEWAY;
}

/**
 * A URI the browser can put in `src`, or null if it must not be loaded.
 *
 * ⚠ THE null CASES ARE A SECURITY BOUNDARY, NOT TIDINESS. Metadata URIs are creator-
 * supplied and the contract validates nothing, so this receives arbitrary attacker text.
 * Only `https:`, `http:`, `ipfs:` and `data:image/` are ever returned; `javascript:`,
 * `vbscript:`, `blob:`, `file:` and bare strings return null and render the placeholder.
 * Anything added to that allowlist is handing attacker-controlled input to the browser.
 */
export function resolveMediaUri(uri: string | undefined | null): string | null {
  if (!uri) return null;
  const trimmed = uri.trim();
  if (!trimmed) return null;

  if (/^ipfs:\/\//i.test(trimmed)) {
    // `ipfs://<cid>/<path>` and the legacy `ipfs://ipfs/<cid>` both appear in the wild.
    const rest = trimmed.slice(7).replace(/^ipfs\//, "");
    if (!rest) return null;

    // ⚠ THE PATH MUST LOOK LIKE A CID. Three live tokens store literally `ipfs://x` -- a
    // valid scheme wrapped around a junk path -- and that produced the observed
    // `.../ipfs/x` 400 on every page that rendered them. A scheme check alone cannot catch
    // it: "x" is a perfectly well-formed URI path.
    //
    // Checked by SHAPE, not by decoding: a CIDv0 is 46 base58 characters starting `Qm`, a
    // CIDv1 is ~59 base32 characters starting `b`. Anything shorter than 46 is neither.
    // Deliberately a floor rather than a full parse -- this is a "do not ask the gateway
    // for obvious garbage" guard, and rejecting a genuine CID because a future version is
    // encoded differently would be our bug rather than the creator's.
    const cid = rest.split("/")[0];
    if (cid.length < 46 || !/^[A-Za-z0-9]+$/.test(cid)) return null;

    return `https://${gatewayHost()}/ipfs/${rest}`;
  }

  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  if (/^data:image\//i.test(trimmed)) return trimmed;

  return null;
}
