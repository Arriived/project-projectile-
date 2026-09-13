// Verifies the RLS posture with an ANON key, which is the only key that can.
//
// The service-role key BYPASSES RLS, so it returns rows whether or not the policies work
// and cannot detect a broken one. This must be run with the anon key:
//
//   SUPABASE_ANON_KEY=eyJ... node indexer/scripts/verify-anon-access.js
//
// ⚠ THE LESSON THIS SCRIPT ENCODES. A first version judged the destructive checks by HTTP
// status and reported "DELETE ALLOWED — SERIOUS". It was wrong: PostgREST returns 204 for a
// DELETE that matched ZERO rows, which is exactly what RLS produces when no DELETE policy
// exists. Nothing had been deleted. A status code cannot tell "refused" from "allowed but
// matched nothing", so every destructive check here compares the row count BEFORE and
// AFTER and judges on that. Status is printed as detail only.
require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });

const URL = process.env.SUPABASE_URL;
const ANON = process.env.SUPABASE_ANON_KEY;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!URL || !ANON) {
  console.error("Set SUPABASE_ANON_KEY (and SUPABASE_URL in indexer/.env).");
  console.error("The anon key is public by design — it is what the browser ships with.");
  process.exit(1);
}

const anonH = { apikey: ANON, Authorization: `Bearer ${ANON}` };
const svcH = { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` };

const results = [];
const check = (label, pass, detail = "") => {
  results.push({ label, pass });
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${label}${detail ? `  — ${detail}` : ""}`);
};

// Ground truth, read with the service key so RLS cannot hide anything from the check.
async function trueCount(table) {
  if (!SERVICE) return null;
  const r = await fetch(`${URL}/rest/v1/${table}?select=*&limit=1`, {
    headers: { ...svcH, Prefer: "count=exact", Range: "0-0" },
  });
  const cr = r.headers.get("content-range");
  return cr ? Number(cr.split("/")[1]) : null;
}

(async () => {
  console.log("=== anon CAN read public data ===");
  for (const t of ["tokens_with_volume", "token_candles_1s", "tokens", "trades"]) {
    const r = await fetch(`${URL}/rest/v1/${t}?select=*&limit=100`, { headers: anonH });
    const b = await r.json().catch(() => null);
    const n = Array.isArray(b) ? b.length : -1;
    check(`${t} readable and non-empty`, r.ok && n > 0,
      `HTTP ${r.status}, rows=${n}${n === 0 ? " — an empty array here means the policies did not take" : ""}`);
  }

  console.log("\n=== the view carries the columns the frontend needs ===");
  const r = await fetch(`${URL}/rest/v1/tokens_with_volume?select=symbol,state,creator_launch_bps,volume_1h_usdc&limit=1`, { headers: anonH });
  const row = (await r.json())[0] || {};
  check("view exposes state (migration 001)", "state" in row, JSON.stringify(row.state));
  check("view exposes creator_launch_bps (migration 002)", "creator_launch_bps" in row,
    "the creator disclosure the frontend is required to show");
  check("view exposes volume_1h_usdc", "volume_1h_usdc" in row, String(row.volume_1h_usdc));

  console.log("\n=== anon CANNOT read operational bookkeeping ===");
  const s = await fetch(`${URL}/rest/v1/indexer_state?select=*`, { headers: anonH });
  const sb = await s.json().catch(() => null);
  check("indexer_state not readable by anon",
    !s.ok || (Array.isArray(sb) && sb.length === 0), `HTTP ${s.status}`);

  console.log("\n=== anon CANNOT write — judged by row counts, not status codes ===");
  const beforeTokens = await trueCount("tokens");
  const beforeTrades = await trueCount("trades");

  const ins = await fetch(`${URL}/rest/v1/tokens`, {
    method: "POST", headers: { ...anonH, "Content-Type": "application/json" },
    body: JSON.stringify({
      contract_address: "0x" + "1".repeat(40), chain_id: 5042002,
      creator_address: "0x" + "2".repeat(40), name: "rls-probe", symbol: "RLSPROBE",
      metadata_uri: "", buy_fee_bps: 1, sell_fee_bps: 1, graduation_threshold_usdc: 1,
      real_usdc_reserves: 0, token_reserves: 0, virtual_usdc_reserves: 1,
      virtual_token_reserves: 1, graduated: false,
    }),
  });
  const afterInsert = await trueCount("tokens");
  check("INSERT did not add a row", afterInsert === beforeTokens,
    `HTTP ${ins.status}, ${beforeTokens} -> ${afterInsert}`);

  const del = await fetch(`${URL}/rest/v1/tokens?contract_address=neq.0xZZZ`, { method: "DELETE", headers: anonH });
  const afterDelete = await trueCount("tokens");
  check("DELETE did not remove any row", afterDelete === beforeTokens,
    `HTTP ${del.status} (204 here means "matched nothing", not "allowed"), ${beforeTokens} -> ${afterDelete}`);

  const upd = await fetch(`${URL}/rest/v1/tokens?contract_address=neq.0xZZZ`, {
    method: "PATCH", headers: { ...anonH, "Content-Type": "application/json" },
    body: JSON.stringify({ verification_status: "verified" }),
  });
  const verified = await fetch(`${URL}/rest/v1/tokens?select=verification_status&verification_status=eq.verified`, { headers: svcH });
  const nVerified = (await verified.json().catch(() => [])).length;
  check("UPDATE did not change any row", nVerified === 0,
    `HTTP ${upd.status}, rows now marked verified: ${nVerified}`);

  const delTrades = await fetch(`${URL}/rest/v1/trades?id=neq.00000000-0000-0000-0000-000000000000`, { method: "DELETE", headers: anonH });
  const afterTrades = await trueCount("trades");
  check("DELETE on trades did not remove any row", afterTrades === beforeTrades,
    `HTTP ${delTrades.status}, ${beforeTrades} -> ${afterTrades}`);

  const failed = results.filter((x) => !x.pass);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) { failed.forEach((f) => console.log("  FAILED: " + f.label)); process.exit(1); }
})().catch((e) => { console.error("verification failed:", e.message); process.exit(1); });
