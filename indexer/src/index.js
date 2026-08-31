require("dotenv").config();
const { ethers } = require("ethers");
const { createClient } = require("@supabase/supabase-js");
// Generated from the Hardhat artifact by scripts/gen-indexer-abi.js. Never hand-edit:
// the previous hand-maintained subset silently truncated the Curve struct.
const factoryAbi = require("./generated/lfx1Abi.json");
const { fetchAndSanitizeMetadata } = require("./metadata");
const { getLastProcessedBlock, saveCheckpoint } = require("./recovery");

// Curve.state values, mirrored from Ballista.sol's CurveState enum. This replaced the
// old `graduated` bool: a curve that has crossed its threshold but not yet completed
// the DEX hand-off sits in GRADUATION_READY, which is neither "still trading" nor
// "graduated". The boolean tokens.graduated column cannot express that middle state,
// so tokens.state carries it instead — see stateLabel() and migrations/001.
const CurveState = Object.freeze({
  ACTIVE: 0,
  GRADUATION_READY: 1,
  GRADUATED: 2,
});

// Only a fully completed graduation counts. GRADUATION_READY deliberately maps to
// false: the token is not on the DEX yet, and reporting it as graduated would point
// holders at a pool that does not exist.
function isGraduated(curve) {
  return Number(curve.state) === CurveState.GRADUATED;
}

// The tokens.state column, which unlike the boolean can express the middle state.
// See migrations/001_add_token_state.sql.
const STATE_LABEL = Object.freeze({
  [CurveState.ACTIVE]: "trading",
  [CurveState.GRADUATION_READY]: "awaiting_graduation",
  [CurveState.GRADUATED]: "graduated",
});

function stateLabel(curve) {
  const label = STATE_LABEL[Number(curve.state)];
  if (!label) {
    // A state the contract has but this indexer doesn't know about. Refuse to
    // invent a label -- the column is nullable precisely so "unknown" is
    // representable rather than being rounded to the nearest wrong answer.
    console.warn(`[warn] unrecognized curve state ${curve.state}; leaving state null`);
    return null;
  }
  return label;
}

const {
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  FACTORY_RPC_URL,
  FACTORY_ADDRESS,
  FACTORY_DEPLOY_BLOCK,
} = process.env;

for (const [key, val] of Object.entries({ SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, FACTORY_RPC_URL, FACTORY_ADDRESS })) {
  if (!val) {
    console.error(`Missing required env var: ${key}. Check .env against .env.example.`);
    process.exit(1);
  }
}

const CHUNK_SIZE = 500; // blocks per historical getLogs call — reduced after hitting a
// real rate limit on the public RPC endpoint; lower this further (or raise it, if you
// switch to a dedicated provider like QuickNode/dRPC/Blockdaemon with a higher quota)
// depending on what you observe.
const CHUNK_DELAY_MS = 750; // pause between chunks, gentler on shared rate limits

