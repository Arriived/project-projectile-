// Measures ACTUAL gas for buy, sell, approve and createToken on Arc testnet.
//
// WHY. The gas LIMIT and the gas RESERVE are different numbers and must not be derived
// from each other. The old frontend sent a hardcoded 600,000 limit against a buy that
// really consumed 194,372 -- so a reserve sized from the limit withholds roughly 3x what
// the operation needs. On Arc that is not free: gas and settlement are the SAME balance
// (rule 3), so every unit reserved is a unit the user cannot trade with.
//
//   limit   = eth_estimateGas x 1.5   per operation, at send time
//   reserve = worst EXIT cost + margin
//
// The reserve is sized on the EXIT, not the entry. Rule 3's failure was a holder left
// with 471 trillion tokens and 0.0016 USDC who could not afford to sell. And selling is
// TWO transactions for a first-time seller: LFX1.sell() takes the tokens with
// `IERC20(token).safeTransferFrom(msg.sender, ...)` (LFX1.sol:577), so an ERC-20 approve
// must land first. A reserve covering only the sell strands exactly the user it exists
// to protect.
//
// Trade hashes come from the INDEXER, not from eth_getLogs: Arc's public RPC rejects wide
// ranges with `-32012 requested range too large` and then rate-limits the chunked retry
// with "Request exceeds defined limit", which silently produces an INCOMPLETE sample. A
// measurement with unnoticed holes is worse than none. (Worth carrying into trap 19: a
// chain-only fallback cannot issue one wide getLogs.)
//
// Run: npm run measure:gas

import { createPublicClient, http, formatUnits, maxUint256 } from "viem";
import { arc, MIN_BASE_FEE_WEI } from "../src/chain.ts";
import { FACTORY_ADDRESS } from "../src/config.ts";
import { readFileSync } from "node:fs";

const client = createPublicClient({ chain: arc, transport: http() });

// Indexer credentials, read the same way the repo's other scripts do.
const envPath = new URL("../../indexer/.env", import.meta.url);
const env = Object.fromEntries(
  readFileSync(envPath, "utf8")
    .split("\n")
    .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
    })
);
const SUPABASE_URL = env.SUPABASE_URL;
const SERVICE = env.SUPABASE_SERVICE_ROLE_KEY;

type Sample = { kind: string; gasUsed: bigint };
const samples: Sample[] = [];

async function record(kind: string, hash: string) {
  try {
    const r = await client.getTransactionReceipt({ hash: hash as `0x${string}` });
    if (r.status === "success") samples.push({ kind, gasUsed: r.gasUsed });
  } catch {
    /* pruned */
  }
}

