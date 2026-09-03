// Slippage bounds, and the aggregator link row.
//
// The bounds are the money part: a tolerance the interface accepts is a floor the contract
// will honour, and on a bonding curve during the snipe window a wide floor is a
// wallet-draining transaction that reverts nothing. So the refusal is tested as behaviour
// (no bps comes back), not merely as a message.
//
// Run: npm run verify:slippage

import {
  DEFAULT_SLIPPAGE_BPS,
  SLIPPAGE_MAX_BPS,
  SLIPPAGE_PRESETS_BPS,
  SLIPPAGE_WARN_ABOVE_BPS,
  parseSlippagePct,
  slippageBlocks,
  requiresAcknowledgement,
} from "../src/lib/slippage.ts";
import { resolveLinks } from "../src/lib/aggregatorLinks.ts";
import { minOutFromQuote } from "../src/lib/quotes.ts";

let failures = 0;
const check = (label: string, pass: boolean, detail = "") => {
  if (!pass) failures++;
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${label}${detail ? `  — ${detail}` : ""}`);
};

console.log("\nslippage — presets and the default");
check("S1  the default is 1%, the value that was hardcoded before", DEFAULT_SLIPPAGE_BPS === 100n);
check("S2  presets are 0.5 / 1 / 2 / 5%", JSON.stringify(SLIPPAGE_PRESETS_BPS.map(String)) === JSON.stringify(["50","100","200","500"]));
check("S3  every preset is at or below the warn threshold", SLIPPAGE_PRESETS_BPS.every((p) => p <= SLIPPAGE_WARN_ABOVE_BPS));

console.log("\nslippage — the two thresholds");
check("S4  warn above 5%", SLIPPAGE_WARN_ABOVE_BPS === 500n);
check("S5  refuse above 50%", SLIPPAGE_MAX_BPS === 5_000n);

// S6-S8. A warned value is still USABLE. Blocking it would make the UI stricter than the
// contract, which §11.14 records as the wrong instinct for the symbol-length rule.
{
  const { bps, issue } = parseSlippagePct("12");
  check("S6  12% warns but still yields a usable value", bps === 1200n && issue?.kind === "high");
  check("S7  a warning does not block", !slippageBlocks(issue));
}
{
  const { bps, issue } = parseSlippagePct("5");
  check("S8  exactly 5% does NOT warn (the boundary is 'above')", bps === 500n && issue === null);
}

// S9-S12. ⚠ THE REFUSAL IS TESTED AS BEHAVIOUR: a refused value must yield NO bps, so a
// caller cannot commit it even by ignoring the issue. A message-only refusal would leave a
// number sitting there for the next edit to start using.
for (const [label, raw] of [["51%", "51"], ["80%", "80"], ["500% (a stray zero)", "500"]] as const) {
  const { bps, issue } = parseSlippagePct(raw);
  check(`S9+ ${label} is refused and yields no value`, bps === null && issue?.kind === "tooHigh", `bps=${bps}`);
}
check("S12 a refusal blocks", slippageBlocks(parseSlippagePct("80").issue));

// ⚠ S12b IS THE ONE THE CEILING EXISTS FOR. The ceiling was justified as "stop a stray
// zero -- 5 becomes 50", and with a strict > the value 50 itself was PERMITTED: the exact
// typo it was justified by went through on a passive warning. Boundary now matches claim.
check("S12b exactly 50% is REFUSED (the 5 -> 50 stray zero)", parseSlippagePct("50").bps === null);
check("S12c 49.99% is still reachable", parseSlippagePct("49.99").bps === 4999n);

// S12d-S12f. A wide tolerance needs an explicit acknowledgement, because a passive
// warning beside a live button is advice rather than a decision.
check("S12d 1% needs no acknowledgement", !requiresAcknowledgement(100n));
check("S12e exactly 5% needs no acknowledgement", !requiresAcknowledgement(500n));
check("S12f 8% requires an acknowledgement", requiresAcknowledgement(800n));

console.log("\nslippage — input handling");
check("S13 a comma decimal separator is accepted", parseSlippagePct("1,5").bps === 150n);
check("S14 a negative is refused", parseSlippagePct("-1").bps === null);
check("S15 non-numeric is refused", parseSlippagePct("abc").bps === null);
check("S16 empty yields no value and no scolding", parseSlippagePct("").bps === null && parseSlippagePct("").issue?.kind === "empty");

console.log("\nslippage — it reaches minOut unchanged");
// S17-S18. The whole point: this module chooses a tolerance, lib/quotes.ts still does the
// arithmetic. No quote math is re-derived here (CLAUDE.md §1.3).
{
  const quoted = 1_000_000n;
  check("S17 1% tolerance floors at 99% of the quote", minOutFromQuote(quoted, 100n) === 990_000n);
  check("S18 a wider tolerance yields a strictly lower floor",
    minOutFromQuote(quoted, 500n) < minOutFromQuote(quoted, 100n));
}

console.log("\nlinks — only what resolves is rendered");
const TOKEN = "0xe49fb999F6442a01D62b5d8851797c623aA0F9c8" as const;
const EXPLORER = "https://testnet.arcscan.app";
{
  const links = resolveLinks({ token: TOKEN, explorerUrl: EXPLORER });
  check("L1  with no pool and no aggregator slug, exactly ONE link resolves", links.length === 1, links.map((l) => l.id).join(","));
  check("L2  that link is the verified contract", links[0]?.id === "contract");
  check("L3  no dead aggregator link is emitted", !links.some((l) => l.id === "dexscreener" || l.id === "geckoterminal"));
  check("L4  no pool link before a pool exists", !links.some((l) => l.id === "pool"));
  check("L5  every emitted href is absolute", links.every((l) => /^https:\/\//.test(l.href)));
}
{
  // The 16-September shape: filling in a slug and a pool turns the same row into four,
  // with no component change. Pinned so the structure cannot rot before it is needed.
  const links = resolveLinks({
    token: TOKEN,
    explorerUrl: EXPLORER,
    poolAddress: "0x1111111111111111111111111111111111111111",
    aggregatorChainSlug: "arc",
  });
  check("L6  with a pool and a slug, all four resolve", links.length === 4, links.map((l) => l.id).join(","));
  check("L7  contract stays first", links[0]?.id === "contract");
  check("L8  aggregator links point at the POOL, not the token, when a pool exists",
    links.filter((l) => l.id !== "contract").every((l) => l.href.includes("0x1111")));
}

console.log(failures === 0 ? `\n  all slippage/link checks passed\n` : `\n  ${failures} FAILED\n`);
// ⚠ process.exitCode, NOT process.exit(). process.exit() tears the loop down while the
// console.log lines above may still be flushing, and on Windows that races libuv into
// "Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)" and an exit code of 127 -- a
// GREEN suite reported as a failed build, intermittently. Setting exitCode lets node exit
// naturally once stdout has drained.
process.exitCode = failures === 0 ? 0 : 1;
