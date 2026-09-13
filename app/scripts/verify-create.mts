// The create flow's rules: the approval amount, symbol length, and launch preconditions.
//
// WHY THIS EXISTS. Two of these are the difference between a working launch and a
// creator losing money, and neither is visible by reading the form:
//
//   R13  the creation fee is approved for an EXACT amount. creationFeeUsdc is not in
//        currentEconomicsHash(), so the economics guard cannot fire on a change to it,
//        and the approval is the ONLY bound on the exposure. A creator who pinned the
//        old terms has already paid a 1000x fee in that exact scenario.
//
//   The economics hash is fetched in the SAME action that sends the transaction. A hash
//   read at page load and reused is a hash that can be stale by the time it is submitted,
//   which either reverts (best case) or pins terms the creator never saw.
//
// Run: npm run verify:create
//
// Red-proofs, each hitting a different row:
//   a) return MAX_UINT256 from creationFeeApprovalAmount  -> C1 fails
//   b) make a long symbol severity "error"                -> C4 fails
//   c) drop the gas reserve from the affordability check  -> C7 fails
//   d) let cooldown pass while still cooling              -> C6 fails
//   e) creationFeeNeedsApproval back to `allowance < fee` -> C12, C12b, C12e fail
//   f) Create.tsx's gate back to `allowance < fee`        -> C13 fails
//   g) keep the call, put `allowance < fee &&` back       -> C13 fails (its inline half)
//   h) make C13's forbidden pattern unmatchable           -> C13b fails; C13 stays green

import {
  creationFeeApprovalAmount,
  creationFeeNeedsApproval,
  validateDraft,
  blocksSubmission,
  launchBlocker,
  MAX_UINT256,
  WATCH_ASSET_SYMBOL_MAX,
} from "../src/lib/create.ts";
import { GAS_RESERVE_UNITS } from "../src/lib/gas.ts";
import { stripComments } from "./lib/strip-comments.mts";