// ── real trades, via the indexer ────────────────────────────────────────────────
const res = await fetch(`${SUPABASE_URL}/rest/v1/trades?select=tx_hash,is_buy,token_address,trader_address`, {
  headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` },
});
const trades = (await res.json()) as {
  tx_hash: string;
  is_buy: boolean;
  token_address: string;
  trader_address: string;
}[];
console.log(`${trades.length} indexed trades\n`);
for (const t of trades) await record(t.is_buy ? "buy" : "sell", t.tx_hash);

// ── approve, estimated LIVE against a real token ────────────────────────────────
// No historical approve was recoverable from logs, and this is the number the reserve
// turns on, so it is measured rather than guessed. Estimated from an address whose
// allowance is currently zero, which is the expensive case: a 0 -> non-zero SSTORE.
const erc20Abi = [
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "value", type: "uint256" },
    ],
    outputs: [{ type: "bool" }],
  },
  {
    type: "function",
    name: "allowance",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ type: "uint256" }],
  },
] as const;

const someToken = trades[0]?.token_address as `0x${string}` | undefined;
const someHolder = trades[0]?.trader_address as `0x${string}` | undefined;
let approveGas = 0n;
if (someToken && someHolder) {
  const current = await client.readContract({
    address: someToken,
    abi: erc20Abi,
    functionName: "allowance",
    args: [someHolder, FACTORY_ADDRESS],
  });
  try {
    approveGas = await client.estimateContractGas({
      address: someToken,
      abi: erc20Abi,
      functionName: "approve",
      args: [FACTORY_ADDRESS, maxUint256],
      account: someHolder,
    });
    console.log(
      `approve estimated live on ${someToken.slice(0, 10)}… (current allowance ${current}) = ${approveGas} gas`
    );
    if (current > 0n) {
      console.log(
        "  NOTE: this holder already has an allowance, so this is the CHEAP (non-zero -> non-zero)"
      );
      console.log(
        "  case. A first-time approve writes 0 -> non-zero and costs ~20,000 more. Margin below covers it."
      );
      approveGas += 20_000n;
      console.log(`  adjusted to ${approveGas} for the first-time case`);
    }
  } catch (e) {
    console.log("approve estimate failed:", (e as Error).message.split("\n")[0]);
  }
}
console.log("");

// ── report ──────────────────────────────────────────────────────────────────────
if (samples.length === 0) {
  console.log("NO SAMPLES — cannot size from measurement.");
  process.exit(1);
}

const kinds = [...new Set(samples.map((s) => s.kind))];
const maxByKind = new Map<string, bigint>();
console.log("════ observed gasUsed, from real receipts ════");
for (const k of kinds) {
  const g = samples.filter((s) => s.kind === k).map((s) => s.gasUsed);
  const max = g.reduce((a, b) => (b > a ? b : a), 0n);
  const min = g.reduce((a, b) => (b < a ? b : a), g[0]);
  maxByKind.set(k, max);
  console.log(
    `  ${k.padEnd(8)} n=${String(g.length).padStart(3)}  min ${min.toString().padStart(8)}  max ${max
      .toString()
      .padStart(8)}`
  );
}
console.log(`  ${"approve".padEnd(8)} (live estimate)          ${approveGas.toString().padStart(8)}`);

// createToken is not measured here: it does not affect the EXIT reserve, and estimating
// it live needs a USDC allowance and a fresh economics hash. CLAUDE.md §7B records it
// measured at 1,065,491 with the symbol lock present. Phase 4 sizes its own limit.
console.log("  createToken  not measured (Phase 4); CLAUDE.md §7B records 1,065,491");

const sellMax = maxByKind.get("sell") ?? 0n;
const buyMax = maxByKind.get("buy") ?? 0n;
const exitWorst = sellMax + approveGas;

console.log("\n════ the exit, which is what the reserve is for ════");
console.log(`  worst observed sell        ${sellMax}`);
console.log(`  approve (required first)   ${approveGas}`);
console.log(`  worst exit                 ${exitWorst}`);

// Margin covers a curve in a different state and a first-time-storage sell, not
// estimator error -- the limit multiplier handles that separately.
const reserve = (exitWorst * 15n) / 10n;

console.log("\n════ RECOMMENDATION ════");
console.log(`  GAS LIMIT   = eth_estimateGas x 1.5, per operation, at send time`);
console.log(`  GAS RESERVE = ${reserve} gas units   (worst exit ${exitWorst} + 50%)`);

const block = await client.getBlock();
const baseFee = block.baseFeePerGas ?? MIN_BASE_FEE_WEI;
const fees = await client.estimateFeesPerGas();
const cost = (units: bigint, perGas: bigint) => `${formatUnits(units * perGas, 18)} USDC`;

console.log("\n════ what it withholds from the user, at fees right now ════");
console.log(`  chain baseFeePerGas        ${formatUnits(baseFee, 9)} Gwei`);
console.log(`  our maxFeePerGas (floored) ${formatUnits(fees.maxFeePerGas, 9)} Gwei`);
console.log("");
console.log(`  WITHHELD  ${cost(reserve, fees.maxFeePerGas)}  (reserve priced at maxFeePerGas)`);
console.log(`  likely actual spend        ${cost(exitWorst, baseFee)}`);
console.log("");
console.log("  what the naive alternatives would have withheld:");
console.log(`    the old hardcoded 600k limit   ${cost(600_000n, fees.maxFeePerGas)}`);
console.log(`    1.5x worst BUY (wrong op)      ${cost((buyMax * 15n) / 10n, fees.maxFeePerGas)}`);
console.log("");
console.log(`  The reserve is held in GAS UNITS and priced at send time, so it tracks the`);
console.log(`  fee. At Arc's 20,000 Gwei ceiling the same reserve would withhold`);
console.log(`  ${cost(reserve, 20_000_000_000_000n)} -- which is the number that makes sizing it from a`);
console.log(`  600k limit indefensible.`);
