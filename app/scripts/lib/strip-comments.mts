// One comment stripper, shared by every checker that reads source.
//
// ⚠ THIS EXISTS BECAUSE THE SAME TRAP FIRED THREE TIMES. A checker that greps source for
// a forbidden string matches its OWN explanation of why that string is forbidden:
//
//   1. `verify:claims` matched /Uniswap\s*v/i against the string "NO UNISWAP VERSION" in
//      its own header, and failed the build for saying the right thing (CLAUDE.md §11.7).
//   2. `verify:address` searched styles.css for `hyphens: auto` and matched the comment
//      above `.addr` explaining why `hyphens: auto` is NOT the cause of the bug.
//   3. `verify:guard` asserts useArcGuard.ts does not call `useChainId()`, and that file's
//      prose names `useChainId()` several times explaining why it must not be used.
//
// Each of those three was fixed independently, with its own private copy of this regex
// pair. CLAUDE.md §12.6 promotes the pattern to a rule and proposes exactly this module.
// A fourth checker written tomorrow now has somewhere to reach instead of rediscovering
// it -- which is the whole point, because the failure mode is silent in the dangerous
// direction: a POSITIVE check satisfied by a comment passes while the real code is gone.
//
// ── ⚠ WHY LINE COMMENTS ARE ANCHORED TO THE START OF THE LINE ────────────────────────
//
// `//` is not only a comment opener. It appears inside every absolute URL, and this
// codebase is full of them -- `https://x.com/`, `https://uploads.pinata.cloud/...`,
// `ipfs://`. An unanchored /\/\/.*$/ would truncate
//
//     const PINATA_SIGN_URL = "https://uploads.pinata.cloud/v3/files/sign";
//
// to `const PINATA_SIGN_URL = "https:` and silently break `verify:upload` U7, which
// asserts that exact host. So only a line whose FIRST non-whitespace characters are `//`
// is treated as a comment. A trailing comment after code survives; that is the deliberate
// trade, and it is the safe direction -- leaving a trailing comment in costs a false
// positive that someone investigates, while eating a URL costs a false PASS.

/**
 * Remove comments from TS/TSX/CSS/HTML-ish source before asserting on it.
 *
 * Handles, in this order:
 *   1. `{/* ... *\/}` — the JSX form, braces included, so nothing is left behind
 *   2. `/* ... *\/`   — block comments (also CSS's only comment form)
 *   3. `// ...`       — line comments, ONLY where the line begins with them (see above)
 *
 * Newlines are preserved so line numbers reported by a caller stay meaningful.
 *
 * ⚠ THE JSX RULE IS TEMPERED -- `(?:(?!\*\/)[\s\S])*` rather than `[\s\S]*?` -- AND THAT
 * IS NOT A STYLE CHOICE. The lazy form backtracks past the first `*\/` looking for a
 * later one followed by `}`, so in CSS it matched
 *
 *     @media (max-width: 560px) {
 *       /* a comment *\/
 *       .upload-row { ... }
 *       .addr-full  { hyphens: none; ... }
 *     }
 *
 * from the media query's opening brace all the way to its CLOSING brace, and deleted
 * 1,013 characters of real CSS -- including the `.addr-full` rule two checks assert on.
 * Caught because `verify:address` A13/A14 went red on adoption.
 *
 * ⚠ Those two went red, which is the SAFE direction. The same over-deletion in a NEGATIVE
 * checker is silent and dangerous: `verify:claims` scans for forbidden claims, so text
 * this function eats is text that can never be flagged. A stripper that removes too much
 * turns every negative check into a pass. The tempered form cannot span a comment
 * boundary, so it matches exactly one comment and the brace that immediately follows it.
 */
export function stripComments(source: string): string {
  return source
    .replace(/\{\s*\/\*(?:(?!\*\/)[\s\S])*\*\/\s*\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "");
}
