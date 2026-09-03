// The address copy guarantee.
//
// ⚠ READ THIS BEFORE ADDING A CSS ASSERTION HERE. The brief asked for a check on the
// COPIED TEXT rather than on a CSS property, which is the right instinct. But the two are
// not merely different confidence levels -- they test different things, and only one of
// them is even reachable from node:
//
//   * There is no layout engine here. `node --experimental-strip-types` has no DOM, no
//     CSS cascade and no line-breaking, so nothing in this file can observe hyphenation.
//   * More importantly, hyphenation is not observable in TEXT at all, in any engine.
//     Measured in a real browser: with `hyphens: auto` forcibly applied and confirmed
//     active, a `Selection` over the address still serialised to exactly 42 characters
//     with zero hyphens. A CSS hyphen is painted, not inserted.
//
// So the copyable text cannot be corrupted by CSS, and the thing that CAN corrupt it is
// the copy path itself -- a formatter, a checksum pass, a "readability" chunker, or a
// component that copies something other than what it renders. That is what this file
// pins, against the real code path rather than a transcription of it.
//
// Run: npm run verify:address

import { readFileSync } from "node:fs";
import {
  ADDRESS_LENGTH,
  EXACT_ADDRESS_RE,
  clipboardTextFor,
  forbiddenCharsIn,
  isExactAddress,
} from "../src/lib/address.ts";

