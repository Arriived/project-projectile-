// Read-only checks before the re-freeze. Nothing here sends a transaction.
// Run: npx hardhat run scripts/refreeze-preflight.js --network arcTestnet
const hre = require("hardhat");
const { ethers } = hre;

const ARC_TESTNET_USDC = "0x3600000000000000000000000000000000000000";
// Uniswap on Arc MAINNET, from their SDK. Checked here only to confirm it is ABSENT on
// testnet -- GraduationHelper needs a real V2 factory and must not be pointed at a
// codeless address.
const ARC_MAINNET_V2_FACTORY = "0x89e5db8b5aa49aa85ac63f691524311aeb649eba";
const ARC_MAINNET_V2_ROUTER = "0x1f7d7550b1b028f7571e69a784071f0205fd2efa";

async function main() {
  const net = await ethers.provider.getNetwork();
  const [deployer] = await ethers.getSigners();
  const bal = await ethers.provider.getBalance(deployer.address);

  console.log(`network   ${hre.network.name}  chainId ${net.chainId}`);
  console.log(`block     ${await ethers.provider.getBlockNumber()}`);
  console.log(`deployer  ${deployer.address}`);
  console.log(`balance   ${ethers.formatUnits(bal, 18)} USDC (native gas, 18dp view)`);
  console.log(`treasury  ${process.env.TREASURY_ADDRESS}`);

  const usdc = new ethers.Contract(ARC_TESTNET_USDC, [
    "function symbol() view returns (string)",
    "function decimals() view returns (uint8)",
  ], ethers.provider);
  try {
    console.log(`usdc      ${ARC_TESTNET_USDC} -> ${await usdc.symbol()} / ${await usdc.decimals()}dp`);
  } catch (e) {
    console.log(`usdc      UNREACHABLE: ${String(e.shortMessage || e.message).slice(0, 90)}`);
  }

  for (const [label, addr] of [
    ["v2 factory (mainnet addr)", ARC_MAINNET_V2_FACTORY],
    ["v2 router  (mainnet addr)", ARC_MAINNET_V2_ROUTER],
  ]) {
    const code = await ethers.provider.getCode(addr);
    console.log(`${label}  ${addr}  ${code === "0x" ? "NO CODE on this chain" : "code present"}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
