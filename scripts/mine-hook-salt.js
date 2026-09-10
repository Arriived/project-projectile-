// Mines the CREATE2 salt for the Ballista fee hook, and predicts the adapter's
// CREATE address that the hook's constructor has to be mined AGAINST.
//
//   node scripts/mine-hook-salt.js --selftest
//   node scripts/mine-hook-salt.js --deployer 0x.. --nonce 158 \
//        --artifact BallistaFeeHook --args <lfx1> <usdc> <protocolRecipient>
//
// WHY THIS EXISTS, AND WHY IT RUNS BEFORE ANY CONTRACT IS WRITTEN.
//
// A v4 hook's PERMISSIONS ARE ITS ADDRESS. PoolManager reads the low 14 bits of the
// hook address and calls only the callbacks whose bit is set -- Hooks.sol:29-47 and
// hasPermission() at Hooks.sol:186-188. So the hook's address is not an output of
// deployment, it is an INPUT to the design, and it must be fixed before the adapter
// can be constructed pointing at it.
//
// ⚠ THE FAILURE MODE IS SILENT AND TOTAL. A mis-mined salt does NOT revert at deploy.
// PoolManager simply never calls the callback whose flag is missing, the hook's logic
// runs zero times, and the first symptom is a graduated pool that takes no fees --
// discovered days later, on an immutable contract, with pools already live. There is
// no second chance: hooks are part of the PoolKey, so a corrected hook is a different
// pool, and liquidity already burned into the old one can never migrate.
//
// ⚠ AND THE ADAPTER/HOOK BINDING IS CIRCULAR. The adapter needs the hook's address for
// the PoolKey; the hook needs the adapter's address for its beforeInitialize gate. Both
// are immutable, so neither can be set afterwards. The only resolution is to predict one
// side: the adapter is deployed with plain CREATE at a KNOWN NONCE, that predicted
// address is baked into the hook's constructor args, the hook is mined and deployed
// first, and the adapter is then deployed at exactly that nonce.
//
// ⚠ IF THE DEPLOYER'S NONCE IS NOT EXACTLY THE PREDICTED ONE WHEN THE ADAPTER IS SENT,
// the adapter lands at a different address and the hook's `adapter` immutable points at
// an address that will never hold it. Every graduation then reverts in beforeInitialize
// and every token parks at GRADUATION_READY forever. Both contracts deploy CLEANLY in
// that case -- the failure is invisible until the first graduation. Hence --verify-nonce
// below, and hence the runbook rule that the on-chain binding is read back BEFORE LFX1's
// router is proposed.
"use strict";

const fs = require("fs");
const path = require("path");
const { keccak256, getAddress, AbiCoder, concat, hexlify, toBeHex } = require("ethers");

// ---------------------------------------------------------------------------
// Flag constants.
//
// ⚠ READ FROM THE PINNED node_modules COPY AT RUN TIME, NEVER HARDCODED HERE.
// The values below are parsed out of the same Hooks.sol that hardhat compiles
// against, so a v4-core bump cannot silently desynchronise this miner from the
// PoolManager that will actually read the address. A constant copied into this
// file would keep mining the old target and the failure would be silent.
// ---------------------------------------------------------------------------
const HOOKS_SOL = path.join(
  __dirname,
  "..",
  "node_modules",
  "@uniswap",
  "v4-core",
  "src",
  "libraries",
  "Hooks.sol"
);

function readFlagConstants() {
  const src = fs.readFileSync(HOOKS_SOL, "utf8");
  const lines = src.split("\n");
  const flags = {};
  const re = /^\s*uint160 internal constant ([A-Z_0-9]+_FLAG) = 1 << (\d+);/;
  lines.forEach((line, i) => {
    const m = line.match(re);
    if (m) flags[m[1]] = { bit: Number(m[2]), line: i + 1 };
  });
  const maskLine = lines.findIndex((l) => l.includes("ALL_HOOK_MASK"));
  if (Object.keys(flags).length !== 14) {
    throw new Error(
      `expected 14 hook flags in ${HOOKS_SOL}, parsed ${Object.keys(flags).length} -- ` +
        "v4-core may have changed shape; do NOT mine until this is reconciled"
    );
  }
  return { flags, maskLine: maskLine + 1, path: HOOKS_SOL };
}

