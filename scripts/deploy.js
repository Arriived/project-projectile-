const hre = require("hardhat");

// Confirmed directly against Circle's own official docs (docs.arc.io/arc/references/
// contract-addresses) at the time this was written — not a third-party guess. If Arc's
// mainnet ever launches, this address is testnet-only and MUST be replaced with the
// real mainnet USDC address before any mainnet deployment; docs.arc.io states mainnet
// addresses are not published yet as of this writing.
const ARC_TESTNET_USDC = "0x3600000000000000000000000000000000000000";

async function main() {
  const treasury = process.env.TREASURY_ADDRESS;
  if (!treasury) {
    throw new Error(
      "TREASURY_ADDRESS is not set in .env. This is where creation fees and trading " +
      "fees get sent — set it deliberately, don't deploy with it blank."
    );
  }

  const [deployer] = await hre.ethers.getSigners();
  const network = await hre.ethers.provider.getNetwork();
  console.log(`Deploying from: ${deployer.address}`);
  console.log(`Network: ${network.name} (chainId ${network.chainId})`);
  console.log(`USDC: ${ARC_TESTNET_USDC}`);
  console.log(`Treasury: ${treasury}`);

  const balance = await hre.ethers.provider.getBalance(deployer.address);
  console.log(`Deployer USDC balance (native gas token on Arc): ${hre.ethers.formatUnits(balance, 18)}`);
  if (balance === 0n) {
    throw new Error(
      "Deployer wallet has zero balance. Fund it from https://faucet.circle.com " +
      "(select Arc Testnet) before deploying — gas on Arc is paid in USDC."
    );
  }

  console.log("\nDeploying ArcLaunchFactory...");
  const Factory = await hre.ethers.getContractFactory("ArcLaunchFactory");
  const factory = await Factory.deploy(ARC_TESTNET_USDC, treasury);
  await factory.waitForDeployment();

  const factoryAddress = await factory.getAddress();
  const deployTx = factory.deploymentTransaction();
  const receipt = await deployTx.wait();

  console.log("\n✅ Deployed successfully.");
  console.log(`ArcLaunchFactory address: ${factoryAddress}`);
  console.log(`Deployment block: ${receipt.blockNumber}`);
  console.log(`Transaction hash: ${receipt.hash}`);
  console.log(`Explorer: https://testnet.arcscan.app/address/${factoryAddress}`);
  console.log(
    "\nNext steps:\n" +
    `  1. Set FACTORY_ADDRESS=${factoryAddress} in indexer/.env\n` +
    `  2. Set FACTORY_DEPLOY_BLOCK=${receipt.blockNumber} in indexer/.env\n` +
    "  3. Verify the contract source on the explorer (separate step — ask me for this next)\n" +
    "  4. router stays unset until a real Arc DEX exists — that's expected, not a bug"
  );
}

main().catch((err) => {
  console.error("\n❌ Deployment failed:", err.message);
  process.exit(1);
});
