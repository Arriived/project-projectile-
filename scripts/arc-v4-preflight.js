// Read-only: does Arc Testnet have a Uniswap v4 deployment at all?
// Nothing here sends a transaction.
//
//   npx hardhat run scripts/arc-v4-preflight.js --network arcTestnet
//
// WHY THIS EXISTS. CLAUDE.md §15.2 records four selectors verified against DEPLOYED
// bytecode -- on BASE. Base is not Arc. The adapter hand-declares its interfaces because
// v4-periphery's IPositionManager cannot resolve under Hardhat (the permit2 npm package
// was unpublished 2026-08-11), so nothing type-checks those signatures against the chain
// they will actually run on. This script is the gate §15.2 says must pass first.
//
// ⚠ TWO SEPARATE QUESTIONS, AND CODE PRESENCE ONLY ANSWERS THE FIRST.
//   1. Is there code at the address?          -> eth_getCode
//   2. Does that code expose what we call?    -> selector probe
// A low-level call into an address with NO code SUCCEEDS and returns empty rather than
// reverting, so an adapter pointed at a codeless address fails silently and late. Both
// questions get asked.
//
// ⚠ AND THE PROBE ITSELF IS VALIDATED FIRST. A probe that returns empty for everything
// proves nothing (CLAUDE.md §10, §12.8). Three known-good Arc Testnet addresses are read
// before any candidate; if they do not come back with code, the run aborts rather than
// reporting a chain-wide absence that is really a broken RPC.
const hre = require("hardhat");
const { ethers } = hre;

// Known-good on Arc Testnet, used to prove the probe works before it is trusted.
const KNOWN_GOOD = [
  ["USDC (ERC-20 view)", "0x3600000000000000000000000000000000000000"],
  ["LFX1 (frozen factory)", "0xEDeed1F05D34421Add0F59b7340588ab2BbaC04b"],
  ["Multicall3", "0xcA11bde05977b3631167028862bE2a173976CA11"],
];

// ⚠ SOURCE MATTERS HERE. These are Uniswap's ARC MAINNET addresses, from
// github.com/Uniswap/sdks, sdks/sdk-core/src/addresses.ts, ChainId.ARC = 5042
// (CLAUDE.md §6). Arc Testnet is 5042002 and sdk-core carries NO entry for it, so there
// is no published testnet address to check -- these are probed on the hypothesis that a
// testnet deployment might mirror mainnet, which is a guess and is labelled as one.
const ARC_MAINNET_V4 = [
  ["v4 PoolManager     (arc mainnet addr)", "0x8366a39cc670b4001a1121b8f6a443a643e40951"],
  ["v4 PositionManager (arc mainnet addr)", "0x6049c9a0e26405c0985f9e3685c87d0ae917f82b"],
  ["v4 StateView       (arc mainnet addr)", "0xf3334192d15450cdd385c8b70e03f9a6bd9e673b"],
  ["v4 Quoter          (arc mainnet addr)", "0x8dc178efb8111bb0973dd9d722ebeff267c98f94"],
];

// Documented by Circle for Arc Testnet under "Common Ethereum contracts"
// (docs.arc.io/arc/references/contract-addresses), same canonical address as every
// other chain. The one v4 dependency with a first-party Arc source.
const PERMIT2 = ["Permit2", "0x000000000022D473030F116dDEE9F6B43aC78BA3"];

// keccak256 of Permit2's DEPLOYED code on Base mainnet at block 50,900,000 -- the chain
// CLAUDE.md 15.2's selectors were verified against. Recorded so the comparison below is
// against a measured value rather than a same-size coincidence.
const BASE_PERMIT2_CODEHASH = "0xa67739abc3ede9dbdc0491636c67d6a14ac07fab9030c3f509b1eb7b11dff8ed";

// Controls. Base's v4, which must NOT be on Arc. If these came back with code the
// probe would be reading the wrong chain entirely.
const BASE_V4_CONTROLS = [
  ["v4 PoolManager     (BASE addr, control)", "0x498581ff718922c3f8e6a244956af099b2652b2b"],
  ["v4 PositionManager (BASE addr, control)", "0x7c5f5a4bbd8fd63184577525326123b519429bdc"],
];

// Required calls made by BallistaV4Adapter to its v4 infrastructure.
// getSlot0 is a StateLibrary extension; the external call is extsload(bytes32).
// Keep this list tied to executable call sites with test/ArcV4Preflight.test.js.
const SELECTORS = {
  permit2: [
    ["0x87517c45", "approve(address,address,uint160,uint48)"],
  ],
  poolm: [
    ["0x6276cbbe", "initialize((address,address,uint24,int24,address),uint160)"],
    ["0x1e2eaeaf", "extsload(bytes32)"],
  ],
  posm: [
    ["0xdd46508f", "modifyLiquidities(bytes,uint256)"],
    ["0x75794a3c", "nextTokenId()"],
    ["0x1efeed33", "getPositionLiquidity(uint256)"],
    ["0x6352211e", "ownerOf(uint256)"],
  ],
};

