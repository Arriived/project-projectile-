// /health, and the outbound heartbeat. Both answer the same question, from one function.
//
// ── THE FAILURE THIS DEFENDS AGAINST ──────────────────────────────────────────
//
// The indexer once sat 29 hours behind while reporting healthy. It did not crash. ethers
// caught an RPC error, logged it through `console.log("@TODO", error)` where nothing could
// intercept it, and re-armed on every new block forever. `provider.on("error")` saw zero
// events; `unhandledRejection` saw zero. The process was alive, busy, and making no
// progress.
//
// So "the process is running" is worthless as a health signal, and so is "it pinged
// recently". BOTH ARE TRUE DURING THE EXACT OUTAGE THIS EXISTS TO CATCH. The only signal
// that separates a quiet chain from a dead indexer is head-relative lag, which is why
// everything below routes through `livenessVerdict` in liveness.js and nothing here
// re-decides what healthy means.

const http = require("node:http");
const {
  livenessVerdict,
  lagSeconds,
  MAX_HEAD_LAG_BLOCKS,
  ARC_BLOCK_TIME_MS,
} = require("./liveness");

const PORT = Number(process.env.HEALTH_PORT || 8080);
const HEARTBEAT_URL = process.env.HEARTBEAT_URL;

/**
 * How often to ping the dead-man's switch.
 *
 * ⚠ MUST BE COMFORTABLY SHORTER THAN THE LAG WINDOW. The threshold is 1000 blocks, about
 * 8 minutes of ground; at 60s that is ~8 pings inside one threshold period. If the ping
 * interval approached the window, a single missed ping would be indistinguishable from a
 * real outage and the receiving service's grace period would have to absorb the ambiguity
 * -- which is how a monitor gets tuned loose enough to miss the thing it watches for.
 *
 * The live loop already polls every 5s, so a 60s ping adds one HTTP request per twelve
 * polls. It is not a load consideration at this rate; it is a resolution one.
 */
const HEARTBEAT_INTERVAL_MS = Number(process.env.HEARTBEAT_INTERVAL_MS || 60_000);

/**
 * The single source of truth for "is this indexer healthy right now".
 *
 * ⚠ FAILS CLOSED. If the head cannot be fetched, or the checkpoint cannot be read, the
 * answer is UNHEALTHY -- never "healthy because the comparison could not be made". A
 * monitor that reports health when it cannot measure is the 29-hour outage wearing a
 * different hat: it was also, technically, not reporting a problem.
 *
 * Returns a plain object; does no I/O beyond the two reads it needs, and never throws.
 */
async function computeHealth({ supabase, provider, getLastProcessedBlock }) {
  const at = new Date().toISOString();

  let head = null;
  let checkpoint = null;
  let error = null;

  try {
    head = await provider.getBlockNumber();
  } catch (e) {
    error = `head unavailable: ${e?.shortMessage || e?.message || String(e)}`;
  }

  try {
    checkpoint = await getLastProcessedBlock(supabase);
  } catch (e) {
    error = error
      ? `${error}; checkpoint unavailable: ${e?.shortMessage || e?.message || String(e)}`
      : `checkpoint unavailable: ${e?.shortMessage || e?.message || String(e)}`;
  }

  // Either read failing means we cannot make the comparison, which is itself unhealthy.
  if (head === null || error) {
    return {
      healthy: false,
      reason: error || "head unavailable",
      head,
      checkpoint,
      lagBlocks: null,
      lagSecondsApprox: null,
      thresholdBlocks: MAX_HEAD_LAG_BLOCKS,
      thresholdSecondsApprox: lagSeconds(MAX_HEAD_LAG_BLOCKS),
      blockTimeMsAssumed: ARC_BLOCK_TIME_MS,
      at,
    };
  }

  // `checkpoint === null` (never written, or unreadable) is handled INSIDE livenessVerdict
  // as infinitely behind. Do not special-case it here -- that would be a second opinion.
  const verdict = livenessVerdict({ reached: checkpoint, head, strikes: 0 });
  const healthy = verdict.lag <= MAX_HEAD_LAG_BLOCKS;

  return {
    healthy,
    reason: healthy
      ? "checkpoint is keeping up with the chain head"
      : checkpoint === null
        ? "no checkpoint has ever been written — treated as infinitely behind"
        : "the chain advanced and the checkpoint did not — this is the silent-death signature",
    head,
    checkpoint,
    lagBlocks: Number.isFinite(verdict.lag) ? verdict.lag : null,
    lagSecondsApprox: lagSeconds(verdict.lag),
    thresholdBlocks: MAX_HEAD_LAG_BLOCKS,
    thresholdSecondsApprox: lagSeconds(MAX_HEAD_LAG_BLOCKS),
    blockTimeMsAssumed: ARC_BLOCK_TIME_MS,
    at,
  };
}

/**
 * GET /health -> 200 when healthy, 503 when not.
 *
 * 503 rather than 500: the process is fine, the SERVICE is not available in the sense that
 * matters. That is also what Fly's health check reads to decide on a restart, and a
 * restart is the correct response to a checkpoint that has stopped moving.
 */
