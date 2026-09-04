// The creator launch buy: capability gating and the cap arithmetic.
//
// ⚠ THE CAPABILITY CHECK IS THE SAFETY PROPERTY HERE, not a nicety. A wallet that reports
// `atomic: unsupported` will still ACCEPT wallet_sendCalls and run the calls sequentially,
// in separate transactions and therefore separate blocks. The launch window is 3 seconds
// from `createToken`'s block.timestamp, so a sequential run creates the token and then
// reverts LaunchWindowClosed -- leaving the creator with a token whose allocation is gone
// and no way to retry. Treating a missing or unknown capability as "yes" is the bug.
//
// Run: npm run verify:launchbuy

import {
  CURVE_TOKEN_SUPPLY,
  DEFAULT_MAX_CREATOR_LAUNCH_BPS,
  launchBuyCapTokens,
  parseLaunchBuyUsdc,
  canBatchLaunchBuy,
  supportsAtomicBatch,
} from "../src/lib/launchBuy.ts";

let failures = 0;
const check = (label: string, pass: boolean, detail = "") => {
  if (!pass) failures++;
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${label}${detail ? `  — ${detail}` : ""}`);
};

const ARC = 5042002;

console.log("\nlaunch buy — the cap");
check("B1  curve supply is 807M, not the 1,000M total", CURVE_TOKEN_SUPPLY === 807_000_000n * 10n ** 18n);
check(
  "B2  2.5% of curve supply is 20.175M tokens",
  launchBuyCapTokens(DEFAULT_MAX_CREATOR_LAUNCH_BPS) === 20_175_000n * 10n ** 18n,
  launchBuyCapTokens(DEFAULT_MAX_CREATOR_LAUNCH_BPS).toString()
);
check(
  "B3  the cap is read from a per-token bps value, not hardcoded",
  launchBuyCapTokens(500n) === launchBuyCapTokens(250n) * 2n
);

console.log("\nlaunch buy — the amount");
check("B4  empty means no launch buy, and is not an error", parseLaunchBuyUsdc("", 10_000_000n).usdc6 === 0n);
check("B5  a plain amount parses to 6dp", parseLaunchBuyUsdc("2.5", 10_000_000n).usdc6 === 2_500_000n);
check("B6  a comma separator is accepted", parseLaunchBuyUsdc("2,5", 10_000_000n).usdc6 === 250_0000n);
check("B7  non-numeric is refused", parseLaunchBuyUsdc("abc", 10_000_000n).usdc6 === null);
check("B8  negative is refused", parseLaunchBuyUsdc("-1", 10_000_000n).usdc6 === null);
check(
  "B9  more than the balance is refused (USDC is also the gas token)",
  parseLaunchBuyUsdc("100", 10_000_000n).usdc6 === null &&
    parseLaunchBuyUsdc("100", 10_000_000n).issue?.kind === "exceedsBalance"
);

console.log("\nlaunch buy — ⚠ the capability gate");

// B10-B13. The shapes a real wallet returns.
check(
  "B10 atomic: supported -> batching allowed",
  supportsAtomicBatch({ [ARC]: { atomic: { status: "supported" } } }, ARC)
);
check(
  "B11 atomic: ready -> batching allowed",
  supportsAtomicBatch({ [ARC]: { atomic: { status: "ready" } } }, ARC)
);
check(
  "B12 atomic: unsupported -> REFUSED (sequential execution would miss the window)",
  !supportsAtomicBatch({ [ARC]: { atomic: { status: "unsupported" } } }, ARC)
);

// ⚠ B13 is the set that matters. Every one of these is a wallet we cannot prove will
// execute atomically, and every one must be treated as "no". A capability we cannot read
// is not a capability we have.
const UNKNOWN: [string, unknown][] = [
  ["undefined capabilities (hook not settled)", undefined],
  ["null", null],
  ["empty object", {}],
  ["a different chain only", { 1: { atomic: { status: "supported" } } }],
  ["atomic present but empty", { [ARC]: { atomic: {} } }],
  ["atomic as a bare boolean", { [ARC]: { atomic: true } }],
  ["atomic as a string", { [ARC]: { atomic: "supported" } }],
  ["chain present, no atomic key", { [ARC]: { paymasterService: { supported: true } } }],
  ["a string instead of an object", "supported"],
];
for (const [label, caps] of UNKNOWN) {
  check(`B13 REFUSES ${label}`, !supportsAtomicBatch(caps, ARC));
}

console.log("\nlaunch buy — the gate combines capability AND intent");
check("B14 no batching without the capability", !canBatchLaunchBuy({ supportsAtomicBatch: false, launchBuyUsdc6: 1_000_000n }));
check("B15 no batching when the creator asked for nothing", !canBatchLaunchBuy({ supportsAtomicBatch: true, launchBuyUsdc6: 0n }));
check("B16 no batching on a refused amount", !canBatchLaunchBuy({ supportsAtomicBatch: true, launchBuyUsdc6: null }));
check("B17 batching only with BOTH", canBatchLaunchBuy({ supportsAtomicBatch: true, launchBuyUsdc6: 1_000_000n }));

console.log(failures === 0 ? `\n  all launch-buy checks passed\n` : `\n  ${failures} FAILED\n`);
process.exitCode = failures === 0 ? 0 : 1;
