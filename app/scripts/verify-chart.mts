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
import {
  priceScaleFor,
  priceScaleLabel,
  formatScaledPrice,
  utcOffsetLabel,
  formatLocalTickMark,
  formatLocalCrosshair,
} from "../src/lib/chartFormat.ts";
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

console.log("\n── the price axis is bounded, not a 12-character string ──");
{
  // K14. The scale is a power of ten below the reference price -- checked at three
  // magnitudes spanning a launch price, a mid-range price, and a graduated-scale price.
  check("K14a priceScaleFor(2.54e-6) picks 1e-6", priceScaleFor(0.00000254) === 0.000001);
  check("K14b priceScaleFor(0.0834) picks 0.01", priceScaleFor(0.0834) === 0.01);
  check("K14c priceScaleFor(834) picks 100", priceScaleFor(834) === 100);
  check(
    "K14d a non-finite or non-positive reference falls back to scale 1, never NaN/Infinity",
    priceScaleFor(0) === 1 && priceScaleFor(-5) === 1 && priceScaleFor(NaN) === 1
  );

  check("K15a priceScaleLabel(1e-6) is \"×1e-6\"", priceScaleLabel(0.000001) === "×1e-6");
  check("K15b priceScaleLabel(100) is \"×1e2\"", priceScaleLabel(100) === "×1e2");
  check("K15c priceScaleLabel(1) is \"×1\", not \"×1e0\"", priceScaleLabel(1) === "×1");

  // K16. THE ROW THAT MATTERS FOR "bounded width": the old format was
  // "0.0000025400" (12 characters). The new one must be short AND exact.
  const scaled = formatScaledPrice(0.00000254, 0.000001);
  check("K16a formatScaledPrice(2.54e-6, 1e-6) is exactly \"2.5400\"", scaled === "2.5400");
  check(
    "K16b every formatted label stays far under the old 12-character width, across five magnitudes",
    [
      formatScaledPrice(0.00000254, priceScaleFor(0.00000254)),
      formatScaledPrice(0.0834, priceScaleFor(0.0834)),
      formatScaledPrice(834, priceScaleFor(834)),
      formatScaledPrice(9.9999, priceScaleFor(9.9999)),
      formatScaledPrice(1, priceScaleFor(1)),
    ].every((s) => s.length <= 7),
    "one of the five exceeded 7 characters"
  );
  check(
    "K16c a non-finite price or a zero scale never produces a broken label",
    formatScaledPrice(NaN, 1) === "" && formatScaledPrice(5, 0) === ""
  );
}

console.log("\n── the local-time captions do what they claim ──");
{
  check("K17a utcOffsetLabel(60) is \"UTC+1\"", utcOffsetLabel(60) === "UTC+1");
  check("K17b utcOffsetLabel(-300) is \"UTC-5\"", utcOffsetLabel(-300) === "UTC-5");
  check(
    "K17c utcOffsetLabel(330) is \"UTC+5:30\" -- half-hour zones need the minutes",
    utcOffsetLabel(330) === "UTC+5:30"
  );
  check("K17d utcOffsetLabel(0) is \"UTC+0\", not bare \"UTC\"", utcOffsetLabel(0) === "UTC+0");

  // K18. THE ROW THAT PROVES "local, not UTC" rather than assuming it: the SAME timestamp,
  // formatted with two different explicit zones, must produce different clock times.
  // `timeZone` is the test-only escape hatch chartFormat.ts documents for exactly this --
  // production never passes it, which is what lets Intl.DateTimeFormat resolve the
  // viewer's real zone instead.
  const noonUtc = Date.UTC(2026, 0, 15, 12, 0, 0) / 1000; // 2026-01-15 12:00 UTC
  const inUtc = formatLocalTickMark(noonUtc, 3 /* Time */, "en-US", "UTC");
  const inTokyo = formatLocalTickMark(noonUtc, 3, "en-US", "Asia/Tokyo");
  check(
    "K18a the same instant renders a DIFFERENT clock time in a different zone",
    inUtc !== inTokyo,
    `UTC="${inUtc}" Asia/Tokyo="${inTokyo}"`
  );
  check(
    // en-US is a 12-hour locale, so 12:00 UTC + 9h = 21:00 = 9:00 PM, not "21:00".
    "K18b Asia/Tokyo (UTC+9) reads 9:00 PM for a 12:00 UTC instant",
    /09:00\s*PM/.test(inTokyo),
    inTokyo
  );
  const crossUtc = formatLocalCrosshair(noonUtc, "en-US", "UTC");
  const crossLA = formatLocalCrosshair(noonUtc, "en-US", "America/Los_Angeles");
  check(
    "K18c the crosshair label differs by zone the same way the axis does",
    crossUtc !== crossLA,
    `UTC="${crossUtc}" LA="${crossLA}"`
  );
  check(
    "K18d each TickMarkType granularity produces a distinct shape, not one hardcoded string",
    new Set([0, 1, 2, 3, 4].map((tm) => formatLocalTickMark(noonUtc, tm, "en-US", "UTC"))).size === 5,
    [0, 1, 2, 3, 4].map((tm) => formatLocalTickMark(noonUtc, tm, "en-US", "UTC")).join(" | ")
  );
}

