// Economics stress model. Runs real trades through a real Ballista deployment on a
// local chain and reports what the fee model actually produces, including rounding.
// This is a REPORT, not a test -- re-run it with different inputs.
//
//   npx hardhat run scripts/economics.js
//
// Overrides (all optional):
//   ECON_VOLUMES=10000,100000,1000000   lifetime volumes to model, USDC
//   ECON_CHUNK=5000                     size of each simulated buy, USDC
//   ECON_GAS_PER_LAUNCH=900209          measured createToken gas (Arc Testnet)
//   ECON_GAS_PRICE_GWEI=21              measured Arc Testnet gas price
const hre = require("hardhat");
const { ethers } = hre;
const { activateRouter } = require('../test/routerHelper');

const ONE = 1_000_000n; // 1 USDC, 6dp
const BPS = 10_000n;

// Measured on Arc Testnet, not estimated. createToken from the live smoke test.
const GAS_PER_LAUNCH = BigInt(process.env.ECON_GAS_PER_LAUNCH || 900209);
const GAS_PRICE_WEI = BigInt(process.env.ECON_GAS_PRICE_GWEI || 21) * 10n ** 9n;

const VOLUMES = (process.env.ECON_VOLUMES || "10000,100000,1000000")
  .split(",").map((v) => BigInt(v.trim()));
const CHUNK = BigInt(process.env.ECON_CHUNK || 5000);

