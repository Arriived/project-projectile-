// Read-only inspection of the Supabase schema the indexer depends on.
// Never prints the service-role key. Run: node indexer/scripts/db-inspect.js
require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });

const URL = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!URL || !KEY) { console.error("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set"); process.exit(1); }

const H = { apikey: KEY, Authorization: `Bearer ${KEY}` };

async function tableExists(name) {
  const r = await fetch(`${URL}/rest/v1/${name}?select=*&limit=0`, { headers: H });
  return { ok: r.ok, status: r.status, body: r.ok ? null : (await r.text()).slice(0, 160) };
}

async function columnExists(table, column) {
  const r = await fetch(`${URL}/rest/v1/${table}?select=${column}&limit=0`, { headers: H });
  return r.ok;
}

async function rowCount(name) {
  const r = await fetch(`${URL}/rest/v1/${name}?select=*&limit=1`, {
    headers: { ...H, Prefer: "count=exact", Range: "0-0" },
  });
  const cr = r.headers.get("content-range");
  return cr ? cr.split("/")[1] : "?";
}

(async () => {
  console.log(`project ${URL.replace(/https:\/\/([^.]+).*/, "$1")}\n`);

  for (const t of ["tokens", "trades", "indexer_state"]) {
    const e = await tableExists(t);
    console.log(`${t.padEnd(15)} ${e.ok ? "EXISTS  rows=" + (await rowCount(t)) : "MISSING (" + e.status + ") " + e.body}`);
  }

  console.log("\nmigration-added columns:");
  const checks = [
    ["001", "tokens", "state"],
    ["002", "tokens", "creator_launch_purchased"],
    ["002", "tokens", "creator_launch_bps"],
  ];
  for (const [mig, t, c] of checks) {
    const ok = await columnExists(t, c);
    console.log(`  ${mig}  ${t}.${c.padEnd(28)} ${ok ? "present" : "ABSENT"}`);
  }
})().catch((e) => { console.error("inspect failed:", e.message); process.exit(1); });