console.log("\n── the component is wired to use all of it ──");
{
  const chart = stripComments(
    readFileSync(new URL("../src/components/token/PriceChart.tsx", import.meta.url), "utf8")
  );

  // K19. Item 2: gridline/last-value collisions. Extract the actual number rather than
  // matching a specific literal, so a future retune that keeps it above the library's
  // 2.5 default still passes.
  const density = chart.match(/tickMarkDensity:\s*([\d.]+)/);
  check(
    "K19 rightPriceScale.tickMarkDensity is raised above lightweight-charts' default of 2.5",
    density !== null && Number(density[1]) > 2.5,
    density ? `found ${density[1]}` : "tickMarkDensity not found in source"
  );

  // K20. Item 3: illegible candle bodies.
  const minSpacing = chart.match(/minBarSpacing:\s*([\d.]+)/);
  check(
    "K20 timeScale.minBarSpacing floors candle width above lightweight-charts' default of 0.5px",
    minSpacing !== null && Number(minSpacing[1]) >= 3,
    minSpacing ? `found ${minSpacing[1]}` : "minBarSpacing not found in source"
  );

  // K21. Item 1: the swap away from the fixed, unbounded-width format.
  check(
    "K21a the series priceFormat is type: \"custom\", not the old fixed type: \"price\"",
    /priceFormat:\s*\{\s*type:\s*"custom"/.test(chart)
  );
  check(
    "K21b the old precision: 10 / minMove-only format is gone, not left alongside the new one",
    !/type:\s*"price",\s*precision:\s*10/.test(chart)
  );
  check(
    "K21c the custom formatter actually calls formatScaledPrice, not a fresh calculation",
    /formatter:\s*\(price[^)]*\)\s*=>\s*formatScaledPrice\(/.test(chart)
  );

  // K22. Item 5: local time actually wired into both the axis and the crosshair, not just
  // present as an unused import.
  check(
    "K22a timeScale.tickMarkFormatter calls formatLocalTickMark",
    /tickMarkFormatter:\s*\([^)]*\)\s*=>\s*formatLocalTickMark\(/.test(chart)
  );
  check(
    "K22b localization.timeFormatter calls formatLocalCrosshair",
    /localization:\s*\{\s*timeFormatter:\s*\([^)]*\)\s*=>\s*formatLocalCrosshair\(/.test(chart)
  );

  // K24. Candle query failure is a distinct state from a genuinely empty trade history.
  const tokenPage = stripComments(
    readFileSync(new URL("../src/routes/TokenPage.tsx", import.meta.url), "utf8")
  );
  check(
    "K24 candle query errors are passed through and win over the flat no-trades state",
    /isError=\{candles\.isError\}/.test(tokenPage) &&
      /\{isError \? \([\s\S]*chart\.unavailable[\s\S]*\) : isLoading/.test(chart) &&
      /!isError && isFlatLaunch/.test(chart)
  );

  // K23. Item 4: the attribution CSS override actually cancels the library's own
  // bottom-left placement rather than merely adding a competing declaration.
  const css = stripComments(readFileSync(new URL("../src/styles.css", import.meta.url), "utf8"));
  check(
    "K23a .chart-box #tv-attr-logo repositions to the top-left",
    /\.chart-box #tv-attr-logo\s*\{[^}]*top:\s*6px[^}]*left:\s*6px/s.test(css)
  );
  check(
    "K23b the override explicitly cancels the library's bottom placement (bottom: auto)",
    /\.chart-box #tv-attr-logo\s*\{[^}]*bottom:\s*auto/s.test(css)
  );
}

console.log(`\n${checks - failures}/${checks} checks passed`);
// process.exitCode, not process.exit(): see the Windows note in verify-create.mts.
if (failures) process.exitCode = 1;
