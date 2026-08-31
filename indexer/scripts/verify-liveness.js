// The liveness rule, and the polling loop's failure bounds.
//
// ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
//
// Live mode used `provider.on()` against an RPC that does not support filters. ethers
// retried `eth_newFilter` forever -- measured: 11 attempts in 45s, ~4s apart, no backoff,
// the same request id every time -- printed `console.log("@TODO", error)` internally, and
// emitted ZERO `provider.on("error")` events. The process stayed alive, the checkpoint
// never advanced, and the data went 29 hours stale with no signal anywhere.
//
// Everything below exists so that cannot happen quietly again.
//
// Run: node indexer/scripts/verify-liveness.js
//
// Red-proofs, each hitting a different row:
//   a) make livenessVerdict compare against wall-clock instead of the head -> V1/V2 fail
//   b) clear strikes on any successful poll (not only a keeping-up one)    -> V5 fails
//   c) treat a null checkpoint as healthy                                  -> V4 fails
//   d) remove -32005 from RATE_LIMIT_CODES                                 -> V9 fails
//   e) make saveCheckpoint a bare upsert again                             -> V12 fails

const {
  livenessVerdict,
  MAX_HEAD_LAG_BLOCKS,
  MAX_LIVENESS_STRIKES,
  MAX_CONSECUTIVE_POLL_FAILURES,
} = require("../src/index.js");

let failures = 0;
const check = (label, pass, detail = "") => {
  if (!pass) failures++;
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${label}${detail ? `  — ${detail}` : ""}`);
};

// ── the signature the whole rule exists to catch ────────────────────────────
console.log("── head-relative liveness ──");

// THE ROW THAT MATTERS. A frozen checkpoint while the head runs away is a dead indexer.
// On a wall-clock timer this is indistinguishable from a quiet chain; against the head
// they are opposites. If this rule is ever rewritten against time, this fails.
{
  // The real scenario, run to conclusion: checkpoint frozen, chain advancing ~10 blocks
  // per 5s poll (Arc's 0.48s blocks). Poll until it dies or we give up.
  const frozen = 59_000_000;
  const BLOCKS_PER_POLL = 10;
  let strikes = 0;
  let head = frozen;
  let polls = 0;
  let fatal = false;
  let firstStrikePoll = null;

  while (polls < 500 && !fatal) {
    polls++;
    head += BLOCKS_PER_POLL;
    const v = livenessVerdict({ reached: frozen, head, strikes });
    strikes = v.strikes;
    fatal = v.fatal;
    if (strikes === 1 && firstStrikePoll === null) firstStrikePoll = polls;
  }

  check(
    "V1  a frozen checkpoint while the head moves goes FATAL",
    fatal,
    `died on poll ${polls} at lag ${head - frozen} blocks ` +
      `(~${((polls * 5) / 60).toFixed(1)} min at a 5s poll)`
  );
  // Detection is deliberately not instantaneous: the limit is a real amount of ground
  // lost, not a hair trigger, so ordinary catch-up after a restart does not kill the
  // process while it is legitimately working through a backlog.
  check(
    "V2  and it does NOT fire on the first poll (a small lag is normal)",
    firstStrikePoll !== null && firstStrikePoll > 1,
    `first strike at poll ${firstStrikePoll}, lag ${firstStrikePoll * BLOCKS_PER_POLL}`
  );
}

// A quiet chain is HEALTHY. This is the case a timer gets wrong.
{
  const head = 59_000_000;
  const v = livenessVerdict({ reached: head, head, strikes: 0 });
  check(
    "V3  a quiet chain with a caught-up checkpoint is healthy, not a violation",
    !v.fatal && v.strikes === 0,
    `lag=${v.lag} — a wall-clock timer cannot distinguish this from a dead indexer`
  );
}

// An unreadable checkpoint is not evidence of health.
{
  const v = livenessVerdict({ reached: null, head: 59_000_000, strikes: MAX_LIVENESS_STRIKES - 1 });
  check(
    "V4  a null checkpoint counts as infinitely behind, not as fine",
    v.fatal && v.lag === Infinity,
    `lag=${v.lag} fatal=${v.fatal}`
  );
}

// Strikes only clear on a poll that actually kept up.
{
  // Lagging, lagging, then caught up, then lagging again: the catch-up clears.
  let s = livenessVerdict({ reached: 100, head: 100 + MAX_HEAD_LAG_BLOCKS + 1, strikes: 0 }).strikes;
  s = livenessVerdict({ reached: 100, head: 100 + MAX_HEAD_LAG_BLOCKS + 1, strikes: s }).strikes;
  const recovered = livenessVerdict({ reached: 5000, head: 5000, strikes: s });
  check(
    "V5  strikes clear only when a poll KEEPS UP",
    recovered.strikes === 0 && s === 2,
    `two strikes accrued, then reset to ${recovered.strikes}`
  );
  // And a still-lagging poll does NOT clear them -- otherwise a permanently-behind
  // indexer alternates strike/reset forever and never dies.
  const stillBehind = livenessVerdict({
    reached: 100,
    head: 100 + MAX_HEAD_LAG_BLOCKS + 1,
    strikes: 1,
  });
  check("V5b a still-lagging poll increments rather than clearing", stillBehind.strikes === 2);
}

// The boundary itself.
{
  const at = livenessVerdict({ reached: 0, head: MAX_HEAD_LAG_BLOCKS, strikes: 0 });
  const over = livenessVerdict({ reached: 0, head: MAX_HEAD_LAG_BLOCKS + 1, strikes: 0 });
  check(
    "V6  exactly at the limit is tolerated; one block over is a strike",
    at.strikes === 0 && over.strikes === 1,
    `lag ${at.lag} ok, lag ${over.lag} strike`
  );
}

// ── the bounds that stop an infinite quiet loop ─────────────────────────────
console.log("\n── failure bounds ──");
check(
  "V7  poll failures are BOUNDED (an unrecoverable RPC error must not loop forever)",
  Number.isFinite(MAX_CONSECUTIVE_POLL_FAILURES) && MAX_CONSECUTIVE_POLL_FAILURES > 0,
  `${MAX_CONSECUTIVE_POLL_FAILURES} consecutive failures then exit(1)`
);
check(
  "V8  the head-lag limit is finite",
  Number.isFinite(MAX_HEAD_LAG_BLOCKS) && MAX_HEAD_LAG_BLOCKS > 0,
  `${MAX_HEAD_LAG_BLOCKS} blocks ≈ ${((MAX_HEAD_LAG_BLOCKS * 0.48) / 60).toFixed(1)} min at Arc's block time`
);

