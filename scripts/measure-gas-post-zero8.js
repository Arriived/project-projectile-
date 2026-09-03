// Post-Zero8 gas re-measurement, against the live Arc testnet deployment.
//
// WHY THIS EXISTS RATHER THAN app/scripts/measure-gas.mts: that script samples HISTORICAL
// receipts through the indexer, so every figure it returns predates Zero8. Zero8 (3 Sep
// 2026, 15:00 UTC) is described by Circle as a gas-accounting and state-clearing change at
// the execution layer, so historical receipts are exactly the wrong sample.
//
// This measures estimate-vs-actual for each operation NOW, in one run, so the pair is
// self-consistent. Every number is a real receipt on chain.
//
//   BALLISTA_ADDRESS=0x... npx hardhat run scripts/measure-gas-post-zero8.js --network arcTestnet
//
// Costs a few USDC. Sweeps nothing -- it trades from the deployer directly and the
// positions it opens are tiny.

const hre = require("hardhat");
const { ethers } = hre;

const BALLISTA = process.env.BALLISTA_ADDRESS;
const USDC_ADDR = "0x3600000000000000000000000000000000000000";

// The figures the repo currently asserts, for a side-by-side.
const RECORDED = {
  estimateBuy: 143_576n,
  actualBuy: 194_372n,
  worstSell: 119_254n,
  firstApprove: 47_110n,
  reserveUnits: 249_546n,
};

const rows = [];
function row(op, estimate, actual) {
  const ratio = estimate > 0n ? Number(actual) / Number(estimate) : NaN;
  rows.push({ op, estimate, actual, ratio });
  console.log(
    `  ${op.padEnd(26)} estimate ${String(estimate).padStart(9)}  actual ${String(actual).padStart(9)}  actual/estimate ${ratio.toFixed(3)}`
  );
}

async function main() {
  if (!BALLISTA) throw new Error("set BALLISTA_ADDRESS");
  const [me] = await ethers.getSigners();
  const p = ethers.provider;
  const factory = await ethers.getContractAt("LFX1", BALLISTA);
  const usdc = new ethers.Contract(
    USDC_ADDR,
    [
      "function approve(address,uint256) returns (bool)",
      "function allowance(address,address) view returns (uint256)",
      "function balanceOf(address) view returns (uint256)",
    ],
    me
  );

  const fee = await p.getFeeData();
  console.log("deployer   ", me.address);
  console.log("block      ", await p.getBlockNumber());
  console.log("gasPrice   ", fee.gasPrice?.toString(), "wei");
  console.log("");

  // ── 1. createToken ─────────────────────────────────────────────────────────
  const creationFee = await factory.creationFeeUsdc();
  const cur = await usdc.allowance(me.address, BALLISTA);
  if (cur < creationFee) {
    // Measured too: this is one of the three approve paths under review.
    const est = await usdc.approve.estimateGas(BALLISTA, creationFee);
    const tx = await usdc.approve(BALLISTA, creationFee);
    const rc = await tx.wait();
    row("approve (USDC, exact)", est, rc.gasUsed);
  }

  const hash = await factory.currentEconomicsHash();
  const name = "GasProbe" + Date.now().toString().slice(-5);
  const args = [name, "GP" + Date.now().toString().slice(-4), "", hash, false];

  const estCreate = await factory.createToken.estimateGas(...args);
  const txCreate = await factory.createToken(...args);
  const rcCreate = await txCreate.wait();
  row("createToken", estCreate, rcCreate.gasUsed);

  // Pull the launched address out of the receipt.
  let token = null;
  for (const log of rcCreate.logs) {
    try {
      const parsed = factory.interface.parseLog(log);
      if (parsed && parsed.name === "TokenCreated") { token = parsed.args[0]; break; }
    } catch { /* not ours */ }
  }
  if (!token) throw new Error("could not read TokenCreated from the receipt");
  console.log("  launched  ", token);

  // Trading opens the block AFTER creation, and there is a launch cooldown.
  // ⚠ Wait for the block-0 restriction AND the launch cooldown. Trading opens the block
  // AFTER creation, and estimateGas reverts during that window too -- a 4s wait was not
  // enough on the first run and the whole measurement aborted on a pure timing artifact.
  await new Promise((r) => setTimeout(r, 12000));

  // ── 2. buy ─────────────────────────────────────────────────────────────────
  const spend = 2_000_000n; // 2 USDC
  await (await usdc.approve(BALLISTA, spend)).wait();
  const estBuy = await factory.buy.estimateGas(token, spend, 0n);
  const rcBuy = await (await factory.buy(token, spend, 0n)).wait();
  row("buy", estBuy, rcBuy.gasUsed);

  // ── 3. approve the launched token, then sell ───────────────────────────────
  const tok = new ethers.Contract(
    token,
    ["function approve(address,uint256) returns (bool)", "function balanceOf(address) view returns (uint256)"],
    me
  );
  const held = await tok.balanceOf(me.address);
  const estApproveTok = await tok.approve.estimateGas(BALLISTA, held);
  const rcApproveTok = await (await tok.approve(BALLISTA, held)).wait();
  row("approve (launched token)", estApproveTok, rcApproveTok.gasUsed);

  const estSell = await factory.sell.estimateGas(token, held, 0n);
  const rcSell = await (await factory.sell(token, held, 0n)).wait();
  row("sell (full position)", estSell, rcSell.gasUsed);

  // ── summary ────────────────────────────────────────────────────────────────
  console.log("\n── against the figures the repo asserts ──");
  const buy = rows.find((r) => r.op === "buy");
  const sell = rows.find((r) => r.op === "sell (full position)");
  const appr = rows.find((r) => r.op.startsWith("approve (launched"));

  const recordedRatio = Number(RECORDED.actualBuy) / Number(RECORDED.estimateBuy);
  console.log(`  buy estimate      recorded ${RECORDED.estimateBuy}  ->  now ${buy.estimate}`);
  console.log(`  buy actual        recorded ${RECORDED.actualBuy}  ->  now ${buy.actual}`);
  console.log(`  actual/estimate   recorded ${recordedRatio.toFixed(3)} (est ${((1 - 1 / recordedRatio) * 100).toFixed(1)}% BELOW actual)  ->  now ${buy.ratio.toFixed(3)}`);
  console.log(`  x3.0 limit covers actual?  ${(buy.estimate * 30n) / 10n} vs ${buy.actual}  -> ${(buy.estimate * 30n) / 10n >= buy.actual ? "YES" : "NO"}`);

  const exitNow = sell.actual + appr.actual;
  const exitPlus50 = (exitNow * 3n) / 2n;
  console.log(`\n  exit (sell + approve)  recorded ${RECORDED.worstSell + RECORDED.firstApprove}  ->  now ${exitNow}`);
  console.log(`  exit +50%              recorded ${RECORDED.reserveUnits}  ->  now ${exitPlus50}`);
  console.log(`  GAS_RESERVE_UNITS 249546 still covers the exit?  ${RECORDED.reserveUnits >= exitNow ? "YES" : "NO"} (margin ${Number(RECORDED.reserveUnits) - Number(exitNow)} units)`);

  console.log("\nJSON " + JSON.stringify(rows.map((r) => ({ ...r, estimate: r.estimate.toString(), actual: r.actual.toString() }))));
}

main().catch((e) => { console.error(e.shortMessage || e.message); process.exitCode = 1; });
