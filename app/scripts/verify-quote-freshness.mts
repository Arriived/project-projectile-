// Quote freshness — the check for CLAUDE.md §12.2.
//
// ⚠ WHAT THE INCIDENT ACTUALLY WAS, because the recorded diagnosis was wrong and a check
// written from it would have tested the wrong thing.
//
// §12.2 recorded: "for up to 30 seconds after any trade the panel quotes reserves that
// have moved", reading the displayed 0.000001 USDC against a settled 6.08 as a stale
// quote. Measured against the live chain at the incident's own blocks, that is not what
// happened — a stale quote could not have produced that figure:
//
//   quoteSell(token, 2471092226246865422123154) net out, by block:
//     60466878  (before the preceding sell)       6.168161 USDC
//     60466934  (immediately BEFORE the sell)     6.083285 USDC   <- what a stale quote shows
//     60466935  (the sell's OWN block, after it)  0.000001 USDC   <- what was displayed
//
// 0.000001 exists at exactly one block: after the trade. So the panel was not showing an
// old number. It was showing a FRESH quote for an amount the user no longer held —
// `input` was never cleared on settle, so the query kept running, was re-read against the
// drained curve, and rendered directly beneath "Settled … 6.08 USDC".
//
// There are therefore TWO defects, and both are checked here:
//
//   A  THE ORPHAN.  After a trade settles the box must be empty, so no quote survives for
//                   a trade that has already happened.  (Q1–Q4)
//   B  THE STALE WINDOW.  Real, and genuinely harmful, just not what the screenshot
//                   showed. The same amount quoted at 60466878 vs 60466934 gives
//                   18.419215 then 6.083286 — a 3.03x OVERSTATEMENT persisting up to 30s
//                   across anyone's trade. Fixed by putting the curve fingerprint in the
//                   query key.  (Q5–Q24)
//
// Every USDC figure below was read from the chain with eth_call at those block numbers.
// They are not invented and they are not round.

import { QueryClient } from "@tanstack/query-core";
import { readFileSync } from "node:fs";
// ⚠ IMPORTED FROM lib/, NOT FROM THE HOOK. hooks/useQuote.ts pulls in the ABI, wagmi and
// viem, none of which resolve under `node --experimental-strip-types`. The hook re-exports
// every one of these, so the hook and this check are provably reading the same functions.
import {
  quoteQueryKey,
  carryForwardQuote,
  QUOTE_KEY_FINGERPRINT_INDEX,
  quotePollIntervalMs,
  QUOTE_POLL_COLD_MS,
  QUOTE_POLL_HOT_MS,
  curveQuoteFingerprint,
} from "../src/lib/quotes.ts";

