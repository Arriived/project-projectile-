// Live smoke test against a deployed Ballista. Creates a token, trades on it, and
// checks the behaviours that had only ever been exercised in the simulator.
// Spends real (testnet) USDC. Reports gas for every transaction.
//
// GAS: every transaction here is sent with an explicit limit of 2x the estimate.
// Arc's eth_estimateGas returns a figure with no usable margin, and hardhat-ethers
// sends at exactly the estimate with no buffer of its own. A buy() sent at the bare
// estimate (198,794) ran out of gas on-chain, while the identical call with a
// 400,000 limit succeeded using only 192,616 -- less than the estimate that failed.
// Do not send transactions at the bare estimate on Arc.
const hre = require("hardhat");
const { ethers } = hre;

const BALLISTA = process.env.BALLISTA_ADDRESS;
const USDC_ADDR = "0x3600000000000000000000000000000000000000";
const ONE_USDC = 1_000_000n;
const GAS_BUFFER = 2n;

const gas = [];
async function send(label, contract, method, args) {
  const est = await contract[method].estimateGas(...args);
  const tx = await contract[method](...args, { gasLimit: est * GAS_BUFFER });
  const r = await tx.wait();
  gas.push({ label, est, gasUsed: r.gasUsed, cost: r.gasUsed * r.gasPrice });
  if (r.status !== 1) throw new Error(`${label} reverted (tx ${r.hash})`);
  return r;
}

function parse(iface, receipt, name) {
  return receipt.logs
    .map((l) => { try { return iface.interface.parseLog(l); } catch { return null; } })
    .filter((l) => l && l.name === name);
}

// Wallet balance deltas are useless for attribution on this deployment: treasury ==
// deployer == trader, so fees paid "to treasury" land back in the same wallet, and gas
// is paid from that same USDC pot too. Read the actual USDC Transfer events instead.
const USDC_TRANSFER_TOPIC = ethers.id("Transfer(address,address,uint256)");
function usdcTransferTo(receipt, to) {
  const pad = ethers.zeroPadValue(ethers.getAddress(to), 32).toLowerCase();
  let sum = 0n;
  for (const l of receipt.logs) {
    if (l.address.toLowerCase() !== USDC_ADDR.toLowerCase()) continue;
    if (l.topics[0] !== USDC_TRANSFER_TOPIC) continue;
    if (l.topics[2].toLowerCase() !== pad) continue;
    sum += BigInt(l.data);
  }
  return sum;
}

const results = [];
function check(label, pass, detail = "") {
  results.push({ label, pass, detail });
  console.log(`  ${pass ? "PASS" : "**FAIL**"}  ${label}${detail ? `  -- ${detail}` : ""}`);
}

