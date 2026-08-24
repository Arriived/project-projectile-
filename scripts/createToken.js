const hre = require("hardhat");

// Same address your factory was deployed to and verified at.
const FACTORY_ADDRESS = process.env.FACTORY_ADDRESS || "0x63C4c5b7D7add4dbE9Bf8f155711dd00F566Ec57";
const ARC_TESTNET_USDC = "0x3600000000000000000000000000000000000000";

const ERC20_MIN_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
];

async function main() {
  const name = process.env.TOKEN_NAME;
  const symbol = process.env.TOKEN_SYMBOL;
  const metadataURI = process.env.TOKEN_METADATA_URI || "";

  if (!name || !symbol) {
    console.error(
      "Set TOKEN_NAME and TOKEN_SYMBOL as environment variables before running this script.\n" +
      "PowerShell example:\n" +
      '  $env:TOKEN_NAME="Test Token"; $env:TOKEN_SYMBOL="TEST"; $env:TOKEN_METADATA_URI="test"; npx hardhat run scripts/createToken.js --network arcTestnet'
    );
    process.exit(1);
  }

  const [signer] = await hre.ethers.getSigners();
  const factory = await hre.ethers.getContractAt("LFX1", FACTORY_ADDRESS, signer);
  const usdc = new hre.ethers.Contract(ARC_TESTNET_USDC, ERC20_MIN_ABI, signer);

  console.log(`Calling createToken from: ${signer.address}`);
  console.log(`  name: ${name}`);
  console.log(`  symbol: ${symbol}`);
  console.log(`  metadataURI: ${metadataURI || "(none)"}`);

  // createToken charges a fee via transferFrom, which requires prior ERC20 approval —
  // read the LIVE fee from the contract rather than assuming a fixed number, since the
  // owner can change it (new launches only — see the per-token snapshot design).
  const requiredFee = await factory.creationFeeUsdc();
  const balance = await usdc.balanceOf(signer.address);
  if (balance < requiredFee) {
    throw new Error(
      `Insufficient USDC. Need ${hre.ethers.formatUnits(requiredFee, 6)}, have ${hre.ethers.formatUnits(balance, 6)}. ` +
      `Fund ${signer.address} from https://faucet.circle.com (select Arc Testnet).`
    );
  }

  const currentAllowance = await usdc.allowance(signer.address, FACTORY_ADDRESS);
  if (currentAllowance < requiredFee) {
    console.log(`\nApproving factory to spend ${hre.ethers.formatUnits(requiredFee, 6)} USDC...`);
    const approveTx = await usdc.approve(FACTORY_ADDRESS, requiredFee);
    await approveTx.wait();
    console.log("Approved.");
  }

  const tx = await factory.createToken(name, symbol, metadataURI || "");
  console.log(`\nTransaction sent: ${tx.hash}`);
  console.log("Waiting for confirmation...");
  const receipt = await tx.wait();

  const event = receipt.logs
    .map((log) => {
      try {
        return factory.interface.parseLog(log);
      } catch {
        return null;
      }
    })
    .find((parsed) => parsed && parsed.name === "TokenCreated");

  console.log("\n✅ Confirmed.");
  console.log(`Block: ${receipt.blockNumber}`);
  if (event) {
    console.log(`New token address: ${event.args.token}`);
    console.log(`Explorer: https://testnet.arcscan.app/address/${event.args.token}`);
  }
}

main().catch((err) => {
  console.error("\n❌ createToken failed:", err.message);
  process.exit(1);
});
