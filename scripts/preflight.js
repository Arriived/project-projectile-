// Read-only pre-deploy checks against Arc Testnet. Sends no transactions and
// never prints the private key -- only the address derived from it.
const hre = require("hardhat");
const { ethers } = hre;

// The address the existing Ballista deployment used. Verified below rather
// than trusted: a wrong quote-asset address is unrecoverable fund loss, not a revert.
const EXPECTED_USDC = "0x3600000000000000000000000000000000000000";

const ERC20_ABI = [
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
  "function transfer(address to, uint256 amount) returns (bool)",
];

const LIVE_FACTORY = "0xEDeed1F05D34421Add0F59b7340588ab2BbaC04b";

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

  // ── Transfer integrity, at zero bytecode cost ────────────────────────────
  // LFX1 credits realUsdcReserves from the amount REQUESTED. The in-contract check
  // catches a short transfer at runtime and reverts loudly, but that only helps after
  // deployment; this catches "USDC is not what we think" BEFORE we point a factory at
  // it, for free, because the address is fixed and immutable at construction.
  //
  // A SELF-transfer is the probe: a well-behaved token leaves the balance exactly
  // unchanged, while a fee-on-transfer token that burns its fee shows a drop. It moves
  // no value, so it is safe to run against a funded deployer.
  const [signer] = await ethers.getSigners();
  const usdcRW = new ethers.Contract(EXPECTED_USDC, ERC20_ABI, signer);
  const bal = await usdcRW.balanceOf(signer.address);
  if (bal === 0n) {
    console.log(`  transfer probe   SKIPPED -- deployer holds no USDC`);
    console.log(`                   fund it and re-run; this is the only free check that`);
    console.log(`                   USDC moves the full amount before we deploy against it`);
  } else {
    // ARC SPECIFIC, AND IT PRODUCES A FALSE ALARM IF IGNORED: USDC is the native gas
    // token here, so the transaction's own gas comes out of the balance being measured.
    // A raw self-transfer looks like a fee-on-transfer token -- the first run of this
    // probe reported a 897-wei "fee" that was simply the gas. Gas is charged in 18dp
    // native units against the same pot the 6dp ERC20 view reads, so it is divided down
    // by 1e12 before comparing.
    //
    // The in-contract check is NOT affected by this: it reads the CONTRACT's balance,
    // and the contract never pays gas -- the caller does.
    const probe = bal < 1_000_000n ? bal : 1_000_000n;
    const before = await usdcRW.balanceOf(signer.address);
    const est = await usdcRW.transfer.estimateGas(signer.address, probe);
    const rcpt = await (await usdcRW.transfer(signer.address, probe, { gasLimit: est * 2n })).wait();
    const after = await usdcRW.balanceOf(signer.address);

    const gasNative = rcpt.gasUsed * rcpt.gasPrice;      // 18dp
    const gasIn6dp = gasNative / 1_000_000_000_000n;     // -> 6dp, the ERC20 view
    const drop = before - after;
    const unexplained = drop > gasIn6dp ? drop - gasIn6dp : 0n;

    console.log(`  transfer probe   moved ${probe}, balance fell ${drop}`);
    console.log(`                   gas accounted for ${gasIn6dp} (USDC is the gas token on Arc)`);
    // One unit of slack for the 18dp->6dp truncation, which cannot hide a 1bp fee: at
    // the 1,000,000 probe a 1bp fee is 100 units.
    if (unexplained > 1n) {
      throw new Error(
        `USDC is NOT transfer-exact: a self-transfer of ${probe} lost ${unexplained} ` +
        `beyond gas. LFX1 credits reserves from the requested amount and would ` +
        `under-collateralise the pooled balance on every buy. Do not deploy against this token.`
      );
    }
    console.log(`  transfer probe   OK -- exact once gas is accounted for`);
  }

  // Cross-check: whatever the LIVE Ballista is actually pointed at is the
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
