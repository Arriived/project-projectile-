// Image upload: the client half of the Pinata presigned-URL flow ("Shape B").
//
// Pure. No React, no network, no secrets. The constants here are mirrored by the
// serverless function in `api/sign-upload.ts`, which is the half that actually enforces
// them -- see the boundary note below.
//
// ── SHAPE B, AND WHY NOT SHAPE A ──────────────────────────────────────────────
//
// The browser asks our function for a short-lived signed URL (a few hundred bytes of
// JSON), then uploads the file DIRECTLY to Pinata. The file never transits our function.
//
// The alternative -- proxying the bytes through the function -- collides with Vercel's
// 4.5 MB request body limit (`413 FUNCTION_PAYLOAD_TOO_LARGE`). A 2 MB image fits, but
// base64 inflates it to ~2.67 MB and the platform limit silently becomes the product's
// size cap. Shape B never touches that limit, and the function's cold start lands on a
// tiny JSON request instead of a multi-megabyte transfer.
//
// ── ⚠ THE CLIENT CHECKS BELOW ARE UX, NOT SECURITY ────────────────────────────
//
// `validateImageFile` runs in the browser and is therefore advice, not a control. Anyone
// can skip it. The ACTUAL enforcement is server-side inside Pinata: the signed URL is
// minted with `max_file_size` and `allow_mime_types` baked into the signature, so Pinata
// itself rejects an oversized or wrong-typed upload no matter what the client sent.
//
// Duplicating the rules here is still worth it -- rejecting a 40 MB file before the
// upload starts is a better experience than a failure after it -- but the two copies must
// not drift, which is what `verify:upload` pins.
//
// ── THE ABUSE CEILING, STATED HONESTLY ────────────────────────────────────────
//
// There is no rate limiting and deliberately none: an IP limiter adds a vendor (KV) for a
// speed bump, and a wallet gate asks for a signature to pick an image, which is precisely
// the pattern users are correctly taught to treat as phishing.
//
// So the real boundary is the signed URL's own terms: MAX_UPLOAD_BYTES × whatever fits
// inside SIGNED_URL_TTL_SECONDS. A signed URL is not documented as single-use, so assume
// it is replayable within its window and size the window accordingly. That is a bounded,
// self-expiring exposure rather than an open upload endpoint -- which is the property
// being bought here, not "unabusable".

/**
 * Hard size cap, enforced by Pinata via the signature.
 *
 * 5 MiB is deliberately generous: a creator photographing something on a phone lands
 * around 3-4 MB, and rejecting real images to shave the abuse ceiling trades a common
 * frustration against an uncommon one. Every byte of this is also the per-upload half of
 * the ceiling arithmetic above, so it is not free.
 */
export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

/**
 * How long a minted URL stays valid. Pinata's own example uses 30.
 *
 * Short on purpose -- this is the second half of the abuse ceiling. It only has to cover
 * one upload that has already been picked, not a user's thinking time, because the URL is
 * requested at submit rather than when the form opens.
 */
export const SIGNED_URL_TTL_SECONDS = 30;

/**
 * ⚠ SVG IS EXCLUDED ON PURPOSE. DO NOT ADD IT.
 *
 * SVG is XML, and it can carry `<script>`, event handlers and external references. Served
 * from a gateway origin and rendered in an `<img>` it is mostly inert, but "mostly" is
 * doing real work in that sentence: the same file is one `<object>`, one `fetch`-and-
 * inline, or one gateway that serves it as a document away from executing. A token image
 * is attacker-supplied content displayed next to other people's money.
 *
 * The raster formats have no such mode. Excluding one format costs a creator nothing --
 * every design tool exports PNG.
 */
export const ALLOWED_MIME_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;

export type AllowedMime = (typeof ALLOWED_MIME_TYPES)[number];

/** The path our own function is served from. Relative, so it follows the deployment. */
export const SIGN_ENDPOINT = "/api/sign-upload";

export type UploadIssue =
  | { kind: "tooLarge"; bytes: number; max: number }
  | { kind: "badType"; type: string }
  | { kind: "empty" };

/**
 * Whether this file can be offered to the signer, and if not, why.
 *
 * Returns null when acceptable. The caller renders the reason; this module owns no
 * user-facing English (see i18n).
 */
