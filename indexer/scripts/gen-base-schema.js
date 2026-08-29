// Generates indexer/migrations/000_base_schema.sql by introspecting the LIVE database
// through PostgREST's OpenAPI document.
//
// WHY: the base tables were created out of band, in the Supabase dashboard, and existed
// nowhere in the repo. Migrations 001 and 002 are ALTER TABLE statements against tables
// nothing could recreate. The project has already paused on us once; if it were lost, the
// schema went with it.
//
// ⚠ READ THE LIMITS. This is reconstructed from PostgREST's view of the schema, which is
// the best a service-role key can reach -- it is NOT pg_dump. It captures columns, types,
// NOT NULL and primary keys. It does NOT capture:
//
//   * indexes            * CHECK constraints        * column DEFAULTs
//   * triggers           * RLS policies and grants  * sequences / identity
//   * foreign keys beyond what PostgREST annotates
//   * the body of the tokens_with_volume VIEW
//
// So treat this as "enough to stand the indexer back up", not "an authoritative backup".
// The authoritative route is `pg_dump --schema-only` with the database password, which
// this key cannot do. That gap is stated in the generated file too, so nobody mistakes it.
//
//   node indexer/scripts/gen-base-schema.js
require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });
const fs = require("fs");
const path = require("path");

const URL = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const OUT = path.join(__dirname, "..", "migrations", "000_base_schema.sql");

// PostgREST's OpenAPI `format` is the real Postgres type.
const TYPE = (f) => ({
  text: "text", integer: "integer", bigint: "bigint", numeric: "numeric",
  boolean: "boolean", "timestamp with time zone": "timestamptz",
  "timestamp without time zone": "timestamp", uuid: "uuid", json: "json", jsonb: "jsonb",
  "double precision": "double precision", smallint: "smallint", real: "real", date: "date",
}[f] || f);


