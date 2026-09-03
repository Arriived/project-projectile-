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
 * Matched case-insensitively against SOURCE TEXT, including comments -- a comment
 * asserting "we ship v4" is wrong in the same way and misleads the next reader, which is
 * how the claim reached five places to begin with.
 *
 * The one legitimate exception is prose that explicitly says V4 is NOT what ships. Those
 * lines name the contradiction rather than making the claim, so they are allowed by an
 * explicit allowlist of surrounding words rather than by a blanket carve-out.
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

/**
 * Lines that NAME a forbidden claim in order to reject it are not making it.
 *
 * This vocabulary was too narrow on its first run and flagged this very file's header,
 * which quotes "Uniswap v4" precisely to explain why it is banned. A checker that fails
 * on its own explanation of itself is a checker people switch off, so the exemption has
 * to cover honest quotation -- while staying keyed to explicit rejection words rather
 * than becoming a blanket carve-out for comments.
 */
const REJECTS_CLAIM =
  /\bnot\b|\bnever\b|\bno version\b|\bpost-launch\b|\bforbidden\b|\bmust not\b|\bcontradicts?\b|\binstead\b|\bwas\b|\bsaid\b|\bbanned\b|\bunversioned\b/i;

const hits: string[] = [];
for (const f of files) {
  const src = readFileSync(f, "utf8");
  src.split("\n").forEach((line, i) => {
    for (const { pattern, why } of FORBIDDEN) {
      if (!pattern.test(line)) continue;
      if (REJECTS_CLAIM.test(line)) continue;
      hits.push(`${relative(root, f)}:${i + 1}\n        ${line.trim().slice(0, 90)}\n        -> ${why}`);
    }
  });
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
