// Trade reserves are the curve state at the trade's OWN block -- never "latest".
//
// ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
//
// The candle chart prices every trade from trades.virtual_*_reserves (migration 006).
// updateReservesFromChain() used to call curves() with no blockTag, so it read whatever
// block was latest when the indexer reached the log. Measured on 11 September 2026: 26 of
// 27 stored rows matched the chain at their own block. The 27th (GP4265, block 60267961, a
// BUY) held the state after the NEXT trade, a SELL six blocks later, because both were
// ingested two hours late during a catch-up. The buy charted at the post-sell price and the
// sell's candle collapsed to a dash. The fault grows exactly where it hurts: bursts, where
// several trades share one 5s poll, and any catch-up after downtime.
//
// Run:  node indexer/scripts/verify-trade-reserves.js          # offline checks only
//       node indexer/scripts/verify-trade-reserves.js --live   # + every stored row vs chain
//
// --live costs one archive eth_call per stored trade. Fine at testnet volume; bound it
// before it runs against a large mainnet table.
//
// Red-proofs, each hitting a different row:
//   a) drop `{ blockTag }` from readCurveAtBlock               -> T1 fails
//   b) remove readCurveAtBlock's block-number guard            -> T2, T3 fail
//   c) remove -32001 from NODE_LAG_CODES                       -> T6 fails
//   d) (--live) run before the GP4265 row is repaired          -> T9 fails
//   e) remove -32014 from NODE_LAG_CODES                       -> T7b fails

const { ethers } = require("ethers");
const index = require("../src/index.js");

const LIVE = process.argv.includes("--live");