export function validateImageFile(file: { size: number; type: string }): UploadIssue | null {
  if (file.size === 0) return { kind: "empty" };
  if (file.size > MAX_UPLOAD_BYTES) {
    return { kind: "tooLarge", bytes: file.size, max: MAX_UPLOAD_BYTES };
  }
  // Compared case-insensitively and with any `;charset=` parameter dropped: browsers are
  // permitted to report either, and a creator should not be blocked by punctuation.
  const bare = file.type.split(";")[0].trim().toLowerCase();
  if (!(ALLOWED_MIME_TYPES as readonly string[]).includes(bare)) {
    return { kind: "badType", type: file.type || "unknown" };
  }
  return null;
}

/**
 * What gets written to the chain for an uploaded image.
 *
 * ⚠ `ipfs://<cid>`, NEVER a gateway URL. The metadata URI is stored on chain and is
 * changeable only by the creator, so a gateway hostname baked into it is a permanent
 * dependency on one company's domain: if it lapses, moves, or rate-limits, every token
 * that ever pointed at it renders a broken image and only each individual creator can fix
 * their own. The CID is the content; the gateway is one of many ways to fetch it, and
 * belongs at RENDER time where it can be changed for every token at once.
 */
export function cidToTokenUri(cid: string): string {
  return `ipfs://${cid}`;
}

/** Shape of our function's success response. Mirrored in `api/sign-upload.ts`. */
export type SignResponse = { url: string };

/**
 * Ask our function to mint a signed URL, then upload straight to Pinata.
 *
 * Two hops on purpose (see the header). `onPhase` exists because the two hops fail for
 * completely different reasons -- ours means the deployment is misconfigured, Pinata's
 * means the upload itself was rejected -- and a single "upload failed" would collapse
 * them into one unactionable message.
 */
export async function uploadImage(
  file: File,
  opts: { signal?: AbortSignal; onPhase?: (p: "signing" | "uploading") => void } = {}
): Promise<{ cid: string; uri: string }> {
  opts.onPhase?.("signing");

  const signRes = await fetch(SIGN_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: file.name, type: file.type, size: file.size }),
    signal: opts.signal,
  });

  if (!signRes.ok) {
    // The function returns a machine-readable `error` for the cases it can name. Anything
    // else (an HTML error page from the platform, say) must not be shown raw.
    const detail = await signRes
      .json()
      .then((b: unknown) => (b as { error?: string })?.error)
      .catch(() => undefined);
    throw new UploadError(detail ? `sign:${detail}` : `sign:http_${signRes.status}`);
  }

  // ⚠ A 200 does not mean this is JSON. If an SPA catch-all rewrite ever swallows
  // /api/sign-upload, this endpoint returns the app's own index.html with a 200, and an
  // unguarded .json() throws a raw SyntaxError that surfaces as an unhandled rejection
  // rather than a message. That exact rewrite bug is fixed in vercel.json and pinned by
  // verify:upload U26 -- this is the second line of defence for when it is not.
  let parsed: SignResponse;
  try {
    parsed = (await signRes.json()) as SignResponse;
  } catch {
    throw new UploadError("sign:not_json");
  }
  const url = parsed?.url;
  if (!url || typeof url !== "string") throw new UploadError("sign:malformed");

  opts.onPhase?.("uploading");

  const form = new FormData();
  form.append("file", file);
  form.append("network", "public");

  const upRes = await fetch(url, { method: "POST", body: form, signal: opts.signal });
  if (!upRes.ok) throw new UploadError(`pinata:http_${upRes.status}`);

  const body = (await upRes.json()) as { data?: { cid?: string } };
  const cid = body?.data?.cid;
  if (!cid) throw new UploadError("pinata:no_cid");

  return { cid, uri: cidToTokenUri(cid) };
}

/**
 * Carries a stable machine code so the UI can map to copy without parsing prose.
 *
 * ⚠ The field is declared and assigned explicitly rather than via a TypeScript parameter
 * property (`constructor(public readonly code: string)`). The verify scripts run under
 * node's `--experimental-strip-types`, which is strip-ONLY: it erases annotations but
 * refuses syntax that would have to emit code, and a parameter property is exactly that.
 * The shorthand fails the whole suite at import time with ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX.
 */
export class UploadError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.name = "UploadError";
    this.code = code;
  }
}
