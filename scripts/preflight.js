// Read-only pre-deploy checks against Arc Testnet. Sends no transactions and
// never prints the private key -- only the address derived from it.
const hre = require("hardhat");
const { ethers } = hre;

// The address the existing ArcLaunchFactory deployment used. Verified below rather
// than trusted: a wrong quote-asset address is unrecoverable fund loss, not a revert.
const EXPECTED_USDC = "0x3600000000000000000000000000000000000000";

const ERC20_ABI = [
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
];

const LIVE_FACTORY = "0x63C4c5b7D7add4dbE9Bf8f155711dd00F566Ec57";

async function main() {
  const net = await ethers.provider.getNetwork();
  console.log(`network            ${hre.network.name}  chainId=${net.chainId}`);
  if (net.chainId !== 5042002n) {
    throw new Error(`unexpected chainId ${net.chainId}, expected 5042002 (Arc Testnet)`);
  }

  const [deployer] = await ethers.getSigners();
  const balance = await ethers.provider.getBalance(deployer.address);
  console.log(`deployer           ${deployer.address}`);
  console.log(`native balance     ${ethers.formatUnits(balance, 18)} (Arc native gas, 18dp)`);
  console.log(`nonce              ${await ethers.provider.getTransactionCount(deployer.address)}`);

  const treasury = process.env.TREASURY_ADDRESS;
  if (!treasury || !ethers.isAddress(treasury)) {
    throw new Error(`TREASURY_ADDRESS missing or not an address: ${treasury}`);
  }
  console.log(`treasury           ${ethers.getAddress(treasury)}`);
  if (ethers.getAddress(treasury) === deployer.address) {
    console.log(`  NOTE: treasury == deployer. Fine for testnet, revisit for mainnet.`);
  }

  // --- USDC verification -------------------------------------------------
  console.log(`\nchecking quote asset ${EXPECTED_USDC}`);
  const code = await ethers.provider.getCode(EXPECTED_USDC);
  if (code === "0x") {
    throw new Error(`NO CONTRACT at ${EXPECTED_USDC} -- do not deploy against this address`);
  }
  console.log(`  bytecode         ${code.length} chars (contract present)`);

  const usdc = new ethers.Contract(EXPECTED_USDC, ERC20_ABI, ethers.provider);
  const [name, symbol, decimals] = await Promise.all([
    usdc.name().catch(() => "<no name()>"),
    usdc.symbol().catch(() => "<no symbol()>"),
    usdc.decimals().catch(() => null),
  ]);
  console.log(`  name/symbol      ${name} / ${symbol}`);
  console.log(`  decimals         ${decimals}`);
  if (decimals !== 6n && decimals !== 6) {
    throw new Error(`decimals is ${decimals}, expected 6 -- every amount in Ballista assumes 6dp`);
  }

  // Cross-check: whatever the LIVE ArcLaunchFactory is actually pointed at is the
  // strongest available confirmation, since that deployment is known-good.
  const liveCode = await ethers.provider.getCode(LIVE_FACTORY);
  if (liveCode !== "0x") {
    const live = new ethers.Contract(LIVE_FACTORY, ["function usdc() view returns (address)"], ethers.provider);
    try {
      const liveUsdc = await live.usdc();
      const match = ethers.getAddress(liveUsdc) === ethers.getAddress(EXPECTED_USDC);
      console.log(`  live factory usdc() -> ${liveUsdc}  ${match ? "MATCHES" : "*** MISMATCH ***"}`);
      if (!match) {
        throw new Error("quote asset disagrees with the known-good live deployment; stopping");
      }
    } catch (e) {
      if (String(e.message).includes("disagrees")) throw e;
      console.log(`  live factory usdc() unreadable (${e.shortMessage || e.message})`);
    }
  } else {
    console.log(`  live factory ${LIVE_FACTORY} has no code on this network`);
  }

  console.log(`\npreflight OK`);
}

main().catch((e) => {
  console.error(`\nPREFLIGHT FAILED: ${e.message}`);
  process.exitCode = 1;
});
