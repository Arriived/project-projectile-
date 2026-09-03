// The /health endpoint and the heartbeat, proved against a REAL HTTP server.
//
// ⚠ THE ONLY TEST THAT MATTERS HERE IS THAT IT CAN GO RED. An endpoint that always returns
// healthy is the 29-hour outage with extra steps -- the process was alive, busy, and
// reporting nothing wrong the entire time. So H5-H8 below freeze the checkpoint, advance
// the head, and assert a real socket returns a real 503.
//
// No chain and no database: `provider` and `supabase` are stubs, because the thing under
// test is the DECISION, and the decision is pure given two numbers. The two numbers are
// read from the real sources in production (index.js wires them in).
//
// Run: node indexer/scripts/verify-health.js

const http = require("node:http");
const { computeHealth, startHealthServer, startHeartbeat } = require("../src/health");
const { MAX_HEAD_LAG_BLOCKS } = require("../src/liveness");

let failures = 0;
const check = (label, pass, detail = "") => {
  if (!pass) failures++;
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${label}${detail ? `  — ${detail}` : ""}`);
};

/** A provider whose head we control. */
const providerAt = (head) => ({ getBlockNumber: async () => head });
const providerThatFails = () => ({
  getBlockNumber: async () => { throw new Error("RPC unreachable"); },
});
const checkpointAt = (n) => async () => n;
const checkpointThatFails = () => async () => { throw new Error("supabase unreachable"); };

const HEAD = 60_000_000;

async function main() {
  console.log("\nhealth — the verdict");

  // H1. Keeping up.
  {
    const h = await computeHealth({
      supabase: {}, provider: providerAt(HEAD), getLastProcessedBlock: checkpointAt(HEAD - 10),
    });
    check("H1  a checkpoint 10 blocks behind is healthy", h.healthy === true && h.lagBlocks === 10);
  }

  // H2. Exactly at the threshold is still healthy — the rule is `lag <= maxLag`.
  {
    const h = await computeHealth({
      supabase: {}, provider: providerAt(HEAD),
      getLastProcessedBlock: checkpointAt(HEAD - MAX_HEAD_LAG_BLOCKS),
    });
    check("H2  exactly at the threshold is still healthy", h.healthy === true, `lag ${h.lagBlocks}`);
  }

  // H3. ⚠ THE SIGNATURE: head moved, checkpoint did not.
  {
    const h = await computeHealth({
      supabase: {}, provider: providerAt(HEAD),
      getLastProcessedBlock: checkpointAt(HEAD - MAX_HEAD_LAG_BLOCKS - 1),
    });
    check("H3  one block past the threshold is UNHEALTHY", h.healthy === false, `lag ${h.lagBlocks}`);
  }

  // H4. The quiet-chain row of the runbook table: head still, checkpoint still, lag 0.
  {
    const h = await computeHealth({
      supabase: {}, provider: providerAt(HEAD), getLastProcessedBlock: checkpointAt(HEAD),
    });
    check("H4  a QUIET CHAIN (head still, checkpoint level) is healthy, not dead", h.healthy === true && h.lagBlocks === 0);
  }

  console.log("\nhealth — fails closed");

  // H5-H7. Not being able to measure is not the same as being fine.
  {
    const h = await computeHealth({
      supabase: {}, provider: providerThatFails(), getLastProcessedBlock: checkpointAt(HEAD),
    });
    check("H5  an unreachable RPC head is UNHEALTHY, not 'healthy, could not check'", h.healthy === false, h.reason);
  }
  {
    const h = await computeHealth({
      supabase: {}, provider: providerAt(HEAD), getLastProcessedBlock: checkpointThatFails(),
    });
    check("H6  an unreadable checkpoint is UNHEALTHY", h.healthy === false, h.reason);
  }
  {
    const h = await computeHealth({
      supabase: {}, provider: providerAt(HEAD), getLastProcessedBlock: checkpointAt(null),
    });
    check("H7  a checkpoint that was never written is UNHEALTHY (infinitely behind)", h.healthy === false, h.reason);
  }

  console.log("\nhealth — the response a human reads at 3am");
  {
    const h = await computeHealth({
      supabase: {}, provider: providerAt(HEAD), getLastProcessedBlock: checkpointAt(HEAD - 2000),
    });
    for (const k of ["head", "checkpoint", "lagBlocks", "healthy", "lagSecondsApprox", "thresholdBlocks", "reason"]) {
      check(`H8  the body carries \`${k}\``, k in h && h[k] !== undefined);
    }
    check("H8b lag is also expressed in SECONDS, because 2000 blocks means nothing to a human",
      h.lagSecondsApprox === Math.round((2000 * h.blockTimeMsAssumed) / 1000), `${h.lagSecondsApprox}s`);
  }

  // ── H9-H10. THE REAL SOCKET TEST. This is the one that matters. ────────────
  console.log("\nhealth — over a real socket (freeze the checkpoint, advance the head)");

  let movingHead = HEAD;
  const frozenCheckpoint = HEAD; // frozen on purpose: it never advances below
  const server = startHealthServer({
    supabase: {},
    provider: { getBlockNumber: async () => movingHead },
    getLastProcessedBlock: async () => frozenCheckpoint,
    port: 0, // ephemeral, so this never clashes with a real indexer on the default port
  });
  await new Promise((r) => server.on("listening", r));
  const port = server.address().port;

  const get = (path = "/health") =>
    new Promise((resolve, reject) => {
      http.get({ host: "127.0.0.1", port, path }, (res) => {
        let b = "";
        res.on("data", (c) => (b += c));
        res.on("end", () => resolve({ status: res.statusCode, body: b }));
      }).on("error", reject);
    });

  // Head level with the checkpoint -> healthy.
  {
    const r = await get();
    const j = JSON.parse(r.body);
    check("H9  head level with checkpoint -> HTTP 200", r.status === 200 && j.healthy === true, `status ${r.status}`);
  }

  // ⚠ NOW ADVANCE THE HEAD AND LEAVE THE CHECKPOINT FROZEN. This is the exact shape of the
  // 29-hour outage: nothing crashed, nothing threw, the process is serving requests.
  movingHead = HEAD + MAX_HEAD_LAG_BLOCKS + 1;
  {
    const r = await get();
    const j = JSON.parse(r.body);
    check(
      "H10 head advanced past the threshold while the checkpoint froze -> HTTP 503",
      r.status === 503 && j.healthy === false,
      `status ${r.status}, lag ${j.lagBlocks}`
    );
    check("H10b the body says WHY, in words", /silent-death signature/.test(j.reason), j.reason);
  }

  // And back again, so the endpoint is not simply stuck red.
  movingHead = HEAD;
  {
    const r = await get();
    check("H11 recovering (head back level) -> HTTP 200 again", r.status === 200, `status ${r.status}`);
  }

  {
    const r = await get("/nope");
    check("H12 an unknown path is 404, not a second health surface", r.status === 404);
  }

  server.close();

  // ── heartbeat ──────────────────────────────────────────────────────────────
  console.log("\nheartbeat — silence is the alarm");

  check("H13 with HEARTBEAT_URL unset, no heartbeat is started and nothing crashes",
    startHeartbeat({ supabase: {}, provider: providerAt(HEAD), getLastProcessedBlock: checkpointAt(HEAD) }) === null);

  // A stub receiver, so "did it ping" is observed rather than assumed.
  const received = [];
  const receiver = http.createServer((req, res) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => { received.push({ url: req.url, body: b }); res.writeHead(200); res.end("ok"); });
  });
  await new Promise((r) => receiver.listen(0, "127.0.0.1", r));
  const rport = receiver.address().port;

  // Healthy -> pings, and the ping CARRIES THE LAG.
  process.env.HEARTBEAT_URL = `http://127.0.0.1:${rport}/ping`;
  process.env.HEARTBEAT_INTERVAL_MS = "100000"; // effectively only the immediate tick
  delete require.cache[require.resolve("../src/health")];
  const health2 = require("../src/health");

  const h1 = health2.startHeartbeat({
    supabase: {}, provider: providerAt(HEAD), getLastProcessedBlock: checkpointAt(HEAD - 5),
  });
  await new Promise((r) => setTimeout(r, 600));
  check("H14 healthy -> a ping is sent", received.length === 1, `${received.length} received`);
  check("H15 the ping CARRIES THE LAG (absence-only alerting reintroduces the wall-clock bug)",
    received.length > 0 && /lag=5/.test(received[0].url) && /"lagBlocks":\s*5/.test(received[0].body),
    received[0]?.url);
  if (h1) clearInterval(h1);

  // ⚠ Unhealthy -> NO ping. The dead-man's switch fires on silence.
  received.length = 0;
  const h2 = health2.startHeartbeat({
    supabase: {}, provider: providerAt(HEAD),
    getLastProcessedBlock: checkpointAt(HEAD - MAX_HEAD_LAG_BLOCKS - 1),
  });
  await new Promise((r) => setTimeout(r, 600));
  check("H16 UNHEALTHY -> no ping at all, so the dead-man's switch fires", received.length === 0, `${received.length} received`);
  if (h2) clearInterval(h2);

  // A failing receiver must not take the indexer down.
  received.length = 0;
  receiver.close();
  process.env.HEARTBEAT_URL = "http://127.0.0.1:1/unreachable";
  delete require.cache[require.resolve("../src/health")];
  const health3 = require("../src/health");
  let threw = false;
  try {
    const h3 = health3.startHeartbeat({
      supabase: {}, provider: providerAt(HEAD), getLastProcessedBlock: checkpointAt(HEAD),
    });
    await new Promise((r) => setTimeout(r, 800));
    if (h3) clearInterval(h3);
  } catch { threw = true; }
  check("H17 an unreachable heartbeat URL does not throw — monitoring must not be a new way to die", !threw);

  console.log(failures === 0 ? `\n  all health checks passed\n` : `\n  ${failures} FAILED\n`);
  // process.exitCode, not process.exit() — see the note in app/scripts/*.mts.
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((e) => { console.error("harness error:", e); process.exitCode = 1; });