let failures = 0;
let checks = 0;
const check = (label, pass, detail = "") => {
  checks++;
  if (!pass) failures++;
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${label}${detail ? `  — ${detail}` : ""}`);
};
// A check whose subject is missing must FAIL, not crash the run and hide the rows after it.
const attempt = (fn) => {
  try {
    return { value: fn() };
  } catch (err) {
    return { error: err };
  }
};

// A stand-in contract that records exactly what curves() was called with.
function recordingContract() {
  const calls = [];
  return {
    calls,
    curves: (...args) => {
      calls.push(args);
      return Promise.resolve({});
    },
  };
}

(async () => {
  console.log("── reads are pinned to the trade's block ──");
  {
    // THE ROW THAT MATTERS. Without the override this is eth_call at "latest", and the stored
    // price silently becomes whatever the curve says whenever the indexer got round to it.
    const c = recordingContract();
    const r = attempt(() => index.readCurveAtBlock(c, "0xToken", 60267961));
    const args = c.calls[0] || [];
    const overrides = args[1] || {};
    check(
      "T1 curves() is called with { blockTag: <the trade's block> }",
      !r.error && args[0] === "0xToken" && overrides.blockTag === 60267961,
      r.error ? `threw: ${r.error.message}` : `called with ${JSON.stringify(args)}`
    );

    // ⚠ Refuse rather than fall back. A missing block number would otherwise mean "latest",
    // which is exactly the bug -- silent, plausible, and wrong.
    // ⚠ "It threw" is not enough on its own. Calling a function that does not exist throws
    // too, and the baseline run -- before readCurveAtBlock existed -- passed T2 and T3 for
    // exactly that wrong reason. The function must EXIST and refuse.
    const exists = typeof index.readCurveAtBlock === "function";
    const c2 = recordingContract();
    const r2 = attempt(() => index.readCurveAtBlock(c2, "0xToken", undefined));
    check(
      "T2 a missing block number THROWS instead of reading at latest",
      exists && !!r2.error && c2.calls.length === 0,
      !exists ? "readCurveAtBlock does not exist" : r2.error ? r2.error.message : `no throw; called with ${JSON.stringify(c2.calls)}`
    );
    const c3 = recordingContract();
    const r3 = attempt(() => index.readCurveAtBlock(c3, "0xToken", "latest"));
    check(
      "T3 the string 'latest' is refused too",
      exists && !!r3.error && c3.calls.length === 0,
      !exists ? "readCurveAtBlock does not exist" : r3.error ? r3.error.message : "accepted 'latest'"
    );

    // ethers v6 gives log.blockNumber as a number, but a bigint must not crash every trade.
    const c4 = recordingContract();
    const r4 = attempt(() => index.readCurveAtBlock(c4, "0xToken", 60267961n));
    check(
      "T4 a bigint block number is accepted and passed as a number",
      !r4.error && (c4.calls[0] || [])[1]?.blockTag === 60267961,
      r4.error ? `threw: ${r4.error.message}` : ""
    );
  }

  console.log("\n── retry classification, by code first ──");
  {
    const reason = (err) => {
      const r = attempt(() => index.retryReason(err));
      return r.error ? `threw: ${r.error.message}` : r.value;
    };
    // ethers v6 wraps the node's error: err.code is ITS string, the node's number is nested.
    // A "codes first" check against err.code alone never matched anything ethers threw.
    check(
      "T5 an ethers-wrapped -32005 is a rate limit, by code",
      reason({ code: "UNKNOWN_ERROR", message: "could not coalesce error", error: { code: -32005, message: "x" } }) === "rate-limit",
      String(reason({ code: "UNKNOWN_ERROR", message: "could not coalesce error", error: { code: -32005, message: "x" } }))
    );
    // Measured on Arc, 11 Sep 2026: eth_call pinned to a block the serving node has not
    // reached returns {"code":-32001,"message":"block not found: 0x..."}. With reads now
    // pinned, this is what a lagging node says instead of quietly returning old state.
    // Shaped so ONLY the code can match -- the CALL_EXCEPTION heuristic cannot fire here.
    check(
      "T6 -32001 'block not found' is node lag, by code alone",
      reason({ code: "UNKNOWN_ERROR", message: "x", info: { error: { code: -32001, message: "block not found: 0x3aa5143" } } }) === "node-lag",
      String(reason({ code: "UNKNOWN_ERROR", message: "x", info: { error: { code: -32001, message: "block not found: 0x3aa5143" } } }))
    );
    check(
      "T7 the shape ethers actually throws for it is node lag too",
      reason({ code: "CALL_EXCEPTION", data: null, reason: null, info: { error: { code: -32001, message: "block not found" } } }) === "node-lag"
    );
    // Measured in PRODUCTION, 11 Sep 2026 (CLAUDE.md 23.4): the live poll's eth_getLogs asked
    // for a range ending at the head it had just been handed, and the node behind the load
    // balancer had not reached it. Three times in nine hours, each recovered by the next poll.
    // It is the eth_getLogs twin of -32001, so it takes the same path -- retry, do not fail
    // the whole poll.
    // Shaped so ONLY the code can match: the outer message is what the text fallback reads,
    // and err.code is not CALL_EXCEPTION, so neither fallback can fire in its place.
    check(
      "T7b -32014 'requested data not available' is node lag too, by code alone",
      reason({ code: "UNKNOWN_ERROR", message: "x", info: { error: { code: -32014, message: "requested data not available" } } }) === "node-lag",
      String(reason({ code: "UNKNOWN_ERROR", message: "x", info: { error: { code: -32014, message: "requested data not available" } } }))
    );
    check(
      "T8 a genuine revert is NOT retried",
      reason({ code: "CALL_EXCEPTION", data: "0x08c379a0", reason: "UnknownToken" }) === null,
      String(reason({ code: "CALL_EXCEPTION", data: "0x08c379a0", reason: "UnknownToken" }))
    );
  }

  if (LIVE) {
    console.log("\n── every stored trade vs the chain at its own block (--live) ──");
    const { SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY, FACTORY_ADDRESS } = process.env;
    // Anon if provided -- this only reads. The service key works too, for GETs only.
    const key = SUPABASE_ANON_KEY || SUPABASE_SERVICE_ROLE_KEY;
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/trades?select=id,token_address,block_number,` +
        // ::text, or PostgREST sends numeric as a float and truncates it (CLAUDE.md §11.8),
        // which would report a mismatch that is only lost precision.
        `virtual_usdc_reserves::text,virtual_token_reserves::text` +
        `&virtual_token_reserves=not.is.null&order=token_address.asc,block_number.asc,id.asc&limit=10000`,
      { headers: { apikey: key, Authorization: `Bearer ${key}` } }
    );
    const rows = res.ok ? await res.json() : [];
    const factory = new ethers.Contract(
      FACTORY_ADDRESS,
      require("../src/generated/lfx1Abi.json"),
      index.provider
    );
    const bad = [];
    const perBlock = new Map();
    for (const r of rows) {
      const k = `${r.token_address}:${r.block_number}`;
      perBlock.set(k, (perBlock.get(k) || 0) + 1);
      const chain = await factory.curves(r.token_address, { blockTag: Number(r.block_number) });
      if (
        chain.virtualUsdcReserves.toString() !== r.virtual_usdc_reserves ||
        chain.virtualTokenReserves.toString() !== r.virtual_token_reserves
      ) {
        bad.push(`id ${r.id} ${r.token_address.slice(0, 10)}… block ${r.block_number}`);
      }
      await new Promise((ok) => setTimeout(ok, 120));
    }
    // A comparison over zero rows is a pass that proves nothing.
    check("T9 the check compared real rows", rows.length > 0, `${rows.length} rows, HTTP ${res.status}`);
    check(
      "T10 every stored row equals the chain at its own block",
      rows.length > 0 && bad.length === 0,
      bad.length ? `${bad.length} wrong: ${bad.join("; ")}` : `${rows.length}/${rows.length}`
    );
    // Not a failure, a limit: two trades on one token in one block share the block-end state,
    // and the Trade event carries no reserves to separate them.
    const shared = [...perBlock.values()].filter((n) => n > 1).length;
    console.log(`  info  (token, block) pairs holding more than one trade: ${shared}`);
  }

  console.log(`\n${checks - failures}/${checks} checks passed`);
  // process.exitCode, not process.exit(): see the Windows note in app/scripts/verify-create.mts.
  if (failures) process.exitCode = 1;
})();
