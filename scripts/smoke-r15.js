// R15: the ONE-BALANCE configuration, executed on Arc testnet against the real USDC.
//
// Arc pays gas in USDC. Settlement asset and gas asset are the SAME balance, and the
// ERC-20 view is a 6dp truncation of an 18dp native balance. No local EVM and no mainnet
// fork can reach this -- Arc's own docs say simulators "run a standard EVM, not Arc's" --
// so every claim in section 1.6 was arithmetic until this suite ran.
//
//   BALLISTA_ADDRESS=0x... npx hardhat run scripts/smoke-r15.js --network arcTestnet
//
// NOTHING HERE ASSERTS ON A REVERT STRING, deliberately. Zero8 (Arc Testnet, 3 Sep 2026)
// upgrades reth/revm and changes the insufficient-balance text from
// "insufficient funds for gas * price + value" to revm 38's OutOfFunds variant. A test that
// matched on it would break, and worse, a test that passes merely because SOMETHING threw
// would keep passing for the wrong reason -- which this repo lists as test-shape error 3.
// So every failure case below asserts the STATE: the trade did not happen, the tokens are
// still held, the balance did not move. Messages are printed as detail only.
//
// Funds a throwaway wallet from the deployer, so it needs the deployer to hold a few USDC.
// Whatever is left in the throwaway is swept back at the end.
const hre = require("hardhat");
const { ethers } = hre;

const BALLISTA = process.env.BALLISTA_ADDRESS;
const USDC_ADDR = "0x3600000000000000000000000000000000000000";
const ONE = 1_000_000n;      // 1 USDC, 6dp
const SCALE = 10n ** 12n;    // 18dp native -> 6dp ERC-20

