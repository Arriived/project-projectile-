// ATTACK MODEL: is the graduation overshoot profitably arbitrageable?
//
// The scenario. Others fund the curve to just under the 67,000 threshold. An attacker
// then sends the buy that crosses it. That buy is priced along the curve, but it also
// funds a DEX pool that opens ABOVE the curve's closing price (measured +2.4% at tight
// graduation, up to +23% at heavy overshoot). The attacker therefore ends the
// transaction holding tokens bought below the price of the pool they just created.
//
// Question: can they sell into that pool for more than they spent?
//
// The curve side is real -- actual Ballista, actual fees, actual rounding. The pool
// side is modelled as a Uniswap-V2 constant product AMM with a 30 bps swap fee, seeded
// with exactly the reserves the Graduated event reports. That is the closest available
// model; Arc's DEX and version are unconfirmed, so treat the pool side as indicative.
//
//   npx hardhat run scripts/attack-overshoot.js
const hre = require("hardhat");
const { ethers } = hre;

const ONE = 1_000_000n;
const SWAP_FEE_NUM = 997n, SWAP_FEE_DEN = 1000n; // 0.30%, Uniswap V2

const usd = (v) => "$" + Number(ethers.formatUnits(v, 6)).toLocaleString("en-US",
  { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// Constant-product output for selling `dIn` tokens into (tokenRes, usdcRes).
function ammOut(dIn, tokenRes, usdcRes) {
  const inWithFee = (dIn * SWAP_FEE_NUM) / SWAP_FEE_DEN;
  return (usdcRes * inWithFee) / (tokenRes + inWithFee);
}

async function setup() {
  const [deployer, treasury, creator, whale, attacker] = await ethers.getSigners();
  const usdc = await (await ethers.getContractFactory("MockUSDC")).deploy();
  const ballista = await (await ethers.getContractFactory("Ballista"))
    .deploy(await usdc.getAddress(), treasury.address);
  const router = await (await ethers.getContractFactory("MockRouter")).deploy();
  await ballista.setRouter(await router.getAddress());
  await ballista.publishSnipeTaxTable([]); // the attack happens long after launch
  await ballista.setLaunchCooldown(0);
  for (const s of [creator, whale, attacker]) {
    await usdc.mint(s.address, 100_000_000n * ONE);
    await usdc.connect(s).approve(await ballista.getAddress(), ethers.MaxUint256);
  }
  return { ballista, usdc, creator, whale, attacker };
}

async function launch(ballista, creator, symbol) {
  const hash = await ballista.currentEconomicsHash();
  const rc = await (await ballista.connect(creator)
    .createToken("Overshoot", symbol, "ipfs://a", hash)).wait();
  return rc.logs.map((l) => { try { return ballista.interface.parseLog(l); } catch { return null; } })
    .find((l) => l && l.name === "TokenCreated").args.token;
}

// Runs one attack: prefund to `prefund`, then attacker buys `attackBuy` to graduate.
async function runAttack(env, symbol, prefund, attackBuy) {
  const { ballista, whale, attacker, creator } = env;
  const tokenAddress = await launch(ballista, creator, symbol);
  const token = await ethers.getContractAt("ArcLaunchToken", tokenAddress);

  if (prefund > 0n) await ballista.connect(whale).buy(tokenAddress, prefund, 0);
  const pre = await ballista.curves(tokenAddress);
  if (pre.state !== 0n) return null; // prefund alone graduated it; not the case under test

  const before = await token.balanceOf(attacker.address);
  const rc = await (await ballista.connect(attacker).buy(tokenAddress, attackBuy, 0)).wait();
  const grad = rc.logs.map((l) => { try { return ballista.interface.parseLog(l); } catch { return null; } })
    .find((l) => l && l.name === "Graduated");
  if (!grad) return null; // did not graduate
  const trade = rc.logs.map((l) => { try { return ballista.interface.parseLog(l); } catch { return null; } })
    .find((l) => l && l.name === "Trade");

  const acquired = (await token.balanceOf(attacker.address)) - before;
  const spent = trade.args.usdcAmount; // actual, after any clamp
  let poolToken = grad.args.tokenLiquidity;
  let poolUsdc = grad.args.usdcLiquidity;

  // Sweep the fraction of the position sold, and find the best the attacker can do.
  let best = { profit: -(2n ** 255n), frac: 0, proceeds: 0n };
  for (let pctTimes10 = 1; pctTimes10 <= 1000; pctTimes10 += 1) {
    const dIn = (acquired * BigInt(pctTimes10)) / 1000n;
    if (dIn === 0n) continue;
    const out = ammOut(dIn, poolToken, poolUsdc);
    const profit = out - spent;
    if (profit > best.profit) best = { profit, frac: pctTimes10 / 10, proceeds: out };
  }
  return {
    spent, acquired, poolUsdc, poolToken,
    best,
    // Absolute ceiling: even draining the entire pool cannot return more than it holds.
    poolCeiling: poolUsdc,
  };
}

async function main() {
  console.log("=".repeat(80));
  console.log("  ATTACK: graduation overshoot arbitrage");
  console.log("  Curve side = real contract. Pool side = V2 constant product, 30bps fee.");
  console.log("=".repeat(80));

  const env = await setup();
  // NOTE on sizing: the 1% buy fee means a gross spend nets only 99% into reserves,
  // so "others to 66k" does NOT reach the 67k threshold. Prefund figures are GROSS and
  // chosen so the ATTACKER's buy is what actually crosses.
  //
  // The tight cases matter most: the smallest position that still triggers graduation
  // takes the least slippage selling into the pool, so if this arbitrage is ever
  // profitable, it is profitable there.
  const cases = [
    ["solo graduation (attacker funds whole curve)",            0n,      80_000n],
    ["TIGHTEST (others 67.6k, attacker crosses w/ 100)",   67_600n,         100n],
    ["very tight (others 67.5k, attacker 250)",           67_500n,         250n],
    ["tight (others 67k, attacker 700)",                  67_000n,         700n],
    ["small overshoot (others 60k, attacker 10k)",        60_000n,      10_000n],
    ["heavy overshoot (others 50k, attacker 30k)",        50_000n,      30_000n],
    ["huge overshoot  (others 40k, attacker 60k)",        40_000n,      60_000n],
    ["max overshoot   (others 20k, attacker 200k)",       20_000n,     200_000n],
  ];

  console.log("\n  scenario                                     spent      best sale   profit");
  console.log("  " + "-".repeat(76));
  let i = 0;
  const rows = [];
  for (const [label, pre, atk] of cases) {
    const r = await runAttack(env, "OVR" + i++, pre * ONE, atk * ONE);
    if (!r) { console.log(`  ${label.padEnd(44)} -- did not graduate`); continue; }
    rows.push([label, r]);
    const sign = r.best.profit >= 0n ? "+" : "-";
    const abs = r.best.profit >= 0n ? r.best.profit : -r.best.profit;
    console.log(
      `  ${label.padEnd(44)} ${usd(r.spent).padStart(10)}` +
      ` ${usd(r.best.proceeds).padStart(11)}  ${sign}${usd(abs)}` +
      `  @ ${r.best.frac}% of position`
    );
  }

  console.log("\n  Why the solo case cannot work, structurally:");
  const solo = rows.find(([l]) => l.startsWith("solo"));
  if (solo) {
    const r = solo[1];
    console.log(`    attacker spent      ${usd(r.spent)}`);
    console.log(`    entire pool holds   ${usd(r.poolCeiling)}  <- hard ceiling on any recovery`);
    console.log(`    a constant-product pool can never be fully drained, so real recovery is`);
    console.log(`    strictly below that. Spending more than the pool will ever hold cannot`);
    console.log(`    be recovered from the pool by anyone, at any size, ever.`);
  }

  console.log("\n  How close each scenario came, as a fraction of what was spent:");
  for (const [label, r] of rows) {
    const bps = (Number(r.best.profit) / Number(r.spent)) * 10_000;
    console.log(`    ${label.padEnd(48)} ${bps >= 0 ? "+" : ""}${bps.toFixed(1)} bps`);
  }

  console.log("\n  Detail on the profitable-looking cases:");
  for (const [label, r] of rows) {
    if (r.best.profit <= 0n) continue;
    const roi = (Number(r.best.profit) / Number(r.spent)) * 100;
    console.log(`\n    ${label}`);
    console.log(`      spent          ${usd(r.spent)}`);
    console.log(`      acquired       ${ethers.formatUnits(r.acquired, 18)} tokens`);
    console.log(`      pool opened    ${usd(r.poolUsdc)} / ${ethers.formatUnits(r.poolToken, 18)} tokens`);
    console.log(`      best sale      ${r.best.frac}% of position -> ${usd(r.best.proceeds)}`);
    console.log(`      PROFIT         ${usd(r.best.profit)}   (${roi.toFixed(2)}% ROI)`);
    const leftover = (r.acquired * BigInt(Math.round((100 - r.best.frac) * 10))) / 1000n;
    console.log(`      still holding  ${ethers.formatUnits(leftover, 18)} tokens on top of that`);
  }

  console.log("\n" + "=".repeat(80));
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