/// @notice Retries a function with exponential backoff, specifically when the failure
///         looks like a rate limit rather than a real error (wrong ABI, bad address,
///         etc. fail immediately instead — retrying those would just waste time).
async function withRetry(fn, { retries = 5, baseDelayMs = 1000 } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      // ⚠ MATCH ON CODES FIRST, TEXT ONLY AS A FALLBACK.
      //
      // This used to test `err.code === -32011` alone, and Arc actually returns **-32005**
      // for a rate limit. It worked only because the message regex happened to match
      // "rate limit exceeded" -- i.e. our own retry logic was depending on error TEXT, the
      // exact fragility that caused the live-mode outage. ethers has the same weakness one
      // layer down: it decides a method is unsupported by matching
      // /the method .* does not exist/i, so Arc's "internal error" defeats its
      // downgrade-to-polling path entirely.
      //
      // Measured against Arc: -32005 "rate limit exceeded". -32011 is kept because it is
      // what some other providers return and removing it would narrow coverage for no gain.
      // The text match stays as a last resort, not as the mechanism.
      const RATE_LIMIT_CODES = [-32005, -32011];
      const isRateLimit =
        RATE_LIMIT_CODES.includes(err.code) ||
        /request limit|rate limit|too many requests/i.test(err.message || err.shortMessage || "");
      // "missing revert data" with no actual revert reason on a call that should be
      // trivially safe (reading a public variable right after its own contract's
      // creation tx confirmed) points at RPC node lag — the event got pushed before
      // the node serving this particular call caught up to that block — rather than
      // a genuine contract-level revert, which would normally carry a reason.
      const isLikelyNodeLag =
        err.code === "CALL_EXCEPTION" && err.data === null && err.reason === null;
      if ((!isRateLimit && !isLikelyNodeLag) || attempt >= retries) throw err;
      const delay = baseDelayMs * 2 ** attempt;
      console.warn(`  transient error, retrying in ${delay}ms (attempt ${attempt + 1}/${retries})...`);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
const provider = FACTORY_RPC_URL.startsWith("ws")
  ? new ethers.WebSocketProvider(FACTORY_RPC_URL)
  : new ethers.JsonRpcProvider(FACTORY_RPC_URL, undefined, { batchMaxCount: 1 });
// batchMaxCount: 1 disables ethers' automatic request batching (bundling multiple calls
// into one HTTP request). Found real evidence this RPC endpoint doesn't handle batched
// requests reliably — name()/symbol() called back-to-back showed a deterministic
// pattern (first call always succeeds, second always fails with malformed/missing
// data) that disappeared when called in isolation. Forcing one request per call trades
// a small amount of overhead for actually working correctly.
if (!FACTORY_RPC_URL.startsWith("ws")) {
  provider.pollingInterval = 4000; // only relevant for the http fallback path
}
const factory = new ethers.Contract(FACTORY_ADDRESS, factoryAbi, provider);

const ERC20_MIN_ABI = [
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function creator() view returns (address)",
  "function metadataURI() view returns (string)",
];

// ── Handlers ────────────────────────────────────────────────────────────

let cachedChainId = null;
let cachedCurveSupply = null;

// "Creator bought X% at launch" is the disclosure that protects buyers -- the 2.5% cap
// limits only the PRIVILEGED path and does not cap total creator holdings, so the
// number itself is the protection. It was unrenderable until now: the hand-maintained
// ABI truncated the Curve struct before creatorLaunchPurchased.
//
// The percentage is derived from the contract's own CURVE_TOKEN_SUPPLY rather than a
// hardcoded 807e24, because a hardcoded constant here is the same trap as the hardcoded
// ABI was.
async function creatorLaunchBps(purchased) {
  if (cachedCurveSupply === null) {
    cachedCurveSupply = await withRetry(() => factory.CURVE_TOKEN_SUPPLY());
  }
  if (cachedCurveSupply === 0n) return null;
  return Number((purchased * 10000n) / cachedCurveSupply);
}

// ── migration 003 ───────────────────────────────────────────────────────────

/// @notice CURVE_TOKEN_SUPPLY, for tokens.curve_token_supply.
///
///         ⚠ The CURVE supply (807,000,000e18), NOT TOTAL_TOKEN_SUPPLY (1,000,000,000e18).
///         Market cap is price x CIRCULATING supply, and during the curve phase the 193M
///         LP reserve is held by the factory and cannot be sold into the curve. Using the
///         total would overstate every market cap on the site by 1000/807 = 1.24x.
///
///         Reuses the same cached read as creatorLaunchBps -- one constant, one source,
///         so the market-cap denominator and the creator-percentage denominator cannot
///         drift apart.
async function curveTokenSupply() {
  if (cachedCurveSupply === null) {
    cachedCurveSupply = await withRetry(() => factory.CURVE_TOKEN_SUPPLY());
  }
  return cachedCurveSupply === 0n ? null : cachedCurveSupply.toString();
}

// Block timestamps, memoised by block number.
//
// WHY THIS EXISTS. `trades.created_at` defaults to now() at INSERT time, so it records
// when the indexer saw a trade rather than when the trade happened. Measured on 30 August
// 2026, rows ingested during a catch-up carried up to 30.9 HOURS of drift -- which put
// 31-hour-old trades inside the "last 1 hour" volume window. A time window built on that
// looks live and is not, which is worse than having no window.
//
// Several trades usually share a block (and on Arc, several blocks share a timestamp), so
// the cache keeps this to roughly one extra RPC call per block rather than per trade. It
// is bounded so a long backfill cannot grow it without limit.
const blockTimeCache = new Map();
const BLOCK_TIME_CACHE_MAX = 5000;

async function blockTimeISO(blockNumber) {
  const key = Number(blockNumber);
  if (blockTimeCache.has(key)) return blockTimeCache.get(key);

  let iso = null;
  try {
    const block = await withRetry(() => provider.getBlock(key));
    if (block && block.timestamp) iso = new Date(Number(block.timestamp) * 1000).toISOString();
  } catch (err) {
    // A missing block time degrades the row to created_at via the view's COALESCE. That
    // is the documented fallback, not a failure -- refusing to index a trade because its
    // timestamp could not be fetched would lose the trade itself, which is strictly
    // worse than an approximate window.
    console.warn(`  [warn] could not read timestamp for block ${key}: ${err.message}`);
  }

  if (blockTimeCache.size >= BLOCK_TIME_CACHE_MAX) blockTimeCache.clear();
  blockTimeCache.set(key, iso);
  return iso;
}

async function upsertTokenFromChain(tokenAddress) {
  const curve = await withRetry(() => factory.curves(tokenAddress));
  const token = new ethers.Contract(tokenAddress, ERC20_MIN_ABI, provider);
  const [name, symbol, creator, metadataURI] = await withRetry(async () => {
    const name_ = await token.name();
    const symbol_ = await token.symbol();
    const creator_ = await token.creator();
    const metadataURI_ = await token.metadataURI();
    return [name_, symbol_, creator_, metadataURI_];
  });
  const { description, logoUrl } = await fetchAndSanitizeMetadata(metadataURI);

  if (cachedChainId === null) {
    cachedChainId = Number((await provider.getNetwork()).chainId);
  }

  const { error } = await supabase.from("tokens").upsert(
    {
      contract_address: tokenAddress,
      chain_id: cachedChainId,
      creator_address: creator,
      name,
      symbol,
      metadata_uri: metadataURI,
      description,
      logo_url: logoUrl,
      buy_fee_bps: Number(curve.buyFeeBps),
      sell_fee_bps: Number(curve.sellFeeBps),
      graduation_threshold_usdc: curve.graduationThresholdUsdc.toString(),
      real_usdc_reserves: curve.realUsdcReserves.toString(),
      token_reserves: curve.tokenReserves.toString(),
      virtual_usdc_reserves: curve.virtualUsdcReserves.toString(),
      virtual_token_reserves: curve.virtualTokenReserves.toString(),
      graduated: isGraduated(curve),
      state: stateLabel(curve),
      creator_launch_purchased: curve.creatorLaunchPurchased.toString(),
      creator_launch_bps: await creatorLaunchBps(curve.creatorLaunchPurchased),
      lp_recipient: curve.lpRecipient,
      // migration 003. Read from the contract, never hardcoded -- the same trap the
      // hand-maintained ABI was. The view computes market_cap_usdc from this column
      // and the live virtual reserves. CURVE supply, not total: see curveTokenSupply().
      curve_token_supply: await curveTokenSupply(),
    },
    { onConflict: "contract_address" }
  );
  if (error) throw error;
}

async function updateReservesFromChain(tokenAddress) {
  const curve = await withRetry(() => factory.curves(tokenAddress));
  const { error } = await supabase
    .from("tokens")
    .update({
      real_usdc_reserves: curve.realUsdcReserves.toString(),
      token_reserves: curve.tokenReserves.toString(),
      virtual_usdc_reserves: curve.virtualUsdcReserves.toString(),
      virtual_token_reserves: curve.virtualTokenReserves.toString(),
      graduated: isGraduated(curve),
      state: stateLabel(curve),
      creator_launch_purchased: curve.creatorLaunchPurchased.toString(),
      creator_launch_bps: await creatorLaunchBps(curve.creatorLaunchPurchased),
    })
    .eq("contract_address", tokenAddress);
  if (error) throw error;
}

async function handleTokenCreated(log) {
  const tokenAddress = log.args.token;
  await upsertTokenFromChain(tokenAddress);
  console.log(`[TokenCreated] indexed ${log.args.symbol} at ${tokenAddress}`);
}

async function handleTrade(log) {
  const tokenAddress = log.args.token;

  // Idempotency: skip if this exact transaction was already recorded (handles
  // re-processing the same block range after a restart).
  const { data: existing } = await supabase
    .from("trades")
    .select("id")
    .eq("tx_hash", log.transactionHash)
    .maybeSingle();
  if (existing) return;

  // Race guard: a Trade for a token we haven't indexed yet (shouldn't normally
  // happen given creation must precede trading, but cheap to guard against).
  const { data: tokenRow } = await supabase
    .from("tokens")
    .select("contract_address")
    .eq("contract_address", tokenAddress)
    .maybeSingle();
  if (!tokenRow) await upsertTokenFromChain(tokenAddress);

  const { error } = await supabase.from("trades").insert({
    token_address: tokenAddress,
    trader_address: log.args.trader,
    is_buy: log.args.isBuy,
    usdc_amount: log.args.usdcAmount.toString(),
    token_amount: log.args.tokenAmount.toString(),
    tx_hash: log.transactionHash,
    block_number: log.blockNumber,
    // migration 003. The chain's own timestamp, NOT created_at -- which defaults to
    // now() and therefore records ingest time. Every volume window in
    // tokens_with_volume filters on COALESCE(block_time, created_at), so this column
    // is what makes those windows mean what they say.
    block_time: await blockTimeISO(log.blockNumber),
  });
  if (error) throw error;

  await updateReservesFromChain(tokenAddress);
  console.log(`[Trade] ${log.args.isBuy ? "buy" : "sell"} on ${tokenAddress}`);
}

async function handleGraduated(log) {
  const tokenAddress = log.args.token;
  const { error } = await supabase
    .from("tokens")
    .update({ graduated: true, state: "graduated", graduated_at: new Date().toISOString() })
    .eq("contract_address", tokenAddress);
  if (error) throw error;
  console.log(`[Graduated] ${tokenAddress}`);
}

// The curve finished but the DEX hand-off has not completed. Trading is closed in
// this state, so surfacing it is the whole point of the state column: without it the
// UI shows a normal buyable token and the user discovers otherwise via a revert.
async function handleGraduationReady(log) {
  const tokenAddress = log.args.token;
  const { error } = await supabase
    .from("tokens")
    // Deliberately does not touch `graduated` -- the token is not on a DEX yet. The
    // migration's trigger keeps the boolean correct regardless.
    .update({ state: "awaiting_graduation" })
    .eq("contract_address", tokenAddress);
  if (error) throw error;
  console.log(`[GraduationReady] ${tokenAddress}`);
}

async function dispatchEvent(log) {
  if (log.eventName === "TokenCreated") await handleTokenCreated(log);
  else if (log.eventName === "Trade") await handleTrade(log);
  else if (log.eventName === "Graduated") await handleGraduated(log);
  else if (log.eventName === "GraduationReady") await handleGraduationReady(log);
}

// ── Historical catch-up ─────────────────────────────────────────────────

function parseFactoryLog(log) {
  try {
    const description = factory.interface.parseLog(log);
    return { ...log, eventName: description.name, args: description.args };
  } catch {
    return null; // a log from this address that isn't one of our known events — skip
  }
}

/**
 * Read forward from the checkpoint to the current head, in chunks.
 *
 * ⚠ THIS IS ALSO LIVE MODE. Live mode is this function on an interval -- see watchLive().
 * There is deliberately ONE code path for reading logs, because the two-path version is
 * what broke: catch-up polled `eth_getLogs` and worked, while live mode used
 * `provider.on()` and silently did nothing for 29 hours.
 *
 * `quiet` suppresses the per-chunk chatter for the live poll, which would otherwise print
 * a line every few seconds forever. It does NOT suppress anything that indicates a
 * problem.
 *
 * Returns the block it reached, so the caller can compare progress against the head.
 */
async function catchUp({ quiet = false } = {}) {
  const checkpoint = await getLastProcessedBlock(supabase);
  const fromDefault = Number(FACTORY_DEPLOY_BLOCK || 0);
  let from = checkpoint !== null ? checkpoint + 1 : fromDefault;
  let reached = checkpoint;

  if (!quiet) console.log(`Catching up from block ${from}...`);

  // Re-fetches the current chain head every iteration instead of fixing it once at
  // the start. A long catch-up run (working through a big backlog) takes real time,
  // during which the chain keeps producing new blocks — checking "latest" only once
  // meant anything created after that snapshot, but before live-mode's subscription
  // actually started, fell into a gap neither side covered. This closes that gap by
  // only stopping once we're genuinely caught up to the head at the moment we check.
  while (true) {
    const latest = await withRetry(() => provider.getBlockNumber());
    if (from > latest) break;
    const to = Math.min(from + CHUNK_SIZE - 1, latest);

    // One request per chunk instead of three (previously: separate filtered queries for
    // TokenCreated/Trade/Graduated in parallel — tripled request volume and is what
    // actually triggered the rate limit on the shared public RPC endpoint). Fetch every
    // log from the contract address, unfiltered, then decode each one to figure out
    // which event it is.
    const rawLogs = await withRetry(() =>
      provider.getLogs({ address: FACTORY_ADDRESS, fromBlock: from, toBlock: to })
    );

    const parsed = rawLogs
      .map(parseFactoryLog)
      .filter(Boolean)
      .sort((a, b) =>
        a.blockNumber !== b.blockNumber ? a.blockNumber - b.blockNumber : a.index - b.index
      );

    for (const log of parsed) {
      try {
        await dispatchEvent(log);
      } catch (err) {
        console.error(
          `\n❌ FATAL: failed to index ${log.eventName} for token ${log.args.token} ` +
          `(tx ${log.transactionHash}): ${err.message}`
        );
        console.error(
          `Checkpoint was NOT advanced past block ${from - 1} — restarting the indexer ` +
          `will safely retry this whole chunk (all handlers are idempotent, so already-` +
          `processed events in it will just be re-written, not duplicated).`
        );
        throw err; // stop catch-up rather than silently skip past a real failure
      }
    }

    await saveCheckpoint(supabase, to);
    reached = to;
    // Quiet ticks stay quiet, but an EVENT is never silent -- a live poll that indexes
    // something says so, because "the indexer is working" should be observable.
    if (!quiet || parsed.length > 0) {
      console.log(`  processed through block ${to} (${parsed.length} events)`);
    }
    from = to + 1;
    await sleep(CHUNK_DELAY_MS);
  }

  if (!quiet) console.log("Caught up. Switching to live mode.");
  return reached;
}

// ── Live mode ───────────────────────────────────────────────────────────

// ── Live mode ───────────────────────────────────────────────────────────
//
// ⚠ LIVE MODE IS POLLING, NOT A SUBSCRIPTION, AND THAT IS NOT A STYLE CHOICE.
//
// It used to be `provider.on({ address }, cb)`. Against the Arc RPC that silently indexed
// NOTHING for 29 hours while the process reported healthy. Measured, on both
// rpc.testnet.arc.io and rpc.testnet.arc.network:
//
//   eth_newFilter        -32603 internal error   (NOT supported)
//   eth_newBlockFilter   -32603 internal error   (NOT supported)
//   eth_getLogs          works
//
// ethers HAS a downgrade-to-polling path for exactly this case, in
// subscriber-filterid.js. It never fires, because it is gated on the error being
// UNSUPPORTED_OPERATION and ethers decides that by REGEX-MATCHING THE ERROR MESSAGE
// (provider-jsonrpc.js: `message.match(/the method .* does not exist/i)`). Arc says
// "internal error", which matches nothing, so ethers classifies it UNKNOWN_ERROR,
// re-throws into its own catch, prints `console.log("@TODO", error)` and re-arms itself
// on the next block. Forever. Measured: 11 attempts in 45s, ~4s apart, no backoff, the
// SAME request id every time, and ZERO `provider.on("error")` events.
//
// Had Arc returned -32601 "method not found", ethers would have downgraded to polling
// and none of this would have happened.
//
// WEBSOCKET SUBSCRIPTIONS DO WORK on both hosts (wss://, eth_subscribe returns a usable
// id). They are still not used here: a dropped or silently-dead subscription has exactly
// the failure mode being fixed -- process alive, nothing arriving, checkpoint frozen.
// Polling from the checkpoint is SELF-HEALING, because every tick re-reads from where it
// left off, so a missed tick just means the next one covers more blocks.
//
// ⚠ eth_subscribe OVER HTTP IS A TRAP: it returns a plausible id, then
// eth_getFilterChanges on that id gives -32603 and eth_unsubscribe returns false.
// Anything checking "did subscribe succeed?" gets yes. Do not reintroduce it.

/** How often to poll. Arc blocks are ~0.48s, so this is ~10 blocks of ground per tick. */
const LIVE_POLL_MS = 5000;

/**
 * Consecutive failed polls before the process gives up and exits.
 *
 * The bug this bounds: an unrecoverable RPC method error retried forever, quietly. A
 * bounded count means a genuinely transient blip is ridden out, and a broken RPC method
 * kills the process LOUDLY so a supervisor restarts it or a human sees it.
 */
const MAX_CONSECUTIVE_POLL_FAILURES = 5;

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

/**
 * Poll forward forever. Never returns; exits the process on an unrecoverable condition.
 */
async function watchLive() {
  console.log(
    `Live mode: polling eth_getLogs every ${LIVE_POLL_MS}ms ` +
      `(filters are unsupported on this RPC -- see the note above).`
  );

  let consecutiveFailures = 0;
  let livenessStrikes = 0;

  for (;;) {
    await sleep(LIVE_POLL_MS);

    try {
      const reached = await catchUp({ quiet: true });
      consecutiveFailures = 0;

      // ── liveness, head-relative ──────────────────────────────────────────
      const head = await withRetry(() => provider.getBlockNumber());
      const verdict = livenessVerdict({ reached, head, strikes: livenessStrikes });
      livenessStrikes = verdict.strikes;

      if (verdict.strikes > 0) {
        console.error(
          `⚠ LIVENESS: checkpoint ${reached} is ${verdict.lag} blocks behind head ${head} ` +
            `(limit ${MAX_HEAD_LAG_BLOCKS}) — strike ${verdict.strikes}/${MAX_LIVENESS_STRIKES}`
        );
      }

      if (verdict.fatal) {
        console.error(
          `\n❌ FATAL: the chain advanced while the checkpoint did not, ${MAX_LIVENESS_STRIKES} ` +
            `polls running. The indexer is alive but recording nothing, which is the exact ` +
            `failure this check exists to catch. Exiting so it is visible rather than silent.`
        );
        process.exit(1);
      }
    } catch (err) {
      consecutiveFailures++;
      const method = err?.payload?.method ? ` (${err.payload.method})` : "";
      console.error(
        `Poll failed${method}: ${err.message || err} ` +
          `— failure ${consecutiveFailures}/${MAX_CONSECUTIVE_POLL_FAILURES}`
      );

      if (consecutiveFailures >= MAX_CONSECUTIVE_POLL_FAILURES) {
        console.error(
          `\n❌ FATAL: ${MAX_CONSECUTIVE_POLL_FAILURES} consecutive poll failures. ` +
            `Stopping rather than looping quietly — an unrecoverable RPC error retried ` +
            `forever is what took the data dark for 29 hours.`
        );
        if (err?.payload?.method) {
          console.error(
            `The failing method was ${err.payload.method}. If this RPC does not support ` +
              `it, the fix is a different RPC or a different method, not a retry.`
          );
        }
        process.exit(1);
      }

      // Back off before the next attempt, capped. Bounded by the failure count above, so
      // this cannot become the infinite quiet loop it replaces.
      await sleep(Math.min(30_000, LIVE_POLL_MS * 2 ** consecutiveFailures));
    }
  }
}

// ── Entry point ─────────────────────────────────────────────────────────

// Last-resort safety net — anything not already caught explicitly above logs clearly
// here instead of Node dumping a raw, hard-to-read crash.
// ⚠ THIS HANDLER USED TO SWALLOW. It logged and continued, which is one of the three
// layers that let a dead indexer look alive for 29 hours: ethers printed
// `console.log("@TODO", error)` internally, `provider.on("error")` never fired at all
// (measured: 0 events), and anything that did escape landed here and became a log line.
//
// An unhandled rejection is a bug by definition -- some path threw and nobody was
// waiting. Continuing past it means running in an unknown state, and the failure this
// file exists to prevent is precisely "running in an unknown state while reporting
// healthy". So it is now FATAL.
process.on("unhandledRejection", (err) => {
  console.error("\n❌ FATAL: unhandled rejection — exiting rather than continuing blind.");
  console.error(err);
  process.exit(1);
});

async function main() {
  await catchUp();
  // AWAITED. watchLive never returns normally -- it polls forever and calls
  // process.exit(1) on an unrecoverable condition. Leaving it un-awaited meant main()
  // resolved immediately and any rejection escaped into the unhandledRejection handler
  // below, which logs and swallows. That is one of the three layers that kept a dead
  // indexer looking alive.
  await watchLive();
}

if (require.main === module) {
  main().catch((err) => {
    console.error("Fatal indexer error:", err);
    process.exit(1);
  });
}

module.exports = {
  upsertTokenFromChain,
  supabase,
  provider,
  // Exported for scripts/verify-liveness.js. The liveness rule is the one piece of this
  // file that can be proved without a chain, so it is exported rather than buried.
  livenessVerdict,
  MAX_HEAD_LAG_BLOCKS,
  MAX_LIVENESS_STRIKES,
  MAX_CONSECUTIVE_POLL_FAILURES,
};
