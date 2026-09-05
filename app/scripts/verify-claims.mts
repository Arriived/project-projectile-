// Public claims the contract must actually honour.
//
// ── WHY THIS IS A BUILD CHECK AND NOT A CODE REVIEW ───────────────────────────
//
// The landing page said "Uniswap v4" in five places -- meta description, hero copy,
// section 04 body, the fourth graduation step, and the footer chips. Mainnet ships the
// **V2** router with LP burned to 0x...dEaD (CLAUDE.md §6, a settled forward decision).
// V4 is post-launch work that has to pass the 24-hour router timelock, and CLAUDE.md §6
// is explicit that a session must not start building it.
//
// So the site was making a public, specific, checkable claim the deployed contract
// contradicts. On a project whose entire stated moat is "trust and verifiability",
// that is the worst failure available -- worse than a bug, because a competitor can
// falsify it in one page load and the fix does not undo having said it.
//
// Five instances found by reading carefully once. A sixth would be found the same way, or
// not at all. This finds it every build instead.
//
// Run: npm run verify:claims   (wired into the verify chain)

import { readFileSync, readdirSync, statSync } from "node:fs";
import { stripComments } from "./lib/strip-comments.mts";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

let failures = 0;
const check = (label: string, pass: boolean, detail = "") => {
  if (!pass) failures++;
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${label}${detail ? `  — ${detail}` : ""}`);
};

const root = fileURLToPath(new URL("../src", import.meta.url));

const files: string[] = [];
const walk = (d: string) => {
  for (const e of readdirSync(d)) {
    const p = join(d, e);
    if (statSync(p).isDirectory()) {
      if (e === "abi") continue; // generated, contains no prose
      walk(p);
    } else if (/\.(tsx?|css|html)$/.test(p)) {
      files.push(p);
    }
  }
};
walk(root);

// Also cover the HTML shell, which is where meta descriptions and OG tags live -- the
// landing page had two of its five instances in metadata rather than body copy.
const shell = fileURLToPath(new URL("../index.html", import.meta.url));
files.push(shell);

/**
 * Claims that must not appear, with the reason attached to each.
 *
 * ⚠ MATCHED AGAINST SOURCE WITH COMMENTS STRIPPED. Read the note on REJECTS_CLAIM's
 * removal below before changing that -- scanning comments as well cost this checker four
 * of its five patterns.
 */
const FORBIDDEN: { pattern: RegExp; why: string }[] = [
  {
    pattern: /uniswap\s*v\.?\s*4/i,
    why: "mainnet ships the V2 router with LP burned; V4 is post-launch via the router timelock (CLAUDE.md §6)",
  },
  {
    pattern: /uniswap\s*v\.?\s*3/i,
    why: "we do not deploy to a V3 pool at any point",
  },
  {
    pattern: /\bLP\s+(?:is\s+)?locked\b/i,
    why: "'locked' is a different claim from 'burned' and needs a locker contract that does not exist (CLAUDE.md §1.8)",
  },
  {
    pattern: /\b90\s*\/\s*10\b/,
    why: "the creator split blends to 70%, not 90/10 -- readable on a verified contract in thirty seconds (CLAUDE.md §7A)",
  },
  {
    pattern: /creators?\s+are\s+capped\s+at/i,
    why: "the 2.5% cap limits only the PRIVILEGED launch-buy path; nothing stops a second address (CLAUDE.md §7A)",
  },
];

// ⚠ REJECTS_CLAIM IS DELETED. IT DISABLED FOUR OF THE FIVE PATTERNS ABOVE.
//
// It was a word-list exemption: any line matching /not|never|instead|was|
// said|.../ was skipped, on the reasoning that a line NAMING a forbidden claim in
// order to reject it is not making it. The reasoning was sound; the mechanism was not.
// Those are among the commonest words in English, so ordinary marketing copy carried
// them and was waved straight through. Measured, using this file's own regexes:
//
//   MISSED  Liquidity lands in a Uniswap v3 pool, not a bespoke AMM.
//   MISSED  LP is locked forever — your liquidity is never at risk.
//   MISSED  A 90/10 creator split, not the industry standard.
//   MISSED  Creators are capped at 2.5%, so nobody was able to dump on you.
//
// The second is the one that mattered: CLAUDE.md §1.8 says "burned" and "locked" are NOT
// interchangeable claims, and LP burned to 0x…dEaD is one of the differentiators the
// positioning rests on. A checker that would not catch that sentence was not doing its job.
//
// ⚠ THE RESIDUAL EXEMPTION IS NONE, and that is measured rather than assumed. Stripping
// comments and running all five patterns over all 60 scanned files with NO exemption
// yields ZERO hits -- every one of the 8 matches the word list used to suppress was a
// comment (`// Was "Uniswap v4".`), which stripComments now removes at the source. The
// exemption was therefore buying nothing and costing four patterns.
//
// ⚠ DO NOT REINTRODUCE A WORD LIST if a legitimate rejection ever needs to appear in
// SHIPPED COPY. Exempt that one string by identity, or reword it. A vocabulary rule
// cannot tell "we do not use Uniswap v4" from "Uniswap v4 pools, not the older V3".

/**
 * Every forbidden claim in a piece of text, with the line it appeared on.
 *
 * ⚠ EXPORTED SHAPE ON PURPOSE: the fixture check below runs the SAME function over
 * hand-written claim strings that the file scan runs over real source. A fixture tested
 * against a reimplementation of the detector proves only that the detector can be typed
 * twice -- CLAUDE.md §12.6's M13 rule.
 */
function findForbiddenClaims(text: string): { line: number; text: string; why: string }[] {
  const found: { line: number; text: string; why: string }[] = [];
  stripComments(text)
    .split("\n")
    .forEach((line, i) => {
      for (const { pattern, why } of FORBIDDEN) {
        if (pattern.test(line)) found.push({ line: i + 1, text: line.trim(), why });
      }
    });
  return found;
}

const hits: string[] = [];
for (const f of files) {
  for (const h of findForbiddenClaims(readFileSync(f, "utf8"))) {
    hits.push(`${relative(root, f)}:${h.line}
        ${h.text.slice(0, 90)}
        -> ${h.why}`);
  }
}

console.log(`── public claims (${files.length} files) ──`);
check(
  "no claim the deployed contract contradicts",
  hits.length === 0,
  hits.length ? `${hits.length} found\n        ${hits.join("\n        ")}` : "none"
);

// ── the positive half ──────────────────────────────────────────────────────────
//
// Without this, "fixing" a flagged claim by DELETING the sentence would pass -- and
// deleting the graduation step is not a fix, it is hiding the mechanism the product is
// built on.
//
// It checks the STRING VALUE, not the file source. Two bugs came out of getting that
// wrong, both found by red-proofing rather than by reading:
//
//   1. /Uniswap\s*v/i matched the comment "NO UNISWAP VERSION appears" and failed the
//      build for saying the right thing. A version is "v" followed by a DIGIT.
//   2. Reading the file source meant a COMMENT containing "Uniswap" satisfied the check
//      even after every user-visible mention had been deleted. The red-proof passed when
//      it should have failed, which is the only reason this was noticed.
//
// Same lesson twice: a checker must read what ships, not the file that produces it.
const { en } = (await import("../src/i18n/en.ts")) as { en: Record<string, Record<string, string>> };
const copyValues = Object.values(en)
  .flatMap((group) => (typeof group === "object" ? Object.values(group) : []))
  .filter((v): v is string => typeof v === "string");

const namesUniswap = copyValues.some((v) => /Uniswap/i.test(v));
const versionedInCopy = copyValues.some((v) => /Uniswap\s*v\.?\s*\d/i.test(v));
check(
  "the graduation copy still names Uniswap (unversioned), rather than having been deleted",
  namesUniswap && !versionedInCopy,
  `${copyValues.length} strings checked — names Uniswap: ${namesUniswap}, versioned: ${versionedInCopy}`
);

// ══ FIXTURES ═══════════════════════════════════════════════════════════════════════
//
// ⚠ EVERY PATTERN IS PROVED TO CATCH A REAL-SHAPED CLAIM. Four of these five were MISSED
// by the old REJECTS_CLAIM word list; they are pinned here so removing the exemption
// cannot be quietly undone.
//
// ⚠ THESE ARE CLAIM STRINGS, NOT COMMENTS. That distinction is the whole point: the
// self-matching trap has fired three times in this project, so each fixture is written as
// the sentence a marketing page would actually contain, and F6 below proves the SAME
// sentence is correctly ignored once it is a comment.
//
// ⚠ scripts/ is not in the scanned tree (`root` is ../src plus ../index.html), so these
// strings cannot flag the build by existing here. Verified: the scan reports 60 files and
// none of them is this one.
console.log("\n── the detector catches a real claim for every pattern ──");

const CLAIM_FIXTURES: [string, string][] = [
  ["v4", "Every launch graduates into a Uniswap v4 pool the moment it fills."],
  ["v3", "Liquidity lands in a Uniswap v3 pool, not a bespoke AMM."],
  ["LP locked", "LP is locked forever — your liquidity is never at risk."],
  ["90/10", "A 90/10 creator split, not the industry standard."],
  ["creator cap", "Creators are capped at 2.5%, so nobody was able to dump on you."],
];
for (const [label, claim] of CLAIM_FIXTURES) {
  const found = findForbiddenClaims(claim);
  check(`F  catches the ${label} claim`, found.length > 0, JSON.stringify(claim.slice(0, 52)) + "…");
}

// ⚠ THE OTHER HALF. Stripping must still exempt honest quotation in a COMMENT, or the
// checker fails the build for explaining itself -- the defect CLAUDE.md §11.7 records.
// Same sentence, once as code and once as a comment.
const asComment = "// " + CLAIM_FIXTURES[2][1];
check("F6 the same sentence as a COMMENT is not flagged", findForbiddenClaims(asComment).length === 0);
check("F7 …but as shipped copy it still is", findForbiddenClaims(CLAIM_FIXTURES[2][1]).length > 0);

// Negative control: honest copy must not trip anything, or the checker is noise people
// switch off.
const CLEAN = [
  "At the threshold the curve closes and its liquidity moves to a Uniswap pool.",
  "The LP tokens are burned, so the liquidity cannot be withdrawn.",
  "Creators receive 70% of trading fees, blended across buys and sells.",
];
for (const line of CLEAN) {
  check(`F8 honest copy is not flagged`, findForbiddenClaims(line).length === 0, JSON.stringify(line.slice(0, 44)) + "…");
}

console.log(`\n${failures === 0 ? "OK" : `${failures} FAILURE(S)`}`);
// ⚠ process.exitCode, NOT process.exit(). process.exit() tears the event loop down
// while the console.log lines above may still be flushing, and on Windows that races
// libuv into "Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)" and an exit code
// of 127 -- a GREEN suite reported as a failed build, intermittently. Measured before
// the fix: verify:slippage 0/127/127/127/127/0, verify:upload 0/127/0/0/0/127.
// A gate that fails randomly trains a human to re-run until green, which is how a real
// failure gets dismissed under pressure. Setting exitCode lets node exit naturally once
// stdout has drained.
if (failures) process.exitCode = 1;
