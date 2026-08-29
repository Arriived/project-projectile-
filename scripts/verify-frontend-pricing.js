// Proves the frontend pricing fix against the LIVE deployment.
//
// The deleted JS math took only buyFeeBps and had no snipe-tax parameter. The contract
// charges c.buyFeeBps + taxBps, and the tax decays per second from 9800 bps. So in the
// first seconds after a launch the two disagree enormously. This launches a token and
// measures the gap second by second, then confirms the sell side quotes NET.
//
//   BALLISTA_ADDRESS=0x... npx hardhat run scripts/verify-frontend-pricing.js --network arcTestnet
const hre = require("hardhat");
const { ethers } = hre;

const BALLISTA = process.env.BALLISTA_ADDRESS;
const USDC_ADDR = "0x3600000000000000000000000000000000000000";
const BPS = 10000n;

// The exact function the frontend used to use, reproduced here ONLY to measure how wrong
// it was. It is not exported and must never be copied back into the app.
function ceilDiv(a, b) { return (a + b - 1n) / b; }
function deletedJsBuyMath(vUsdc, vToken, usdcIn, buyFeeBps) {
  const fee = (usdcIn * BigInt(buyFeeBps)) / BPS;
  const usdcInAfterFee = usdcIn - fee;
  const k = vUsdc * vToken;
  const newVirtualUsdc = vUsdc + usdcInAfterFee;
  const newVirtualToken = ceilDiv(k, newVirtualUsdc);
  if (newVirtualToken > vToken) return 0n;
  return vToken - newVirtualToken;
}

async function main() {
  if (!BALLISTA) throw new Error("set BALLISTA_ADDRESS");
  const [signer] = await ethers.getSigners();
  const f = await ethers.getContractAt("LFX1", BALLISTA);
  const usdc = new ethers.Contract(USDC_ADDR, [
    "function approve(address,uint256) returns (bool)",
  ], signer);

  console.log(`factory ${BALLISTA}`);
  await (await usdc.approve(BALLISTA, ethers.MaxUint256)).wait();

  const hash = await f.currentEconomicsHash();
  const sym = "PRC" + Date.now().toString().slice(-4);
  const rc = await (await f.createToken("PriceCheck", sym, "", hash, false, { gasLimit: 6000000 })).wait();
  const token = rc.logs.map((l) => { try { return f.interface.parseLog(l); } catch { return null; } })
    .filter(Boolean).find((l) => l.name === "TokenCreated").args.token;
  console.log(`launched ${sym} -> ${token}\n`);

  const probe = 1_000_000n; // 1 USDC
  console.log("contract quoteBuy vs the DELETED JS math, 1 USDC, as the snipe tax decays");
  console.log("elapsed  taxBps  contract tokensOut        deleted-JS tokensOut      JS error");
  for (let i = 0; i < 9; i++) {
    const c = await f.curves(token);
    const tax = await f.currentSnipeTaxBps(token);
    const q = await f.quoteBuy(token, probe);
    const js = deletedJsBuyMath(c.virtualUsdcReserves, c.virtualTokenReserves, probe, c.buyFeeBps);
    const ratio = q.tokensOut === 0n ? 0 : Number(js * 1000n / q.tokensOut) / 1000;
    console.log(
      String(i).padEnd(9) + String(tax).padEnd(8) +
      q.tokensOut.toString().padEnd(26) + js.toString().padEnd(26) +
      (q.tokensOut === 0n ? "-" : ratio.toFixed(2) + "x too high")
    );
    await new Promise((r) => setTimeout(r, 1000));
  }

  console.log("\nsell side: gross vs net");
  const q = await f.quoteBuy(token, probe);
  const qs = await f.quoteSell(token, q.tokensOut);
  console.log(`  usdcOutGross ${qs.usdcOutGross}  fee ${qs.fee}  NET ${qs.usdcOutGross - qs.fee}`);
  console.log(`  sell() compares minUsdcOut against the NET figure; quoting gross would`);
  console.log(`  set an unreachable floor and revert every sell.`);

  const spot = await f.currentPrice(token);
  const eff = q.tokensOut === 0n ? 0n : (q.actualUsdcIn * 10n ** 18n) / q.tokensOut;
  console.log(`\nprice impact on 1 USDC: spot ${spot}  effective ${eff}  ` +
    (spot > 0n && eff > spot ? (Number((eff - spot) * 10000n / spot) / 100).toFixed(3) + "%" : "0%"));
}

main().catch((e) => { console.error(e); process.exit(1); });
