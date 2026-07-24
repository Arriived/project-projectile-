require("dotenv").config();
const { ethers } = require("ethers");
const { createClient } = require("@supabase/supabase-js");
const factoryAbi = require("./factoryAbi");
const { fetchAndSanitizeMetadata } = require("./metadata");
const { getLastProcessedBlock, saveCheckpoint } = require("./recovery");

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

const CHUNK_SIZE = 2000; // blocks per historical getLogs call — conservative default,
// tune up or down depending on what Arc's RPC provider actually allows before erroring.

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
const provider = FACTORY_RPC_URL.startsWith("ws")
  ? new ethers.WebSocketProvider(FACTORY_RPC_URL)
  : new ethers.JsonRpcProvider(FACTORY_RPC_URL);
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

async function upsertTokenFromChain(tokenAddress) {
  const [curve, token] = await Promise.all([
    factory.curves(tokenAddress),
    Promise.resolve(new ethers.Contract(tokenAddress, ERC20_MIN_ABI, provider)),
  ]);
  const [name, symbol, creator, metadataURI] = await Promise.all([
    token.name(),
    token.symbol(),
    token.creator(),
    token.metadataURI(),
  ]);
  const { description, logoUrl } = await fetchAndSanitizeMetadata(metadataURI);

  const { error } = await supabase.from("tokens").upsert(
    {
      contract_address: tokenAddress,
      chain_id: Number((await provider.getNetwork()).chainId),
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
      graduated: curve.graduated,
    },
    { onConflict: "contract_address" }
  );
  if (error) throw error;
}

async function updateReservesFromChain(tokenAddress) {
  const curve = await factory.curves(tokenAddress);
  const { error } = await supabase
    .from("tokens")
    .update({
      real_usdc_reserves: curve.realUsdcReserves.toString(),
      token_reserves: curve.tokenReserves.toString(),
      virtual_usdc_reserves: curve.virtualUsdcReserves.toString(),
      virtual_token_reserves: curve.virtualTokenReserves.toString(),
      graduated: curve.graduated,
    })
    .eq("contract_address", tokenAddress);
  if (error) throw error;
}

async function handleTokenCreated(log) {
  const tokenAddress = log.args.token;
  try {
    await upsertTokenFromChain(tokenAddress);
    console.log(`[TokenCreated] indexed ${log.args.symbol} at ${tokenAddress}`);
  } catch (err) {
    console.error(`[TokenCreated] failed for ${tokenAddress}:`, err.message);
  }
}

async function handleTrade(log) {
  const tokenAddress = log.args.token;
  try {
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
  } catch (err) {
    console.error(`[Trade] failed for ${tokenAddress}:`, err.message);
  }
}

async function handleGraduated(log) {
  const tokenAddress = log.args.token;
  try {
    const { error } = await supabase
      .from("tokens")
      .update({ graduated: true, graduated_at: new Date().toISOString() })
      .eq("contract_address", tokenAddress);
    if (error) throw error;
    console.log(`[Graduated] ${tokenAddress}`);
  } catch (err) {
    console.error(`[Graduated] failed for ${tokenAddress}:`, err.message);
  }
}

// ── Historical catch-up ─────────────────────────────────────────────────

async function catchUp() {
  const checkpoint = await getLastProcessedBlock(supabase);
  const fromDefault = Number(FACTORY_DEPLOY_BLOCK || 0);
  let from = checkpoint !== null ? checkpoint + 1 : fromDefault;
  const latest = await provider.getBlockNumber();

  console.log(`Catching up from block ${from} to ${latest}...`);

  while (from <= latest) {
    const to = Math.min(from + CHUNK_SIZE - 1, latest);

    const [created, trades, graduations] = await Promise.all([
      factory.queryFilter(factory.filters.TokenCreated(), from, to),
      factory.queryFilter(factory.filters.Trade(), from, to),
      factory.queryFilter(factory.filters.Graduated(), from, to),
    ]);

    const all = [...created, ...trades, ...graduations].sort((a, b) =>
      a.blockNumber !== b.blockNumber ? a.blockNumber - b.blockNumber : a.index - b.index
    );

    for (const log of all) {
      if (log.eventName === "TokenCreated") await handleTokenCreated(log);
      else if (log.eventName === "Trade") await handleTrade(log);
      else if (log.eventName === "Graduated") await handleGraduated(log);
    }

    await saveCheckpoint(supabase, to);
    console.log(`  processed through block ${to} (${all.length} events)`);
    from = to + 1;
  }

  console.log("Caught up. Switching to live mode.");
}

// ── Live mode ───────────────────────────────────────────────────────────

function watchLive() {
  factory.on("TokenCreated", (...args) => handleTokenCreated(args[args.length - 1].log));
  factory.on("Trade", (...args) => handleTrade(args[args.length - 1].log));
  factory.on("Graduated", (...args) => handleGraduated(args[args.length - 1].log));

  // Live events still need their own checkpoint updates so a restart doesn't
  // re-scan from the last historical checkpoint and reprocess everything since.
  provider.on("block", async (blockNumber) => {
    try {
      await saveCheckpoint(supabase, blockNumber);
    } catch (err) {
      console.error("Checkpoint update failed:", err.message);
    }
  });

  console.log(`Watching ${FACTORY_ADDRESS} for new events...`);
}

// ── Entry point ─────────────────────────────────────────────────────────

async function main() {
  await catchUp();
  watchLive();
}

main().catch((err) => {
  console.error("Fatal indexer error:", err);
  process.exit(1);
});
