// The price chart is created once and driven incrementally. It is never rebuilt for data.
//
// WHY THIS EXISTS. PriceChart destroyed and recreated its lightweight-charts instance -- and
// called fitContent() -- every time its series changed, and the series changed on every
// render: `now` came from Date.now() inside render, and useCandles returned freshly built
// arrays. On an active token that was every trade the page noticed. The chart flickered and
// the user's zoom and pan were thrown away. See CLAUDE.md §23.
//
// Run: node --experimental-strip-types scripts/verify-chart.mts
//
// Red-proofs, each hitting a different row:
//   a) make planSeriesUpdate always return "reset"                  -> K1, K2, K3, K4 fail
//      (K1 too: identical data must be a no-op, and "always reset" rebuilds it)
//   b) skip the history comparison in planSeriesUpdate              -> K5 fails
//   c) drop the strictly-newer guard on appended bars               -> K9 fails
//   d) put `series` in the createChart effect's dependency list     -> K10 fails
//   e) read Date.now() inside PriceChart's render again             -> K11 fails

import { readFileSync } from "node:fs";
import { planSeriesUpdate, type Bar } from "../src/lib/chartSeries.ts";
import { stripComments } from "./lib/strip-comments.mts";

let failures = 0;
let checks = 0;
const check = (label: string, pass: boolean, detail = "") => {
  checks++;
  if (!pass) failures++;
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${label}${detail ? `  — ${detail}` : ""}`);
};

const bar = (time: number, close: number, open = close, high = close, low = close): Bar => ({
  time, open, high, low, close,
});
const base: Bar[] = [bar(60, 1), bar(120, 1.1), bar(180, 1.2)];

console.log("── planSeriesUpdate ──");
{
  const p1 = planSeriesUpdate(base, base.map((b) => ({ ...b })));
  check("K1 identical data (new arrays, same values) is a no-op", p1.kind === "none", p1.kind);

  // THE ROW THAT MATTERS. A new trade in the current bucket moves the last bar. That must be
  // one update() call -- not a rebuild that throws away the user's zoom.
  const moved = [...base.slice(0, 2), bar(180, 1.3, 1.2, 1.3, 1.2)];
  const p2 = planSeriesUpdate(base, moved);
  check(
    "K2 a changed LAST bar is a single update(), not a rebuild",
    p2.kind === "update" && p2.bars.length === 1 && p2.bars[0].close === 1.3,
    JSON.stringify(p2)
  );

  const p3 = planSeriesUpdate(base, [...base, bar(240, 1.25)]);
  check(
    "K3 an appended bar is update(), not setData",
    p3.kind === "update" && p3.bars.length === 1 && p3.bars[0].time === 240,
    JSON.stringify(p3)
  );

  const both = [...base.slice(0, 2), bar(180, 1.3, 1.2, 1.3, 1.2), bar(240, 1.3), bar(300, 1.4)];
  const p4 = planSeriesUpdate(base, both);
  check(
    "K4 a last-bar change plus appends: updates, in time order",
    p4.kind === "update" && p4.bars.map((b) => b.time).join(",") === "180,240,300",
    p4.kind === "update" ? p4.bars.map((b) => b.time).join(",") : p4.kind
  );

  // A late-indexed trade in an OLD bucket rewrites history, which update() cannot do.
  const p5 = planSeriesUpdate(base, [bar(60, 1), bar(120, 1.05), bar(180, 1.2)]);
  check("K5 a changed EARLIER bar is a reset", p5.kind === "reset", p5.kind);

  check("K6 fewer bars is a reset", planSeriesUpdate(base, base.slice(0, 2)).kind === "reset");
  check(
    "K7 a moved time grid (a re-bucket) is a reset",
    planSeriesUpdate(base, [bar(60, 1), bar(120, 1.1), bar(240, 1.2)]).kind === "reset"
  );
  check(
    "K8 the first draw is a reset; nothing to draw is a no-op",
    planSeriesUpdate(null, base).kind === "reset" && planSeriesUpdate(null, []).kind === "none"
  );
  // update() throws "Cannot update oldest data" on a bar that is not strictly newer.
  check(
    "K9 an appended bar that is not strictly newer is a reset, never an update",
    planSeriesUpdate(base, [...base, bar(180, 9)]).kind === "reset"
  );
}

console.log("\n── the component is built for it ──");
{
  // Comments stripped: both files explain the old behaviour in prose (CLAUDE.md §12.6).
  const chart = stripComments(
    readFileSync(new URL("../src/components/token/PriceChart.tsx", import.meta.url), "utf8")
  );
  // The effect that creates the chart must not depend on data or theme. Tempered so the
  // match cannot run from one useEffect into the next.
  const m = chart.match(
    /useEffect\(\s*\(\)\s*=>\s*\{(?:(?!useEffect\()[\s\S])*?createChart\((?:(?!useEffect\()[\s\S])*?\},\s*\[([^\]]*)\]\s*\)/
  );
  const deps = m ? m[1] : null;
  check(
    "K10 createChart runs in an effect that depends on neither the data nor the theme",
    deps !== null && !/\b(series|candles|points|theme|chosen)\b/.test(deps),
    deps === null ? "no createChart effect found -- the scan is broken" : `deps: [${deps.trim()}]`
  );
  check(
    "K11 PriceChart does not read the clock during render",
    !/Date\.now\(/.test(chart),
    "a `now` from Date.now() changes every render and rebuilt the series with it"
  );
  const candles = stripComments(
    readFileSync(new URL("../src/hooks/useCandles.ts", import.meta.url), "utf8")
  );
  check("K12 useCandles does not read the clock during render either", !/Date\.now\(/.test(candles));
  check(
    "K13 useCandles memoises what it returns",
    /useMemo\(/.test(candles),
    "a fresh array per render changes PriceChart's inputs every time"
  );
}

console.log(`\n${checks - failures}/${checks} checks passed`);
// process.exitCode, not process.exit(): see the Windows note in verify-create.mts.
if (failures) process.exitCode = 1;