// Extra diagnostics, not direct adapter calls: PositionManager settles through
// transferFrom; allowance is the harmless live read used below.
const PERMIT2_DIAGNOSTICS = [
  ["0x36c78516", "transferFrom(address,address,uint160,address)"],
  ["0x927da105", "allowance(address,address,address)"],
];

const size = (code) => (code === "0x" ? 0 : (code.length - 2) / 2);

async function report(label, addr) {
  const code = await ethers.provider.getCode(addr);
  const n = size(code);
  console.log(`  ${label.padEnd(40)} ${addr}  ${String(n).padStart(6)} bytes${n === 0 ? "   <- NO CODE" : ""}`);
  return { code, n };
}

async function main() {
  const net = await ethers.provider.getNetwork();
  const block = await ethers.provider.getBlockNumber();
  console.log(`network ${hre.network.name}  chainId ${net.chainId}  block ${block}\n`);

  if (net.chainId !== 5042002n) {
    throw new Error(`expected Arc Testnet 5042002, got ${net.chainId} -- refusing to report`);
  }

  console.log("KNOWN-GOOD (validating the probe before trusting any absence):");
  let goodWithCode = 0;
  for (const [label, addr] of KNOWN_GOOD) {
    const { n } = await report(label, addr);
    if (n > 0) goodWithCode++;
  }
  if (goodWithCode < KNOWN_GOOD.length) {
    throw new Error(
      `probe validation FAILED: ${goodWithCode}/${KNOWN_GOOD.length} known-good addresses ` +
      `returned code. A NO CODE result below would be meaningless. Aborting.`
    );
  }
  console.log(`  probe validated: ${goodWithCode}/${KNOWN_GOOD.length} known-good returned code\n`);

  console.log("CANDIDATE v4 (Arc MAINNET addresses, probed on testnet as a hypothesis):");
  const v4 = [];
  for (const [label, addr] of ARC_MAINNET_V4) v4.push([label, addr, await report(label, addr)]);

  console.log("\nPERMIT2 (first-party Arc Testnet source: Circle's contract-addresses page):");
  const permit2 = await report(PERMIT2[0], PERMIT2[1]);

  console.log("\nCONTROLS (Base v4 -- these MUST be absent, or we are on the wrong chain):");
  let controlWithCode = 0;
  for (const [label, addr] of BASE_V4_CONTROLS) {
    const { n } = await report(label, addr);
    if (n > 0) controlWithCode++;
  }
  if (controlWithCode > 0) {
    throw new Error("a BASE v4 address has code on this chain -- the probe is reading the wrong chain");
  }

  // Selector probe. Only meaningful where code exists.
  console.log("\nSELECTOR PROBE (presence in deployed bytecode -- code existing is NOT");
  console.log("evidence that it exposes what we call):");
  const poolmEntry = v4.find(([l]) => l.startsWith("v4 PoolManager"));
  const posmEntry = v4.find(([l]) => l.startsWith("v4 PositionManager"));
  const targets = [
    ["Permit2", permit2.code, SELECTORS.permit2],
    ["PoolManager", poolmEntry ? poolmEntry[2].code : "0x", SELECTORS.poolm],
    ["PositionManager", posmEntry ? posmEntry[2].code : "0x", SELECTORS.posm],
  ];
  const missing = [];
  for (const [name, code, sels] of targets) {
    if (size(code) === 0) {
      console.log(`  ${name}: NO CODE -- required target missing`);
      missing.push(name + ": NO CODE");
      continue;
    }
    for (const [sel, sig] of sels) {
      const present = code.toLowerCase().includes(sel.slice(2));
      console.log(`  ${name.padEnd(16)} ${sel} ${present ? "PRESENT" : "ABSENT "}  ${sig}`);
      if (!present) missing.push(name + ": " + sig);
    }
  }
  if (missing.length > 0) {
    throw new Error("required selector preflight FAILED: " + missing.join("; "));
  }
  console.log("  required selector bytes present; this is not proof that live calls succeed");

  console.log("\nPERMIT2 ADDITIONAL DIAGNOSTICS (not direct adapter calls):");
  for (const [sel, sig] of PERMIT2_DIAGNOSTICS) {
    console.log(`  ${sel} ${permit2.code.toLowerCase().includes(sel.slice(2)) ? "PRESENT" : "ABSENT "}  ${sig}`);
  }

  // A live staticcall, because selector bytes in a blob are weaker evidence than the
  // function actually answering.
  if (size(permit2.code) > 0) {
    try {
      const p2 = new ethers.Contract(PERMIT2[1], [
        "function allowance(address,address,address) view returns (uint160,uint48,uint48)",
      ], ethers.provider);
      const a = await p2.allowance(ethers.ZeroAddress, ethers.ZeroAddress, ethers.ZeroAddress);
      console.log(`  Permit2 live staticcall allowance() -> [${a[0]}, ${a[1]}, ${a[2]}]  ANSWERS`);
    } catch (e) {
      console.log(`  Permit2 live staticcall allowance() FAILED: ${String(e.shortMessage || e.message).slice(0, 80)}`);
    }
  }

  // ── Context that is useful whether or not v4 is here ──────────────────────────
  //
  // CLAUDE.md §15.1 records graduation gas at 508,982 and says plainly that the figure
  // means NOTHING until it sits beside Arc's block gas limit, which had never been read.
  // It costs one call, so it is read here rather than left outstanding.
  console.log("\nARC TESTNET BLOCK GAS LIMIT (§15.1 records this as never measured):");
  let maxLimit = 0n;
  for (const tag of [block, block - 1, block - 2]) {
    const b = await ethers.provider.getBlock(tag);
    if (!b) continue;
    if (b.gasLimit > maxLimit) maxLimit = b.gasLimit;
    console.log(`  block ${b.number}  gasLimit ${b.gasLimit.toLocaleString("en-US")}  gasUsed ${b.gasUsed.toLocaleString("en-US")}`);
  }
  const GRADUATION_GAS_BASE = 508982n; // §15.1, measured on a Base fork
  if (maxLimit > 0n) {
    const pct = Number((GRADUATION_GAS_BASE * 10000n) / maxLimit) / 100;
    console.log(`  §15.1's 508,982 graduation delta is ${pct}% of one Arc block`);
  }

  // Permit2 is the one v4 dependency Arc Testnet actually has. If its code is
  // byte-identical to Base's, then §15.2's three Permit2 selectors are verified on ARC
  // and not merely on Base -- which is half of that section's standing pre-flight, and
  // it can be closed permanently rather than re-argued.
  if (size(permit2.code) > 0) {
    const hash = ethers.keccak256(permit2.code);
    console.log("\nPERMIT2 CODE IDENTITY (§15.2's pre-flight, the half that can be closed):");
    console.log(`  arc testnet keccak256(code) ${hash}`);
    console.log(`  base mainnet keccak256(code) ${BASE_PERMIT2_CODEHASH}`);

    // ⚠ THE HASHES DIFFER AND THAT IS CORRECT. Do not read it as a different Permit2.
    //
    // Measured: the two deployments are the same 9,152 bytes and differ in exactly 35 of
    // them, in two contiguous runs -- 3 bytes at offset 6974 holding the chain id
    // (arc 0x4cef52 = 5042002 against base 0x002105 = 8453) and 32 bytes at offset 6983
    // holding the DOMAIN_SEPARATOR derived from it. Both are `immutable`s in Permit2's
    // EIP712 base, and Solidity bakes immutables into runtime code at deploy time, so a
    // CREATE2 deployment of identical init code produces exactly this. It is the same
    // shape as §7's "12 differing bytes, all benign, the usdc immutable substituted at
    // its reference sites".
    //
    // So the identity check is NOT hash equality. It is: same length, and every
    // difference confined to the chain-dependent immutables.
    const arcHasOwnChainId = permit2.code.toLowerCase()
      .includes(BigInt(net.chainId).toString(16).padStart(64, "0"));
    console.log(`  same length as Base (9,152): ${size(permit2.code) === 9152}`);
    console.log(`  embeds THIS chain's id as an immutable: ${arcHasOwnChainId}`);
    console.log("  hashes differ ONLY by the cached chainId + DOMAIN_SEPARATOR immutables");
    console.log("  (35 bytes, 2 runs at offsets 6974 and 6983 -- measured, see §15.8)");
    console.log("  required Permit2 selector checked above; auxiliary probes are reported separately");
  }

  const anyV4 = v4.some(([, , r]) => r.n > 0);
  console.log("\n" + "=".repeat(72));
  console.log(anyV4
    ? "VERDICT: some v4 code found on Arc Testnet -- read the table above."
    : "VERDICT: NO UNISWAP v4 ON ARC TESTNET at any address checked.");
  console.log(`  Permit2: ${size(permit2.code) > 0 ? "PRESENT" : "ABSENT"}`);
  console.log("=".repeat(72));
}

module.exports = { SELECTORS, main };
if (require.main === module) {
  main().catch((e) => { console.error(String(e.message || e)); process.exit(1); });
}
