// Mobile layout safety, and the CSS-cleanup regression guard that goes with it.
//
// Two unrelated concerns share this file because they were fixed in the same pass and
// both come down to the same discipline: a CSS assertion has to name the actual property
// or selector, never infer it from the file's prose (CLAUDE.md §11.7's self-matching-
// comment trap, and §12.6's "mutate the thing the check asserts about").
//
// ── PART 1: the trades table no longer widens the page ──────────────────────────────
//
// TradesFeed rendered a bare <table className="trades"> with no wrapper and no
// `overflow-x` anywhere on it or its ancestors. A wide row (a trader address, two mono
// figures, an age, a tx link) forced the whole page wider on a phone instead of scrolling
// in place -- the same failure FAMILY as the `.watch-fail` bug, but not the same bug:
// that one had an `overflow-x: auto` that never engaged because its ancestor wasn't
// bounded; this one never had `overflow-x: auto` to begin with.
//
// ── PART 2: three dead CSS rules, and the one regression a careless deletion would
//    have caused ─────────────────────────────────────────────────────────────────────
//
// `.stat-row` was never rendered by any component. The base `.stat-value` rule WAS
// referenced (every stat figure on the token page uses the class), but its `font-size`
// was unconditionally overridden by `.stat-strip .stat-value` everywhere the class is
// actually used -- so the rule looked dead by the audit's own "does this value ever
// render" test, while still being the ONLY source of that class's `font-family`,
// `font-weight` and `margin-top`. Deleting it outright, on the strength of "nothing
// references this value", would have silently dropped the monospace font and the weight
// from every market-cap and progress figure on the page. L7 below is the guard against
// exactly that: it does not just check the dead rules are gone, it checks the properties
// they carried are still somewhere.
//
// Run: npm run verify:layout

import { readFileSync } from "node:fs";
import { stripComments } from "./lib/strip-comments.mts";

let failures = 0;
const check = (label: string, pass: boolean, detail = "") => {
  if (!pass) failures++;
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${label}${detail ? `  — ${detail}` : ""}`);
};

const css = stripComments(readFileSync(new URL("../src/styles.css", import.meta.url), "utf8"));
const feed = stripComments(
  readFileSync(new URL("../src/components/token/TradesFeed.tsx", import.meta.url), "utf8")
);

console.log("\nlayout — the trades table scrolls inside its own box");

// L1. Structural: the table sits inside a wrapper, not bare in the card. Anchored to the
// actual tag names so a rename of either class would fail this rather than pass silently.
check(
  "L1 <table className=\"trades\"> is wrapped in a container, not a direct child of the card",
  /<div className="trades-wrap">[\s\S]{0,80}<table className="trades">/.test(feed)
);

// L2. The wrapper is the one that scrolls -- named specifically so a mutation restoring
// the OLD unwrapped shape (L1) cannot accidentally satisfy this by matching `.trades`
// itself, which carries no overflow rule and never has.
check(
  "L2 .trades-wrap declares overflow-x: auto",
  /\.trades-wrap\s*\{[^}]*overflow-x:\s*auto/s.test(css)
);

// L3. .quote-lines dd now matches its sibling .kv dd: a long unbroken mono figure wraps
// rather than forcing its 1fr grid track wider than the space available.
check(
  "L3 .quote-lines dd declares overflow-wrap: anywhere, matching .kv dd",
  /\.quote-lines dd\s*\{[^}]*overflow-wrap:\s*anywhere/s.test(css)
);

console.log("\nlayout — three dead CSS rules removed, nothing lost with them");

// L4-L6. Each dead rule is gone. L6 is deliberately about the SELECTOR, not a specific
// property list, because the whole point of the duplicate was that `.create` appeared
// twice with different properties each time -- checking a property would only prove one
// of the two copies is gone, not that the duplication itself is resolved.
check(
  "L4 .stat-row no longer exists as a rule (it was never rendered by any component)",
  !/(^|[^-\w])\.stat-row\s*\{/m.test(css)
);
check(
  "L5 the standalone .stat-value rule is gone (only .stat-strip .stat-value remains)",
  !/(?<!\.stat-strip )\.stat-value\s*\{/.test(css)
);
// Anchored to column 0: the real `.create` rule and its dead former twin both sat
// unindented at the top level, while the (legitimate, unrelated) mobile override at
// `@media (max-width: 900px)` is indented 2 spaces along with everything else in that
// block. Anchoring this way is what lets the check tell "duplicated" from "responsively
// overridden" apart, rather than flagging every rule with a media-query variant.
check(
  "L6 .create is declared exactly once at the top level, not twice with different max-widths",
  (css.match(/^\.create\s*\{/gm) ?? []).length === 1
);

// L7. THE REGRESSION GUARD. Proves the properties the deleted base rule carried --
// font-family, font-weight, margin-top -- survive on the selector that is actually used,
// not just that the old rule is gone. A checker that only asserted L4/L5/L6 would have
// passed on a plain deletion that silently dropped these three properties from every
// stat figure on the token page.
check(
  "L7 .stat-strip .stat-value still carries font-family, font-weight and margin-top",
  /\.stat-strip \.stat-value\s*\{[^}]*font-family:\s*var\(--mono\)/s.test(css) &&
    /\.stat-strip \.stat-value\s*\{[^}]*font-weight:\s*500/s.test(css) &&
    /\.stat-strip \.stat-value\s*\{[^}]*margin-top:\s*3px/s.test(css)
);

// L8. Belt and braces alongside L4: no component still expects the class to exist, so a
// future edit re-adding the CSS rule alone (without a consumer) would not silently start
// mattering again unnoticed.
{
  const componentsWithStatRow = ["../src/components/token/PriceAndProgress.tsx"].filter((p) =>
    /className="[^"]*\bstat-row\b/.test(readFileSync(new URL(p, import.meta.url), "utf8"))
  );
  check("L8 no component renders className=\"stat-row\"", componentsWithStatRow.length === 0);
}

console.log(failures === 0 ? "\n  all layout checks passed\n" : `\n  ${failures} FAILED\n`);
// ⚠ process.exitCode, NOT process.exit() -- see the note in every other verify script.
// process.exit() races pending stdout into a libuv assertion on Windows and reports a
// green suite as a failed build, intermittently.
process.exitCode = failures === 0 ? 0 : 1;