function startHealthServer({ supabase, provider, getLastProcessedBlock, port = PORT }) {
  const server = http.createServer(async (req, res) => {
    // Anything other than the health path is a 404. This server exists for one endpoint;
    // it is not a place to grow an API surface on a process holding a service-role key.
    const path = (req.url || "").split("?")[0];
    if (req.method !== "GET" || (path !== "/health" && path !== "/")) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found", try: "/health" }));
      return;
    }

    let body;
    try {
      body = await computeHealth({ supabase, provider, getLastProcessedBlock });
    } catch (e) {
      // computeHealth is written not to throw; if it somehow does, that is still unhealthy.
      body = { healthy: false, reason: `health check threw: ${e?.message || String(e)}` };
    }

    res.writeHead(body.healthy ? 200 : 503, {
      "content-type": "application/json",
      "cache-control": "no-store",
    });
    // Pretty-printed on purpose: a human opens this in a browser during an incident.
    res.end(JSON.stringify(body, null, 2) + "\n");
  });

  server.on("error", (e) => {
    // A port clash must not take the indexer down -- indexing is the job, health reporting
    // is the instrument. Loud, but not fatal.
    console.error(`⚠ health server error (indexing continues): ${e.message}`);
  });

  // `port` is injectable so the test can bind an ephemeral port. Without it the suite
  // binds the real default and fails, confusingly, whenever a real indexer is running --
  // a test that clashes with the thing it tests is a test people learn to skip.
  server.listen(port, "0.0.0.0", () => {
    const bound = server.address().port;
    console.log(`Health endpoint on :${bound}/health (threshold ${MAX_HEAD_LAG_BLOCKS} blocks ≈ ${lagSeconds(MAX_HEAD_LAG_BLOCKS)}s)`);
  });

  return server;
}

/**
 * Outbound heartbeat to a generic webhook, if one is configured.
 *
 * ── ⚠ PING ONLY WHEN HEALTHY. SILENCE IS THE ALARM. ──────────────────────────
 *
 * When lag exceeds the threshold this STOPS pinging, so a dead-man's switch on the
 * receiving end fires. The alternative -- pinging with `healthy: false` in the body --
 * relies on the receiver parsing that body and being configured to alert on its contents.
 * That is a second place for the alarm to be misconfigured, and it fails OPEN: a receiver
 * that ignores the body sees a cheerful ping and reports everything fine. Silence needs no
 * parsing and fails closed.
 *
 * ⚠ THE PING STILL CARRIES THE LAG. Alerting on ping ABSENCE alone would reintroduce the
 * wall-clock failure one layer up -- a process 29 hours behind pings cheerfully forever if
 * the ping means only "I am running". Carrying the number gives a dashboard something to
 * trend, so lag climbing toward the threshold is visible BEFORE silence starts.
 *
 * If HEARTBEAT_URL is unset the indexer runs normally and says so once. This must never be
 * a startup dependency: monitoring that can prevent the service from starting is a new way
 * to be down.
 */
function startHeartbeat({ supabase, provider, getLastProcessedBlock }) {
  if (!HEARTBEAT_URL) {
    console.log("HEARTBEAT_URL not set — no outbound heartbeat (this is fine).");
    return null;
  }

  console.log(
    `Heartbeat -> configured URL every ${HEARTBEAT_INTERVAL_MS}ms, ` +
      `only while lag <= ${MAX_HEAD_LAG_BLOCKS} blocks (silence is the alarm).`
  );

  const tick = async () => {
    try {
      const h = await computeHealth({ supabase, provider, getLastProcessedBlock });

      if (!h.healthy) {
        // Deliberately no ping. Say so locally so the logs explain the silence.
        console.error(
          `⚠ heartbeat SUPPRESSED — lag ${h.lagBlocks ?? "unknown"} blocks ` +
            `(threshold ${MAX_HEAD_LAG_BLOCKS}). Silence is the alarm; the dead-man's switch should fire.`
        );
        return;
      }

      // Generic shape on purpose: no provider's API is assumed. A query string carries the
      // lag for receivers that only record a URL; the JSON body carries it for those that
      // parse one. Neither is required for the ping itself to register.
      const url = `${HEARTBEAT_URL}${HEARTBEAT_URL.includes("?") ? "&" : "?"}lag=${h.lagBlocks}&head=${h.head}`;
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 10_000);
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(h),
          signal: ctl.signal,
        });
        if (!res.ok) console.error(`⚠ heartbeat returned ${res.status} (indexing continues)`);
      } finally {
        clearTimeout(timer);
      }
    } catch (e) {
      // ⚠ NEVER FATAL. The monitoring must not become a new way to die -- that would be a
      // strictly worse outcome than the outage it watches for.
      console.error(`⚠ heartbeat failed (indexing continues): ${e?.message || String(e)}`);
    }
  };

  const handle = setInterval(tick, HEARTBEAT_INTERVAL_MS);
  // Do not hold the event loop open on the heartbeat alone.
  if (typeof handle.unref === "function") handle.unref();
  void tick(); // one immediately, so a misconfigured URL surfaces at startup not in an hour
  return handle;
}

module.exports = {
  computeHealth,
  startHealthServer,
  startHeartbeat,
  HEALTH_PORT: PORT,
  HEARTBEAT_INTERVAL_MS,
};
