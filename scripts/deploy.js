const hre = require("hardhat");
const { ethers } = hre;

// Arc Testnet USDC. Verified on-chain by scripts/preflight.js rather than taken on
// trust: it reports name/symbol USDC with 6 decimals, and the known-good live
// ArcLaunchFactory deployment returns this exact address from its own usdc().
// TESTNET ONLY -- Arc mainnet addresses are not published yet. A wrong quote-asset
// address here is unrecoverable fund loss, not a revert.
const ARC_TESTNET_USDC = "0x3600000000000000000000000000000000000000";

// Resume support: set either of these in the environment to skip that deployment and
// reuse an existing address, so a halt partway through does not force a full redo.
const EXISTING_ROUTER = process.env.ROUTER_ADDRESS;
const EXISTING_BALLISTA = process.env.BALLISTA_ADDRESS;

const receipts = [];

async function record(label, txPromise) {
  const tx = await txPromise;
  const receipt = await tx.wait();
  receipts.push({ label, receipt });
  console.log(
    `    tx ${receipt.hash}\n` +
    `    gas ${receipt.gasUsed.toString()} @ ${ethers.formatUnits(receipt.gasPrice, "gwei")} gwei` +
    `  =  ${ethers.formatUnits(receipt.gasUsed * receipt.gasPrice, 18)} USDC`
  );
  return receipt;
}

