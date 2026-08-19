require("dotenv").config();
const { ethers } = require("ethers");
const { createClient } = require("@supabase/supabase-js");
const factoryAbi = require("./factoryAbi");
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
      const isRateLimit =
        err.code === -32011 ||
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

async function catchUp() {
  const checkpoint = await getLastProcessedBlock(supabase);
  const fromDefault = Number(FACTORY_DEPLOY_BLOCK || 0);
  let from = checkpoint !== null ? checkpoint + 1 : fromDefault;

  console.log(`Catching up from block ${from}...`);

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
    console.log(`  processed through block ${to} (${parsed.length} events)`);
    from = to + 1;
    await sleep(CHUNK_DELAY_MS);
  }

  console.log("Caught up. Switching to live mode.");
}

// ── Live mode ───────────────────────────────────────────────────────────

function watchLive() {
  let degraded = false; // once true, stop advancing the checkpoint until a manual restart
  let processingChain = Promise.resolve(); // serializes event handling — see below

  async function processLiveLog(log) {
    const parsedLog = parseFactoryLog(log);
    if (!parsedLog) return;

    try {
      await dispatchEvent(parsedLog);

      // Only advance the checkpoint while nothing has failed yet. Freezing it after a
      // failure (rather than continuing to advance past subsequent successful events)
      // means a restart's catch-up correctly re-syncs from before the failure — every
      // handler is idempotent, so re-processing anything already-successful in that
      // range is safe, just slightly redundant. The alternative (letting the checkpoint
      // keep advancing on later successes) would permanently skip the failed event on
      // any future restart, which is the exact silent-data-loss bug this whole pass
      // was meant to fix.
      if (!degraded) await saveCheckpoint(supabase, parsedLog.blockNumber);
    } catch (err) {
      degraded = true;
      console.error(
        `\n❌ Live event handling FAILED for ${parsedLog.eventName} on ` +
        `${parsedLog.args.token} (tx ${log.transactionHash}): ${err.message}`
      );
      console.error(
        "Checkpoint progress is now frozen — this and further events will still be " +
        "attempted and written when possible, but restart the indexer once the " +
        "underlying issue is resolved so catch-up correctly re-syncs from before this failure."
      );
    }
  }

  // One subscription for every log at this address, instead of a separate one per
  // event type (previously: TokenCreated + Trade + Graduated + a block listener for
  // checkpointing = 4 simultaneous subscriptions, which is what triggered the rate
  // limit the instant live mode started).
  provider.on({ address: FACTORY_ADDRESS }, (log) => {
    // Chained rather than fired independently: two events arriving close together are
    // both async and yield at every `await`, so without this they could interleave —
    // letting a LATER block's checkpoint get saved while an EARLIER block's handler is
    // still mid-flight (and might fail afterward). Chaining forces strict in-order
    // processing, so `degraded` is always checked against a fully-settled prior state.
    processingChain = processingChain.then(() => processLiveLog(log));
  });

  // Provider-level errors (dropped connection, rate limit on the subscription itself,
  // etc.) get logged instead of crashing the process. NOTE: unlike an earlier version
  // of this comment claimed, ethers v6's WebSocketProvider reconnection behavior on a
  // dropped connection isn't something to rely on with full confidence — if events
  // stop appearing here for an extended period without any further log output at all,
  // don't assume it's silently recovering; restart the process manually instead of
  // waiting.
  provider.on("error", (err) => {
    console.error("Provider error:", err.message || err);
  });

  console.log(`Watching ${FACTORY_ADDRESS} for new events...`);
}

// ── Entry point ─────────────────────────────────────────────────────────

// Last-resort safety net — anything not already caught explicitly above logs clearly
// here instead of Node dumping a raw, hard-to-read crash.
process.on("unhandledRejection", (err) => {
  console.error("Unhandled rejection:", err);
});

async function main() {
  await catchUp();
  watchLive();
}

if (require.main === module) {
  main().catch((err) => {
    console.error("Fatal indexer error:", err);
    process.exit(1);
  });
}

module.exports = { upsertTokenFromChain, supabase, provider };
