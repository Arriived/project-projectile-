// Asserts the Arc chain definition against the live chain and against Arc's docs.
//
// This exists because src/chain.ts is the highest-risk config in the build and every
// way it can be wrong is SILENT. A wrong `nativeCurrency.decimals` misprices gas by
// 10^12 and renders a confident wrong number; a wrong chain-id hex produces a
// wallet_addEthereumChain call for a chain that does not exist. Neither throws.
//
// FRONTEND_BUILD_V2 rule 8 carried `0x4CEDB2` -- 5041586, 416 chains from Arc -- for an
// unknown length of time because nothing checked it. This is the thing that checks it.
//
// Run: npm run verify:chain     (from app/)
//
// To prove it can go red: change LAUNCH_TOKEN_DECIMALS to 6 in src/chain.ts, or point
// rpcUrls at the .network host, and re-run. Each assertion below fails independently.

import { createPublicClient, http, formatGwei, getAddress } from "viem";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { stripComments } from "./lib/strip-comments.mts";
import {
  arc,
  ARC_CHAIN_ID_HEX,
  MIN_BASE_FEE_WEI,
  PRIORITY_FEE_WEI,
  writeFees,
  LAUNCH_TOKEN_DECIMALS,
  USDC_ERC20_DECIMALS,
  USDC_NATIVE_DECIMALS,
} from "../src/chain.ts";
import { FACTORY_ADDRESS, USDC_ADDRESS } from "../src/config.ts";

const results: { label: string; pass: boolean; detail: string }[] = [];
const check = (label: string, pass: boolean, detail = "") =>
  results.push({ label, pass, detail });

const client = createPublicClient({ chain: arc, transport: http() });

// ── Identity ───────────────────────────────────────────────────────────────────
const liveChainId = await client.getChainId();
check("chain.id matches live eth_chainId", liveChainId === arc.id, `${arc.id} vs ${liveChainId}`);
check(
  "ARC_CHAIN_ID_HEX is derived and correct",
  parseInt(ARC_CHAIN_ID_HEX, 16) === liveChainId,
  `${ARC_CHAIN_ID_HEX} = ${parseInt(ARC_CHAIN_ID_HEX, 16)}`
);

// ── Decimals: the field that fails silently ────────────────────────────────────
// Source: /integrate/wallets/add-arc-to-a-wallet EIP-3085 params.
check(
  "nativeCurrency.decimals is 18",
  arc.nativeCurrency.decimals === 18,
  `got ${arc.nativeCurrency.decimals}`
);
check("nativeCurrency.symbol is USDC", arc.nativeCurrency.symbol === "USDC", arc.nativeCurrency.symbol);
check("USDC_NATIVE_DECIMALS is 18", USDC_NATIVE_DECIMALS === 18, String(USDC_NATIVE_DECIMALS));

// These two are read off the chain, not asserted from the source, because the whole
// point of trap 4 is that the source is easy to misread.
const usdcDecimals = await client.readContract({
  address: USDC_ADDRESS,
  abi: [{ type: "function", name: "decimals", inputs: [], outputs: [{ type: "uint8" }], stateMutability: "view" }],
  functionName: "decimals",
});
check(
  "USDC ERC-20 decimals() on chain is 6, matching USDC_ERC20_DECIMALS",
  Number(usdcDecimals) === USDC_ERC20_DECIMALS,
  `chain says ${usdcDecimals}, config says ${USDC_ERC20_DECIMALS}`
);

// A launch token, read live. Any token from this factory has the same bytecode.
const KNOWN_TOKEN = "0x2b4a6568e24679b38Cec48971F57318C13ac6C52" as const;
const tokenDecimals = await client.readContract({
  address: KNOWN_TOKEN,
  abi: [{ type: "function", name: "decimals", inputs: [], outputs: [{ type: "uint8" }], stateMutability: "view" }],
  functionName: "decimals",
});
check(
  "launch token decimals() on chain is 18, matching LAUNCH_TOKEN_DECIMALS",
  Number(tokenDecimals) === LAUNCH_TOKEN_DECIMALS,
  `chain says ${tokenDecimals}, config says ${LAUNCH_TOKEN_DECIMALS}`
);