// ─────────────────────────────────────────────────────────────────────────────
// HAND-MAINTAINED. PostgREST exposes a view's COLUMNS but not the SELECT behind it, so
// this cannot be introspected -- it is carried here verbatim so regeneration preserves it.
// If the view changes in the database, update this constant.
const VIEW_BLOCK = `
-- ═══ tokens_with_volume ══════════════════════════════════════════════════
--
-- SECURITY INVOKER, deliberately, and this is the part to not "fix" back.
--
-- Postgres creates views SECURITY DEFINER by default: the view runs with its OWNER's
-- permissions and BYPASSES row-level security on the tables underneath. Supabase's linter
-- flags that, correctly -- it means an anon caller reads through the view whatever the
-- owner could read, regardless of any policy meant to constrain them.
--
-- Everything this view exposes is public on-chain data or derived from it:
--
--   contract_address, chain_id, creator_address, name, symbol, metadata_uri
--                            -- from the TokenCreated event
--   buy/sell_fee_bps, graduation_threshold_usdc, all four reserve columns, graduated
--                            -- from curves() on the factory
--   description, logo_url    -- fetched from the creator's own public metadata URI
--   verification_status      -- an operator-set display flag; a public claim, not a secret
--   volume_1h_usdc           -- an aggregate over trades, all of which are public transfers
--
-- Note what it does NOT expose: trades.trader_address never leaves the subquery, because
-- the join aggregates it away. Individual wallet activity is not surfaced here even though
-- it is public on chain.
--
-- So there is nothing that RLS needs to protect, and SECURITY INVOKER is the honest
-- setting: the querying role's own permissions apply, and the view stops being a hole
-- around whatever policies exist now or are added later.
--
-- ⚠ SWITCHING TO INVOKER CAN SILENTLY EMPTY THE VIEW. Under INVOKER the caller needs its
-- own SELECT rights on public.tokens and public.trades. If anon does not have them -- or
-- RLS is enabled with no permissive policy -- the view returns ZERO ROWS and raises no
-- error. The frontend shows an empty token list and nothing looks broken. The grants and
-- policies below exist to prevent exactly that, and MUST be verified with a real anon key
-- after applying: see the check at the end of this file.

DROP VIEW IF EXISTS public.tokens_with_volume;

CREATE VIEW public.tokens_with_volume
WITH (security_invoker = true) AS
SELECT t.contract_address,
    t.chain_id,
    t.creator_address,
    t.name,
    t.symbol,
    t.metadata_uri,
    t.description,
    t.logo_url,
    t.buy_fee_bps,
    t.sell_fee_bps,
    t.graduation_threshold_usdc,
    t.real_usdc_reserves,
    t.token_reserves,
    t.virtual_usdc_reserves,
    t.virtual_token_reserves,
    t.graduated,
    t.graduated_at,
    t.verification_status,
    t.created_at,
    COALESCE(v.volume_1h_usdc, 0::numeric) AS volume_1h_usdc,
    -- APPENDED. The original view predates migrations 001 and 002 and omitted these, so a
    -- frontend reading the view could not show the curve state or the creator's launch
    -- purchase. The creator disclosure is a HARD requirement -- FRONTEND_BUILD_V2 and
    -- CLAUDE.md 7A both state the 2.5% cap limits only the privileged path and does not cap
    -- total creator holdings, which makes disclosure the actual protection.
    t.state,
    t.creator_launch_purchased,
    t.creator_launch_bps,
    t.lp_recipient
   FROM public.tokens t
     LEFT JOIN ( SELECT trades.token_address,
            sum(trades.usdc_amount) / 1000000.0 AS volume_1h_usdc
           FROM public.trades
          WHERE trades.created_at > (now() - '01:00:00'::interval)
          GROUP BY trades.token_address) v ON v.token_address = t.contract_address;

-- Public read, explicitly. The data is public; say so in policy rather than relying on a
-- definer view to smuggle it past RLS.
ALTER TABLE public.tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.trades ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tokens_public_read ON public.tokens;
CREATE POLICY tokens_public_read ON public.tokens FOR SELECT TO anon, authenticated USING (true);

DROP POLICY IF EXISTS trades_public_read ON public.trades;
CREATE POLICY trades_public_read ON public.trades FOR SELECT TO anon, authenticated USING (true);

-- No INSERT/UPDATE/DELETE policy for anon or authenticated: writes stay with the
-- service-role key, which bypasses RLS. A browser must never be able to write here.
--
-- REVOKE as well as omitting the policy, because those are two independent barriers and
-- only one of them was actually in place. Measured with the anon key: INSERT returned 401
-- (no grant) but DELETE and UPDATE returned 204 -- meaning anon HOLDS those privileges and
-- nothing but the absence of an RLS policy was stopping them. One accidental permissive
-- policy, or one \`ALTER TABLE ... DISABLE ROW LEVEL SECURITY\`, and a browser could empty
-- the table. Supabase grants broadly to anon by default; GRANT SELECT adds to that, it
-- does not replace it.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.tokens, public.trades FROM anon, authenticated;
GRANT SELECT ON public.tokens, public.trades, public.tokens_with_volume TO anon, authenticated;

-- indexer_state is operational bookkeeping with no reason to be public.
ALTER TABLE public.indexer_state ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.indexer_state FROM anon, authenticated;

-- ═══ VERIFY WITH AN ANON KEY, NOT THE SERVICE KEY ════════════════════════
-- The service-role key bypasses RLS, so it CANNOT detect a broken policy -- it will return
-- rows either way. Run this from a browser or curl with the project's ANON key:
--
--   curl -s "$SUPABASE_URL/rest/v1/tokens_with_volume?select=symbol,volume_1h_usdc" \\
--        -H "apikey: $SUPABASE_ANON_KEY"
--
-- Expect the token rows. An empty array means anon cannot read the underlying tables and
-- the frontend will show an empty list with no error.
`;