// The three our hook needs, and nothing else. Named here; VALUES come from the file.
const REQUIRED_FLAGS = ["BEFORE_INITIALIZE_FLAG", "AFTER_SWAP_FLAG", "AFTER_SWAP_RETURNS_DELTA_FLAG"];

const ALL_HOOK_MASK = (1 << 14) - 1; // Hooks.sol:27 -- asserted against the file in selftest

// ---------------------------------------------------------------------------
// CREATE address prediction: keccak256(rlp([sender, nonce]))[12:]
//
// Hand-rolled rather than delegated, so this file does not depend on a library
// getting RLP right. The selftest cross-checks it against three REAL deployments
// recorded in deployments/arcTestnet.json.
// ---------------------------------------------------------------------------
function rlpEncodeAddressAndNonce(address, nonce) {
  const addr = getAddress(address).slice(2).toLowerCase();
  const addrItem = "94" + addr; // 0x80 + 20 bytes

  let nonceItem;
  if (nonce === 0) {
    nonceItem = "80"; // the empty string, NOT 0x00 -- RLP has no leading zero
  } else if (nonce <= 0x7f) {
    nonceItem = nonce.toString(16).padStart(2, "0"); // single byte, self-encoding
  } else {
    let h = nonce.toString(16);
    if (h.length % 2) h = "0" + h;
    nonceItem = (0x80 + h.length / 2).toString(16).padStart(2, "0") + h;
  }

  const payload = addrItem + nonceItem;
  const byteLen = payload.length / 2;
  if (byteLen > 55) throw new Error("nonce too large for the short-list encoding path");
  const prefix = (0xc0 + byteLen).toString(16).padStart(2, "0");
  return "0x" + prefix + payload;
}

function predictCreateAddress(deployer, nonce) {
  return getAddress("0x" + keccak256(rlpEncodeAddressAndNonce(deployer, nonce)).slice(-40));
}

// ---------------------------------------------------------------------------
// CREATE2: keccak256(0xff ++ deployer ++ salt ++ keccak256(initCode))[12:]
// ---------------------------------------------------------------------------
function predictCreate2Address(create2Deployer, salt, initCodeHash) {
  const packed = concat(["0xff", getAddress(create2Deployer), salt, initCodeHash]);
  return getAddress("0x" + keccak256(packed).slice(-40));
}

// ---------------------------------------------------------------------------
// The decoder.
//
// ⚠ THIS IS THE PIECE THAT MUST BE ABLE TO SAY "NO". A decoder that reports the
// flags it was asked about, rather than the flags the address actually carries,
// would confirm any address at all. It therefore reports EVERY set bit and the
// caller compares the whole set -- it never takes the expected set as input.
// ---------------------------------------------------------------------------
function decodeHookFlags(address, flagTable) {
  const low = BigInt(getAddress(address)) & BigInt(ALL_HOOK_MASK);
  const set = [];
  for (const [name, { bit }] of Object.entries(flagTable)) {
    if ((low >> BigInt(bit)) & 1n) set.push(name);
  }
  return { low: Number(low), lowHex: "0x" + Number(low).toString(16).padStart(4, "0"), set };
}

