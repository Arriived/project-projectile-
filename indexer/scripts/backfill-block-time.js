// Backfills trades.block_time and tokens.total_supply for rows written before
// migration 003.
//
// ── WHY THIS IS NEEDED ──────────────────────────────────────────────────────
//
// `trades.created_at` defaults to now() at INSERT, so it records when the indexer SAW a
// trade, not when the trade happened. Measured on 30 August 2026, rows ingested during a
// catch-up carried up to 30.9 hours of drift -- which put 31-hour-old trades inside the
// "last 1 hour" volume window on the live site.
//
// tokens_with_volume filters every window on COALESCE(block_time, created_at), so until
// block_time is populated the windows silently fall back to ingest time. This script is
// what makes 003's windows mean what they say for existing history.
//
// Idempotent: only touches rows where the column is still NULL, so it is safe to re-run
// and safe to run while the indexer is catching up.
//
// Run:  node indexer/scripts/backfill-block-time.js
//       node indexer/scripts/backfill-block-time.js --dry-run
//
// Requires SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, FACTORY_RPC_URL, FACTORY_ADDRESS
// -- the SERVICE key, because this WRITES and anon is correctly refused (verified 11/11
// in verify-anon-access.js).

require("dotenv").config();
const { ethers } = require("ethers");
const { createClient } = require("@supabase/supabase-js");
const factoryAbi = require("../src/generated/lfx1Abi.json");

const DRY_RUN = process.argv.includes("--dry-run");

const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, FACTORY_RPC_URL, FACTORY_ADDRESS } = process.env;
for (const [k, v] of Object.entries({
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  FACTORY_RPC_URL,
  FACTORY_ADDRESS,
})) {
  if (!v) {
    console.error(`Missing required env var: ${k}. Run from indexer/ so dotenv finds .env.`);
    process.exit(1);
  }
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
const provider = new ethers.JsonRpcProvider(FACTORY_RPC_URL, undefined, { batchMaxCount: 1 });
const factory = new ethers.Contract(FACTORY_ADDRESS, factoryAbi, provider);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The public RPC rate-limits, and CLAUDE.md records it stalling 150s at a time under
// load. One block read per distinct block, gently paced.
const PACE_MS = 150;

async function main() {
  console.log(DRY_RUN ? "DRY RUN — nothing will be written.\n" : "");

  // ── 1. trades.block_time ──────────────────────────────────────────────────
  const { data: rows, error } = await supabase
    .from("trades")
    .select("id,block_number")
    .is("block_time", null)
    .order("block_number", { ascending: true });

  if (error) {
    // A 42703 here means migration 003 has not been applied yet.
    console.error(`Could not read trades: ${error.message}`);
    if (String(error.code) === "42703") {
      console.error("The block_time column does not exist. Apply migration 003 first.");
    }
    process.exit(1);
  }

  console.log(`trades needing block_time: ${rows.length}`);

  // Several trades usually share a block, so resolve each distinct block once.
  const distinct = [...new Set(rows.map((r) => Number(r.block_number)))];
  console.log(`distinct blocks to read: ${distinct.length}`);

  const times = new Map();
  for (let i = 0; i < distinct.length; i++) {
    const bn = distinct[i];
    try {
      const block = await provider.getBlock(bn);
      if (block && block.timestamp) {
        times.set(bn, new Date(Number(block.timestamp) * 1000).toISOString());
      } else {
        console.warn(`  [warn] block ${bn} returned no timestamp; leaving NULL`);
      }
    } catch (err) {
      // Left NULL rather than guessed. The view's COALESCE falls back to created_at,
      // which is the documented approximate path -- inventing a timestamp would be
      // worse, because it would look exact.
      console.warn(`  [warn] block ${bn}: ${err.message.slice(0, 80)}; leaving NULL`);
    }
    if ((i + 1) % 25 === 0) console.log(`  read ${i + 1}/${distinct.length} blocks`);
    await sleep(PACE_MS);
  }

  let written = 0;
  let maxDriftH = 0;
  for (const r of rows) {
    const iso = times.get(Number(r.block_number));
    if (!iso) continue;
    if (!DRY_RUN) {
      const { error: uErr } = await supabase
        .from("trades")
        .update({ block_time: iso })
        .eq("id", r.id);
      if (uErr) {
        console.error(`  failed on trade ${r.id}: ${uErr.message}`);
        continue;
      }
    }
    written++;
  }

  // Report the drift this actually corrected, so the fix is measured rather than assumed.
  const { data: check } = await supabase
    .from("trades")
    .select("block_number,created_at,block_time")
    .not("block_time", "is", null)
    .limit(1000);
  for (const c of check ?? []) {
    const h = Math.abs(new Date(c.created_at) - new Date(c.block_time)) / 3600000;
    if (h > maxDriftH) maxDriftH = h;
  }

  console.log(`\ntrades ${DRY_RUN ? "that would be" : ""} updated: ${written}`);
  console.log(`worst created_at vs block_time drift now visible: ${maxDriftH.toFixed(1)} h`);

  // ── 2. tokens.total_supply ────────────────────────────────────────────────
  //
  // ⚠ TOTAL_TOKEN_SUPPLY (1,000,000,000e18), NOT CURVE_TOKEN_SUPPLY (807,000,000e18).
  // The view's market_cap_usdc is computed against this column; substituting the curve
  // supply would change every market cap on the site by a factor of 1000/807.
  const total = (await factory.TOTAL_TOKEN_SUPPLY()).toString();
  console.log(`\nTOTAL_TOKEN_SUPPLY from the contract: ${total}`);

  const { data: needSupply, error: sErr } = await supabase
    .from("tokens")
    .select("contract_address")
    .is("total_supply", null);

  if (sErr) {
    console.error(`Could not read tokens: ${sErr.message}`);
    process.exit(1);
  }
  console.log(`tokens needing total_supply: ${needSupply.length}`);

  if (!DRY_RUN && needSupply.length) {
    for (const t of needSupply) {
      const { error: uErr } = await supabase
        .from("tokens")
        .update({ total_supply: total })
        .eq("contract_address", t.contract_address);
      if (uErr) console.error(`  failed on ${t.contract_address}: ${uErr.message}`);
    }
  }

  console.log(
    `tokens ${DRY_RUN ? "that would be" : ""} updated: ${DRY_RUN ? needSupply.length : needSupply.length}`
  );

  // ── 3. what remains approximate ───────────────────────────────────────────
  const { count: remaining } = await supabase
    .from("trades")
    .select("id", { count: "exact", head: true })
    .is("block_time", null);

  console.log(`\ntrades still without block_time: ${remaining ?? "?"}`);
  if (remaining) {
    console.log(
      "Those tokens' volume windows remain APPROXIMATE (they fall back to ingest time).\n" +
        "The frontend must keep saying so until this reaches zero."
    );
  } else {
    console.log("Every trade now carries a real block timestamp.");
  }
}

main().catch((err) => {
  console.error("Backfill failed:", err);
  process.exit(1);
});