// ── the RPC error codes we classify, matched by CODE not text ───────────────
console.log("\n── error classification ──");
{
  // Arc returns -32005 for a rate limit. The old code tested only -32011 and worked by
  // accident, because the message regex happened to match "rate limit exceeded". Reading
  // the source rather than re-implementing it, so this cannot pass against a copy.
  const src = require("node:fs").readFileSync(require("node:path").join(__dirname, "../src/index.js"), "utf8");
  check(
    "V9  -32005 (Arc's actual rate-limit code) is matched by CODE",
    /RATE_LIMIT_CODES\s*=\s*\[[^\]]*-32005/.test(src),
    "text-matching is a fallback, not the mechanism"
  );
  check(
    "V10 live mode does not use provider.on() or eth_newFilter",
    !/^\s*provider\.on\(/m.test(src),
    "filters are unsupported on Arc; live mode polls eth_getLogs"
  );
  check(
    "V11 unhandled rejections are FATAL, not logged and swallowed",
    /unhandledRejection[\s\S]{0,400}process\.exit\(1\)/.test(src),
    "swallowing was one of the three layers that hid the outage"
  );
}

// ── the checkpoint may only move forward ────────────────────────────────────
console.log("\n── checkpoint monotonicity ──");
{
  // Found by running two indexers at once BY ACCIDENT while testing this fix: both
  // catch up from their own start block and each blindly writes its own cursor, so the
  // slower one overwrites the faster one. Observed 59782875 written, then 59776875
  // written over it. Nothing corrupts (handlers are idempotent) but the indexer can
  // appear to make no progress while working hard, and the liveness check would
  // eventually kill it with no obvious cause.
  const rec = require("node:fs").readFileSync(
    require("node:path").join(__dirname, "../src/recovery.js"), "utf8");
  check(
    "V12 saveCheckpoint refuses to LOWER the checkpoint",
    /blockNumber <= current/.test(rec) && /advanced: false/.test(rec),
    "two concurrent indexers must not be able to move it backwards"
  );
}

const total = 14;
console.log(`\n${total - failures}/${total} checks passed`);
if (failures) process.exit(1);
