// Checks on the image-upload path.
//
// The rules worth checking here are the ones a well-meaning edit would break silently:
// the secret's name acquiring a VITE_ prefix, the two copies of the size/mime limits
// drifting, a gateway URL replacing the ipfs:// URI on chain, SVG entering the allowlist.
// None of those fail loudly on their own.
//
// ⚠ SEVERAL CHECKS READ THE SOURCE TEXT, NOT THE EXPORTS. That is deliberate and is the
// same technique verify-create.mts uses for the economics hash: a check that imports a
// value can be satisfied by a copy of the value, whereas a check that greps the file it
// is protecting cannot pass while the file says something else.
//
// Run: npm run verify:upload

import { readFileSync } from "node:fs";
import {
  ALLOWED_MIME_TYPES,
  MAX_UPLOAD_BYTES,
  SIGNED_URL_TTL_SECONDS,
  cidToTokenUri,
  validateImageFile,
  SIGN_ENDPOINT,
} from "../src/lib/upload.ts";
import { resolveMediaUri } from "../src/lib/ipfs.ts";

let failures = 0;
const check = (label: string, pass: boolean, detail = "") => {
  if (!pass) failures++;
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${label}${detail ? `  — ${detail}` : ""}`);
};

const apiSrc = readFileSync(new URL("../api/sign-upload.ts", import.meta.url), "utf8");
const libSrc = readFileSync(new URL("../src/lib/upload.ts", import.meta.url), "utf8");
const vercelJson = readFileSync(new URL("../vercel.json", import.meta.url), "utf8");
const viteSrc = readFileSync(new URL("../vite.config.ts", import.meta.url), "utf8");

console.log("\nupload — the secret");

// U1. The whole point of the serverless function. A VITE_ prefix publishes the key.
check(
  "U1  PINATA_JWT is read from process.env and is NOT VITE_-prefixed",
  /process\.env\.PINATA_JWT/.test(apiSrc) && !/VITE_PINATA_JWT/.test(apiSrc),
  "a VITE_ prefix would inline the Pinata key into the client bundle"
);

// U2. The key must never be reachable from anything Vite bundles.
const clientFiles = [libSrc, readFileSync(new URL("../src/lib/ipfs.ts", import.meta.url), "utf8")];
check(
  "U2  no client module references PINATA_JWT",
  clientFiles.every((s) => !/PINATA_JWT/.test(s))
);

// U3. Fail closed. A missing key must refuse, never fall through to an unsigned call.
check(
  "U3  a missing PINATA_JWT refuses to sign",
  /if \(!jwt\)/.test(apiSrc) && /not_configured/.test(apiSrc)
);

console.log("\nupload — server-side enforcement is the real control");

// U4/U5. These two fields are the only actual security boundary in the feature: they are
// bound into the signature, so Pinata enforces them against the real bytes.
check("U4  the signed URL carries max_file_size", /max_file_size:\s*MAX_UPLOAD_BYTES/.test(apiSrc));
check(
  "U5  the signed URL carries allow_mime_types",
  /allow_mime_types:\s*\[\.\.\.ALLOWED_MIME_TYPES\]/.test(apiSrc)
);

// U6. Bounded window. Without expires the URL is a standing upload endpoint.
check("U6  the signed URL expires", /expires:\s*SIGNED_URL_TTL_SECONDS/.test(apiSrc));

// U7. The documented signing host. `api.pinata.cloud` is a different service and 404s.
check(
  "U7  signs against uploads.pinata.cloud/v3/files/sign",
  apiSrc.includes("https://uploads.pinata.cloud/v3/files/sign")
);

console.log("\nupload — the two copies of the limits must not drift");

/** Pull a numeric const out of a source file by name, so both copies are read as text. */
function numConst(src: string, name: string): number | null {
  const m = src.match(new RegExp(`const ${name} = ([^;]+);`));
  if (!m) return null;
  try {
    return Number(new Function(`return (${m[1]})`)());
  } catch {
    return null;
  }
}

const apiMax = numConst(apiSrc, "MAX_UPLOAD_BYTES");
const apiTtl = numConst(apiSrc, "SIGNED_URL_TTL_SECONDS");
const apiMimeMatch = apiSrc.match(/const ALLOWED_MIME_TYPES = (\[[^\]]*\])/);
const apiMime: string[] = apiMimeMatch ? JSON.parse(apiMimeMatch[1].replace(/'/g, '"')) : [];

check("U8  MAX_UPLOAD_BYTES matches across api/ and src/", apiMax === MAX_UPLOAD_BYTES, `api=${apiMax} lib=${MAX_UPLOAD_BYTES}`);
check("U9  SIGNED_URL_TTL_SECONDS matches across api/ and src/", apiTtl === SIGNED_URL_TTL_SECONDS, `api=${apiTtl} lib=${SIGNED_URL_TTL_SECONDS}`);
check(
  "U10 ALLOWED_MIME_TYPES matches across api/ and src/",
  JSON.stringify(apiMime) === JSON.stringify([...ALLOWED_MIME_TYPES]),
  `api=${JSON.stringify(apiMime)}`
);

console.log("\nupload — the allowlist");

// U11. See the header in lib/upload.ts. SVG is script-capable, attacker-supplied, and
// displayed next to other people's money.
check(
  "U11 SVG is NOT in the mime allowlist",
  !(ALLOWED_MIME_TYPES as readonly string[]).some((m) => /svg/i.test(m)) && !/svg/i.test(apiMimeMatch?.[1] ?? "")
);

check(
  "U12 a 6 MB PNG is rejected client-side",
  validateImageFile({ size: 6 * 1024 * 1024, type: "image/png" })?.kind === "tooLarge"
);
check("U13 a 1 MB PNG is accepted", validateImageFile({ size: 1024 * 1024, type: "image/png" }) === null);
check(
  "U14 an SVG is rejected client-side",
  validateImageFile({ size: 1000, type: "image/svg+xml" })?.kind === "badType"
);
check("U15 an empty file is rejected", validateImageFile({ size: 0, type: "image/png" })?.kind === "empty");
check(
  "U16 a mime with a charset parameter is still accepted",
  validateImageFile({ size: 1000, type: "image/png; charset=binary" }) === null,
  "browsers may report either form"
);

console.log("\nupload — what goes on chain");

// U17. A gateway hostname written on chain is a permanent dependency on one domain.
check("U17 an upload yields an ipfs:// URI, not a gateway URL", cidToTokenUri("bafyTEST") === "ipfs://bafyTEST");
check(
  "U17b cidToTokenUri never emits an http(s) URL",
  !/https?:/.test(cidToTokenUri("bafyTEST"))
);

console.log("\nupload — the render-side scheme allowlist");

check("U18 ipfs:// resolves through a gateway", (resolveMediaUri("ipfs://bafyTEST") ?? "").endsWith("/ipfs/bafyTEST"));
check("U19 https: passes through unchanged", resolveMediaUri("https://x.test/a.png") === "https://x.test/a.png");
check("U20 javascript: is refused", resolveMediaUri("javascript:alert(1)") === null);
check("U21 blob: is refused", resolveMediaUri("blob:https://x.test/abc") === null);
check("U22 data:text/html is refused", resolveMediaUri("data:text/html,<script>") === null);
check("U23 data:image is allowed", resolveMediaUri("data:image/png;base64,AAAA") !== null);
check("U24 a bare string is refused", resolveMediaUri("not-a-url") === null);
check("U25 legacy ipfs://ipfs/<cid> is normalised", (resolveMediaUri("ipfs://ipfs/bafyTEST") ?? "").endsWith("/ipfs/bafyTEST"));

console.log("\ndeploy — the routing and build settings this feature depends on");

// U26. THE ONE THAT MATTERS MOST FOR THE DEPLOY. The SPA rewrite is a catch-all for
// extensionless paths, and /api/sign-upload is extensionless: without the exclusion it is
// rewritten to the app shell and the upload receives HTML where it expects JSON.
const rewriteSource: string = JSON.parse(vercelJson).rewrites[0].source;
const rewriteRe = new RegExp(`^${rewriteSource}$`);
check(
  "U26 the SPA rewrite does NOT swallow /api/sign-upload",
  !rewriteRe.test(SIGN_ENDPOINT),
  `source=${rewriteSource}`
);

// U27. The check the whole domain's search presence rests on.
check(
  "U27 the SPA rewrite does NOT swallow the Google verification file",
  !rewriteRe.test("/google3af9e8ceff8d4db2.html")
);
check("U28 the SPA rewrite does NOT swallow static assets", ["/favicon-32x32.png", "/site.webmanifest", "/apple-touch-icon.png", "/assets/index-abc123.js"].every((p) => !rewriteRe.test(p)));

// U29. App routes must still reach the shell, or the rewrite has been over-tightened.
check(
  "U29 app routes still reach the shell",
  ["/", "/about", "/create", "/t/0xEDeed1F05D34421Add0F59b7340588ab2BbaC04b"].every((p) => rewriteRe.test(p))
);

// U30. Source maps republish the original TypeScript next to the app.
check("U30 production source maps are off", /sourcemap:\s*false/.test(viteSrc));

console.log(
  failures === 0
    ? `\n  all upload checks passed\n`
    : `\n  ${failures} FAILED\n`
);
process.exit(failures === 0 ? 0 : 1);