async function main() {
  if (!BALLISTA) throw new Error("set BALLISTA_ADDRESS");
  const [me] = await ethers.getSigners();
  const ballista = await ethers.getContractAt("LFX1", BALLISTA);
  const usdc = new ethers.Contract(USDC_ADDR, [
    "function balanceOf(address) view returns (uint256)",
    "function approve(address,uint256) returns (bool)",
    "function allowance(address,address) view returns (uint256)",
  ], me);

  // On Arc the ERC20 USDC balance and the native gas balance are the SAME pot, just
  // exposed at 6 and 18 decimals. Gas and trading capital compete for it.
  const wallet = await usdc.balanceOf(me.address);
  const creationFee = await ballista.creationFeeUsdc();
  const spend = BigInt(process.env.SMOKE_SPEND_USDC || 5) * ONE_USDC;

  console.log(`ballista ${BALLISTA}`);
  console.log(`actor    ${me.address}`);
  console.log(`usdc     ${ethers.formatUnits(wallet, 6)} (6dp; same pot as native gas)`);
  console.log(`plan     fee ${ethers.formatUnits(creationFee, 6)} + buy ${ethers.formatUnits(spend, 6)} + gas\n`);

  if (wallet < creationFee + spend + 2n * ONE_USDC) {
    throw new Error(`insufficient USDC: have ${ethers.formatUnits(wallet, 6)}, need ~${ethers.formatUnits(creationFee + spend + 2n * ONE_USDC, 6)}`);
  }

  if ((await usdc.allowance(me.address, BALLISTA)) < 1_000_000n * ONE_USDC) {
    await send("approve USDC", usdc, "approve", [BALLISTA, ethers.MaxUint256]);
  }

  // ── create ───────────────────────────────────────────────────────────
  console.log("CREATE");
  const symbol = "SMK" + (Date.now() % 100000);
  const hash = await ballista.currentEconomicsHash();
  const createRcpt = await send("createToken", ballista, "createToken",
    ["Smoke Test", symbol, "ipfs://smoke", hash, false]);
  const created = parse(ballista, createRcpt, "TokenCreated")[0];
  const tokenAddress = created.args.token;
  const token = await ethers.getContractAt("LFX1Token", tokenAddress);

  console.log(`  token ${tokenAddress}  symbol ${symbol}  block ${createRcpt.blockNumber}`);
  check("TokenCreated fired with our creator", created.args.creator === me.address);
  check("symbol recorded on the ERC20", (await token.symbol()) === symbol);
  check("full 1B minted to factory, none to creator",
    (await token.balanceOf(BALLISTA)) === 1_000_000_000n * 10n ** 18n &&
    (await token.balanceOf(me.address)) === 0n,
    `factory holds ${ethers.formatUnits(await token.balanceOf(BALLISTA), 18)}`);

  const curve0 = await ballista.curves(tokenAddress);
  check("curve state ACTIVE", curve0.state === 0n);
  check("creationBlock recorded", curve0.creationBlock === BigInt(createRcpt.blockNumber));
  check("creator splits snapshotted (buy 90 / sell 50 bps)",
    curve0.creatorBuyFeeBps === 90n && curve0.creatorSellFeeBps === 50n,
    `buy ${curve0.creatorBuyFeeBps} / sell ${curve0.creatorSellFeeBps}`);
  check("snipeTaxTreasuryBps snapshotted at 7000", curve0.snipeTaxTreasuryBps === 7000n);
  check("snipeTaxTableVersion snapshotted", curve0.snipeTaxTableVersion === 0n);

  // ── block-0 restriction ──────────────────────────────────────────────
  console.log("\nBLOCK-0 RESTRICTION");
  // Assert it from the contract's own rule rather than trying to race a 500ms chain:
  // a call evaluated AT the creation block must be rejected.
  try {
    await ballista.buy.staticCall(tokenAddress, ONE_USDC, 0, {
      blockTag: createRcpt.blockNumber,
    });
    check("buy evaluated at the creation block is rejected", false, "unexpectedly succeeded");
  } catch (e) {
    let name = null;
    try { name = ballista.interface.parseError(e.data).name; } catch (_) {}
    check("buy evaluated at the creation block is rejected",
      name === "TradingNotOpenYet",
      name || (e.shortMessage || e.message).slice(0, 90));
  }
  const head = await ethers.provider.getBlockNumber();
  check("trading open in later blocks", head > Number(curve0.creationBlock),
    `head ${head} > creationBlock ${curve0.creationBlock}`);

  // ── snipe tax at t=0 ─────────────────────────────────────────────────
  console.log("\nSNIPE TAX");
  const t0 = Number(curve0.creationTimestamp);
  const table = (await ballista.snipeTaxTable(curve0.snipeTaxTableVersion)).map(Number);
  console.log(`  table [${table.join(", ")}]  creationTimestamp ${t0}`);

  const nowBlk = await ethers.provider.getBlock("latest");
  const elapsedNow = nowBlk.timestamp - t0;
  // Pin the call to the SAME block the timestamp came from. Reading "latest" and then
  // issuing a separate eth_call races a 500ms chain: a whole second ticks over between
  // the two RPCs, so the contract computes a later elapsed than the script did and the
  // comparison fails against a contract that is behaving correctly.
  const taxNow = Number(
    await ballista.currentSnipeTaxBps.staticCall(tokenAddress, { blockTag: nowBlk.number })
  );
  const expectNow = elapsedNow >= table.length ? 0 : table[elapsedNow];
  check("live tax matches the table for elapsed seconds", taxNow === expectNow,
    `t=${elapsedNow}s -> ${taxNow} bps (expected ${expectNow})`);

  const treasuryAddr = await ballista.treasury();
  if (ethers.getAddress(treasuryAddr) === me.address) {
    console.log(`  NOTE: treasury == trader on this deployment, so balance deltas cannot`);
    console.log(`  attribute fees. All fee checks below read USDC Transfer events instead.`);
  }
  const accruedBefore = await ballista.creatorFeesAccrued(me.address);

  const buyRcpt = await send("buy", ballista, "buy", [tokenAddress, spend, 0]);
  const buyBlk = await ethers.provider.getBlock(buyRcpt.blockNumber);
  const elapsedBuy = buyBlk.timestamp - t0;
  const taxAtBuy = elapsedBuy >= table.length ? 0 : table[elapsedBuy];
  console.log(`  buy landed at t=${elapsedBuy}s -> tax ${taxAtBuy} bps`);

  const trade = parse(ballista, buyRcpt, "Trade")[0];
  const taxEvents = parse(ballista, buyRcpt, "SnipeTaxCollected");
  const feeEvents = parse(ballista, buyRcpt, "CreatorFeeAccrued");

  check("Trade fired, isBuy true", !!trade && trade.args.isBuy === true);
  check("Trade usdcAmount equals what we spent", trade.args.usdcAmount === spend,
    `${ethers.formatUnits(trade.args.usdcAmount, 6)} USDC`);
  check("tokens received match the Trade event",
    (await token.balanceOf(me.address)) === trade.args.tokenAmount,
    `${ethers.formatUnits(trade.args.tokenAmount, 18)} tokens`);

  const totalTax = (spend * BigInt(taxAtBuy)) / 10_000n;
  if (taxAtBuy > 0) {
    check("SnipeTaxCollected fired inside the window", taxEvents.length === 1);
    if (taxEvents.length) {
      const toTreasury = (totalTax * 7000n) / 10_000n;
      check("70/30 treasury/curve split is exact",
        taxEvents[0].args.toTreasury === toTreasury &&
        taxEvents[0].args.toCurve === totalTax - toTreasury,
        `treasury ${ethers.formatUnits(taxEvents[0].args.toTreasury, 6)} / curve ${ethers.formatUnits(taxEvents[0].args.toCurve, 6)}`);
      const curveAfterBuy = await ballista.curves(tokenAddress);
      const baseFee = (spend * 100n) / 10_000n;
      check("curve reserves grew by post-fee spend PLUS the tax share",
        curveAfterBuy.realUsdcReserves === spend - baseFee - totalTax + taxEvents[0].args.toCurve,
        `${ethers.formatUnits(curveAfterBuy.realUsdcReserves, 6)} USDC`);
    }
  } else {
    check("no SnipeTaxCollected outside the window", taxEvents.length === 0,
      `buy landed at t=${elapsedBuy}s, window is ${table.length}s`);
  }

  // ── creator fees ─────────────────────────────────────────────────────
  console.log("\nCREATOR FEES");
  const accruedAfterBuy = await ballista.creatorFeesAccrued(me.address);
  check("creator fees accrued on the buy", accruedAfterBuy > accruedBefore,
    `+${ethers.formatUnits(accruedAfterBuy - accruedBefore, 6)} USDC`);
  check("CreatorFeeAccrued carries this token",
    feeEvents.length === 1 && feeEvents[0].args.token === tokenAddress);
  check("accrual is exactly 0.90% of the buy",
    feeEvents.length > 0 && feeEvents[0].args.amount === (spend * 90n) / 10_000n,
    feeEvents.length ? `${ethers.formatUnits(feeEvents[0].args.amount, 6)} USDC` : "no event");

  const treasuryPaid = usdcTransferTo(buyRcpt, treasuryAddr);
  const expectedTreasury = (spend * 100n) / 10_000n - (spend * 90n) / 10_000n
    + (totalTax * 7000n) / 10_000n;
  check("treasury received base fee minus creator share, plus its tax share",
    treasuryPaid === expectedTreasury,
    `${ethers.formatUnits(treasuryPaid, 6)} USDC transferred (expected ${ethers.formatUnits(expectedTreasury, 6)})`);

  // ── decay ────────────────────────────────────────────────────────────
  console.log("\nDECAY");
  const samples = [];
  for (let i = 0; i < 5; i++) {
    const b = await ethers.provider.getBlock("latest");
    samples.push([b.timestamp - t0, Number(await ballista.currentSnipeTaxBps(tokenAddress))]);
    if (i < 4) await new Promise((r) => setTimeout(r, 1500));
  }
  console.log(`  ${samples.map(([e, t]) => `t=${e}s:${t}bps`).join("   ")}`);
  check("tax is non-increasing over time",
    samples.every((s, i) => i === 0 || s[1] <= samples[i - 1][1]));
  check("tax reaches zero past the window",
    samples[samples.length - 1][1] === 0,
    `last sample t=${samples[samples.length - 1][0]}s`);

  // ── sell ─────────────────────────────────────────────────────────────
  console.log("\nSELL");
  const held = await token.balanceOf(me.address);
  const sellAmount = held / 3n;
  await send("approve token", token, "approve", [BALLISTA, sellAmount]);
  const quoteSell = await ballista.quoteSell(tokenAddress, sellAmount);
  const sellRcpt = await send("sell", ballista, "sell", [tokenAddress, sellAmount, 0]);
  const sellTrade = parse(ballista, sellRcpt, "Trade")[0];
  // What the contract actually paid the seller, from the USDC Transfer event.
  const paidToSeller = usdcTransferTo(sellRcpt, me.address);

  const sellPayout = quoteSell.usdcOutGross - quoteSell.fee;
  const sellCreatorCut = (quoteSell.usdcOutGross * 50n) / 10_000n;
  const sellTreasuryCut = quoteSell.fee - sellCreatorCut;

  check("Trade fired, isBuy false", !!sellTrade && sellTrade.args.isBuy === false);
  // The pre-Ballista bug emitted (tokensIn, usdcOut) into the (usdcAmount, tokenAmount)
  // slots. Checked against the quote rather than a wallet delta: treasury == seller
  // here, so every USDC Transfer in this receipt lands on the same address.
  check("sell Trade args are (usdcOut, tokensIn) in the right slots -- the old swapped-order bug",
    sellTrade.args.tokenAmount === sellAmount && sellTrade.args.usdcAmount === sellPayout,
    `usdcAmount ${ethers.formatUnits(sellTrade.args.usdcAmount, 6)} / tokenAmount ${ethers.formatUnits(sellTrade.args.tokenAmount, 18)}`);
  check("quoteSell predicted the payout exactly",
    sellTrade.args.usdcAmount === sellPayout,
    `quoted ${ethers.formatUnits(sellPayout, 6)}, Trade says ${ethers.formatUnits(sellTrade.args.usdcAmount, 6)}`);
  // Full reconciliation of every USDC unit the contract sent out on this sell.
  check("sell USDC out reconciles: seller payout + treasury cut, creator share retained",
    paidToSeller === sellPayout + sellTreasuryCut,
    `transferred ${ethers.formatUnits(paidToSeller, 6)} = payout ${ethers.formatUnits(sellPayout, 6)} + treasury ${ethers.formatUnits(sellTreasuryCut, 6)}`);
  check("tokens left our balance", (await token.balanceOf(me.address)) === held - sellAmount);
  check("sell accrued more creator fees",
    (await ballista.creatorFeesAccrued(me.address)) > accruedAfterBuy);
  check("no snipe tax on the sell side",
    parse(ballista, sellRcpt, "SnipeTaxCollected").length === 0);

  // ── claim ────────────────────────────────────────────────────────────
  console.log("\nCLAIM");
  const owed = await ballista.creatorFeesAccrued(me.address);
  const claimRcpt = await send("claimCreatorFees", ballista, "claimCreatorFees", []);
  const claimed = parse(ballista, claimRcpt, "CreatorFeesClaimed")[0];
  check("claim paid exactly what was owed",
    claimed.args.amount === owed && usdcTransferTo(claimRcpt, me.address) === owed,
    `${ethers.formatUnits(owed, 6)} USDC, event and transfer agree`);
  check("accrual zeroed after claim",
    (await ballista.creatorFeesAccrued(me.address)) === 0n);

  // ── final ────────────────────────────────────────────────────────────
  const fin = await ballista.curves(tokenAddress);
  console.log(`\nFINAL CURVE`);
  console.log(`  state ${fin.state} (0=ACTIVE)   realUsdcReserves ${ethers.formatUnits(fin.realUsdcReserves, 6)} USDC`);
  console.log(`  tokenReserves ${ethers.formatUnits(fin.tokenReserves, 18)}   progress ${await ballista.graduationProgressBps(tokenAddress)} bps`);

  // -- creator launch buy, on REAL Arc timing --------------------------------
  // The one thing local tests cannot check. The window is TIME-based now, so the buy
  // no longer has to share the creation block -- it has to land within
  // creatorLaunchWindow seconds. Two flows are exercised and the FIRST is the one that
  // was impossible before: wait for the creation receipt, then buy, which is what a
  // plain wallet or a simple frontend actually does.
  console.log("");
  console.log("CREATOR LAUNCH BUY (real Arc block timing)");
  const windowSecs = await ballista.creatorLaunchWindow();
  console.log("  creatorLaunchWindow = " + windowSecs + "s");

  async function creatorFlow(label, predictAddress) {
    const sym = "CB" + (Date.now() % 1000000);
    const h = await ballista.currentEconomicsHash();
    let createRc, buyRc, predicted = null, tokenAddr;
    try {
      if (predictAddress) {
        const n0 = await ethers.provider.getTransactionCount(me.address);
        const fN = await ethers.provider.getTransactionCount(BALLISTA);
        predicted = ethers.getCreateAddress({ from: BALLISTA, nonce: fN });
        const cTx = await ballista.createToken("W", sym, "ipfs://w", h, false,
          { nonce: n0, gasLimit: 2000000 });
        const bTx = await ballista.creatorLaunchBuy(predicted, 20n * ONE_USDC, 0,
          { nonce: n0 + 1, gasLimit: 1000000 });
        createRc = await cTx.wait();
        buyRc = await bTx.wait().catch((e) => (e && e.receipt) || null);
      } else {
        createRc = await send("createToken (seq)", ballista, "createToken",
          ["W", sym, "ipfs://w", h, false]);
        tokenAddr = parse(ballista, createRc, "TokenCreated")[0].args.token;
        const bTx = await ballista.creatorLaunchBuy(tokenAddr, 20n * ONE_USDC, 0,
          { gasLimit: 1000000 });
        buyRc = await bTx.wait().catch((e) => (e && e.receipt) || null);
      }
    } catch (e) {
      check(label + ": creator buy landed", false, e.shortMessage || e.message);
      return;
    }
    if (predicted) {
      const real = parse(ballista, createRc, "TokenCreated")[0].args.token;
      check(label + ": predicted address matched", predicted.toLowerCase() === real.toLowerCase());
    }
    const cBlk = await ethers.provider.getBlock(createRc.blockNumber);
    const bBlk = buyRc ? await ethers.provider.getBlock(buyRc.blockNumber) : null;
    const dBlocks = bBlk ? buyRc.blockNumber - createRc.blockNumber : null;
    const dSecs = bBlk ? bBlk.timestamp - cBlk.timestamp : null;
    console.log("  " + label + ": create blk " + createRc.blockNumber +
      " -> buy blk " + (buyRc ? buyRc.blockNumber : "n/a") +
      "  (+" + dBlocks + " blocks, +" + dSecs + "s)");

    const ok = buyRc && buyRc.status === 1;
    check(label + ": creator buy SUCCEEDED on real Arc timing", !!ok,
      ok ? "" : "buy reverted or missing");
    if (ok) {
      const ev = parse(ballista, buyRc, "CreatorLaunchBuy")[0];
      check(label + ": CreatorLaunchBuy event present", !!ev);
      if (ev) {
        const pct = Number(ev.args.bpsOfCurveSupply) / 100;
        console.log("    creator bought " + pct.toFixed(3) + "% for " +
          ethers.formatUnits(ev.args.usdcSpent, 6) + " USDC");
        check(label + ": within the 2.5% cap", ev.args.bpsOfCurveSupply <= 250n, pct + "%");
        check(label + ": no snipe tax on the creator path",
          parse(ballista, buyRc, "SnipeTaxCollected").length === 0);
      }
      gas.push({ label: "creatorLaunchBuy (" + label + ")", est: 0n,
                 gasUsed: buyRc.gasUsed, cost: buyRc.gasUsed * buyRc.gasPrice });
    }
    if (dSecs !== null) {
      check(label + ": elapsed fits inside the window",
        dSecs <= Number(windowSecs), dSecs + "s of " + windowSecs + "s");
    }
  }

  // THE REGRESSION TEST: sequential, receipt-then-buy. Impossible under the old rule.
  await creatorFlow("sequential", false);
  // launchCooldown is per wallet and the sequential flow launched moments ago, so the
  // second createToken would revert on cooldown and the buy would then have no token to
  // hit -- which looks like a window failure and is not one.
  const cdSecs = Number(await ballista.launchCooldown());
  if (cdSecs > 0) {
    console.log("  waiting " + (cdSecs + 2) + "s for the launch cooldown...");
    await new Promise((r) => setTimeout(r, (cdSecs + 2) * 1000));
  }
  // And the optimised flow, which used to be the only one that worked.
  await creatorFlow("back-to-back", true);

  console.log(`\nGAS  (limit sent = 2x estimate)`);
  let total = 0n, totalCost = 0n;
  for (const g of gas) {
    total += g.gasUsed; totalCost += g.cost;
    console.log(`  ${g.label.padEnd(20)} est ${g.est.toString().padStart(8)}  used ${g.gasUsed.toString().padStart(8)}  ${ethers.formatUnits(g.cost, 18)} USDC`);
  }
  console.log(`  ${"TOTAL".padEnd(20)} ${" ".repeat(13)} used ${total.toString().padStart(8)}  ${ethers.formatUnits(totalCost, 18)} USDC`);

  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) {
    console.log("FAILED:");
    for (const f of failed) console.log(`  - ${f.label}  ${f.detail}`);
    process.exitCode = 1;
  }
  console.log(`\ntoken: https://testnet.arcscan.app/address/${tokenAddress}`);
}

main().catch((e) => {
  console.error(`\nSMOKE TEST ERROR: ${e.message}`);
  process.exitCode = 1;
});