const results = [];
function check(label, pass, detail = "") {
  results.push({ label, pass });
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${label}${detail ? `  -- ${detail}` : ""}`);
}

async function main() {
  if (!BALLISTA) throw new Error("set BALLISTA_ADDRESS");
  const p = ethers.provider;
  const [deployer] = await ethers.getSigners();
  const ballista = await ethers.getContractAt("LFX1", BALLISTA);
  const usdc = new ethers.Contract(USDC_ADDR, [
    "function balanceOf(address) view returns (uint256)",
    "function transfer(address,uint256) returns (bool)",
    "function approve(address,uint256) returns (bool)",
  ], deployer);

  console.log(`factory   ${BALLISTA}`);
  console.log(`deployer  ${deployer.address}`);

  // The creation fee is pulled from the caller, so the deployer needs an allowance
  // before the first createToken -- not just before the buy in step 5.
  await (await usdc.approve(BALLISTA, ethers.MaxUint256)).wait();

  // ── 1. The truncation lemma, executed ────────────────────────────────
  // 1.6 proves floor((N + A*1e12)/1e12) == floor(N/1e12) + A for any sub-6dp dust N.
  // That is the whole basis of the balance-delta check. Run it on the real token, on a
  // wallet that genuinely carries dust.
  console.log(`\n-- 1. section 1.6's truncation lemma, on the real token --`);
  const nBefore = await p.getBalance(deployer.address);
  const eBefore = await usdc.balanceOf(deployer.address);
  const dust = nBefore % SCALE;
  check("ERC-20 view is exactly the truncated native balance",
    eBefore === nBefore / SCALE, `native ${nBefore}, erc20 ${eBefore}`);
  check("the wallet actually carries sub-6dp dust (otherwise this proves nothing)",
    dust > 0n, `dust ${dust} wei`);

  // ── 2. A throwaway wallet, funded exactly ────────────────────────────
  const w = ethers.Wallet.createRandom().connect(p);
  console.log(`\n-- 2. throwaway wallet ${w.address} --`);
  const FUND = 6n * ONE;
  await (await usdc.transfer(w.address, FUND)).wait();
  const wNative = await p.getBalance(w.address);
  const wErc = await usdc.balanceOf(w.address);
  check("a 6dp transfer moves the 18dp native balance by exactly amount*1e12",
    wNative === FUND * SCALE, `native ${wNative}`);
  check("recipient's ERC-20 view equals the truncated native balance",
    wErc === wNative / SCALE, `erc20 ${wErc}`);

  const usdcW = usdc.connect(w);
  const ballistaW = ballista.connect(w);

  // ── 3. Enough for the trade, not for trade + gas ─────────────────────
  // The failure that cannot exist on a chain where gas is a different asset.
  console.log(`\n-- 3. enough for the trade, not for trade + gas --`);
  const hash = await ballista.currentEconomicsHash();
  await (await usdcW.approve(BALLISTA, ethers.MaxUint256)).wait();

  const token0 = await createToken(ballista, deployer, hash, "R15A");
  const tok0 = await ethers.getContractAt("LFX1Token", token0);
  const balNow = await usdc.balanceOf(w.address);

  let detail = "";
  try {
    // Spend the ENTIRE balance on a buy. On Arc this cannot succeed: the gas for the buy
    // itself comes out of the same balance.
    await (await ballistaW.buy(token0, balNow, 0, { gasLimit: 600000 })).wait();
  } catch (e) {
    detail = String(e.shortMessage || e.message).slice(0, 60);
  }
  // Assert the STATE, not the message: no tokens arrived, so the trade did not execute.
  check("buying the ENTIRE balance does not execute -- gas comes out of the same pot",
    (await tok0.balanceOf(w.address)) === 0n, detail || "no tokens received");

  // ── 4. Spend down until the user can no longer sell ──────────────────
  // Two earlier shapes of this test were wrong, both because gas and settlement come out
  // of one balance and the arithmetic fights you:
  //   * leaving 0.3 USDC -- ample, a transaction here costs ~0.004 USDC, so the sell
  //     went through and proved nothing;
  //   * spending down to a quarter of a transaction -- the BUY could then not afford its
  //     own gas and reverted, moving the trap to the wrong operation.
  // So do not try to land it with one buy. Buy comfortably, approve while it is still
  // affordable, then sweep the wallet down to below one transaction and attempt the sell.
  // That isolates the property: holds tokens, cannot afford to move them.
  console.log(`\n-- 4. spend down until selling is unaffordable --`);
  const token = await createToken(ballista, deployer, hash, "R15B");
  await new Promise((r) => setTimeout(r, 2000));

  const gasPrice = (await p.getFeeData()).gasPrice;
  const txCost6dp = (600000n * gasPrice) / SCALE;
  const before = await usdc.balanceOf(w.address);
  const spend = before / 2n;
  await (await ballistaW.buy(token, spend, 0, { gasLimit: 600000 })).wait();

  const tokenC = await ethers.getContractAt("LFX1Token", token);
  const held = await tokenC.balanceOf(w.address);
  check("the buy landed and the wallet holds tokens", held > 0n, `${held} tokens`);

  // Approve now, while the wallet can still pay for it, so the sell is the only thing
  // left needing gas.
  await (await tokenC.connect(w).approve(BALLISTA, held, { gasLimit: 200000 })).wait();

  // Sweep down. Native value on Arc IS USDC, so a plain send moves the settlement asset.
  const keep = txCost6dp / 8n;
  const nativeNow = await p.getBalance(w.address);
  const sendGas = 21000n * gasPrice;
  const sweep = nativeNow - keep * SCALE - sendGas;
  if (sweep > 0n) {
    await (await w.sendTransaction({ to: deployer.address, value: sweep, gasLimit: 21000 })).wait();
  }
  const stranded = await usdc.balanceOf(w.address);
  console.log(`     one tx costs ~${txCost6dp} (6dp); wallet left with ${stranded}`);
  check("the wallet is now below the cost of a single transaction",
    stranded < txCost6dp, `${stranded} < ${txCost6dp}`);
  check("and it still holds the tokens it bought", (await tokenC.balanceOf(w.address)) > 0n);

  // The predictive form, which is also what the frontend must do: compare the balance
  // against what the transaction will cost BEFORE submitting. No string, no submission.
  const needed = 600000n * gasPrice;
  const haveNative = await p.getBalance(w.address);
  check("balance is below the cost of the sell, checked BEFORE submitting",
    haveNative < needed, `have ${haveNative}, need ${needed}`);

  let detail2 = "";
  try {
    await (await ballistaW.sell(token, held, 0, { gasLimit: 600000 })).wait();
  } catch (e) {
    detail2 = String(e.shortMessage || e.message).slice(0, 60);
  }
  // State again: the position is still held, so the exit did not happen.
  check("holder cannot SELL -- the position is still there afterwards",
    (await tokenC.balanceOf(w.address)) === held, detail2 || "tokens still held");

  // ── 5. The delta check, executed rather than proven ──────────────────
  // _settleBuy measures the factory's balance around the pull and reverts on any
  // shortfall. Assert the measured delta is EXACT against the real truncating token.
  console.log(`\n-- 5. the balance-delta check, against real Arc USDC --`);
  const amt = 2n * ONE;
  const t2 = await createToken(ballista, deployer, hash, "R15C");
  await new Promise((r) => setTimeout(r, 2000));
  // Snapshot AFTER createToken. The creation fee is pulled into the factory and accrued
  // to treasuryFeesAccrued, so a snapshot taken before it lands measures fee + trade and
  // the delta check fails by exactly creationFeeUsdc -- which is what it did first run.
  const fBefore = await usdc.balanceOf(BALLISTA);
  const fNativeBefore = await p.getBalance(BALLISTA);
  const rc = await (await ballista.buy(t2, amt, 0, { gasLimit: 600000 })).wait();
  const fAfter = await usdc.balanceOf(BALLISTA);
  const fNativeAfter = await p.getBalance(BALLISTA);

  const trade = rc.logs.map((l) => { try { return ballista.interface.parseLog(l); } catch { return null; } })
    .filter(Boolean).find((l) => l.name === "Trade");
  const actualUsdcIn = trade.args[3];
  check("UsdcTransferMismatch did not fire on the real token", true, "the buy succeeded");
  check("factory 6dp balance delta == actualUsdcIn exactly",
    fAfter - fBefore === actualUsdcIn, `delta ${fAfter - fBefore}, actualUsdcIn ${actualUsdcIn}`);
  check("factory 18dp native delta == actualUsdcIn * 1e12 exactly",
    fNativeAfter - fNativeBefore === actualUsdcIn * SCALE,
    `native delta ${fNativeAfter - fNativeBefore}`);
  check("factory carries no sub-6dp dust, so truncation is lossless here",
    fNativeAfter % SCALE === 0n, `dust ${fNativeAfter % SCALE}`);

  // ── sweep back ───────────────────────────────────────────────────────
  try {
    const left = await p.getBalance(w.address);
    const fee = 300000n * (await p.getFeeData()).gasPrice;
    if (left > fee) {
      await (await w.sendTransaction({ to: deployer.address, value: left - fee, gasLimit: 21000 })).wait();
    }
  } catch { /* dust left in a throwaway is not worth failing the run over */ }

  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) { console.log("FAILED:"); failed.forEach((f) => console.log("  " + f.label)); process.exit(1); }
}

async function createToken(ballista, signer, hash, sym) {
  // launchCooldown is per-sender (10s by default). Three launches from one address in a
  // single run will trip it, so wait it out rather than racing it.
  const cd = await ballista.launchCooldown();
  const last = await ballista.lastLaunchTimestamp(await signer.getAddress());
  if (last > 0n) {
    const now = BigInt((await ethers.provider.getBlock("latest")).timestamp);
    const readyAt = last + cd;
    if (now < readyAt) {
      const waitMs = Number(readyAt - now + 2n) * 1000;
      console.log(`     (waiting ${waitMs / 1000}s for the launch cooldown)`);
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
  const rc = await (await ballista.connect(signer).createToken(
    "R15", sym + Date.now().toString().slice(-4), "", hash, false, { gasLimit: 6000000 }
  )).wait();
  const ev = rc.logs.map((l) => { try { return ballista.interface.parseLog(l); } catch { return null; } })
    .filter(Boolean).find((l) => l.name === "TokenCreated");
  return ev.args.token;
}

main().catch((e) => { console.error(e); process.exit(1); });