// ── Transport ──────────────────────────────────────────────────────────────────
check(
  "RPC is the documented host (rpc.testnet.arc.io)",
  arc.rpcUrls.default.http[0] === "https://rpc.testnet.arc.io",
  arc.rpcUrls.default.http[0]
);

// ── multicall3: viem claims it, so verify it ───────────────────────────────────
const mc = arc.contracts?.multicall3?.address;
const mcCode = mc ? await client.getCode({ address: getAddress(mc) }) : undefined;
check(
  "multicall3 has code at the address viem claims",
  !!mcCode && mcCode !== "0x",
  mc ? `${mc} -> ${mcCode && mcCode !== "0x" ? (mcCode.length - 2) / 2 + " bytes" : "NO CODE"}` : "not declared"
);

// ── The fee floor ──────────────────────────────────────────────────────────────
// Source: /arc/references/gas-and-fees -- below 20 Gwei "may remain pending indefinitely".
const fees = await client.estimateFeesPerGas();
check(
  "estimateFeesPerGas is at or above the 20 Gwei floor",
  fees.maxFeePerGas >= MIN_BASE_FEE_WEI,
  `maxFeePerGas ${formatGwei(fees.maxFeePerGas)} Gwei, tip ${formatGwei(fees.maxPriorityFeePerGas ?? 0n)} Gwei`
);

// ── The factory is actually there ──────────────────────────────────────────────
const factoryCode = await client.getCode({ address: FACTORY_ADDRESS });
check(
  "factory has code (24,033 bytes, frozen)",
  !!factoryCode && factoryCode !== "0x",
  factoryCode ? `${(factoryCode.length - 2) / 2} bytes` : "NO CODE"
);


// ── WHAT IS ACTUALLY SENT ──────────────────────────────────────────────────────
//
// ⚠ THE CHECK ABOVE READS THE ESTIMATOR, NOT THE TRANSACTION, AND THAT DISTINCTION IS
// THE WHOLE REASON THIS SECTION EXISTS. `estimateFeesPerGas` is chain.ts's override, and
// for a wallet write viem NEVER CALLS IT: sendTransaction branches at
// actions/wallet/sendTransaction.js:92 on `account?.type === 'json-rpc'`, builds the
// request from the passed parameters only, and calls eth_sendTransaction at :126-131.
// `prepareTransactionRequest`, which is what would apply the override, is reached only
// inside `if (account?.type === 'local')` at :165. Every injected and WalletConnect
// account is json-rpc.
//
// So for a long time the suite asserted a floor that held for the arithmetic and not for
// a single user transaction, and it went green throughout. These checks assert the thing
// that reaches the wire.

const FLOOR = MIN_BASE_FEE_WEI + PRIORITY_FEE_WEI;

// ⚠ THE UNDEFINED CASE IS THE ONE THAT MATTERS. useFees() is async and returns undefined
// until it resolves, and `maxFeePerGas: undefined` is indistinguishable to viem from not
// passing the field at all -- so a naive `...{ maxFeePerGas }` would reintroduce the bug
// on precisely the first click after a page load.
check(
  "writeFees(undefined) still floors -- an unresolved estimate cannot send nothing",
  writeFees(undefined).maxFeePerGas >= MIN_BASE_FEE_WEI,
  `${formatGwei(writeFees(undefined).maxFeePerGas)} Gwei`
);
check(
  "writeFees() raises a below-floor estimate to the floor",
  writeFees(1n).maxFeePerGas === FLOOR,
  `1 wei in -> ${formatGwei(writeFees(1n).maxFeePerGas)} Gwei out`
);
check(
  "writeFees() passes an above-floor estimate through untouched",
  writeFees(FLOOR + 12_345n).maxFeePerGas === FLOOR + 12_345n,
  `${formatGwei(FLOOR + 12_345n)} Gwei preserved`
);
check(
  "writeFees() always sets the priority tip",
  writeFees(undefined).maxPriorityFeePerGas === PRIORITY_FEE_WEI &&
    writeFees(FLOOR * 2n).maxPriorityFeePerGas === PRIORITY_FEE_WEI,
  `${formatGwei(PRIORITY_FEE_WEI)} Gwei`
);

