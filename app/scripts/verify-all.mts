// Run every verify suite and print a machine-readable summary.
//
// ── WHY THIS REPLACED A CHAIN OF `&&` ────────────────────────────────────────────────
//
// The old `verify` script was `npm run verify:chain && npm run verify:guard && …`, which
// had two problems beyond being long:
//
//   1. IT STOPPED AT THE FIRST FAILURE. One red suite hid the state of every suite after
//      it, so a session fixing things saw one failure at a time and could not tell whether
//      it was fixing the last one or the first of six.
//   2. THE TOTAL HAD TO BE COUNTED BY HAND, and hand-counted totals rot. CLAUDE.md
//      asserted "143 checks across seven suites" and then "187 across nine" while the real
//      figures were 337 across 13 — wrong in both the count and the suite number, in a
//      document whose whole purpose is being trustworthy.
//
// The suite list is DISCOVERED from package.json rather than written here, so adding a
// `verify:*` script wires it in automatically and the count follows on its own. A figure
// that maintains itself is worth more than one corrected today.
//
// ⚠ The summary line is the point: `SUITES=n CHECKS=n FAILED=n`. Quote THAT in docs, or
// better, quote the command that prints it, rather than pasting a number that will rot.

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  scripts: Record<string, string>;
};

// Every verify:* script except this runner's own entry point.
const suites = Object.keys(pkg.scripts)
  .filter((n) => n.startsWith("verify:"))
  .sort();

let totalChecks = 0;
let totalFailed = 0;
const red: string[] = [];

for (const suite of suites) {
  const cmd = pkg.scripts[suite];
  // The scripts are all `node --experimental-strip-types scripts/x.mts`; run them directly
  // rather than through another npm layer, which on Windows costs ~300ms of shell per suite.
  const parts = cmd.split(/\s+/);
  const res = spawnSync(parts[0], parts.slice(1), {
    cwd: new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"),
    encoding: "utf8",
    // ⚠ NOT `shell: true`. Node deprecates passing an args array with a shell (DEP0190)
    // because the arguments are concatenated rather than escaped. `node` is directly
    // executable on every platform this runs on, so no shell is needed.
    shell: false,
  });

  const out = (res.stdout ?? "") + (res.stderr ?? "");
  process.stdout.write(out);

  const passes = (out.match(/^\s*PASS\b/gm) ?? []).length;
  const fails = (out.match(/^\s*FAIL\b/gm) ?? []).length;
  totalChecks += passes + fails;
  totalFailed += fails;

  // ⚠ A suite can fail WITHOUT printing a FAIL line — a crash, a syntax error, or the
  // Windows exit-127 race. Judging only by counted FAIL lines would report a crashed suite
  // as green with zero checks, which is this project's signature failure mode.
  if (res.status !== 0) {
    red.push(`${suite} (exit ${res.status}${fails ? `, ${fails} failing` : ", no FAIL lines — crashed?"})`);
  }
}

console.log("\n" + "─".repeat(64));
for (const r of red) console.log(`  RED  ${r}`);
console.log(`  SUITES=${suites.length} CHECKS=${totalChecks} FAILED=${totalFailed}`);
console.log("─".repeat(64) + "\n");

// process.exitCode, not process.exit() — see the note in the other verify scripts. Exiting
// eagerly races pending stdout into a libuv assertion on Windows and reports a green suite
// as exit 127.
process.exitCode = red.length > 0 || totalFailed > 0 ? 1 : 0;