(async () => {
  if (!URL || !KEY) { console.error("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set"); process.exit(1); }
  const r = await fetch(`${URL}/rest/v1/`, { headers: { apikey: KEY, Authorization: `Bearer ${KEY}` } });
  const spec = await r.json();
  const defs = spec.definitions || spec.components?.schemas || {};

  // Only the tables the indexer actually depends on. tokens_with_volume is a VIEW and
  // cannot be reconstructed from this document -- recorded as a gap, not guessed at.
  const TABLES = ["tokens", "trades", "indexer_state"];
  const VIEWS = Object.keys(defs).filter((n) => !TABLES.includes(n));

  let sql = `-- 000_base_schema.sql — GENERATED by indexer/scripts/gen-base-schema.js
-- Introspected from the live database on ${new Date().toISOString().slice(0, 10)}.
--
-- Run this FIRST on an empty project, then 001, then 002. Together they stand the indexer
-- back up from nothing. Before this file existed, the base tables lived only in the hosted
-- project — migrations 001 and 002 are ALTER TABLE statements against tables the repo could
-- not create, so losing the project meant losing the schema.
--
-- ⚠ WHAT THIS DOES NOT CAPTURE. It is reconstructed from PostgREST's OpenAPI document,
-- which is the most a service-role key can see. It is NOT pg_dump. Missing:
--
--     indexes · CHECK constraints · triggers · sequences and identity · foreign keys
--
-- Two exceptions, both handled below and both LABELLED where they appear:
--   * column DEFAULTs are absent from the document, so the two that matter are INFERRED
--     from observed behaviour (trades.id, tokens.verification_status);
--   * the tokens_with_volume VIEW, its RLS policies and its grants cannot be introspected
--     at all, so they are hand-maintained in this generator and emitted verbatim.
--
-- For a real backup use \`pg_dump --schema-only\` with the database password. This key
-- cannot do that, which is exactly why this file is a floor and not a ceiling.
--
-- Idempotent: CREATE TABLE IF NOT EXISTS, so it is safe against a populated database.

BEGIN;
`;

  for (const t of TABLES) {
    const d = defs[t];
    if (!d) { sql += `\n-- ⚠ ${t}: not present in the API document at generation time\n`; continue; }
    const props = d.properties || {};
    const required = new Set(d.required || []);
    const cols = Object.keys(props);
    const pk = cols.filter((c) => /<pk\/>/.test(props[c].description || ""));

    sql += `\n-- ${t} — ${cols.length} columns${pk.length ? `, primary key (${pk.join(", ")})` : ", NO PRIMARY KEY DETECTED"}\n`;
    sql += `CREATE TABLE IF NOT EXISTS public.${t} (\n`;
    const lines = cols.map((c) => {
      const type = TYPE(props[c].format);
      const notNull = required.has(c) ? " NOT NULL" : "";
      // DEFAULTs are not in the OpenAPI document, and one of them is load-bearing: the
      // indexer inserts into trades WITHOUT supplying id, so the live column must default
      // server-side. Emitting the column without a default produces a schema that looks
      // right and rejects every insert. Inferred, and labelled as inferred.
      // The note goes on its OWN line above the column, never trailing it: a trailing
      // `-- comment` swallows the comma that separates this column from the next, and the
      // result is a file that looks right and fails to parse.
      // DEFAULTs are absent from the OpenAPI document, and two of them are load-bearing.
      // Both are INFERRED from observed behaviour and labelled as such, never presented as
      // read from the API.
      const INFERRED_DEFAULTS = {
        // The indexer inserts into trades without supplying id, so it must default.
        "trades.id": {
          value: "gen_random_uuid()",
          why: "the indexer inserts without supplying id, so the live column must default server-side",
        },
        // Nothing writes verification_status -- not the indexer, not any script -- yet every
        // live row reads 'unverified'. So the live column carries this default. The frontend
        // branches on it (a checkmark badge), so a rebuilt schema without it would leave the
        // column NULL and silently change what every token page displays.
        "tokens.verification_status": {
          value: "'unverified'",
          why: "nothing writes this column yet every live row reads 'unverified'; the frontend branches on it",
        },
      };
      const inferred = (type === "uuid" && pk.includes(c) && required.has(c))
        ? INFERRED_DEFAULTS["trades.id"]
        : INFERRED_DEFAULTS[`${t}.${c}`];
      const note = inferred
        ? `  -- DEFAULT below is INFERRED, not read from the API:\n  -- ${inferred.why}.\n`
        : "";
      const dflt = inferred ? ` DEFAULT ${inferred.value}` : "";
      return `${note}  ${c.padEnd(28)} ${type}${notNull}${dflt}`;
    });
    if (pk.length) lines.push(`  PRIMARY KEY (${pk.join(", ")})`);
    sql += lines.join(",\n") + "\n);\n";
  }

  sql += `\nCOMMIT;\n\n-- Run 001_add_token_state.sql and 002_add_creator_launch_disclosure.sql BEFORE the view\n-- below, which selects columns those migrations add.\n`;
  sql += VIEW_BLOCK;
  const unhandled = VIEWS.filter((v) => v !== "tokens_with_volume");
  if (unhandled.length) {
    sql += `\n-- STILL MISSING: ${unhandled.join(", ")}. The API document describes the columns but\n`;
    sql += `-- not the SELECT. Recover from the dashboard or a pg_dump and add here.\n`;
  }

  fs.writeFileSync(OUT, sql);
  console.log(`wrote ${path.relative(path.join(__dirname, "..", ".."), OUT)}`);
  console.log(`  tables reconstructed: ${TABLES.join(", ")}`);
  const unhandledViews = VIEWS.filter((v) => v !== "tokens_with_volume");
  console.log(`  views emitted (hand-maintained): tokens_with_volume, SECURITY INVOKER`);
  if (unhandledViews.length) console.log(`  views NOT reconstructed: ${unhandledViews.join(", ")}`);
})().catch((e) => { console.error("generation failed:", e.message); process.exit(1); });