let failures = 0;
const check = (label: string, pass: boolean, detail = "") => {
  if (!pass) failures++;
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${label}${detail ? `  — ${detail}` : ""}`);
};

const TOKEN = "0x28Ea13eF0fdF76367e522Ab59c6dc522C2a5D878" as const;
const SOLD = 2471092226246865422123154n; // the amount actually submitted, from the Trade event

// ── Real curve states, read from chain at the incident's blocks ───────────────────────
// The real `curves()` members at their real magnitudes: virtual USDC ~2.67e9 (6dp) and
// virtual tokens ~1.07e27 (18dp). Tidy small fixtures here would not exercise the bigint
// path those magnitudes force, and a fixture that cannot occur in production is not a
// test of production.
const BEFORE = {                       // block 60466878, realUsdcReserves 24.750000
  virtualUsdcReserves: 2691750000n,
  virtualTokenReserves: 1065115631095012500000000000n,
  realUsdcReserves: 24750000n,
  tokenReserves: 797115631095012500000000000n,
  state: 0,
};
const AFTER_FIRST_SELL = {             // block 60466934, realUsdcReserves 6.144733
  virtualUsdcReserves: 2673144733n,
  virtualTokenReserves: 1072528907773753000000000000n,
  realUsdcReserves: 6144733n,
  tokenReserves: 804528907773753000000000000n,
  state: 0,
};
const DRAINED = {                      // block 60466935, realUsdcReserves 0.000001
  virtualUsdcReserves: 2667000001n,
  virtualTokenReserves: 1075000000000000000000000000n,
  realUsdcReserves: 1n,
  tokenReserves: 807000000000000000000000000n,
  state: 0,
};

// Measured net-out for SOLD at each of those blocks.
const NET_AT_BEFORE = 6168161n;
const NET_AT_AFTER_FIRST = 6083285n;
const NET_AT_DRAINED = 1n;
// What a quote taken before the first sell, for THAT trade's own amount, showed.
const STALE_FIGURE = 18419215n;

type Q = { side: "sell"; out: bigint; actualIn: bigint; fee: bigint; clamped: boolean; impact: null };
const q = (out: bigint): Q => ({ side: "sell", out, actualIn: SOLD, fee: 0n, clamped: false, impact: null });

// ══ A. THE ORPHAN ════════════════════════════════════════════════════════════════════
console.log("\nA — the orphaned quote: a settled trade must not leave one behind");

// The panel derives `amount` from `input`, and useQuote is `enabled` only when
// amount > 0n. Clearing the box is therefore what disables the query, so this asserts the
// CONSEQUENCE of clearing rather than the clearing itself.
const enabledFor = (input: string) => {
  let amount: bigint;
  try {
    amount = input.trim() ? BigInt(input.trim()) : 0n;
  } catch {
    amount = 0n;
  }
  return amount > 0n;
};
check("Q1  a filled box quotes", enabledFor(SOLD.toString()));
check("Q2  an EMPTY box does not quote — this is what clearing on settle buys", !enabledFor(""));
check("Q3  whitespace is not a live amount either", !enabledFor("   "));

// ⚠ COMMENTS STRIPPED BEFORE ASSERTING. This file's own prose explains the fix at length
// and names setInput(""); a checker that reads its own documentation is the defect
// CLAUDE.md §11.7 records for verify:claims and §12.6 promotes to a standing rule.
const panelSrc = readFileSync(new URL("../src/components/token/TradePanel.tsx", import.meta.url), "utf8");
const panel = panelSrc
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^\s*\/\/.*$/gm, "")
  .replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
const afterGuard = panel.slice(panel.indexOf("if (!receipt || !address) return;"));
const effectBody = afterGuard.slice(0, afterGuard.indexOf("}, [receipt]);"));
check(
  "Q4  the receipt effect CLEARS the input — the orphan cannot outlive the trade",
  effectBody.length > 0 && /setInput\(\s*""\s*\)/.test(effectBody),
  effectBody.length > 0 ? "found in the settle path" : "settle path not located"
);

// ══ B. THE FINGERPRINT ═══════════════════════════════════════════════════════════════
console.log("\nB — the fingerprint: a figure known to be superseded is never shown");

const fpBefore = curveQuoteFingerprint(BEFORE, 0);
const fpAfter = curveQuoteFingerprint(AFTER_FIRST_SELL, 0);
const fpDrained = curveQuoteFingerprint(DRAINED, 0);

check("Q5  a trade changes the fingerprint", fpBefore !== fpAfter);
check("Q6  a further trade changes it again", fpAfter !== fpDrained);
check("Q7  an unchanged curve keeps it stable — no needless refetch", fpBefore === curveQuoteFingerprint(BEFORE, 0));
check(
  "Q8  the snipe tax alone changes it (it changes per SECOND for 7s)",
  curveQuoteFingerprint(BEFORE, 9800) !== curveQuoteFingerprint(BEFORE, 9500)
);
check(
  "Q9  an ABSENT curve never compares equal to a real one",
  curveQuoteFingerprint(undefined, undefined) !== fpBefore &&
    curveQuoteFingerprint(undefined, undefined) !== fpAfter
);
// ⚠ ADDED AFTER A RED-PROOF SURVIVOR. Replacing the unknown marker with "" survived Q9,
// because "" is still != every real fingerprint. It is collision-safe -- a real
// fingerprint joins six fields with ":" so it can never be empty -- but it is NOT
// harmless: "" is FALSY, and this codebase already reaches for falsy-ish defaults
// (useQuote's `curveFingerprint = "curve:unpinned"`). A future `if (fingerprint)` guard
// would read "curve unknown" as "no fingerprint given" and fall through to a default,
// which is the silent-wrong-answer shape this whole check exists to prevent.
check(
  "Q9b the unknown marker is TRUTHY — a falsy one would be misread by any `if (fp)` guard",
  curveQuoteFingerprint(undefined, undefined).length > 0,
  JSON.stringify(curveQuoteFingerprint(undefined, undefined))
);
check(
  "Q9c not even an all-zero curve can produce the unknown marker",
  curveQuoteFingerprint(
    { virtualUsdcReserves: 0n, virtualTokenReserves: 0n, realUsdcReserves: 0n, tokenReserves: 0n, state: 0 },
    0
  ) !== curveQuoteFingerprint(undefined, undefined)
);
check(
  "Q10 realUsdcReserves is in it — it drives the sell clamp",
  curveQuoteFingerprint({ ...BEFORE, realUsdcReserves: 1n }, 0) !== fpBefore
);
check(
  "Q11 tokenReserves is in it — it drives the buy clamp",
  curveQuoteFingerprint({ ...BEFORE, tokenReserves: 1n }, 0) !== fpBefore
);
check(
  "Q12 state is in it — GRADUATION_READY closes both sides",
  curveQuoteFingerprint({ ...BEFORE, state: 1 }, 0) !== fpBefore
);
check(
  "Q13 virtual reserves are in it — they ARE the price",
  curveQuoteFingerprint({ ...BEFORE, virtualUsdcReserves: 1n }, 0) !== fpBefore &&
    curveQuoteFingerprint({ ...BEFORE, virtualTokenReserves: 1n }, 0) !== fpBefore
);

// ── the carry-forward decision, on the real exported function ──
const keyBefore = quoteQueryKey(TOKEN, "sell", SOLD, fpBefore);
const keyAfter = quoteQueryKey(TOKEN, "sell", SOLD, fpAfter);

check(
  "Q14 SAME curve, new amount -> the figure is carried forward (no dash flicker)",
  carryForwardQuote(q(NET_AT_BEFORE), keyBefore, fpBefore)?.out === NET_AT_BEFORE
);
check(
  "Q15 ⚠ CURVE MOVED -> the figure is DROPPED, so the panel shows a dash, not 18.419215",
  carryForwardQuote(q(STALE_FIGURE), keyBefore, fpAfter) === undefined,
  "the 3.03x overstatement is unreachable"
);
check(
  "Q16 a missing previous key is treated as superseded, not as a match",
  carryForwardQuote(q(NET_AT_BEFORE), undefined, fpBefore) === undefined
);
check("Q17 undefined previous data stays undefined", carryForwardQuote(undefined, keyAfter, fpAfter) === undefined);

// ══ C. THE REAL CACHE ════════════════════════════════════════════════════════════════
// B is pure. This proves the property actually holds inside TanStack, using the real key
// builder — a hand-built key here would prove only that the shape can be retyped.
console.log("\nC — against a real QueryClient, with the real key builder");

const qc = new QueryClient();
qc.setQueryData(quoteQueryKey(TOKEN, "sell", SOLD, fpBefore), q(NET_AT_BEFORE));

check(
  "Q18 the pre-trade entry is readable at its own key",
  (qc.getQueryData(quoteQueryKey(TOKEN, "sell", SOLD, fpBefore)) as Q | undefined)?.out === NET_AT_BEFORE
);
check(
  "Q19 ⚠ after the curve moves, the SAME token/side/amount reads NOTHING from cache",
  qc.getQueryData(quoteQueryKey(TOKEN, "sell", SOLD, fpAfter)) === undefined,
  "the stale figure sits in a different entry and is structurally unreachable"
);
qc.setQueryData(quoteQueryKey(TOKEN, "sell", SOLD, fpAfter), q(NET_AT_AFTER_FIRST));
check(
  "Q20 once refetched, the new entry carries what the chain actually returns",
  (qc.getQueryData(quoteQueryKey(TOKEN, "sell", SOLD, fpAfter)) as Q | undefined)?.out === NET_AT_AFTER_FIRST,
  "6.083285 USDC — the figure the trade settled at"
);
check(
  "Q21 the drained curve is a third distinct entry",
  qc.getQueryData(quoteQueryKey(TOKEN, "sell", SOLD, fpDrained)) === undefined
);

// ══ D. THE DELIBERATE REPRODUCTION ═══════════════════════════════════════════════════
// Replay the incident's own sequence through the real functions and assert that at no
// point is a superseded figure readable. This is the "trade, then read the panel before
// the next poll would fire" reproduction, done deterministically: executing it for real
// would mean sending live sells with real funds.
console.log("\nD — replaying the incident: 18.419215 must never be shown against a moved curve");

const replay = [
  { at: "block 60466878 (before the first sell)", fp: fpBefore, chainNet: NET_AT_BEFORE },
  { at: "block 60466934 (after it, before the second)", fp: fpAfter, chainNet: NET_AT_AFTER_FIRST },
  { at: "block 60466935 (after the second sell)", fp: fpDrained, chainNet: NET_AT_DRAINED },
];

let carried: Q | undefined;
let prevKey: readonly unknown[] | undefined;
let leaked = 0;

for (const step of replay) {
  const key = quoteQueryKey(TOKEN, "sell", SOLD, step.fp);
  // What the panel renders in the instant BEFORE the new answer lands.
  const shown = carryForwardQuote(carried, prevKey, step.fp);
  if (shown !== undefined && shown.out !== step.chainNet) leaked++;
  console.log(
    `    ${step.at.padEnd(44)} in-flight shows ${(shown === undefined ? "—" : String(shown.out)).padEnd(9)}  truth ${step.chainNet}`
  );
  carried = q(step.chainNet);
  prevKey = key;
}
check("Q22 ⚠ no step of the real sequence ever displayed a superseded figure", leaked === 0, `${leaked} leak(s)`);

// ⚠ THE CONTROL. Without this, Q22 would also pass if carryForwardQuote returned
// undefined unconditionally — which would blank the panel on every poll and be its own
// bug. This asserts the mechanism DISCRIMINATES rather than merely refusing.
let carriedSame: Q | undefined = q(NET_AT_BEFORE);
let sameKey: readonly unknown[] | undefined = keyBefore;
let carriedThrough = 0;
for (let i = 0; i < 3; i++) {
  const shown = carryForwardQuote(carriedSame, sameKey, fpBefore);
  if (shown?.out === NET_AT_BEFORE) carriedThrough++;
  carriedSame = shown ?? carriedSame;
  sameKey = keyBefore;
}
check(
  "Q23 ⚠ CONTROL: on an UNCHANGED curve the figure survives all three polls",
  carriedThrough === 3,
  "so Q22 is discrimination, not a blanket refusal"
);

// The cold poll is now a liveness floor rather than the freshness mechanism. Assert it
// still exists — removing it would leave a page with no other trigger never refreshing.
check("Q24 the cold poll remains as a liveness floor", quotePollIntervalMs(60) === QUOTE_POLL_COLD_MS);
check("Q25 the snipe window still polls per second", quotePollIntervalMs(3) === QUOTE_POLL_HOT_MS);
check(
  "Q26 the slot the placeholder reads IS the key's fingerprint slot",
  quoteQueryKey(TOKEN, "sell", SOLD, "FP")[QUOTE_KEY_FINGERPRINT_INDEX] === "FP"
);

console.log(failures === 0 ? `\n  all quote-freshness checks passed\n` : `\n  ${failures} FAILED\n`);
// process.exitCode, not process.exit() — see the note in the other verify scripts.
process.exitCode = failures === 0 ? 0 : 1;