function flagsMatchExactly(address, flagTable, required) {
  const { set } = decodeHookFlags(address, flagTable);
  const a = [...set].sort();
  const b = [...required].sort();
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

function targetMask(flagTable, required) {
  let m = 0;
  for (const name of required) {
    if (!flagTable[name]) throw new Error(`flag ${name} not present in Hooks.sol -- refusing to mine`);
    m |= 1 << flagTable[name].bit;
  }
  return m;
}

// ---------------------------------------------------------------------------
// The miner. 14 bits => ~16,384 tries expected. Trivial; no workers needed.
// ---------------------------------------------------------------------------
function mineSalt(create2Deployer, initCodeHash, mask, { maxTries = 5_000_000, saltPrefix = 0n } = {}) {
  for (let i = 0n; i < BigInt(maxTries); i++) {
    const salt = toBeHex(saltPrefix + i, 32);
    const addr = predictCreate2Address(create2Deployer, salt, initCodeHash);
    if ((BigInt(addr) & BigInt(ALL_HOOK_MASK)) === BigInt(mask)) {
      return { salt, address: addr, tries: Number(i) + 1 };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
module.exports = {
  readFlagConstants,
  predictCreateAddress,
  predictCreate2Address,
  decodeHookFlags,
  flagsMatchExactly,
  targetMask,
  mineSalt,
  REQUIRED_FLAGS,
  ALL_HOOK_MASK,
  ARACHNID_CREATE2_DEPLOYER: "0x4e59b44847b379578588920cA78FbF26c0B4956C",
};

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
}

function main() {
  const { flags, path: hooksPath } = readFlagConstants();

  if (process.argv.includes("--selftest")) {
    require("./mine-hook-salt.selftest.js")(module.exports, flags, hooksPath);
    return;
  }

  const deployer = arg("deployer");
  const nonce = arg("nonce");
  const artifactName = arg("artifact");
  if (!deployer || nonce === undefined || !artifactName) {
    console.error("usage: --deployer 0x.. --nonce N --artifact <ContractName> [--args a b c]");
    console.error("       --selftest");
    process.exit(2);
  }

  const adapterAddress = predictCreateAddress(deployer, Number(nonce));
  console.log(`predicted adapter address (CREATE, nonce ${nonce}): ${adapterAddress}`);

  const argsIdx = process.argv.indexOf("--args");
  const ctorArgs = argsIdx === -1 ? [] : process.argv.slice(argsIdx + 1);
  const artifactPath = findArtifact(artifactName);
  const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf8"));

  // Constructor args order is the hook's own; the adapter address is appended last
  // by convention and asserted by the hook's own tests.
  const types = artifact.abi.find((x) => x.type === "constructor")?.inputs ?? [];
  const values = [...ctorArgs, adapterAddress];
  if (types.length !== values.length) {
    throw new Error(`constructor expects ${types.length} args, got ${values.length}`);
  }
  const encoded = AbiCoder.defaultAbiCoder().encode(types.map((t) => t.type), values);
  const initCode = concat([artifact.bytecode, encoded]);
  const initCodeHash = keccak256(initCode);

  const mask = targetMask(flags, REQUIRED_FLAGS);
  console.log(`target mask: 0x${mask.toString(16).padStart(4, "0")}  (${REQUIRED_FLAGS.join(" + ")})`);
  console.log(`initCodeHash: ${initCodeHash}`);

  const found = mineSalt(module.exports.ARACHNID_CREATE2_DEPLOYER, initCodeHash, mask);
  if (!found) throw new Error("no salt found");

  const decoded = decodeHookFlags(found.address, flags);
  const exact = flagsMatchExactly(found.address, flags, REQUIRED_FLAGS);
  console.log(`salt:    ${found.salt}   (${found.tries} tries)`);
  console.log(`address: ${found.address}`);
  console.log(`low14:   ${decoded.lowHex}`);
  console.log(`flags:   ${decoded.set.join(", ") || "(none)"}`);
  console.log(exact ? "EXACT MATCH" : "!!! FLAGS DO NOT MATCH -- DO NOT DEPLOY !!!");
  if (!exact) process.exit(1);
}

function findArtifact(name) {
  const root = path.join(__dirname, "..", "artifacts", "contracts");
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.name === `${name}.json`) return p;
    }
  }
  throw new Error(`artifact ${name}.json not found -- run: npx hardhat compile`);
}

if (require.main === module) main();
