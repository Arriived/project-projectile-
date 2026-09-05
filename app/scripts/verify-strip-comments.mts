// The shared comment stripper — checked, because four checkers now rest on it.
//
// ⚠ WHY THIS SUITE EXISTS. `stripComments` is infrastructure: verify:claims,
// verify:guard, verify:address and verify:list all read source through it. A bug here is
// silent in the worst direction — a stripper that removes TOO MUCH turns every NEGATIVE
// checker into a pass, because text it eats is text that can never be flagged. That is
// precisely the "something reporting success while doing nothing" genre.
//
// It is not hypothetical. The first version of the shared helper used a lazy JSX pattern
// `\{\s*\/\*[\s\S]*?\*\/\s*\}`, which backtracks past the first `*/` hunting for a later
// one followed by `}`. On styles.css that matched from a media query's OPENING brace to
// its CLOSING brace and deleted 1,013 characters of real CSS. S6/S7 below are that exact
// case, pinned.

import { readFileSync } from "node:fs";
import { stripComments } from "./lib/strip-comments.mts";

let failures = 0;
const check = (label: string, pass: boolean, detail = "") => {
  if (!pass) failures++;
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${label}${detail ? `  — ${detail}` : ""}`);
};

console.log("\nstripComments — what it must remove");
check("S1  a whole-line // comment is removed", stripComments("  // gone\nkept").trim() === "kept");
check("S2  a block comment is removed", stripComments("/* gone */kept").trim() === "kept");
check(
  "S3  a JSX comment is removed, braces included",
  stripComments("<p>{/* gone */}kept</p>").trim() === "<p>kept</p>"
);
check(
  "S4  a multi-line block comment is removed",
  stripComments("/*\n gone\n gone\n*/kept").trim() === "kept"
);

console.log("\nstripComments — ⚠ what it must NOT remove");
// The reason line comments are anchored. An unanchored /\/\/.*$/ truncates every URL in
// the codebase, and verify:upload U7 asserts one exactly.
const url = 'const U = "https://uploads.pinata.cloud/v3/files/sign";';
check("S5  a URL containing // survives intact", stripComments(url) === url, "verify:upload U7 depends on it");
check(
  "S5b an ipfs:// scheme survives",
  stripComments('const s = "ipfs://bafkreiabc";') === 'const s = "ipfs://bafkreiabc";'
);

// ⚠ THE REGRESSION. This is the shape that deleted 1,013 characters of styles.css.
const cssBlock = `@media (max-width: 560px) {
  /* a comment */
  .upload-row { flex-direction: column; }
  .addr-full { hyphens: none; overflow-wrap: anywhere; }
}`;
const strippedCss = stripComments(cssBlock);
check(
  "S6  ⚠ a JSX-comment rule must NOT span a CSS block and eat the rules inside it",
  strippedCss.includes(".addr-full") && strippedCss.includes("hyphens: none"),
  strippedCss.includes(".addr-full") ? "rules survive" : "RULES DELETED — the 1,013-char bug is back"
);
check(
  "S7  ⚠ the media query's own braces survive",
  strippedCss.includes("@media") && strippedCss.trim().endsWith("}")
);

// Two comments in one brace pair is the backtracking case specifically.
const twoComments = `.a { /* one */ color: red; /* two */ }`;
check(
  "S8  ⚠ two comments inside one brace pair does not delete the declaration between them",
  stripComments(twoComments).includes("color: red")
);

// A genuinely empty JSX comment IS the one thing the brace rule should collapse.
check("S9  `{/* x */}` collapses entirely, leaving no stray braces", !stripComments("a{/* x */}b").includes("{"));

console.log("\nstripComments — against the real files the checkers read");
const files = [
  ["src/styles.css", ".addr-full"],
  ["src/hooks/useArcGuard.ts", "useAccount"],
  ["src/lib/upload.ts", "MAX_UPLOAD_BYTES"],
  ["src/i18n/en.ts", "graduat"],
] as const;
for (const [rel, needle] of files) {
  const raw = readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");
  const out = stripComments(raw);
  check(
    `S10 ${rel} keeps its code (${needle})`,
    out.includes(needle),
    `${raw.length} -> ${out.length} chars`
  );
}

// ⚠ THE PROPERTY THAT MATTERS MOST, stated directly: stripping must only ever remove
// comment text. If a non-comment line vanishes, a negative checker silently stops seeing
// it. Verified by checking that every line of code (comments excluded) survives.
const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
const strippedAll = stripComments(css);
// ⚠ CLASSIFYING A LINE AS "CODE" NEEDS BLOCK TRACKING, NOT A PREFIX TEST. The first
// version of this check filtered on `startsWith("/*") || startsWith("*")`, which treats
// the CONTINUATION lines of a block comment as code -- this file's own prose contains
// lines like "one product." with no leading marker -- and reported 101 false losses. A
// check that cannot tell a comment from code cannot audit a comment stripper.
const codeLines: string[] = [];
let inBlock = false;
for (const rawLine of css.split("\n")) {
  const line = rawLine.trim();
  let rest = line;
  let code = "";
  while (rest.length) {
    if (inBlock) {
      const close = rest.indexOf("*/");
      if (close === -1) { rest = ""; break; }
      inBlock = false;
      rest = rest.slice(close + 2);
    } else {
      const open = rest.indexOf("/*");
      if (open === -1) { code += rest; rest = ""; break; }
      code += rest.slice(0, open);
      inBlock = true;
      rest = rest.slice(open + 2);
    }
  }
  const trimmed = code.trim();
  if (trimmed && !trimmed.startsWith("//")) codeLines.push(trimmed);
}
const missing = codeLines.filter((l) => !strippedAll.includes(l));
check(
  "S11 ⚠ every non-comment line of styles.css survives stripping",
  missing.length === 0,
  missing.length ? `${missing.length} LOST, e.g. ${JSON.stringify(missing[0]?.slice(0, 50))}` : `${codeLines.length} lines checked`
);

console.log(failures === 0 ? `\n  all strip-comments checks passed\n` : `\n  ${failures} FAILED\n`);
// process.exitCode, not process.exit() — see the note in the other verify scripts.
process.exitCode = failures === 0 ? 0 : 1;
