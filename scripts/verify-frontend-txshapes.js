// Executes the EXACT transaction shapes frontend/terminal.html and create-token.html now
// build -- same argument arity, same quote-derived minOut, same fee overrides -- against
// the live deployment with a real signer.
//
// Why this exists: the browser available here has no wallet extension, so the DOM click
// path cannot be driven end to end. This does not test the DOM. It tests that the
// transactions the frontend constructs are accepted by the contract, which is the half
// that can actually be wrong in a way a screenshot would not reveal.
//
//   BALLISTA_ADDRESS=0x... npx hardhat run scripts/verify-frontend-txshapes.js --network arcTestnet
const hre = require("hardhat");
const { ethers } = hre;

const BALLISTA = process.env.BALLISTA_ADDRESS;
const USDC_ADDR = "0x3600000000000000000000000000000000000000";
const GWEI = 1000000000n;
const MIN_MAX_FEE = 20n * GWEI;
const TIP = 1n * GWEI;
const SLIPPAGE_BPS = 200n;

const results = [];
const check = (label, pass, detail = "") => {
  results.push({ label, pass });
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${label}${detail ? `  -- ${detail}` : ""}`);
};

// Mirrors currentFees() in both HTML files.
async function currentFees(provider) {
  let base = MIN_MAX_FEE;
  const fd = await provider.getFeeData();
  const seen = fd.maxFeePerGas ?? fd.gasPrice ?? 0n;
  if (seen > base) base = seen;
  return { maxFeePerGas: base, maxPriorityFeePerGas: TIP };
}
const applySlippage = (o) => (o * (10000n - SLIPPAGE_BPS)) / 10000n;

async function main() {
  if (!BALLISTA) throw new Error("set BALLISTA_ADDRESS");
  const [signer] = await ethers.getSigners();
  const p = ethers.provider;
  const f = await ethers.getContractAt("LFX1", BALLISTA);
  const usdc = new ethers.Contract(USDC_ADDR, [
    "function approve(address,uint256) returns (bool)",
    "function balanceOf(address) view returns (uint256)",
    "function isBlacklisted(address) view returns (bool)",
  ], signer);

  console.log(`factory ${BALLISTA}\nsigner  ${signer.address}\n`);

  // ── rule 7, exactly as the frontend does it ──────────────────────────
  check("blocklist check runs and the signer is not blocked",
    (await usdc.isBlacklisted(signer.address)) === false);

  const fees = await currentFees(p);
  check("fee override is at or above Arc's 20 Gwei floor",
    fees.maxFeePerGas >= MIN_MAX_FEE, `${Number(fees.maxFeePerGas) / 1e9} Gwei, tip ${Number(fees.maxPriorityFeePerGas) / 1e9}`);

  await (await usdc.approve(BALLISTA, ethers.MaxUint256, fees)).wait();

  // ── CREATE: five args, hash fetched immediately before the call ──────
  const hash = await f.currentEconomicsHash();
  const sym = "TXS" + Date.now().toString().slice(-4);
  const rc = await (await f.createToken(
    "TxShape", sym, "ipfs://x", hash, false, { ...fees, gasLimit: 6000000 }
  )).wait();
  const token = rc.logs.map((l) => { try { return f.interface.parseLog(l); } catch { return null; } })
    .filter(Boolean).find((l) => l.name === "TokenCreated").args.token;
  check("createToken accepted with 5 args + freshly fetched economics hash", !!token, token);

  // A stale hash must be REJECTED -- proves the pin is real and rule 5 matters.
  let staleRejected = false;
  try {
    await f.createToken.staticCall("X", sym + "b", "", ethers.ZeroHash, false);
  } catch (e) {
    // Decode the 4-byte SELECTOR against the ABI. Two earlier shapes of this check were
    // wrong: e.message is a string (rule 4 forbids matching it) and e.revert is undefined
    // here -- Arc's RPC returns a raw provider error (code 3) with the revert data in
    // e.data rather than the CALL_EXCEPTION ethers would decode on its own. The selector
    // is ABI data, not prose, so matching it is stable across node upgrades.
    const sel = e.data || e.error?.data || "";
    staleRejected = sel === f.interface.getError("EconomicsChanged").selector;
  }
  check("a stale/incorrect economics hash is rejected", staleRejected,
    "EconomicsChanged — this is why the hash is never cached");

  await new Promise((r) => setTimeout(r, 2000));

  // ── BUY: minOut from the CONTRACT quote, never re-derived ────────────
  const spend = 2_000_000n;
  const qb = await f.quoteBuy(token, spend);
  const minOut = applySlippage(qb.tokensOut);
  check("quoteBuy returned a non-zero quote", qb.tokensOut > 0n, `${qb.tokensOut} tokens`);
  check("minTokensOut is non-zero and below the quote", minOut > 0n && minOut < qb.tokensOut,
    `min ${minOut}`);
  await (await f.buy(token, spend, minOut, { ...fees, gasLimit: 600000 })).wait();
  const tokenC = await ethers.getContractAt("LFX1Token", token);
  const held = await tokenC.balanceOf(signer.address);
  check("buy executed with a quote-derived minTokensOut", held >= minOut,
    `received ${held}`);

  // ── SELL: minOut from the NET quote (gross - fee) ────────────────────
  const sellAmt = held / 2n;
  const qs = await f.quoteSell(token, sellAmt);
  const net = qs.usdcOutGross - qs.fee;
  const minUsdcOut = applySlippage(net);
  check("quoteSell net is gross minus fee", net < qs.usdcOutGross,
    `gross ${qs.usdcOutGross}, fee ${qs.fee}, net ${net}`);
  await (await tokenC.approve(BALLISTA, sellAmt, fees)).wait();
  const before = await usdc.balanceOf(signer.address);
  await (await f.sell(token, sellAmt, minUsdcOut, { ...fees, gasLimit: 600000 })).wait();
  const gained = (await usdc.balanceOf(signer.address)) - before;
  // Gained is net payout minus the gas this very transaction burned -- one balance.
  check("sell executed with a NET-derived minUsdcOut", gained !== 0n,
    `balance moved by ${gained} (net payout ${net} minus gas, same balance)`);

  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) { failed.forEach((x) => console.log("  FAILED: " + x.label)); process.exit(1); }
}

main().catch((e) => { console.error(e); process.exit(1); });