let failures = 0;
// Counted, not declared. The summary used a hardcoded `total`, which goes wrong the first
// time a row is added without updating it (CLAUDE.md §13.7).
let checks = 0;
const check = (label: string, pass: boolean, detail = "") => {
  checks++;
  if (!pass) failures++;
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${label}${detail ? `  — ${detail}` : ""}`);
};

const FEE = 500_000n; // 0.5 USDC, the live creationFeeUsdc

// ── R13 ─────────────────────────────────────────────────────────────────────
console.log("── R13: the creation-fee approval ──");
{
  const amount = creationFeeApprovalAmount(FEE);
  // THE ROW THAT MATTERS. An unlimited approve hands the owner an unbounded claim on the
  // creator's wallet for the one fee the economics hash does not cover.
  check(
    "C1  the approval is the EXACT fee, never MaxUint256",
    amount === FEE && amount !== MAX_UINT256,
    `${amount} (max would be ${MAX_UINT256.toString().slice(0, 12)}…)`
  );
  check(
    "C2  it tracks the fee rather than being a constant",
    creationFeeApprovalAmount(9_999n) === 9_999n
  );
  check("C3  a zero fee approves zero, not unlimited", creationFeeApprovalAmount(0n) === 0n);
}

// ── R13: the shared allowance ───────────────────────────────────────────────
//
// C1-C3 prove the approval AMOUNT is exact. They cannot see whether that approval is SENT,
// and the bound is the allowance, not the amount. The USDC allowance to the factory is one
// number shared with the trade panel, which approves an unlimited amount, and createToken
// pulls whatever creationFeeUsdc is at execution against it. Skipping the exact approval
// because the allowance "already covers" the fee is how R13's bound became whatever trade
// approval had been left standing. CLAUDE.md §22.
console.log("\n── R13: the shared USDC allowance ──");
{
  // THE ROW THAT MATTERS. approve() overwriting a standing unlimited allowance is the only
  // thing that caps the launch.
  check(
    "C12 a standing UNLIMITED allowance still gets the exact re-approval",
    creationFeeNeedsApproval(MAX_UINT256, FEE) === true,
    "skipping leaves createToken uncapped against a fee raised in flight"
  );
  check(
    "C12b an allowance ABOVE the fee still re-approves -- the live bug's shape",
    creationFeeNeedsApproval(FEE * 200n, FEE) === true,
    "a 100 USDC trade approval left standing capped nothing at 0.5"
  );
  check("C12c an allowance BELOW the fee approves", creationFeeNeedsApproval(FEE - 1n, FEE) === true);
  check(
    "C12d an allowance of EXACTLY the fee skips -- the only safe skip",
    creationFeeNeedsApproval(FEE, FEE) === false,
    "an allowance of exactly the fee cannot cover a raised one"
  );
  check(
    "C12e a zero fee still overwrites a standing allowance (to zero)",
    creationFeeNeedsApproval(MAX_UINT256, 0n) === true,
    "the fee can be raised while the launch is in flight"
  );
}

// ── symbol length: warn, never block ────────────────────────────────────────
console.log("\n── symbol length ──");
{
  const long = validateDraft({ name: "Token", symbol: "A".repeat(20), metadataUri: "" });
  const issue = long.find((i) => i.field === "symbol");
  // The contract accepts it. Blocking would make this UI stricter than the chain, and the
  // same token would launch fine through the contract directly.
  check(
    "C4  a >11-char symbol WARNS and does not block",
    issue?.severity === "warning" && !blocksSubmission(long),
    `${WATCH_ASSET_SYMBOL_MAX}-char limit is wallet_watchAsset's, not the contract's`
  );
  check(
    "C4b an 11-char symbol is fine",
    !validateDraft({ name: "T", symbol: "A".repeat(11), metadataUri: "" }).some(
      (i) => i.field === "symbol"
    )
  );
  check(
    "C5  an EMPTY symbol does block -- the token would be unidentifiable",
    blocksSubmission(validateDraft({ name: "T", symbol: "  ", metadataUri: "" }))
  );
}

// ── launch preconditions ────────────────────────────────────────────────────
console.log("\n── launch preconditions ──");
const base = {
  isConnected: true,
  canTransact: true,
  issues: [],
  nowSeconds: 1_000_000,
  lastLaunchTimestamp: 0n,
  launchCooldown: 5n,
  usdcBalance: 100_000_000n,
  creationFee: FEE,
  gasReserve: 0n,
};
{
  check("C6a a clean draft with funds can launch", launchBlocker(base) === null);
  check(
    "C6b unknown fee, cooldown, balance, or last-launch state fails closed",
    [
      launchBlocker({ ...base, creationFee: undefined }),
      launchBlocker({ ...base, launchCooldown: undefined }),
      launchBlocker({ ...base, usdcBalance: undefined }),
      launchBlocker({ ...base, lastLaunchTimestamp: undefined }),
    ].every((blocker) => blocker?.kind === "unavailable")
  );

  const cooling = launchBlocker({
    ...base,
    lastLaunchTimestamp: 999_998n,
    launchCooldown: 5n,
  });
  check(
    "C6  the 5s cooldown is reported with the seconds remaining",
    cooling?.kind === "cooldown" && cooling.secondsRemaining === 3,
    `${cooling?.kind} ${cooling?.kind === "cooldown" ? cooling.secondsRemaining + "s" : ""}`
  );

  // USDC is the gas token too, so the fee alone is not enough to send the fee.
  const broke = launchBlocker({
    ...base,
    usdcBalance: FEE,
    gasReserve: GAS_RESERVE_UNITS,
  });
  check(
    "C7  affordability covers fee PLUS gas out of the SAME balance",
    broke?.kind === "insufficientUsdc",
    "a creator holding exactly the fee cannot afford to send it — USDC is also gas"
  );

  check(
    "C8  a wrong chain blocks before anything else is judged",
    launchBlocker({ ...base, canTransact: false })?.kind === "wrongChain"
  );
  check(
    "C9  disconnected blocks first of all",
    launchBlocker({ ...base, isConnected: false })?.kind === "notConnected"
  );
}

// ── the hash must not be cacheable ──────────────────────────────────────────
console.log("\n── economics hash freshness ──");
{
  const src = await import("node:fs").then((fs) =>
    fs.readFileSync(new URL("../src/routes/Create.tsx", import.meta.url), "utf8")
  );
  // Read from the source so this cannot pass against a copy of the rule.
  check(
    "C10 currentEconomicsHash is read inside the submit handler, not via a cached hook",
    /readContract\([\s\S]{0,400}currentEconomicsHash/.test(src),
    "a hash read at page load can be stale by the time it is submitted"
  );
  check(
    "C11 the approve call uses creationFeeApprovalAmount, not a literal",
    /creationFeeApprovalAmount\(/.test(src) && !/maxUint256|MAX_UINT256/.test(src),
    "R13"
  );

  // ⚠ C13 READS THE SOURCE WITH COMMENTS STRIPPED, and has to: Create.tsx's own comment
  // quotes the condition this replaced, so a raw scan fails on the explanation (CLAUDE.md
  // §12.6). C10 and C11 above still read it raw.
  //
  // Two halves, because either alone passes with the bug back: the gate must CALL
  // creationFeeNeedsApproval, AND nothing may compare allowance and fee directly --
  // `allowance < fee && creationFeeNeedsApproval(allowance, fee)` keeps the call and
  // restores the skip.
  const code = stripComments(src);
  const tradeSrc = await import("node:fs").then((fs) =>
    fs.readFileSync(new URL("../src/components/token/TradePanel.tsx", import.meta.url), "utf8")
  );
  const tradeCode = stripComments(tradeSrc);
  const INLINE_COMPARE = /\ballowance\s*[<>]=?\s*fee\b|\bfee\s*[<>]=?\s*allowance\b/;
  const callsRule = /creationFeeNeedsApproval\(\s*allowance\s*,\s*fee\s*\)/.test(code);
  const inline = code.match(INLINE_COMPARE);
  check(
    "C13 the create approval is gated by creationFeeNeedsApproval, never by comparing allowance and fee",
    callsRule && inline === null,
    !callsRule
      ? "the gate does not call creationFeeNeedsApproval(allowance, fee)"
      : inline
        ? `inline comparison in the code: "${inline[0]}"`
        : "R13 -- `<` skipped the exact approval whenever any standing allowance covered it"
  );
  // A negative check whose pattern cannot match proves nothing. This one must match the
  // condition it forbids, in both directions and both strictnesses.
  check(
    "C13b C13's pattern matches the condition it forbids",
    ["allowance < fee", "allowance >= fee", "fee > allowance", "fee <= allowance"].every((s) =>
      INLINE_COMPARE.test(s)
    ) && !INLINE_COMPARE.test("creationFeeNeedsApproval(allowance, fee)"),
    "otherwise its negative half is vacuous"
  );
  check(
    "C14 create and trade require a successful receipt plus their expected event before success",
    /receipt\.status !== "success"[\s\S]{0,160}throw new Error/.test(code) &&
      /if \(!launched\)[\s\S]{0,100}throw new Error/.test(code) &&
      /receipt\.status !== "success"[\s\S]{0,300}toast\.bad[\s\S]{0,200}return/.test(tradeCode) &&
      /else \{\s*const message = t\("trade\.receiptMissingTrade"\)[\s\S]{0,240}toast\.bad[\s\S]{0,160}return/.test(tradeCode)
  );
}

console.log(`\n${checks - failures}/${checks} checks passed`);
// ⚠ process.exitCode, NOT process.exit(). process.exit() tears the event loop down
// while the console.log lines above may still be flushing, and on Windows that races
// libuv into "Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)" and an exit code
// of 127 -- a GREEN suite reported as a failed build, intermittently. Measured before
// the fix: verify:slippage 0/127/127/127/127/0, verify:upload 0/127/0/0/0/127.
// A gate that fails randomly trains a human to re-run until green, which is how a real
// failure gets dismissed under pressure. Setting exitCode lets node exit naturally once
// stdout has drained.
if (failures) process.exitCode = 1;
