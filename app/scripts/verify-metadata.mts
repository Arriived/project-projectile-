// Reading `tokens.metadata_uri`, and the social-link injection surface.
//
// ⚠ ASSERTS ON THE RESOLVED URL STRING, not on CSS and not on a component. The bug was
// that a JSON blob reached the gateway as a URL PATH, so the only assertion that would
// have caught it is one that looks at the URL actually produced.
//
// Run: npm run verify:metadata

import { parseTokenMetadata, socialUrl, socialLabel } from "../src/lib/metadata.ts";
import { resolveMediaUri } from "../src/lib/ipfs.ts";

let failures = 0;
const check = (label: string, pass: boolean, detail = "") => {
  if (!pass) failures++;
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${label}${detail ? `  — ${detail}` : ""}`);
};

// The exact value on chain for `dog` (0x7605bf0e…), copied verbatim from the live row.
const REAL_JSON =
  '{"image":"ipfs://bafkreihh3qfwu5rdzie7zfdfjoc3onnyw3oxgodmyueuujrlnigufl4noq","description":"a dog who is happy","x":"doggy"}';
const CID = "bafkreihh3qfwu5rdzie7zfdfjoc3onnyw3oxgodmyueuujrlnigufl4noq";

console.log("\nmetadata — shape 1: inline JSON (what the create flow writes)");
{
  const m = parseTokenMetadata(REAL_JSON);
  check("M1  image is extracted from the JSON, not the whole blob", m.image === `ipfs://${CID}`, m.image);
  check("M2  description is extracted", m.description === "a dog who is happy");
  check("M3  the x handle is extracted as a bare handle", m.x === "doggy");

  const url = resolveMediaUri(m.image);
  // ⚠ THE ASSERTION THE BUG WOULD HAVE FAILED. Before the fix the raw string went in and
  // the gateway was asked for a path containing `{"image":...`.
  check("M4  the RESOLVED URL ends in the bare CID", url !== null && url.endsWith(`/ipfs/${CID}`), url ?? "null");
  check("M5  the resolved URL contains no JSON punctuation", !!url && !/[{}"]/.test(url), url ?? "null");
}

console.log("\nmetadata — shape 2: empty / null (the R15 and GP tokens)");
for (const [label, raw] of [["empty string", ""], ["whitespace", "   "], ["null", null], ["undefined", undefined]] as const) {
  const m = parseTokenMetadata(raw as string | null | undefined);
  const url = resolveMediaUri(m.image);
  // ⚠ NO NETWORK REQUEST AT ALL. A null src means the placeholder renders and nothing is
  // fetched; returning "" would make the browser request the current page as an image.
  check(`M6  ${label} yields no image and therefore NO request`, m.image === undefined && url === null, String(url));
}

console.log("\nmetadata — shape 3: a bare URI (create flow with only an image, or set on chain)");
{
  const m = parseTokenMetadata(`ipfs://${CID}`);
  check("M7  a bare ipfs:// URI is taken as the image", m.image === `ipfs://${CID}`);
  check("M8  it resolves through the gateway", (resolveMediaUri(m.image) ?? "").endsWith(`/ipfs/${CID}`));
}
{
  const m = parseTokenMetadata("https://example.test/a.png");
  check("M9  a bare https URL passes through unchanged", resolveMediaUri(m.image) === "https://example.test/a.png");
}

console.log("\nmetadata — shape 4: malformed, or JSON without an image");
{
  // Truncated JSON -- the shape a half-written field takes.
  const m = parseTokenMetadata('{"image":"ipfs://abc","desc');
  check("M10 malformed JSON yields nothing, and never reaches the gateway", m.image === undefined && resolveMediaUri(m.image) === null);
}
{
  const m = parseTokenMetadata('{"description":"no image here"}');
  check("M11 JSON without an image still yields the description", m.image === undefined && m.description === "no image here");
  check("M11b and produces no image request", resolveMediaUri(m.image) === null);
}
for (const [label, raw] of [
  ["a JSON array", "[1,2,3]"],
  ["JSON null", "null"],
  ["a number field", '{"image":42}'],
  ["a nested object as image", '{"image":{"cid":"abc"}}'],
] as const) {
  const m = parseTokenMetadata(raw);
  check(`M12 ${label} yields no image`, m.image === undefined, JSON.stringify(m));
}
{
  // The observed 400: a single junk character reaching the gateway as `/ipfs/x`.
  const m = parseTokenMetadata("x");
  // ⚠ THIS CHECK COULD NOT GO RED, AND THAT IS WHY IT IS WRITTEN THIS WAY NOW.
  //
  // It originally read `resolveMediaUri(m.image) === null || !(…).endsWith("/ipfs/x")` --
  // an escape hatch so wide that a resolver returning "https://evil.example/" satisfied
  // it. Tightening it to just the first disjunct did not help: `parseTokenMetadata("x")`
  // returns `{}`, so `m.image` is undefined and `resolveMediaUri(undefined)` short-circuits
  // on its first guard. The resolver's allowlist was never reached, so mutating the
  // resolver left the check GREEN. It was a tautology restating M12.
  //
  // Proven, not assumed: making the resolver append any bare string to the gateway path
  // did not fail it. Same defect class as S8 asserting the off-by-one it was meant to
  // catch -- a check that cannot fail is not evidence.
  //
  // Now it feeds the RESOLVER directly, which is where the scheme allowlist lives and the
  // only place this behaviour can actually change.
  check("M13 a bare junk string produces no URL from the resolver", resolveMediaUri("x") === null, String(resolveMediaUri("x")));
  check("M13a the parser also declines it, so it never reaches the resolver", m.image === undefined);
}

// ⚠ M13b IS A LIVE VALUE, NOT A HYPOTHETICAL. Three tokens on the deployed indexer store
// literally `ipfs://x` -- a valid scheme wrapped around a junk path -- and it produced a
// real 400 on every page that rendered them. The scheme check alone passes it.
check("M13b a valid ipfs scheme with a junk CID is refused", resolveMediaUri("ipfs://x") === null, String(resolveMediaUri("ipfs://x")));
check("M13c a real CIDv0 is still accepted", resolveMediaUri("ipfs://QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG") !== null);
check("M13d a real CIDv1 is still accepted", resolveMediaUri(`ipfs://${CID}`) !== null);
check("M13e a CID with a sub-path still resolves", (resolveMediaUri(`ipfs://${CID}/img.png`) ?? "").endsWith(`/ipfs/${CID}/img.png`));

console.log("\nsocials — a URL built from attacker-controlled input");
check("M14 a plain handle builds the profile URL", socialUrl("x", "doggy") === "https://x.com/doggy");
check("M15 a leading @ is stripped", socialUrl("x", "@doggy") === "https://x.com/doggy");
check("M16 telegram uses t.me", socialUrl("telegram", "doggy") === "https://t.me/doggy");
check("M17 the label always shows @", socialLabel("doggy") === "@doggy" && socialLabel("@doggy") === "@doggy");

// ⚠ THE HOSTILE CASES. Each of these is a real redirect or injection if concatenated
// naively, and each must produce NO LINK rather than a cleaned-up one.
const HOSTILE: [string, string][] = [
  ["a different host", "evil.com"],
  ["path traversal", "a/../../evil"],
  ["a slash", "doggy/evil"],
  ["a full URL", "https://evil.com"],
  ["a scheme", "javascript:alert(1)"],
  ["a query string", "doggy?next=evil"],
  ["a fragment", "doggy#evil"],
  ["whitespace", "doggy evil"],
  ["a protocol-relative URL", "//evil.com"],
  ["an @ mid-string", "doggy@evil.com"],
  ["empty after stripping", "@"],
  ["a newline", "doggy\nevil"],
];
for (const [label, h] of HOSTILE) {
  check(`M18 REFUSES ${label} (${JSON.stringify(h)})`, socialUrl("x", h) === null && socialLabel(h) === null, String(socialUrl("x", h)));
}

// And the property that matters more than any single case.
check(
  "M19 no hostile handle can ever produce a URL outside the expected host",
  HOSTILE.every(([, h]) => {
    const u = socialUrl("x", h);
    return u === null || u.startsWith("https://x.com/");
  })
);

console.log(failures === 0 ? `\n  all metadata checks passed\n` : `\n  ${failures} FAILED\n`);
// process.exitCode, not process.exit() — see the note in the other verify scripts.
process.exitCode = failures === 0 ? 0 : 1;
