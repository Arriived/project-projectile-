// Mint a short-lived, tightly-scoped Pinata upload URL. Nothing else.
//
// ⚠ THIS FILE IS THE REASON THE PROJECT IS NO LONGER A PURELY STATIC BUILD. Deploying is
// now "a folder plus a function" rather than "a folder". That is accepted and recorded in
// CLAUDE.md §11.17 and app/DEPLOY.md so it is not rediscovered as a surprise.
//
// ── THE TRUST BOUNDARY, STATED PRECISELY ──────────────────────────────────────
//
// This function can mint an upload URL and NOTHING ELSE. It holds no key that touches
// funds, signs no transaction, reads no database, and cannot affect any token that has
// already launched. If it disappears, every existing token is unaffected and only new
// image uploads stop working. That narrowness is the point: it is the smallest server the
// product can have and still not ship a Pinata key to the browser.
//
// ── ⚠ PINATA_JWT IS SERVER-ONLY. NEVER GIVE IT A VITE_ PREFIX ─────────────────
//
// Vite inlines every VITE_-prefixed variable into the client bundle. A prefixed Pinata JWT
// would be published to every visitor, and Pinata's own documentation is explicit that
// even an upload-only key lets an attacker "upload tons of files, costing you significant
// money or locking out your account". There is no scoping that makes a browser-side
// Pinata key safe, which is why this function exists at all rather than the browser
// calling Pinata directly.
//
// `process.env` is not reachable from client code in this project, so the prefix is the
// only way this leaks -- and `verify:upload` fails the build if the name ever acquires one.
//
// ── HANDLER SHAPE ─────────────────────────────────────────────────────────────
//
// Default export of an object with a `fetch` method. This is the signature Vercel
// documents for a NON-framework project (`framework=other`) with an `api/` directory --
// the named `export function POST` form is Next.js-specific and is NOT what this project
// is. Root Directory is `app`, so this file is served at `/api/sign-upload`.

// ── ⚠ THESE THREE ARE DUPLICATED FROM src/lib/upload.ts ON PURPOSE ────────────
//
// Importing them across the api/ -> src/ boundary would be tidier and is NOT worth it:
// this file is compiled by Vercel's Node builder, not by our Vite/tsc pipeline, so a
// cross-directory `.ts` import is a resolution risk that fails at DEPLOY time -- the one
// place in this project where a failure costs a redeploy cycle to discover.
//
// The duplication is made safe mechanically instead: `npm run verify:upload` parses both
// files and fails if any of the three values drift apart. Copying is fine when a check
// makes the copy impossible to get wrong silently.
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
const SIGNED_URL_TTL_SECONDS = 30;
const ALLOWED_MIME_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];

const PINATA_SIGN_URL = "https://uploads.pinata.cloud/v3/files/sign";

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      // A signed URL is minted per request and must never be reused from a cache.
      "cache-control": "no-store",
    },
  });
}

export default {
  async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST") {
      return json({ error: "method_not_allowed" }, 405);
    }

    const jwt = process.env.PINATA_JWT;
    if (!jwt) {
      // Fail closed and say so in the log, not in the response. A misconfigured
      // deployment must not be distinguishable from a working one by probing it, but it
      // must be obvious to whoever deployed it.
      console.error("[sign-upload] PINATA_JWT is not set — refusing to sign.");
      return json({ error: "not_configured" }, 503);
    }

    // The body is advisory. It lets us reject an obviously-wrong file before spending a
    // Pinata call, and gives the stored object a sensible filename.
    //
    // ⚠ NOTHING FROM IT IS TRUSTED AS A CONTROL. The caller reports its own size and mime
    // type, so both are attacker-chosen. The real limits are the ones handed to Pinata
    // below and baked into the signature -- those are checked against the ACTUAL bytes,
    // by Pinata, after we are out of the loop.
    let claimed: { name?: unknown; type?: unknown; size?: unknown } = {};
    try {
      claimed = (await request.json()) as typeof claimed;
    } catch {
      return json({ error: "bad_request" }, 400);
    }

    const claimedSize = typeof claimed.size === "number" ? claimed.size : 0;
    if (claimedSize > MAX_UPLOAD_BYTES) {
      return json({ error: "too_large" }, 413);
    }

    // Filenames are metadata on someone else's storage, and this one is attacker-supplied.
    // Strip path separators and control characters, and bound the length, so nothing
    // downstream has to reason about `../` or a newline in a name.
    const rawName = typeof claimed.name === "string" ? claimed.name : "";
    const filename =
      rawName
        .replace(/[/\\]/g, "_")
        // eslint-disable-next-line no-control-regex
        .replace(/[\x00-\x1f\x7f]/g, "")
        .trim()
        .slice(0, 128) || "token-image";

    let signed: Response;
    try {
      signed = await fetch(PINATA_SIGN_URL, {
        method: "POST",
        headers: {
          authorization: `Bearer ${jwt}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          network: "public",
          // `date` is the signing time in UNIX SECONDS, and `expires` is measured from
          // it -- not from when the client eventually uses the URL.
          date: Math.floor(Date.now() / 1000),
          expires: SIGNED_URL_TTL_SECONDS,
          filename,
          // ⚠ THESE TWO LINES ARE THE ACTUAL SECURITY CONTROL of this whole feature.
          // They are bound into the signature, so Pinata rejects an oversized or
          // wrong-typed upload regardless of what the browser sends. The matching checks
          // in lib/upload.ts are UX only and can be bypassed; these cannot.
          max_file_size: MAX_UPLOAD_BYTES,
          allow_mime_types: [...ALLOWED_MIME_TYPES],
        }),
      });
    } catch (e) {
      console.error("[sign-upload] Pinata unreachable:", e);
      return json({ error: "upstream_unreachable" }, 502);
    }

    if (!signed.ok) {
      // ⚠ Log the status, never the body verbatim to the client. An upstream error body
      // can echo request details, and this response is public.
      console.error("[sign-upload] Pinata refused to sign:", signed.status, await safeText(signed));
      return json({ error: "upstream_refused" }, 502);
    }

    const body = (await signed.json()) as { data?: unknown };
    const url = typeof body?.data === "string" ? body.data : null;
    if (!url) {
      console.error("[sign-upload] Pinata returned no URL in `data`.");
      return json({ error: "upstream_malformed" }, 502);
    }

    return json({ url }, 200);
  },
};

async function safeText(r: Response): Promise<string> {
  try {
    return (await r.text()).slice(0, 500);
  } catch {
    return "<unreadable>";
  }
}
