const hre = require("hardhat");
const { ethers } = hre;

// Deploys the BXR1 stack: CurveMath (the external library _quoteBuy/_quoteSell/
// _ceilDiv were extracted into -- see contracts/bxr1/CurveMath.sol), an
// AssetRegistry, then BXR1 itself LINKED against the library's deployed address.
//
// This is the one hard requirement library extraction adds to deployment: BXR1's
// compiled bytecode carries two unresolved link placeholders
// (`__$<34 hex chars>$__`) where the CurveMath address goes. Hardhat/ethers will not
// fill them in automatically -- CurveMath has to be deployed FIRST, and its address
// passed explicitly:
//
//   ethers.getContractFactory("BXR1", { libraries: { CurveMath: curveMathAddress } })
//
// Skipping the `libraries` option, or deploying BXR1 before CurveMath exists,
// produces a Hardhat error naming the unresolved link -- not a silent bad deploy.
//
// Resume support, same shape as scripts/deploy.js: set CURVE_MATH_ADDRESS or
// BXR1_ASSET_REGISTRY_ADDRESS or BXR1_ADDRESS in the environment to reuse an
// existing deployment of that piece instead of redeploying it.
const EXISTING_CURVE_MATH = process.env.CURVE_MATH_ADDRESS;
const EXISTING_REGISTRY = process.env.BXR1_ASSET_REGISTRY_ADDRESS;
const EXISTING_BXR1 = process.env.BXR1_ADDRESS;

// Not hardcoded to Arc USDC, deliberately -- BXR1's whole point is that the quote
// asset is a registry entry, not an assumption (see AssetRegistry.sol). This is the
// FIRST asset registered so a fresh deployment can launch a token immediately; it
// is not privileged over any asset registered later via registerAsset(). Defaults
// match AssetRegistry's own historic USDC-equivalent figures (see
// test/bxr1/assetRegistryHelper.js) but every value is env-overridable.
const FIRST_ASSET = process.env.BXR1_FIRST_ASSET; // required, no safe default -- a
// wrong quote-asset address here is unrecoverable fund loss, not a revert.
const FIRST_ASSET_DECIMALS = Number(process.env.BXR1_FIRST_ASSET_DECIMALS ?? 6);
const FIRST_ASSET_INITIAL_VIRTUAL_RESERVE = BigInt(
  process.env.BXR1_FIRST_ASSET_INITIAL_VIRTUAL_RESERVE ?? "2667000000"
);
// defaultGraduationThreshold moved into AssetConfig, per asset -- BXR1 no longer
// carries a global default of its own (see BXR1.sol and AssetRegistry.sol). Default
// here matches the historic BXR1-wide value (8,000 USDC-equivalent raw units).
const FIRST_ASSET_DEFAULT_GRADUATION_THRESHOLD = BigInt(
  process.env.BXR1_FIRST_ASSET_DEFAULT_GRADUATION_THRESHOLD ?? "8000000000"
);
// creationFee moved into AssetConfig too, per asset, with no BXR1-side setter any
// more -- see AssetRegistry.sol and CLAUDE.md section 25.3/25.6. Default here matches
// the historic BXR1-wide value (0.5 USDC-equivalent raw units).
const FIRST_ASSET_CREATION_FEE = BigInt(
  process.env.BXR1_FIRST_ASSET_CREATION_FEE ?? "500000"
);

// ⚠ initialRouter_ IS BEHIND A DELIBERATE FLAG, same discipline as
// scripts/deploy-v4-stack.js's --bootstrap-router: unset by default, and BXR1 deploys
// with router == address(0) (createToken() gated behind proposeRouter -> 24h ->
// activateRouter) unless this is explicitly set. Setting it SPENDS the constructor's
// one untimelocked router activation (BXR1.sol:193-198) -- the router goes live at
// block zero, with no public RouterProposed event and no 24h window for anyone to
// notice or object.
//
// ⚠ HARD-GATED AGAINST ARC MAINNET (chainId 5042), checked in main() before any
// transaction. Bootstrapping is a testnet-convenience shortcut around the very
// protection (§1.5's 24h timelock, watched via RouterProposed) that exists specifically
// to catch a malicious or wrong router before it can touch real funds. On mainnet that
// protection must never be skipped, so this refuses outright rather than warning --
// see CLAUDE.md's BXR1 testnet deployment section for the reasoning and
// test/DeployBxr1Guards.test.js for the guard proof.
const BOOTSTRAP_ROUTER = process.env.BXR1_BOOTSTRAP_ROUTER;

