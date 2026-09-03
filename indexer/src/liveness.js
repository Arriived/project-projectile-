// THE LIVENESS RULE. One definition, shared by everything that decides "healthy".
//
// ⚠ EXTRACTED FROM index.js SO THERE IS EXACTLY ONE OF IT. The polling loop, the /health
// endpoint and the outbound heartbeat all answer the same question, and three answers that
// can drift apart is the bug rather than the feature. index.js re-exports these so
// scripts/verify-liveness.js keeps importing from where it always did.
//
// Nothing here does I/O and nothing reads a clock. That is what lets the rule be
// red-proved without a chain (see scripts/verify-liveness.js).

/**
 * ── THE LIVENESS ASSERTION ───────────────────────────────────────────────
 *
 * How far the chain head may run ahead of our checkpoint before we treat the indexer as
 * silently dead.
 *
 * ⚠ MEASURED AGAINST THE HEAD, NEVER AGAINST WALL-CLOCK TIME, and that distinction is the
 * entire point. On a timer, a quiet chain and a dead indexer are indistinguishable -- both
 * look like "no new rows for N minutes", so a timer either fires constantly on a quiet
 * chain or is set so loose it never fires at all. Against the head they are opposites:
 *
 *   head moving, checkpoint moving    -> healthy
 *   head still,  checkpoint still     -> quiet chain, perfectly fine
 *   head moving, checkpoint STILL     -> silently dead. This is the signature.
 *
 * That comparison catches every silent-death variant, including ones nobody has thought
 * of yet, because it does not care WHY the checkpoint stopped -- only that the chain
 * advanced and we did not.
 *
 * At ~0.48s blocks this is roughly 8 minutes of ground lost before it fires.
 */
const MAX_HEAD_LAG_BLOCKS = 1000;

/** Consecutive liveness violations tolerated before exiting, to ride out one bad poll. */
const MAX_LIVENESS_STRIKES = 3;

/**
 * Arc's approximate block time, for turning a block lag into a duration a human can act on.
 *
 * ⚠ DISPLAY ONLY. Nothing decides anything from this number -- the rule above is counted in
 * BLOCKS, deliberately, because a block count is what the chain actually gives us and a
 * wall-clock conversion would smuggle a timer back into a head-relative check. It exists
 * because "1000 blocks behind" means nothing to someone reading /health in a browser at
 * 3am, and "roughly 8 minutes behind" means something immediately.
 *
 * Source: Arc docs, ~0.48s on testnet. If mainnet differs this figure is wrong and the
 * RULE is still right, which is the correct way round for the two to fail.
 */
const ARC_BLOCK_TIME_MS = 480;

/**
 * The liveness rule, as a PURE function so it can be red-proved without a chain.
 *
 * Takes where we reached, where the chain is, and how many strikes are already standing;
 * returns the new strike count and whether to die. No I/O, no clock.
 *
 * `reached === null` means the checkpoint could not be read at all, which is treated as
 * infinitely behind rather than as fine -- an unreadable checkpoint is not evidence of
 * health.
 */
function livenessVerdict({
  reached,
  head,
  strikes,
  maxLag = MAX_HEAD_LAG_BLOCKS,
  maxStrikes = MAX_LIVENESS_STRIKES,
}) {
  const lag = reached === null ? Infinity : head - reached;

  if (lag <= maxLag) {
    // Only a poll that actually KEPT UP clears the strikes. Clearing on any successful
    // poll would let a permanently-lagging indexer alternate strike/reset forever and
    // never reach the limit -- alive, behind, and silent, which is the bug.
    return { lag, strikes: 0, fatal: false };
  }

  const next = strikes + 1;
  return { lag, strikes: next, fatal: next >= maxStrikes };
}

/** A block lag rendered as approximate seconds. Display only -- see ARC_BLOCK_TIME_MS. */
function lagSeconds(lagBlocks) {
  if (!Number.isFinite(lagBlocks)) return null;
  return Math.round((lagBlocks * ARC_BLOCK_TIME_MS) / 1000);
}

module.exports = {
  livenessVerdict,
  lagSeconds,
  MAX_HEAD_LAG_BLOCKS,
  MAX_LIVENESS_STRIKES,
  ARC_BLOCK_TIME_MS,
};
