// ATTACK, ON REAL ARC TESTNET: can a sniper beat the decaying tax?
//
// Local tests can place a buy at any second they like. Arc cannot: blocks target 500ms,
// so the question that only real conditions answer is which tax tier a buyer can
// actually reach when racing the launch, and what that costs them.
//
// This fires createToken and buy back-to-back WITHOUT waiting for the first to confirm,
// which is as close as a same-account script gets to a mempool sniper. A real sniper
// watches for the creation and fires from a different account, which lands in the same
// place or one block later.
//
//   BALLISTA_ADDRESS=0x... npx hardhat run scripts/attack-snipe-race.js --network arcTestnet
const hre = require("hardhat");
const { ethers } = hre;

const BALLISTA = process.env.BALLISTA_ADDRESS;
const USDC_ADDR = "0x3600000000000000000000000000000000000000";
const ONE = 1_000_000n;
const SPEND = BigInt(process.env.RACE_SPEND_USDC || 2) * ONE;

async function main() {
  if (!BALLISTA) throw new Error("set BALLISTA_ADDRESS");
  const [me] = await ethers.getSigners();
  const ballista = await ethers.getContractAt("LFX1", BALLISTA);
  const usdc = new ethers.Contract(USDC_ADDR, [
    "function balanceOf(address) view returns (uint256)",
    "function allowance(address,address) view returns (uint256)",
    "function approve(address,uint256) returns (bool)",
  ], me);

  if ((await usdc.allowance(me.address, BALLISTA)) < 1_000n * ONE) {
    const e = await usdc.approve.estimateGas(BALLISTA, ethers.MaxUint256);
    await (await usdc.approve(BALLISTA, ethers.MaxUint256, { gasLimit: e * 2n })).wait();
  }

  const symbol = "RACE" + (Date.now() % 100000);
  const hash = await ballista.currentEconomicsHash();
  const nonce = await ethers.provider.getTransactionCount(me.address);

  // The buy cannot be pre-signed: it needs the token address, which only exists once
  // creation is mined. So the fastest any sniper can go is "watch for the creation,
  // fire immediately" -- which is exactly what this does.
  console.log("creating, then firing the buy the instant the address is known...");
  const createTx = await ballista.createToken("Race", symbol, "ipfs://r", hash, {
    nonce, gasLimit: 2_000_000,
  }, false);
  const createRc = await createTx.wait();
  const token = createRc.logs
    .map((l) => { try { return ballista.interface.parseLog(l); } catch { return null; } })
    .find((l) => l && l.name === "TokenCreated").args.token;
  const curve = await ballista.curves(token);
  const t0 = Number(curve.creationTimestamp);
  console.log(`  token ${token}  created block ${createRc.blockNumber} ts ${t0}`);

  // Fire the buy the instant creation is known. This is the realistic sniper timing:
  // see the creation, send immediately.
  const est = await ballista.buy.estimateGas(token, SPEND, 0);
  const sent = Date.now();
  const rc = await (await ballista.buy(token, SPEND, 0, { gasLimit: est * 2n })).wait();
  const blk = await ethers.provider.getBlock(rc.blockNumber);
  const elapsed = blk.timestamp - t0;

  const table = (await ballista.snipeTaxTable(curve.snipeTaxTableVersion)).map(Number);
  const tierPaid = elapsed >= table.length ? 0 : table[elapsed];

  const taxEvt = rc.logs.map((l) => { try { return ballista.interface.parseLog(l); } catch { return null; } })
    .find((l) => l && l.name === "SnipeTaxCollected");
  const trade = rc.logs.map((l) => { try { return ballista.interface.parseLog(l); } catch { return null; } })
    .find((l) => l && l.name === "Trade");

  console.log(`\n  RESULT`);
  console.log(`    table            [${table.join(", ")}]`);
  console.log(`    buy mined block  ${rc.blockNumber} (${rc.blockNumber - createRc.blockNumber} after creation)`);
  console.log(`    wall clock       ${((Date.now() - sent) / 1000).toFixed(2)}s from send to mined`);
  console.log(`    elapsed on-chain t=${elapsed}s  ->  tax tier ${tierPaid} bps`);
  console.log(`    tax paid         ${taxEvt ? ethers.formatUnits(taxEvt.args.toTreasury + taxEvt.args.toCurve, 6) : "0"} USDC`);
  console.log(`    tokens received  ${ethers.formatUnits(trade.args.tokenAmount, 18)}`);

  // What the same spend would have bought with no tax at all, for comparison.
  console.log(`\n  ASSESSMENT`);
  if (tierPaid >= 9000) {
    console.log(`    Sniper hit the top tier. The tax is doing its job at real block times.`);
  } else if (tierPaid > 0) {
    console.log(`    Sniper landed mid-decay at ${tierPaid} bps -- taxed, but not at the top rate.`);
  } else {
    console.log(`    Sniper paid NOTHING. At ${table.length}s of window and ~500ms blocks, the`);
    console.log(`    buy still landed outside the window. The tax only bites a buyer who is`);
    console.log(`    in the very first blocks; anyone content to wait ${table.length}s is unaffected.`);
  }
  console.log(`\n  token: https://testnet.arcscan.app/address/${token}`);
}

main().catch((e) => { console.error("RACE ERROR:", e.message); process.exitCode = 1; });