const receipts = [];

async function record(label, txPromise) {
  const tx = await txPromise;
  const receipt = await tx.wait();
  receipts.push({ label, receipt });
  console.log(
    `    tx ${receipt.hash}\n` +
    `    gas ${receipt.gasUsed.toString()} @ ${ethers.formatUnits(receipt.gasPrice, "gwei")} gwei`
  );
  return receipt;
}

async function main() {
  const net = await hre.ethers.provider.getNetwork();
  const [deployer] = await ethers.getSigners();
  const treasury = process.env.TREASURY_ADDRESS;

  if (!treasury || !ethers.isAddress(treasury)) {
    throw new Error(
      "TREASURY_ADDRESS is not set (or not an address). This is where creation and " +
      "trading fees go -- set it deliberately, don't deploy with it blank."
    );
  }
  if (!FIRST_ASSET || !ethers.isAddress(FIRST_ASSET)) {
    throw new Error(
      "BXR1_FIRST_ASSET is not set (or not an address). BXR1 refuses createToken for " +
      "any asset that is not registered and enabled -- set the quote asset to register " +
      "first (e.g. Arc USDC 0x3600000000000000000000000000000000000000 on testnet)."
    );
  }

  // HARD STOP, before any transaction: BXR1_BOOTSTRAP_ROUTER is ALLOWLISTED, not
  // merely denylisted against mainnet -- it is permitted ONLY on Arc testnet
  // (5042002) or the local Hardhat network (31337, e.g. for this script's own guard
  // tests), and refused on every other chainId, Arc mainnet (5042) included. An
  // allowlist fails closed against any chain nobody thought to name here; a
  // denylist of "just 5042" fails open against every OTHER chain the bootstrap
  // path was never meant to reach. This is deliberately unconditional on network
  // NAME -- it checks what the provider itself reports, not hre.network.name, so a
  // misconfigured --network flag pointing a testnet-named network at some other
  // chain's RPC (mainnet included) is still caught.
  const BOOTSTRAP_ALLOWED_CHAIN_IDS = [5042002n, 31337n];
  if (BOOTSTRAP_ROUTER && !BOOTSTRAP_ALLOWED_CHAIN_IDS.includes(net.chainId)) {
    throw new Error(
      `BXR1_BOOTSTRAP_ROUTER is set and this network's chainId is ${net.chainId}, ` +
      `which is not allowlisted for it (only ${BOOTSTRAP_ALLOWED_CHAIN_IDS.join(", ")} ` +
      "are -- Arc testnet and local Hardhat). Refusing to bootstrap a live, " +
      "untimelocked router on any other chain, Arc mainnet (5042) included -- this is " +
      "a hard stop, not a warning. Unset BXR1_BOOTSTRAP_ROUTER, or deploy to arcTestnet."
    );
  }
  if (BOOTSTRAP_ROUTER && !ethers.isAddress(BOOTSTRAP_ROUTER)) {
    throw new Error("BXR1_BOOTSTRAP_ROUTER is set but is not a valid address.");
  }

  console.log(`network    ${hre.network.name} (chainId ${net.chainId})`);
  console.log(`deployer   ${deployer.address}`);
  console.log(`treasury   ${treasury}`);
  console.log(`firstAsset ${FIRST_ASSET} (${FIRST_ASSET_DECIMALS}dp, ` +
    `initialVirtualReserve=${FIRST_ASSET_INITIAL_VIRTUAL_RESERVE}, ` +
    `defaultGraduationThreshold=${FIRST_ASSET_DEFAULT_GRADUATION_THRESHOLD}, ` +
    `creationFee=${FIRST_ASSET_CREATION_FEE})`);

  // ── 1. CurveMath ─────────────────────────────────────────────────────
  console.log(`\n================================================================\n  STEP 1 -- CurveMath (external library)\n================================================================`);

  let curveMathAddress = EXISTING_CURVE_MATH;
  if (curveMathAddress) {
    console.log(`  reusing existing CurveMath ${curveMathAddress} (CURVE_MATH_ADDRESS was set)`);
  } else {
    const CurveMath = await ethers.getContractFactory("CurveMath");
    const lib = await CurveMath.deploy();
    await record("CurveMath deploy", Promise.resolve(lib.deploymentTransaction()));
    await lib.waitForDeployment();
    curveMathAddress = await lib.getAddress();
    console.log(`  CurveMath  ${curveMathAddress}`);
  }

  // ── 2. AssetRegistry ─────────────────────────────────────────────────
  console.log(`\n================================================================\n  STEP 2 -- AssetRegistry\n================================================================`);

  let registryAddress = EXISTING_REGISTRY;
  if (registryAddress) {
    console.log(`  reusing existing AssetRegistry ${registryAddress} (BXR1_ASSET_REGISTRY_ADDRESS was set)`);
  } else {
    const AssetRegistry = await ethers.getContractFactory("AssetRegistry");
    const registry = await AssetRegistry.deploy();
    await record("AssetRegistry deploy", Promise.resolve(registry.deploymentTransaction()));
    await registry.waitForDeployment();
    registryAddress = await registry.getAddress();
    console.log(`  AssetRegistry  ${registryAddress}`);
  }

  const registry = await ethers.getContractAt("AssetRegistry", registryAddress);
  const existingAsset = await registry.getAsset(FIRST_ASSET);
  if (existingAsset.asset === ethers.ZeroAddress) {
    await record(
      "registerAsset",
      registry.registerAsset(
        FIRST_ASSET,
        FIRST_ASSET_DECIMALS,
        true,  // enabled
        false, // rebasing
        false, // transferRestricted
        false, // transferFee
        FIRST_ASSET_INITIAL_VIRTUAL_RESERVE,
        FIRST_ASSET_DEFAULT_GRADUATION_THRESHOLD,
        FIRST_ASSET_CREATION_FEE,
        0 // AssetRegistry.AssetKind.STANDARD -- this script always bootstraps a
          // plain quote asset (Arc USDC on testnet); a LEVERAGED asset is a
          // separate, deliberate registerAsset() call, not this one.
      )
    );
    console.log(`  registered ${FIRST_ASSET} as the first quote asset`);
  } else {
    console.log(`  ${FIRST_ASSET} already registered, enabled=${existingAsset.enabled} -- skipping`);
  }

  // ── 3. BXR1, LINKED against CurveMath ────────────────────────────────
  console.log(`\n================================================================\n  STEP 3 -- BXR1 (linked against CurveMath)\n================================================================`);

  let bxr1Address = EXISTING_BXR1;
  if (bxr1Address) {
    console.log(`  reusing existing BXR1 ${bxr1Address} (BXR1_ADDRESS was set)`);
  } else {
    // The router is NEVER auto-bootstrapped by DEFAULT. Passing a live router here
    // skips this factory's one untimelocked router activation for free -- that bypass
    // is available (BXR1's constructor accepts it) and is now reachable ONLY via the
    // explicit BXR1_BOOTSTRAP_ROUTER env var, hard-refused above on Arc mainnet.
    // Unset, this matches the "untimelocked path is never a default" discipline
    // scripts/deploy-v4-stack.js already applies to LFX1's v4 stack -- proposeRouter()
    // / activateRouter() after the 24h timelock is the only path left open.
    const initialRouter = BOOTSTRAP_ROUTER || ethers.ZeroAddress;
    if (BOOTSTRAP_ROUTER) {
      console.log(`  ⚠ BXR1_BOOTSTRAP_ROUTER set -- SPENDS THE CONSTRUCTOR'S ONE`);
      console.log(`    UNTIMELOCKED ROUTER ACTIVATION. router will be LIVE AT BLOCK`);
      console.log(`    ZERO, no proposeRouter, no 24h wait, no public window to notice`);
      console.log(`    or object: ${BOOTSTRAP_ROUTER}`);
    }
    const BXR1 = await ethers.getContractFactory("BXR1", {
      libraries: { CurveMath: curveMathAddress },
    });
    const bxr1 = await BXR1.deploy(registryAddress, treasury, initialRouter);
    const r = await record("BXR1 deploy", Promise.resolve(bxr1.deploymentTransaction()));
    await bxr1.waitForDeployment();
    bxr1Address = await bxr1.getAddress();
    console.log(`  BXR1  ${bxr1Address}   block ${r.blockNumber}`);
  }

  // ── 4. Post-deploy state ─────────────────────────────────────────────
  console.log(`\n================================================================\n  DEPLOYED STATE\n================================================================`);
  const bxr1 = await ethers.getContractAt("BXR1", bxr1Address);
  const liveRouter = await bxr1.router();
  console.log(`  assetRegistry   ${await bxr1.assetRegistry()}`);
  console.log(`  treasury        ${await bxr1.treasury()}`);
  console.log(`  owner           ${await bxr1.owner()}`);
  console.log(`  router          ${liveRouter}` +
    (liveRouter === ethers.ZeroAddress
      ? `  (address(0) until proposeRouter/activateRouter)`
      : `  (BOOTSTRAPPED -- live at block zero, no timelock)`));

  if (ethers.getAddress(await bxr1.assetRegistry()) !== ethers.getAddress(registryAddress)) {
    throw new Error("deployed BXR1's assetRegistry does not match the registry this script deployed");
  }

  console.log(`\n================================================================\n  NEXT\n================================================================`);
  console.log(`  CurveMath       ${curveMathAddress}`);
  console.log(`  AssetRegistry   ${registryAddress}`);
  console.log(`  BXR1            ${bxr1Address}`);
  console.log(`\n  Verify (the library must verify BEFORE BXR1, or BXR1's verification`);
  console.log(`  cannot resolve the link):`);
  console.log(`    npx hardhat verify --contract contracts/bxr1/CurveMath.sol:CurveMath --network ${hre.network.name} ${curveMathAddress}`);
  console.log(`    npx hardhat verify --contract contracts/bxr1/AssetRegistry.sol:AssetRegistry --network ${hre.network.name} ${registryAddress}`);
  console.log(`    npx hardhat verify --contract contracts/bxr1/BXR1.sol:BXR1 --network ${hre.network.name} --libraries '{"CurveMath":"${curveMathAddress}"}' ${bxr1Address} ${registryAddress} ${treasury} ${liveRouter}`);
  if (liveRouter === ethers.ZeroAddress) {
    console.log(`\n  router() is address(0). Nothing can createToken() until proposeRouter()`);
    console.log(`  + a 24h wait + activateRouter().`);
  } else {
    console.log(`\n  ⚠ router() is LIVE (${liveRouter}), bootstrapped via BXR1_BOOTSTRAP_ROUTER --`);
    console.log(`  no timelock was observed. createToken() works immediately.`);
  }
}

main().catch((err) => {
  console.error(`\nDEPLOYMENT FAILED: ${err.message}`);
  if (receipts.length) {
    console.error(`Completed before failing:`);
    for (const { label, receipt } of receipts) {
      console.error(`  ${label}  tx ${receipt.hash}`);
    }
    console.error(`Set CURVE_MATH_ADDRESS / BXR1_ASSET_REGISTRY_ADDRESS / BXR1_ADDRESS to resume.`);
  }
  process.exitCode = 1;
});
