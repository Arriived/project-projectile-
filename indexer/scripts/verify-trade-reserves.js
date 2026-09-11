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
//   f) delete the transportFailure() call from retryReason     -> T10-T15, T21* fail
//   g) make transportFailure return 'transport' for every 4xx  -> T16-T20 fail
//   h) make transportFailure return 'transport' unconditionally-> T22, T22b, T22c fail
//   i) as (f), end to end through a real 502                   -> T23 fails

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

    // ── T10-T22  TRANSPORT-LEVEL FAILURES ────────────────────────────────────
    //
    // Six HTTP 502s in v3's 21 hours (CLAUDE.md 23.6), one of which took the
    // consecutive-failure counter to 2 of 5. The -32014 fix did nothing for them: a 502 is
    // the load balancer answering instead of the node, so there is no JSON-RPC body and no
    // numeric code, and rpcErrorCode -- which returns only numbers -- saw nothing.
    //
    // The shapes below were MEASURED against a local server on ethers 6.17.0, not inferred:
    //   HTTP 5xx        err.code "SERVER_ERROR" (a STRING), err.response.statusCode 502
    //   socket destroyed err.code "ECONNRESET"
    //   client timeout   err.code "TIMEOUT"
    // with a healthy server as a control (no throw) and a -32014 as a second control.
    const t = (e) => index.transportFailure(e);
    const http = (statusCode) => ({
      code: "SERVER_ERROR",
      shortMessage: `server response ${statusCode}`,
      response: { statusCode },
    });

    check(
      "T10 HTTP 502 is retried -- the one measured six times in production",
      reason(http(502)) === "transport",
      String(reason(http(502)))
    );
    check("T11 HTTP 503 is retried", reason(http(503)) === "transport", String(reason(http(503))));
    check("T12 HTTP 504 is retried", reason(http(504)) === "transport", String(reason(http(504))));
    check("T13 HTTP 500 is retried", reason(http(500)) === "transport", String(reason(http(500))));
    check(
      "T14 HTTP 429 is retried, and labelled rate-limit rather than transport",
      reason(http(429)) === "rate-limit",
      String(reason(http(429)))
    );
    check(
      "T15 HTTP 408 is retried -- it is literally a timeout",
      reason(http(408)) === "transport",
      String(reason(http(408)))
    );

    // The fail-fast half. Without these the suite would pass for a classifier that retried
    // EVERYTHING, which is not a classifier -- and a permanent failure retried five times is
    // a loud failure delayed by thirty seconds.
    check(
      "T16 HTTP 400 is NOT retried -- it will answer the same way in thirty seconds",
      reason(http(400)) === null,
      String(reason(http(400)))
    );
    check("T17 HTTP 401 is NOT retried", reason(http(401)) === null, String(reason(http(401))));
    check("T18 HTTP 403 is NOT retried", reason(http(403)) === null, String(reason(http(403))));
    check("T19 HTTP 404 is NOT retried", reason(http(404)) === null, String(reason(http(404))));
    check(
      "T20 HTTP 501 is NOT retried -- 'Not Implemented' is about the METHOD, not the moment",
      reason(http(501)) === null,
      String(reason(http(501)))
    );

    // Socket-level: no HTTP response at all, so the status path cannot fire and the string
    // code is the only signal.
    check(
      "T21 a destroyed socket (ECONNRESET) is retried",
      reason({ code: "ECONNRESET", message: "socket hang up" }) === "transport",
      String(reason({ code: "ECONNRESET", message: "socket hang up" }))
    );
    check(
      "T21b a client timeout (TIMEOUT) is retried",
      reason({ code: "TIMEOUT", shortMessage: "request timeout" }) === "transport",
      String(reason({ code: "TIMEOUT", shortMessage: "request timeout" }))
    );
    check(
      "T21c a refused connection is retried -- an RPC restarting looks exactly like this",
      reason({ code: "ECONNREFUSED" }) === "transport",
      String(reason({ code: "ECONNREFUSED" }))
    );
    check(
      "T21d a node errno nested on a cause is still seen",
      t({ code: "UNKNOWN_ERROR", cause: { code: "ECONNRESET" } }) === "transport",
      String(t({ code: "UNKNOWN_ERROR", cause: { code: "ECONNRESET" } }))
    );

    // ⚠ THE CONTROLS. Without these, "everything above is retried" would also pass for a
    // classifier that returned "transport" unconditionally.
    check(
      "T22 CONTROL: an ethers string code we do NOT list is not transport",
      t({ code: "UNKNOWN_ERROR", message: "could not coalesce error" }) === null,
      String(t({ code: "UNKNOWN_ERROR", message: "could not coalesce error" }))
    );
    check(
      "T22b CONTROL: a genuine revert is still not retried once transport exists",
      reason({ code: "CALL_EXCEPTION", data: "0x08c379a0", reason: "UnknownToken" }) === null,
      String(reason({ code: "CALL_EXCEPTION", data: "0x08c379a0", reason: "UnknownToken" }))
    );
    check(
      "T22c CONTROL: an empty error is not retried",
      reason({}) === null && t({}) === null,
      `${reason({})} / ${t({})}`
    );
    check(
      "T22d CONTROL: -32014 keeps its own label, not the transport one",
      reason({ code: "UNKNOWN_ERROR", info: { error: { code: -32014 } } }) === "node-lag",
      String(reason({ code: "UNKNOWN_ERROR", info: { error: { code: -32014 } } }))
    );

    // ── T23  END TO END, through the REAL ethers stack against a REAL 502 ────
    //
    // ⚠ EVERY ROW ABOVE FEEDS retryReason A LITERAL OBJECT I WROTE. That proves the
    // classifier agrees with my idea of the error shape -- which is exactly the circularity
    // CLAUDE.md 15.6 warns about, and the error shape is the half that was wrong before.
    // So this one makes a real HTTP request, through the real provider, to a server that
    // really answers 502, and asserts withRetry gets THROUGH it.
    //
    // The server answers 502 twice and then succeeds, so a passing run proves retrying
    // happened -- not merely that nothing threw.
    {
      const http = require("node:http");
      const attemptsSeen = [];
      let hits = 0;
      const server = http.createServer((req, res) => {
        hits++;
        if (hits <= 2) {
          res.writeHead(502, { "Content-Type": "text/html" });
          res.end("<html><body>502 Bad Gateway</body></html>");
          return;
        }
        let body = "";
        req.on("data", (d) => (body += d));
        req.on("end", () => {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ jsonrpc: "2.0", id: JSON.parse(body).id, result: "0x7b" }));
        });
      });
      await new Promise((r) => server.listen(0, "127.0.0.1", r));
      const port = server.address().port;
      const { ethers: E } = require("ethers");
      const local = new E.JsonRpcProvider(`http://127.0.0.1:${port}`, undefined, {
        batchMaxCount: 1,
        staticNetwork: E.Network.from(5042002),
      });

      let got = null;
      let threw = null;
      try {
        // send(), not getBlockNumber(): the latter sits behind the provider's own
        // perform-cache, so a retry is served from memory and never reaches the wire --
        // measured, the server saw 1 request across 4 retries.
        got = await index.withRetry(() => local.send("eth_blockNumber", []), {
          retries: 4,
          baseDelayMs: 5,
        });
      } catch (e) {
        threw = e;
        attemptsSeen.push(e?.code);
      }

      check(
        "T23 END TO END: withRetry survives two real HTTP 502s and gets the answer",
        got === "0x7b" && threw === null && hits === 3,
        `result=${got} threw=${threw && threw.code} requests=${hits}`
      );

      // ⚠ THE CONTROL, and it is the one that makes T23 mean anything. A server that 502s
      // FOREVER must still throw -- otherwise T23 would also pass for a withRetry that
      // swallowed errors, and a sustained outage would be invisible instead of fatal.
      hits = 100; // never satisfied: every subsequent request 502s... except hits>2 succeeds,
      // so use a second server that always fails.
      const always502 = http.createServer((req, res) => {
        res.writeHead(502, { "Content-Type": "text/html" });
        res.end("502");
      });
      await new Promise((r) => always502.listen(0, "127.0.0.1", r));
      const port2 = always502.address().port;
      const local2 = new E.JsonRpcProvider(`http://127.0.0.1:${port2}`, undefined, {
        batchMaxCount: 1,
        staticNetwork: E.Network.from(5042002),
      });
      let stillThrew = null;
      try {
        await index.withRetry(() => local2.send("eth_blockNumber", []), { retries: 2, baseDelayMs: 5 });
      } catch (e) {
        stillThrew = e;
      }
      check(
        "T23b CONTROL: a server that 502s forever still THROWS -- a real outage stays fatal",
        stillThrew !== null && stillThrew.code === "SERVER_ERROR",
        stillThrew ? `threw ${stillThrew.code}` : "DID NOT THROW -- retries are swallowing errors"
      );

      local.destroy();
      local2.destroy();
      server.close();
      always502.close();
    }
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