let failures = 0;
const check = (label: string, pass: boolean, detail = "") => {
  if (!pass) failures++;
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${label}${detail ? `  — ${detail}` : ""}`);
};

// Real addresses off this deployment: the factory, the treasury/creator, and the burn
// address. Mixed case on purpose -- a checksummed address must survive verbatim.
const FACTORY = "0xEDeed1F05D34421Add0F59b7340588ab2BbaC04b";
const CREATOR = "0x64140EAa0a3B6E4682C98e440837bd3d5482B4cb";
const BURN = "0x000000000000000000000000000000000000dEaD";
const TOKEN = "0xe49fb999F6442a01D62b5d8851797c623aA0F9c8";
const ALL = [FACTORY, CREATOR, BURN, TOKEN];

console.log("\naddress — the copied text is the address, exactly");

// A1-A4. The core assertion the brief asked for, on the text the button actually writes.
for (const [i, a] of ALL.entries()) {
  const copied = clipboardTextFor(a);
  check(
    `A${i + 1}  copied text is ${ADDRESS_LENGTH} chars and matches /^0x[0-9a-fA-F]{40}$/`,
    copied.length === ADDRESS_LENGTH && EXACT_ADDRESS_RE.test(copied),
    `${copied.length} chars`
  );
}

// A5. Character-identical, not merely well-formed. A lowercasing or checksum pass would
// still produce 42 valid hex characters while copying a different-looking address.
check(
  "A5  copied text is character-identical to the input (no case or format change)",
  ALL.every((a) => clipboardTextFor(a) === a)
);

// A6. The invisible ones are the dangerous ones -- they survive a paste unseen.
check(
  "A6  no forbidden character survives the copy path",
  ALL.every((a) => forbiddenCharsIn(clipboardTextFor(a)).length === 0)
);

console.log("\naddress — corruption is refused, not passed through");

// A7-A10. Each of these is a real corruption shape, and each must be caught rather than
// copied. A copy button that silently emits a broken address is worse than one that does
// nothing: the user has looked away by the time they paste.
const CORRUPT: [string, string][] = [
  ["soft hyphens at the wrap points (the reported symptom)", "0xEDeed1F0­5D34421Add0F59b73­40588ab2BbaC04b"],
  ["an ASCII hyphen", "0xEDeed1F0-5D34421Add0F59b7340588ab2BbaC04b"],
  ["a zero-width space", "0xEDeed1F0​5D34421Add0F59b7340588ab2BbaC04b"],
  ["truncated to 41 characters", FACTORY.slice(0, 41)],
];
for (const [i, [label, bad]] of CORRUPT.entries()) {
  let threw = false;
  try {
    clipboardTextFor(bad);
  } catch {
    threw = true;
  }
  check(`A${7 + i}  refuses to copy ${label}`, threw, `len ${bad.length}`);
}

check("A11 isExactAddress rejects every corrupted form", CORRUPT.every(([, b]) => !isExactAddress(b)));
check(
  "A12 forbiddenCharsIn names the invisible characters it finds",
  forbiddenCharsIn(CORRUPT[0][1]).includes("U+00AD") && forbiddenCharsIn(CORRUPT[2][1]).includes("U+200B")
);

console.log("\naddress — the render path cannot reintroduce hyphenation");

// A13-A15. Not a substitute for the text assertions above (see the header): this is the
// belt-and-braces layer, and it is checked because it is cheap, not because it is the
// defence. It fails if someone deletes the explicit rule or swaps the break mechanism for
// one that adds a glyph.
const cssRaw = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
// ⚠ STRIP COMMENTS BEFORE ASSERTING ON CSS. A15 below searches for `hyphens: auto`, and
// the comment above `.addr` explains at length why `hyphens: auto` is not the cause of the
// reported bug -- so the first version of this check failed against its own documentation.
// That is the same defect CLAUDE.md §11.7 records for verify:claims, where /Uniswap\s*v/i
// matched the string "NO UNISWAP VERSION" in the checker's own copy. A checker must read
// the rules, never the prose about the rules.
const css = cssRaw.replace(/\/\*[\s\S]*?\*\//g, "");
// ⚠ `.addr-full`, not `.addr`. A pre-existing `.addr` rule (13px muted) styles the
// truncated wallet address in WalletBar, and a full-address class named `.addr` would
// silently restyle it. The regexes must name the specific class or they will happily
// match the wrong rule and report on something this feature does not own.
check(
  "A13 .addr-full sets hyphens: none explicitly",
  /\.addr-full\s*\{[^}]*hyphens:\s*none/s.test(css)
);
check(
  "A14 .addr-full breaks with overflow-wrap (inserts no character), not a hyphenation pass",
  /\.addr-full\s*\{[^}]*overflow-wrap:\s*anywhere/s.test(css)
);
check(
  "A15 no rule anywhere enables automatic hyphenation",
  !/hyphens:\s*auto/.test(css),
  "hyphens: auto must not appear in an actual rule"
);

console.log("\naddress — both full-address render sites use the shared component");

// A16-A17. The guarantee is only worth anything if every site goes through it. The
// CREATOR field previously had no copy affordance at all, which is what left a phone user
// hand-selecting 42 characters across four wrapped lines.
const trust = readFileSync(new URL("../src/components/token/TrustPanel.tsx", import.meta.url), "utf8");
const identity = readFileSync(new URL("../src/components/token/TokenIdentity.tsx", import.meta.url), "utf8");
check("A16 TrustPanel renders the creator through AddressText", /<AddressText/.test(trust));
check("A17 TokenIdentity renders the token address through AddressText", /<AddressText/.test(identity));

const component = readFileSync(new URL("../src/components/AddressText.tsx", import.meta.url), "utf8");
check(
  "A18 AddressText copies via clipboardTextFor, not a raw writeText of arbitrary text",
  /clipboardTextFor\(address\)/.test(component)
);

console.log(failures === 0 ? `\n  all address checks passed\n` : `\n  ${failures} FAILED\n`);
// ⚠ process.exitCode, NOT process.exit(). process.exit() tears the loop down while the
// console.log lines above may still be flushing, and on Windows that races libuv into
// "Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)" and an exit code of 127 -- a
// GREEN suite reported as a failed build, intermittently. Setting exitCode lets node exit
// naturally once stdout has drained.
process.exitCode = failures === 0 ? 0 : 1;