async function main() {
  const net = await ethers.provider.getNetwork();
  const [deployer] = await ethers.getSigners();
  const treasury = process.env.TREASURY_ADDRESS;

  if (!treasury || !ethers.isAddress(treasury)) {
    throw new Error(
      "TREASURY_ADDRESS is not set (or not an address) in .env. This is where creation " +
      "and trading fees go -- set it deliberately, don't deploy with it blank."
    );
  }
  if (net.chainId !== 5042002n) {
    throw new Error(`refusing to deploy: chainId ${net.chainId} is not Arc Testnet (5042002)`);
  }

  const startBalance = await ethers.provider.getBalance(deployer.address);
  console.log(`network    ${hre.network.name} (chainId ${net.chainId})`);
  console.log(`deployer   ${deployer.address}`);
  console.log(`balance    ${ethers.formatUnits(startBalance, 18)} (Arc native gas is USDC, 18dp here)`);
  console.log(`usdc       ${ARC_TESTNET_USDC}`);
  console.log(`treasury   ${treasury}`);
  if (startBalance === 0n) {
    throw new Error(
      "Deployer has zero balance. Fund from https://faucet.circle.com (Arc Testnet) -- " +
      "gas on Arc is paid in USDC."
    );
  }

  // ── 1. Router ────────────────────────────────────────────────────────
  console.log(`
================================================================
  STEP 1 -- MockRouter
================================================================
  *** THIS IS A PLACEHOLDER, NOT A REAL DEX. ***

  No Arc DEX has been publicly confirmed as a launch partner. MockRouter
  accepts addLiquidity() and returns a nonzero liquidity value so that
  graduation can complete on testnet. It creates NO real pool, provides
  NO real liquidity, and the LP tokens it "burns" are meaningless.

  Ballista gates createToken() on a router being set, so testnet cannot
  function at all without one. Replace this the moment a real Arc DEX
  router is confirmed and verified. Swapping it means proposeRouter()
  then activateRouter() after a 24h timelock; revokeRouter() is instant.
`);

  let routerAddress = EXISTING_ROUTER;
  if (routerAddress) {
    console.log(`  reusing existing router ${routerAddress} (ROUTER_ADDRESS was set)`);
  } else {
    const Router = await ethers.getContractFactory("MockRouter");
    const router = await Router.deploy();
    const r = await record("MockRouter deploy", Promise.resolve(router.deploymentTransaction()));
    await router.waitForDeployment();
    routerAddress = await router.getAddress();
    console.log(`  MockRouter (PLACEHOLDER)  ${routerAddress}   block ${r.blockNumber}`);
  }

  // ── 2. Ballista ──────────────────────────────────────────────────────
  console.log(`\n================================================================\n  STEP 2 -- Ballista\n================================================================`);

  let ballistaAddress = EXISTING_BALLISTA;
  let deployBlock;
  if (ballistaAddress) {
    console.log(`  reusing existing Ballista ${ballistaAddress} (BALLISTA_ADDRESS was set)`);
  } else {
    const Ballista = await ethers.getContractFactory("Ballista");
    // Router passed straight into the constructor: the one deliberate timelock
    // bypass, so a fresh deployment is usable immediately instead of rejecting every
    // createToken for 24 hours. Every later change still goes through propose/activate.
    const ballista = await Ballista.deploy(ARC_TESTNET_USDC, treasury, routerAddress);
    const r = await record("Ballista deploy", Promise.resolve(ballista.deploymentTransaction()));
    await ballista.waitForDeployment();
    ballistaAddress = await ballista.getAddress();
    deployBlock = r.blockNumber;
    console.log(`  Ballista  ${ballistaAddress}   block ${r.blockNumber}`);
  }

  const ballista = await ethers.getContractAt("Ballista", ballistaAddress);

  // ── 3. Wire the router ───────────────────────────────────────────────
  console.log(`\n================================================================\n  STEP 3 -- router (propose / activate, timelocked)\n================================================================`);
  const currentRouter = await ballista.router();
  if (ethers.getAddress(currentRouter) === ethers.getAddress(routerAddress)) {
    console.log(`  already set to ${routerAddress}, skipping`);
  } else {
    // Router activation is timelocked: propose now, activate after ROUTER_TIMELOCK.
    // A fresh deployment therefore cannot launch tokens until the delay elapses.
    const delay = await ballista.ROUTER_TIMELOCK();
    const proposedAt = await ballista.routerProposedAt(routerAddress);
    if (proposedAt === 0n) {
      await record("proposeRouter", ballista.proposeRouter(routerAddress));
      console.log(`  proposed ${routerAddress}`);
    }
    const readyAt = (await ballista.routerProposedAt(routerAddress)) + delay;
    const now = BigInt((await ethers.provider.getBlock("latest")).timestamp);
    if (now >= readyAt) {
      await record("activateRouter", ballista.activateRouter(routerAddress));
      console.log(`  router = ${await ballista.router()}`);
    } else {
      const mins = Number(readyAt - now) / 60;
      console.log(`  NOT YET ACTIVATABLE. Timelock elapses in ${mins.toFixed(0)} minutes`);
      console.log(`  (unix ${readyAt}). Re-run this script then, or call:`);
      console.log(`    ballista.activateRouter("${routerAddress}")`);
      console.log(`  createToken() stays closed until a router is live.`);
    }
  }

  // ── 4. Snipe tax table ───────────────────────────────────────────────
  console.log(`\n================================================================\n  STEP 4 -- snipe tax table\n================================================================`);
  const version = await ballista.activeSnipeTaxTableVersion();
  const table = await ballista.snipeTaxTable(version);
  const maxBps = await ballista.snipeTaxTableMaxBps(version);
  console.log(`  active version   ${version}`);
  console.log(`  table (bps/sec)  [${table.map((t) => t.toString()).join(", ")}]`);
  console.log(`  max entry        ${maxBps} bps`);
  if (table.length === 0) {
    console.log(`  !! empty table -- no snipe tax would apply. Publish one before launching.`);
  } else {
    console.log(`  The constructor publishes this table, so createToken() needs no extra`);
    console.log(`  publish step -- a version already exists and is active from block 0.`);
  }

  // ── 5. Post-deploy state ─────────────────────────────────────────────
  console.log(`\n================================================================\n  DEPLOYED STATE\n================================================================`);
  const checks = {
    usdc: await ballista.usdc(),
    treasury: await ballista.treasury(),
    owner: await ballista.owner(),
    router: await ballista.router(),
    defaultBuyFeeBps: await ballista.defaultBuyFeeBps(),
    defaultSellFeeBps: await ballista.defaultSellFeeBps(),
    defaultCreatorBuyFeeBps: await ballista.defaultCreatorBuyFeeBps(),
    defaultCreatorSellFeeBps: await ballista.defaultCreatorSellFeeBps(),
    defaultSnipeTaxTreasuryBps: await ballista.defaultSnipeTaxTreasuryBps(),
    defaultGraduationThresholdUsdc: await ballista.defaultGraduationThresholdUsdc(),
    creationFeeUsdc: await ballista.creationFeeUsdc(),
    launchCooldown: await ballista.launchCooldown(),
    CURVE_TOKEN_SUPPLY: await ballista.CURVE_TOKEN_SUPPLY(),
    LP_TOKEN_RESERVE: await ballista.LP_TOKEN_RESERVE(),
    TOTAL_TOKEN_SUPPLY: await ballista.TOTAL_TOKEN_SUPPLY(),
    MAX_TOTAL_FEE_BPS: await ballista.MAX_TOTAL_FEE_BPS(),
  };
  for (const [k, v] of Object.entries(checks)) {
    console.log(`  ${k.padEnd(30)} ${v}`);
  }

  if (ethers.getAddress(checks.usdc) !== ethers.getAddress(ARC_TESTNET_USDC)) {
    throw new Error("deployed usdc address does not match what was passed in");
  }

  // ── 6. Costs ─────────────────────────────────────────────────────────
  const endBalance = await ethers.provider.getBalance(deployer.address);
  console.log(`\n================================================================\n  GAS\n================================================================`);
  let totalGas = 0n;
  for (const { label, receipt } of receipts) {
    totalGas += receipt.gasUsed;
    console.log(
      `  ${label.padEnd(20)} ${receipt.gasUsed.toString().padStart(10)} gas   ` +
      `${ethers.formatUnits(receipt.gasUsed * receipt.gasPrice, 18)} USDC`
    );
  }
  console.log(`  ${"TOTAL".padEnd(20)} ${totalGas.toString().padStart(10)} gas`);
  console.log(`  balance spent        ${ethers.formatUnits(startBalance - endBalance, 18)} USDC`);

  console.log(`\n================================================================\n  NEXT\n================================================================`);
  console.log(`  Ballista    ${ballistaAddress}`);
  console.log(`  MockRouter  ${routerAddress}  (PLACEHOLDER -- not a real DEX)`);
  console.log(`  explorer    https://testnet.arcscan.app/address/${ballistaAddress}`);
  console.log(`\n  Verify:`);
  // Third constructor arg is the initial router -- omitting it makes verification fail.
  console.log(`    npx hardhat verify --network arcTestnet ${ballistaAddress} ${ARC_TESTNET_USDC} ${treasury} ${routerAddress}`);
  console.log(`    npx hardhat verify --network arcTestnet ${routerAddress}`);
  if (deployBlock) {
    console.log(`\n  indexer/.env:`);
    console.log(`    FACTORY_ADDRESS=${ballistaAddress}`);
    console.log(`    FACTORY_DEPLOY_BLOCK=${deployBlock}`);
  }
  console.log(`\n  Ownership is still the deploying EOA. Multisig transfer is a separate step.`);
}

main().catch((err) => {
  console.error(`\nDEPLOYMENT FAILED: ${err.message}`);
  if (receipts.length) {
    console.error(`Completed before failing:`);
    for (const { label, receipt } of receipts) {
      console.error(`  ${label}  tx ${receipt.hash}`);
    }
    console.error(`Set ROUTER_ADDRESS / BALLISTA_ADDRESS to resume without redeploying.`);
  }
  process.exitCode = 1;
});
