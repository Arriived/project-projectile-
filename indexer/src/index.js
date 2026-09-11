require("dotenv").config();
const { ethers } = require("ethers");
const { createClient } = require("@supabase/supabase-js");
// Generated from the Hardhat artifact by scripts/gen-indexer-abi.js. Never hand-edit:
// the previous hand-maintained subset silently truncated the Curve struct.
const factoryAbi = require("./generated/lfx1Abi.json");
const { fetchAndSanitizeMetadata } = require("./metadata");
const { getLastProcessedBlock, saveCheckpoint } = require("./recovery");
const { startHealthServer, startHeartbeat } = require("./health");

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

// ⚠ FACTORY_DEPLOY_BLOCK IS IN THIS LOOP NOW. It was destructured above but omitted here,
// so a missing value fell through silently and the indexer started from the wrong place on
// a fresh host -- a silent wrong-start, which is the class of failure this project keeps
// finding. On a laptop with a populated .env it never bit; on a container with secrets set
// one at a time it is exactly what happens.
for (const [key, val] of Object.entries({ SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, FACTORY_RPC_URL, FACTORY_ADDRESS, FACTORY_DEPLOY_BLOCK })) {
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

/// @notice The JSON-RPC error code behind an error, wherever the library put it.
///
///         ⚠ ethers v6 does NOT put the node's code on `err.code`. That field holds its own
///         string ("CALL_EXCEPTION", "UNKNOWN_ERROR"); the node's number sits in `err.error`
///         or `err.info.error`. So the "codes first" check below, written against `err.code`
///         until 11 September 2026, never matched anything ethers threw -- the text fallback
///         was doing all the work, which is the fragility that comment exists to prevent. A
///         bare JSON-RPC error object with a numeric `code` is still read directly.
function rpcErrorCode(err) {
  if (typeof err?.code === "number") return err.code;
  return err?.error?.code ?? err?.info?.error?.code ?? null;
}

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

// ⚠ -32001 "block not found". Measured on Arc, 11 September 2026: an eth_call pinned to a
// block the serving node has not reached yet. Reads are pinned to the trade's own block now
// (readCurveAtBlock), and a lagging node answers THIS -- where an unpinned read quietly
// handed back older state. Transient by definition: the node catches up within a block.
//
// ⚠ -32014 "requested data not available" is the eth_getLogs twin, and it was measured in
// PRODUCTION rather than reasoned about: three times in the nine hours after the 11 September
// deploy (05:33:40, 07:32:51 and 08:41:46 UTC), the live poll asked for a range ending at the
// head it had just been handed, and the node behind the load balancer had not reached it. The
// next poll recovered from each one, so the five-in-a-row bound never went past 1 -- but until
// this entry the whole poll failed instead of the one call being retried, and indexing stalled
// until the next tick. Same cause as -32001, one method over, so it takes the same path.
// The log is in CLAUDE.md 23.4; scripts/verify-trade-reserves.js T7b pins the classification.
const NODE_LAG_CODES = [-32001, -32014];

// ⚠ TRANSPORT-LEVEL FAILURES NEVER REACH A JSON-RPC CODE, WHICH IS WHY THE -32014 FIX
// DID NOTHING FOR THEM. Six HTTP 502s in v3's 21 hours (CLAUDE.md 23.6: 07:41:52, 11:41:33,
// 11:56:35, 13:22:29, 19:52:14, 23:08:37 UTC) and one of them took the consecutive-failure
// counter to 2 of 5 for the first time. A 502 is the load balancer answering instead of the
// node, so there IS no JSON-RPC body and no code to classify -- rpcErrorCode returns null,
// retryReason returned null, and the whole poll failed for something the next request would
// have served.
//
// MEASURED, not inferred, against a local server on ethers 6.17.0 -- with a healthy server
// as a control (it must not throw) and a -32014 as a second control (a numeric code must
// still be visible):
//
//     HTTP 502/503/504   err.code "SERVER_ERROR"  err.response.statusCode 502/503/504
//     socket destroyed   err.code "ECONNRESET"    no response
//     client timeout     err.code "TIMEOUT"       no response
//     healthy server     no throw
//     JSON-RPC -32014    err.code "UNKNOWN_ERROR" err.error.code -32014
//
// ⚠ ethers puts a STRING in err.code for all of these, so rpcErrorCode -- which returns
// only numbers -- cannot see them. That is the gap, and it is the same shape as the bug
// CLAUDE.md 11.11 records one layer down: a classifier that only understands one encoding
// of "what went wrong".
//
// ⚠ THE STATUS CODE IS THE SIGNAL, NEVER THE MESSAGE. "server response 502 Bad Gateway" is
// text, and 11.18's standing rule is codes first. err.response.statusCode is a number ethers
// carries deliberately.
const TRANSPORT_ERROR_CODES = [
  "TIMEOUT", // ethers' own client-side timeout
  "ECONNRESET", // socket closed mid-flight -- measured as "socket hang up"
  "ECONNREFUSED", // nothing listening: an RPC restarting looks exactly like this
  "ECONNABORTED",
  "EPIPE",
  "ETIMEDOUT",
  "ENOTFOUND", // DNS
  "EAI_AGAIN", // DNS, and the name says transient
  "ENETUNREACH",
  "EHOSTUNREACH",
];

/// @notice Whether a failure happened BELOW JSON-RPC -- an HTTP status or a socket error --
///         and is worth another attempt. Returns "rate-limit", "transport", or null.
///
/// ⚠ 4xx IS NOT RETRIED, WITH TWO NAMED EXCEPTIONS. A 400, 401, 403 or 404 will answer the
///   same way in thirty seconds; retrying buys nothing and delays a loud failure. 429 is a
///   rate limit and gets that label so the log reads correctly. 408 is literally a timeout.
///
/// ⚠ 501 IS EXCLUDED FROM THE 5xx SWEEP. "Not Implemented" is a statement about the method,
///   not about the moment -- it is the HTTP twin of the -32601 that Arc now returns for
///   eth_newFilter (CLAUDE.md 11.11), and retrying it would be retrying a permanent answer.
function transportFailure(err) {
  const status = err?.response?.statusCode ?? err?.status ?? null;
  if (typeof status === "number") {
    if (status === 429) return "rate-limit";
    if (status === 408) return "transport";
    if (status >= 500 && status !== 501) return "transport";
    return null;
  }
  // No HTTP response at all: the socket failed, or we gave up waiting. ethers puts its own
  // string code on err.code; node's underlying errno can also arrive nested on a cause.
  for (const c of [err?.code, err?.error?.code, err?.cause?.code, err?.error?.cause?.code]) {
    if (typeof c === "string" && TRANSPORT_ERROR_CODES.includes(c)) return "transport";
  }
  return null;
}

/// @notice Why an error is worth retrying -- "rate-limit" or "node-lag" -- or null when it is
///         a real error (wrong ABI, bad address, a genuine revert) that should fail at once.
///         Exported so scripts/verify-trade-reserves.js can prove the classification.
function retryReason(err) {
  const code = rpcErrorCode(err);
  if (
    RATE_LIMIT_CODES.includes(code) ||
    /request limit|rate limit|too many requests/i.test(err?.message || err?.shortMessage || "")
  ) {
    return "rate-limit";
  }
  if (NODE_LAG_CODES.includes(code)) return "node-lag";
  // Below JSON-RPC: an HTTP status or a dead socket. Checked AFTER the code paths so a
  // response that carries a real JSON-RPC error keeps its own, more specific label.
  const transport = transportFailure(err);
  if (transport) return transport;
  // The older, shape-based signal, kept: "missing revert data" with no revert reason on a
  // call that should be trivially safe (reading a public variable right after its own
  // contract's creation tx confirmed) points at RPC node lag — the event got pushed before
  // the node serving this particular call caught up to that block — rather than a genuine
  // contract-level revert, which would normally carry a reason.
  if (err?.code === "CALL_EXCEPTION" && err.data === null && err.reason === null) return "node-lag";
  return null;
}

/// @notice Retries a function with exponential backoff when the failure looks transient
///         (see retryReason). A real error -- wrong ABI, bad address, a genuine revert --
///         fails immediately instead; retrying those would just waste time.
///
/// ⚠ WHAT CLASSIFYING TRANSPORT FAILURES COSTS, stated because it lengthens the time to
///   notice a HARD outage. 5 retries at 1/2/4/8/16s is ~31s before a call finally throws.
///   A 502 used to fail its poll instantly, so five consecutive polls reached the exit in
///   ~50s; now the same sustained outage takes roughly 3.5 minutes. That is the deliberate
///   trade: a SINGLE 502 no longer costs a poll, and a sustained one still exits. The
///   independent backstop is unaffected -- livenessVerdict compares the checkpoint against
///   the chain HEAD, not against a clock, and kills at 1000 blocks behind (CLAUDE.md 11.11).
async function withRetry(fn, { retries = 5, baseDelayMs = 1000 } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (!retryReason(err) || attempt >= retries) throw err;
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

/**
 * curves(token) as it stood at the END of `blockNumber` -- never at "latest".
 *
 * ⚠ THE BUG THIS REPLACES, measured 11 September 2026. The trade row's reserves are what the
 * candle chart plots, and they were read with no blockTag -- at whatever block was latest
 * when the indexer reached the log. 26 of 27 stored rows were right. The 27th, a GP4265 BUY
 * at block 60267961, held the state after the NEXT trade, a SELL six blocks later, because
 * both were ingested two hours late in a catch-up. Every trade sharing one 5s poll, and every
 * trade in a catch-up, got the same later state.
 *
 * ⚠ IT REFUSES A MISSING BLOCK NUMBER rather than falling back to latest. The fallback IS the
 * bug -- silent, plausible and wrong -- so a caller that forgets the block fails loudly.
 *
 * The limit, which cannot be closed from here: two trades on one token in ONE block share the
 * block-end state. The Trade event carries no reserves to separate them, and the contract is
 * frozen. None of the 27 stored rows shares a block.
 *
 * Needs an archive-capable RPC for anything older than the node's recent state. Both Arc
 * testnet hosts serve eth_call from block 1 (measured). Check any new provider before
 * pointing FACTORY_RPC_URL at it: a catch-up reads as far back as the checkpoint.
 */
function readCurveAtBlock(contract, tokenAddress, blockNumber) {
  const block = typeof blockNumber === "bigint" ? Number(blockNumber) : blockNumber;
  if (!Number.isSafeInteger(block) || block < 0) {
    throw new Error(
      `readCurveAtBlock: refusing to read ${tokenAddress} without a block number ` +
        `(got ${String(blockNumber)}); an unpinned read is exactly the bug this prevents`
    );
  }
  return contract.curves(tokenAddress, { blockTag: block });
}

/**
 * Refresh a token's curve state from the chain as it stood at `blockNumber`, and hand the
 * caller the reserves it just read.
 *
 * ⚠ THE RETURN VALUE IS LOAD-BEARING (migration 004). handleTrade writes these same
 * numbers onto the trade row as the POST-TRADE curve state, which is what the candle
 * chart plots. `tokens` holds only the latest state the indexer has processed, so once a
 * second trade lands the state at the first is gone and cannot be recovered from the row.
 *
 * `tokens` is written from the same pinned read. Trades are processed in block order, so it
 * trails the head only while a catch-up is running, and converges on the latest trade's
 * state. One read serves both rows, so the chart still costs ZERO extra RPC calls.
 */
async function updateReservesFromChain(tokenAddress, blockNumber) {
  const curve = await withRetry(() => readCurveAtBlock(factory, tokenAddress, blockNumber));
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

  return {
    virtualUsdcReserves: curve.virtualUsdcReserves.toString(),
    virtualTokenReserves: curve.virtualTokenReserves.toString(),
  };
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

  // ⚠ RESERVES ARE READ BEFORE THE INSERT, NOT AFTER (migration 004) -- AND AT THIS LOG'S
  // BLOCK, NOT AT LATEST.
  //
  // This used to insert the trade and then refresh reserves. The order matters now: the
  // trade row carries the POST-TRADE curve state, and that is what the candle chart
  // plots. `tokens` holds only the latest processed reserves, so the instant a second
  // trade lands the state at the first is unrecoverable.
  //
  // The block matters as much as the order. Read at latest, the "post-trade" state was
  // whatever the curve said when the indexer got here: after any later trade in the same
  // poll, or hours later in a catch-up (see readCurveAtBlock). Pinned to log.blockNumber it
  // is the state at the end of this trade's block, which is exact unless another trade on
  // this token shares that block.
  //
  // Reordering costs nothing -- it is the same single read either way -- and refreshing
  // `tokens` first is safe on a retry because that write is idempotent: the same block gives
  // the same state however many times it runs.
  const reserves = await updateReservesFromChain(tokenAddress, log.blockNumber);

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
    // migration 004. The curve state AFTER this trade. The chart derives mid-price from
    // these -- never from usdc_amount/token_amount, which is execution price INCLUDING
    // the snipe tax and would draw a 5.3x sawtooth that is the fee schedule, not the
    // market. See the migration's header.
    virtual_usdc_reserves: reserves.virtualUsdcReserves,
    virtual_token_reserves: reserves.virtualTokenReserves,
  });
  if (error) throw error;

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

// ⚠ THE LIVENESS RULE NOW LIVES IN ./liveness.js, AND THAT IS THE POINT. The polling loop
// below, the /health endpoint and the outbound heartbeat all have to answer the same
// question, and three copies of the answer is a guarantee they drift. It is re-exported at
// the bottom of this file so scripts/verify-liveness.js imports from where it always did.
const {
  livenessVerdict,
  MAX_HEAD_LAG_BLOCKS,
  MAX_LIVENESS_STRIKES,
} = require("./liveness");

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
  // ⚠ STARTED BEFORE catchUp(), NOT AFTER. A fresh host can have hours of historical
  // backfill ahead of it, and catchUp() does not return until it is done. Starting the
  // endpoint afterwards would leave the platform health check unanswered for that whole
  // window and it would kill the machine mid-backfill, forever, in a loop.
  //
  // During backfill /health correctly reports UNHEALTHY (the checkpoint really is far
  // behind the head) -- which is why the deploy runbook says to widen the platform grace
  // period for a first deploy rather than to weaken the threshold.
  startHealthServer({ supabase, provider, getLastProcessedBlock });
  startHeartbeat({ supabase, provider, getLastProcessedBlock });

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
  // Exported for scripts/verify-trade-reserves.js: the pinned read and the retry
  // classification it depends on, both provable without a chain.
  readCurveAtBlock,
  retryReason,
  transportFailure,
  withRetry,
  TRANSPORT_ERROR_CODES,
  // Exported for scripts/verify-liveness.js. The liveness rule is the one piece of this
  // file that can be proved without a chain, so it is exported rather than buried.
  livenessVerdict,
  MAX_HEAD_LAG_BLOCKS,
  MAX_LIVENESS_STRIKES,
  MAX_CONSECUTIVE_POLL_FAILURES,
};