const usd = (v) => "$" + Number(ethers.formatUnits(v, 6)).toLocaleString("en-US", {
  minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pct = (n, d) => d === 0n ? "n/a" : ((Number(n) / Number(d)) * 100).toFixed(2) + "%";

async function freshDeployment({ creationFee, creatorBuy, creatorSell }) {
  const [deployer, treasury, creator, trader] = await ethers.getSigners();
  const usdc = await (await ethers.getContractFactory("MockUSDC")).deploy();
  const ballista = await (await ethers.getContractFactory("LFX1"))
    .deploy(await usdc.getAddress(), treasury.address, ethers.ZeroAddress);
  const router = await (await ethers.getContractFactory("MockRouter")).deploy();
  await activateRouter(ballista, await router.getAddress());
  // Steady-state economics: the snipe tax is a launch-window deterrent, not part of
  // the ongoing fee model, and leaving it on would distort early volume.
  await ballista.publishSnipeTaxTable([]);
  await ballista.setCreationFee(creationFee);
  await ballista.setDefaultCreatorFees(creatorBuy, creatorSell);
  await ballista.setLaunchCooldown(0);

  for (const s of [creator, trader]) {
    await usdc.mint(s.address, 100_000_000n * ONE);
    await usdc.connect(s).approve(await ballista.getAddress(), ethers.MaxUint256);
  }
  return { deployer, treasury, creator, trader, usdc, ballista };
}

async function launch(ballista, creator, symbol) {
  const hash = await ballista.currentEconomicsHash();
  const rc = await (await ballista.connect(creator)
    .createToken("Econ", symbol, "ipfs://e", hash, false)).wait();
  return rc.logs.map((l) => { try { return ballista.interface.parseLog(l); } catch { return null; } })
    .find((l) => l && l.name === "TokenCreated").args.token;
}

// Trades a token until `targetVolume` of USDC has moved, at the given buy:sell mix.
// Volume counts USDC in on buys plus gross USDC out on sells -- both are fee-bearing.
// Stops early if the curve graduates, and reports that it did.
async function simulate(env, symbol, targetVolume, buyShare) {
  const { ballista, usdc, creator, trader, treasury } = env;
  const tokenAddress = await launch(ballista, creator, symbol);
  const token = await ethers.getContractAt("LFX1Token", tokenAddress);
  const ballistaAddr = await ballista.getAddress();
  await token.connect(trader).approve(ballistaAddr, ethers.MaxUint256);

  const creatorStart = await ballista.creatorFeesAccrued(creator.address);
  const treasuryStart = await usdc.balanceOf(treasury.address);

  let buyVol = 0n, sellVol = 0n, graduated = false, rounds = 0;
  const sellRatio = (100n - buyShare) * 100n / buyShare; // sell USDC per 100 buy USDC

  while (buyVol + sellVol < targetVolume) {
    if ((await ballista.curves(tokenAddress)).state !== 0n) { graduated = true; break; }

    const remaining = targetVolume - buyVol - sellVol;
    const buyAmt = (remaining < CHUNK * ONE ? remaining : CHUNK * ONE);
    if (buyAmt < ONE) break;

    await ballista.connect(trader).buy(tokenAddress, buyAmt, 0);
    buyVol += buyAmt;
    rounds++;

    if ((await ballista.curves(tokenAddress)).state !== 0n) { graduated = true; break; }

    // Sell enough to hit the target mix. The first estimate scales off the whole
    // position's quote, which UNDER-prices because selling everything walks the curve
    // down -- that overshoots the token count and oversells. Refine against the real
    // quote a few times so the realized mix matches the target instead of drifting
    // sell-heavy.
    const wantSell = (buyAmt * sellRatio) / 100n;
    if (wantSell === 0n) continue;
    const held = await token.balanceOf(trader.address);
    if (held === 0n) continue;
    const whole = await ballista.quoteSell(tokenAddress, held);
    if (whole.usdcOutGross === 0n) continue;
    let tokensToSell = (held * wantSell) / whole.usdcOutGross;
    for (let k = 0; k < 4; k++) {
      if (tokensToSell > held) tokensToSell = held;
      if (tokensToSell === 0n) break;
      const probe = await ballista.quoteSell(tokenAddress, tokensToSell);
      if (probe.usdcOutGross === 0n) break;
      const next = (tokensToSell * wantSell) / probe.usdcOutGross;
      if (next === tokensToSell || next === 0n) break;
      tokensToSell = next;
    }
    if (tokensToSell > held) tokensToSell = held;
    if (tokensToSell === 0n) continue;

    const q = await ballista.quoteSell(tokenAddress, tokensToSell);
    await ballista.connect(trader).sell(tokenAddress, tokensToSell, 0);
    sellVol += q.usdcOutGross;
  }

  const creatorEarned = (await ballista.creatorFeesAccrued(creator.address)) - creatorStart;
  const treasuryEarned = (await usdc.balanceOf(treasury.address)) - treasuryStart;
  const creationFee = await ballista.creationFeeUsdc();
  // The creation fee also lands in treasury; separate it from trading revenue.
  const tradingRevenue = treasuryEarned - creationFee;

  return {
    buyVol, sellVol, totalVol: buyVol + sellVol, graduated, rounds,
    creatorEarned, tradingRevenue, creationFee,
    protocolTotal: tradingRevenue + creationFee,
    realizedBuyShare: buyVol + sellVol === 0n ? 0n : (buyVol * 100n) / (buyVol + sellVol),
  };
}

async function main() {
  console.log("=".repeat(78));
  console.log("  BALLISTA ECONOMICS -- measured through the contract, not modelled");
  console.log("=".repeat(78));

  const NEW = { creationFee: ONE / 2n, creatorBuy: 90, creatorSell: 50 };
  const OLD = { creationFee: 5n * ONE, creatorBuy: 30, creatorSell: 30 };

  // ── 1. blended creator share across mixes ──────────────────────────────
  console.log("\n1. BLENDED CREATOR SHARE BY BUY/SELL MIX");
  console.log("   Buy side pays 90% of the fee, sell side 50%. Blend is what a creator");
  console.log("   actually earns over a token's life, and the only honest headline rate.\n");
  console.log("   target   realized     volume        creator      protocol   creator");
  console.log("   mix      mix          traded        earned       (trading)  share");
  console.log("   " + "-".repeat(72));

  const env = await freshDeployment(NEW);
  let i = 0;
  for (const buyShare of [70n, 60n, 50n, 40n]) {
    const r = await simulate(env, "MIX" + i++, 200_000n * ONE, buyShare);
    // A lifetime mix below 50:50 buy is structurally impossible, not merely unusual:
    // every token sold must have been bought first, so cumulative sell volume can
    // never exceed cumulative buy volume. The simulator clamps to selling everything.
    if (buyShare < 50n && r.realizedBuyShare >= 50n) {
      console.log(`   ${buyShare}:${100n - buyShare}    STRUCTURALLY UNREACHABLE over a full lifetime --`);
      console.log(`             every token sold must first have been bought, so sell volume`);
      console.log(`             cannot exceed buy volume. Clamps to 50:50, the sell-everything`);
      console.log(`             limit, with identical economics to the 50:50 row above.`);
      continue;
    }
    const fees = r.creatorEarned + r.tradingRevenue;
    console.log(
      `   ${buyShare}:${100n - buyShare}    ${r.realizedBuyShare}:${100n - r.realizedBuyShare}` +
      `        ${usd(r.totalVol).padStart(12)}  ${usd(r.creatorEarned).padStart(11)}` +
      `  ${usd(r.tradingRevenue).padStart(10)}  ${pct(r.creatorEarned, fees).padStart(7)}` +
      (r.graduated ? "  [GRADUATED]" : "")
    );
  }

  // ── 2. protocol revenue, old vs new ────────────────────────────────────
  console.log("\n2. PROTOCOL REVENUE PER TOKEN -- OLD MODEL vs NEW");
  console.log("   OLD: 5 USDC launch + 30% creator (symmetric)");
  console.log("   NEW: 0.5 USDC launch + 90% buy / 50% sell");
  console.log("   Both at a 50:50 mix, the neutral case.\n");
  console.log("   volume        model   launch   trading      protocol    creator");
  console.log("   " + "-".repeat(72));

  const results = {};
  for (const vol of VOLUMES) {
    for (const [name, cfg] of [["OLD", OLD], ["NEW", NEW]]) {
      const e = await freshDeployment(cfg);
      const r = await simulate(e, name + vol, vol * ONE, 50n);
      results[`${name}-${vol}`] = r;
      console.log(
        `   ${("$" + vol.toLocaleString("en-US")).padStart(12)}  ${name}` +
        `     ${usd(r.creationFee).padStart(6)}  ${usd(r.tradingRevenue).padStart(10)}` +
        `  ${usd(r.protocolTotal).padStart(10)}  ${usd(r.creatorEarned).padStart(10)}` +
        (r.graduated ? "  [GRADUATED early]" : "")
      );
    }
  }

  console.log("\n   Volume multiple needed for NEW to match OLD protocol revenue:");
  for (const vol of VOLUMES) {
    const o = results[`OLD-${vol}`], n = results[`NEW-${vol}`];
    if (!o || !n || n.protocolTotal === 0n) continue;
    const ratio = Number(o.protocolTotal) / Number(n.protocolTotal);
    console.log(`     at $${vol.toLocaleString("en-US")} volume: ${ratio.toFixed(2)}x` +
      `   (old ${usd(o.protocolTotal)} vs new ${usd(n.protocolTotal)})`);
  }

  // ── 3. spam cost ───────────────────────────────────────────────────────
  console.log("\n3. SPAM COST AT 0.5 USDC, WITH REAL MEASURED ARC GAS");
  const gasCostWei = GAS_PER_LAUNCH * GAS_PRICE_WEI;
  const gasUsdc = gasCostWei / 10n ** 12n; // 18dp native -> 6dp USDC
  console.log(`   createToken measured at ${GAS_PER_LAUNCH} gas @ ${GAS_PRICE_WEI / 10n ** 9n} gwei` +
    ` = ${usd(gasUsdc)} per launch\n`);
  console.log("   launches      fee cost      gas cost     total       per day at 10s cooldown");
  console.log("   " + "-".repeat(72));
  for (const fee of [ONE / 10n, ONE / 2n, 5n * ONE]) {
    console.log(`   fee ${usd(fee)}:`);
    for (const n of [1000n, 10000n]) {
      const feeCost = fee * n, gasTotal = gasUsdc * n;
      console.log(`     ${n.toString().padStart(6)}      ${usd(feeCost).padStart(11)}` +
        `  ${usd(gasTotal).padStart(11)}  ${usd(feeCost + gasTotal).padStart(11)}`);
    }
    const perDay = 8640n; // 86400s / 10s cooldown, one wallet
    console.log(`     ${perDay} (1 wallet, cooldown-limited, 24h): ` +
      `${usd((fee + gasUsdc) * perDay)}`);
  }

  // ── 4. what a creator actually sees ────────────────────────────────────
  console.log("\n4. CREATOR EARNINGS AT $100k LIFETIME VOLUME");
  console.log("   The number to market. Measured, at several mixes.\n");
  console.log("   mix        creator earned    protocol (trading)   creator share");
  console.log("   " + "-".repeat(72));
  const e100 = await freshDeployment(NEW);
  let j = 0;
  for (const buyShare of [70n, 60n, 50n]) {
    const r = await simulate(e100, "C" + j++, 100_000n * ONE, buyShare);
    const fees = r.creatorEarned + r.tradingRevenue;
    console.log(`   ${r.realizedBuyShare}:${100n - r.realizedBuyShare}` +
      `      ${usd(r.creatorEarned).padStart(14)}  ${usd(r.tradingRevenue).padStart(18)}` +
      `   ${pct(r.creatorEarned, fees).padStart(8)}` +
      (r.graduated ? "  [GRADUATED]" : ""));
  }

  console.log("\n" + "=".repeat(78));
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