// ⚠ AND THE STRUCTURAL ONE: every write call site must actually pass it.
//
// The unit checks above prove writeFees() is correct; they say nothing about whether it
// is USED. A call site added later without it is silent -- the transaction is accepted by
// the wallet, priced by the wallet, and if the wallet lowballs it the transaction is
// never mined and never errors. This walks the real source instead.
//
// Comments are stripped first (§11.7's self-matching trap: verify:claims once matched its
// own explanatory prose, and a comment mentioning writeFees must not satisfy a check that
// the code calls it).
function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...tsFiles(full));
    else if (/\.(ts|tsx)$/.test(entry)) out.push(full);
  }
  return out;
}

/** Body of the object literal opened at `from`, by brace matching. */
function objectBody(src: string, from: number): string {
  let depth = 0;
  for (let i = from; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) return src.slice(from, i + 1);
    }
  }
  return src.slice(from);
}

const writeSites: { file: string; index: number; hasFees: boolean }[] = [];
for (const file of tsFiles("src")) {
  const src = stripComments(readFileSync(file, "utf8"));
  const re = /\bwriteContract(?:Async)?\s*\(\s*\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    const open = src.indexOf("{", m.index + m[0].length - 1);
    const body = objectBody(src, open);
    writeSites.push({
      file: file.replace(/\\/g, "/"),
      index: m.index,
      hasFees: /writeFees\s*\(/.test(body),
    });
  }
}

const missing = writeSites.filter((w) => !w.hasFees);
check(
  "every writeContract call site passes writeFees()",
  writeSites.length > 0 && missing.length === 0,
  writeSites.length === 0
    ? "NO CALL SITES FOUND -- the scan is broken, not the code"
    : missing.length
      ? `missing at: ${missing.map((w) => w.file).join(", ")}`
      : `${writeSites.length} call sites, all floored`
);

// ⚠ A scan that finds nothing must FAIL, not pass. If the regex stops matching -- viem
// renames the action, the call is refactored behind a helper -- `missing.length === 0` is
// trivially true and the check goes green while covering zero call sites. The
// `writeSites.length > 0` conjunct above is what stops that, and this check names it.
check(
  "the call-site scan actually found call sites",
  writeSites.length >= 5,
  `${writeSites.length} found (expected at least the 5 known: 2 in Create, 3 in TradePanel)`
);

// ── Report ─────────────────────────────────────────────────────────────────────
for (const r of results) {
  console.log(`  ${r.pass ? "PASS" : "FAIL"}  ${r.label}${r.detail ? `  — ${r.detail}` : ""}`);
}
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) {
  console.error("\nFAILED:");
  failed.forEach((f) => console.error("  " + f.label));
  // ⚠ process.exitCode, NOT process.exit(). process.exit() tears the event loop down
  // while the console.log lines above may still be flushing, and on Windows that races
  // libuv into "Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)" and an exit code
  // of 127 -- a GREEN suite reported as a failed build, intermittently. Measured before
  // the fix: verify:slippage 0/127/127/127/127/0, verify:upload 0/127/0/0/0/127.
  // A gate that fails randomly trains a human to re-run until green, which is how a real
  // failure gets dismissed under pressure. Setting exitCode lets node exit naturally once
  // stdout has drained.
  process.exitCode = 1;
}
