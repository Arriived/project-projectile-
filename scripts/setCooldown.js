const hre = require("hardhat");

const FACTORY_ADDRESS = process.env.FACTORY_ADDRESS || "0x63C4c5b7D7add4dbE9Bf8f155711dd00F566Ec57";

async function main() {
  const seconds = process.env.COOLDOWN_SECONDS;
  if (!seconds) {
    console.error('Usage: $env:COOLDOWN_SECONDS="30"; npx hardhat run scripts/setCooldown.js --network arcTestnet');
    process.exit(1);
  }

  const [signer] = await hre.ethers.getSigners();
  const factory = await hre.ethers.getContractAt("ArcLaunchFactory", FACTORY_ADDRESS, signer);

  const current = await factory.launchCooldown();
  console.log(`Current cooldown: ${current} seconds`);
  console.log(`Setting to: ${seconds} seconds...`);

  const tx = await factory.setLaunchCooldown(seconds);
  await tx.wait();

  console.log(`✅ Cooldown updated. Remember to set this back to something realistic before mainnet — this is a testnet convenience, not a real anti-spam setting.`);
}

main().catch((err) => {
  console.error("❌ Failed:", err.message);
  process.exit(1);
});
