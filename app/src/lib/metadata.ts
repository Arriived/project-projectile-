// Reading `tokens.metadata_uri`.
//
// ⚠ THE FIELD HOLDS METADATA, NOT A URI TO METADATA — AND THE NAME CANNOT BE FIXED.
// The frozen contract writes it and five factory addresses have burned, so the mismatch
// is permanent. This comment is the fix.
//
// ── THE BUG THIS EXISTS TO CLOSE ──────────────────────────────────────────────
//
// The create flow packs image, description and socials into an inline JSON document and
// stores THAT in the field (Create.tsx). The read side handed the whole string to the
// IPFS gateway resolver as if it were a URI, so the gateway was asked for
// `ipfs://{"image":...}` -- not a CID, nothing renders, and the ◈ placeholder shows on a
// token whose image was uploaded and pinned correctly. The same path produced an observed
// `.../ipfs/x` 400: a different malformed value reaching the same resolver.
//
// ── ⚠ EVERY FIELD HERE IS ATTACKER-CONTROLLED AND ON CHAIN ────────────────────
//
// `createToken` validates nothing about this string. Anyone can launch a token carrying
// any value at all, and it is then served to every visitor who opens that token's page.
// So this module treats the whole thing as hostile string input: it never throws, never
// lets a malformed value reach a URL path, and returns only values that have been checked
// against an allowlist rather than cleaned up and hoped for.
//
// `description` is returned as a plain string and MUST be rendered as text. Never as HTML.

/** Everything the create flow can write. See Create.tsx -- these four keys, no others. */
export type TokenMetadata = {
  /** Raw image URI as stored: `ipfs://<cid>`, `https://…`, or `data:image/…`. */
  image?: string;
  description?: string;
  /** Bare handles as typed, NOT urls. `socialUrl()` turns them into links. */
  x?: string;
  telegram?: string;
};

/**
 * Parse whatever is in the field into the four known keys.
 *
 * Four shapes occur in the wild and all four must land somewhere sane:
 *
 *   1. Inline JSON        -- what the create flow writes when any extra is filled in.
 *   2. Empty / null       -- the R15 and GP tokens. Must produce NO network request at all,
 *                            not a request for the empty string.
 *   3. A bare URI         -- what the create flow writes when ONLY an image is given, and
 *                            what a creator setting the field directly on chain would use.
 *   4. Malformed JSON, or JSON with no `image`.
 *
 * Never throws. An unparseable value yields an empty object, which renders the placeholder.
 */
export function parseTokenMetadata(raw: string | undefined | null): TokenMetadata {
  if (typeof raw !== "string") return {};
  const s = raw.trim();
  if (!s) return {};

  // Shape 1/4: a JSON document. Checked by shape before parsing so a bare URI never enters
  // the try/catch and never depends on JSON.parse failing in the right way.
  if (s.startsWith("{")) {
    let doc: unknown;
    try {
      doc = JSON.parse(s);
    } catch {
      // Malformed JSON. Not a URI either -- it starts with `{`, so passing it through as
      // one would hand the gateway exactly the garbage this module exists to stop.
      return {};
    }
    if (doc === null || typeof doc !== "object" || Array.isArray(doc)) return {};
    const d = doc as Record<string, unknown>;
    const str = (v: unknown): string | undefined => {
      // Numbers, objects and nulls in these positions are all "not a value we can use".
      if (typeof v !== "string") return undefined;
      const t = v.trim();
      return t ? t : undefined;
    };
    return {
      image: str(d.image),
      description: str(d.description),
      x: str(d.x),
      telegram: str(d.telegram),
    };
  }

  // Shape 3: a bare URI -- but ONLY if it actually looks like one.
  //
  // ⚠ REQUIRING A SCHEME IS NOT BELT-AND-BRACES, IT CLOSES A REAL GAP THE TEST FOUND.
  // The first version returned `{ image: s }` for anything not starting with `{`, so a
  // JSON array ("[1,2,3]") and the literal "null" both became image URIs -- neither starts
  // with a brace, so neither took the JSON branch. Both then travelled to the gateway
  // resolver to be rejected there, which works only for as long as that resolver stays
  // strict. A value that is not a URI should not become one here.
  //
  // The same rule is what makes the observed `/ipfs/x` 400 impossible: "x" has no scheme.
  if (!/^(ipfs:\/\/|https?:\/\/|data:image\/)/i.test(s)) return {};
  return { image: s };
}

/**
 * ── ⚠ HANDLE VALIDATION: REJECT, DO NOT SANITISE ──────────────────────────────
 *
 * `x` holds a bare handle (`doggy`), so a link means concatenating it onto a host. That
 * makes it a URL-injection surface written by any token creator:
 *
 *   "evil.com"        -> https://x.com/evil.com          (looks plausible, wrong site)
 *   "a/../../evil"    -> path traversal out of the profile
 *   "a?next=evil"     -> query injection
 *   "@x.com/evil"     -> after a naive @-strip, a different host entirely
 *
 * Sanitising means guessing which of those a creator "meant". None of them are handles, so
 * the rule is an ALLOWLIST and anything failing it renders no link at all: letters, digits
 * and underscore only, after stripping ONE optional leading `@`.
 *
 * That is also the real rule -- X handles are [A-Za-z0-9_]{1,15} and Telegram is
 * [A-Za-z0-9_]{5,32}. A value containing `/`, `:`, `.`, `?`, `#` or whitespace is not a
 * handle that was typed slightly wrong; it is something else.
 *
 * The lengths are deliberately a little looser than each platform's own limit: this is a
 * safety check, not a registration form, and refusing to link a valid handle because a
 * platform raised its limit would be our bug rather than the creator's.
 */
const HANDLE_RE = /^[A-Za-z0-9_]{1,32}$/;

export type SocialKind = "x" | "telegram";

const SOCIAL_HOST: Record<SocialKind, string> = {
  x: "https://x.com/",
  telegram: "https://t.me/",
};

/**
 * A profile URL for a handle, or null when the handle is not one.
 *
 * Returning null rather than a best-effort URL is the point: a link that goes somewhere
 * unexpected is worse than no link, and this input is written by strangers.
 */
export function socialUrl(kind: SocialKind, handle: string | undefined | null): string | null {
  if (typeof handle !== "string") return null;
  // Exactly one leading `@`, because users type both forms. A second `@` is not a typo.
  const cleaned = handle.trim().replace(/^@/, "");
  if (!HANDLE_RE.test(cleaned)) return null;
  return SOCIAL_HOST[kind] + cleaned;
}

/** The handle as it should be displayed: always `@name`, never a bare word or a URL. */
export function socialLabel(handle: string | undefined | null): string | null {
  if (typeof handle !== "string") return null;
  const cleaned = handle.trim().replace(/^@/, "");
  return HANDLE_RE.test(cleaned) ? `@${cleaned}` : null;
}
