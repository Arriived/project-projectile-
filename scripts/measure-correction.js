// What does correcting an adversarially-skewed pair actually COST, and who would want to
// pay it? Run: FORK=1 npx hardhat run scripts/measure-correction.js
//
// Reproduces section 1.1's scenario against real Uniswap V2, then prices the two ways a
// helper could restore the ratio:
//   A. DONATE to the pair and sync() -- exact, simple, and a pure loss to the payer.
//   B. SWAP toward the target -- inexact, but the attacker's dust is mispriced, so the
//      corrector is buying below launch price and may come out ahead.
// The answer decides whether the helper needs an operator with a reason to care, or works
// permissionlessly on arbitrage alone.
const { ethers } = require('hardhat');

const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const V2_FACTORY = '0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f';
const V2_ROUTER = '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D';
const ONE = 1_000_000n;

const ERC20 = [
  'function balanceOf(address) view returns (uint256)',
  'function transfer(address,uint256) returns (bool)',
  'function approve(address,uint256) returns (bool)',
];
const FACTORY = [
  'function getPair(address,address) view returns (address)',
  'function createPair(address,address) returns (address)',
];
const PAIR = [
  'function token0() view returns (address)',
  'function getReserves() view returns (uint112,uint112,uint32)',
  'function mint(address) returns (uint256)',
];

async function fundUsdc(addr, amount) {
  const t = new ethers.Contract(USDC, ERC20, ethers.provider);
  for (let slot = 0; slot < 20; slot++) {
    const key = ethers.solidityPackedKeccak256(['uint256', 'uint256'], [addr, slot]);
    const before = await ethers.provider.send('eth_getStorageAt', [USDC, key, 'latest']);
    await ethers.provider.send('hardhat_setStorageAt', [USDC, key, ethers.toBeHex(amount, 32)]);
    if ((await t.balanceOf(addr)) === amount) return;
    await ethers.provider.send('hardhat_setStorageAt', [USDC, key, before]);
  }
  throw new Error('USDC balance slot not found');
}

// Smallest USDC swap-in that brings rT/rU down to T/U, with V2's 0.3% fee.
function solveSwapIn(rT, rU, T, U) {
  const out = (dIn) => {
    const f = dIn * 997n;
    return (f * rT) / (rU * 1000n + f);
  };
  // U*(rT - out) <= T*(rU + dIn)  ->  find the smallest dIn satisfying it.
  const ok = (dIn) => U * (rT - out(dIn)) <= T * (rU + dIn);
  let lo = 0n, hi = 1n;
  while (!ok(hi)) { hi *= 2n; if (hi > 10n ** 24n) return null; }
  while (lo < hi) { const mid = (lo + hi) / 2n; if (ok(mid)) hi = mid; else lo = mid + 1n; }
  return { dIn: lo, dOut: out(lo) };
}

async function main() {
  const [, treasury, creator, buyer, attacker] = await ethers.getSigners();
  const usdc = new ethers.Contract(USDC, ERC20, ethers.provider);
  const factory = new ethers.Contract(V2_FACTORY, FACTORY, ethers.provider);

  for (const scenario of [
    { label: 'token looks CHEAP  (attacker seeds tokens + 1 unit USDC)', cheap: true },
    { label: 'token looks DEAR   (attacker seeds 1 token + 500 USDC)', cheap: false },
  ]) {
    const ballista = await (await ethers.getContractFactory('LFX1')).deploy(
      USDC, treasury.address, V2_ROUTER
    );
    for (const s of [creator, buyer, attacker]) {
      await fundUsdc(s.address, 200_000n * ONE);
      await usdc.connect(s).approve(await ballista.getAddress(), ethers.MaxUint256);
    }

    const hash = await ballista.currentEconomicsHash();
    const rc = await (await ballista.connect(creator).createToken('M', 'M' + (scenario.cheap ? 'C' : 'D'), '', hash, false)).wait();
    const token = rc.logs.map((l) => { try { return ballista.interface.parseLog(l); } catch { return null; } })
      .filter(Boolean).find((l) => l.name === 'TokenCreated').args.token;
    await ethers.provider.send('evm_mine', []);
    await ethers.provider.send('evm_increaseTime', [30]);
    await ethers.provider.send('evm_mine', []);

    const tok = new ethers.Contract(token, ERC20, ethers.provider);
    await ballista.connect(attacker).buy(token, 50n * ONE, 0);
    const attackerTokens = await tok.balanceOf(attacker.address);

    await factory.connect(attacker).createPair(token, USDC);
    const pairAddr = await factory.getPair(token, USDC);
    const pair = new ethers.Contract(pairAddr, PAIR, ethers.provider);
    if (scenario.cheap) {
      await tok.connect(attacker).transfer(pairAddr, attackerTokens);
      await usdc.connect(attacker).transfer(pairAddr, 1n);
    } else {
      await tok.connect(attacker).transfer(pairAddr, 10n ** 18n);
      await usdc.connect(attacker).transfer(pairAddr, 500n * ONE);
    }
    await pair.connect(attacker).mint(attacker.address);

    await ballista.connect(buyer).buy(token, 8_100n * ONE, 0);
    const c = await ballista.curves(token);

    const T = (await ballista.LP_TOKEN_RESERVE()) + c.tokenReserves;
    const U = c.realUsdcReserves + c.poolBoost;
    const t0 = await pair.token0();
    const [r0, r1] = await pair.getReserves();
    const rT = t0.toLowerCase() === token.toLowerCase() ? r0 : r1;
    const rU = t0.toLowerCase() === token.toLowerCase() ? r1 : r0;

    const usd = (x) => (Number(x) / 1e6).toFixed(4);
    const tk = (x) => (Number(x) / 1e18).toFixed(2);

    console.log('\n=================================================================');
    console.log(scenario.label);
    console.log('=================================================================');
    console.log(`curve state              : ${c.state} (1 = GRADUATION_READY, i.e. attack landed)`);
    console.log(`attacker spent           : ~50 USDC of curve buys + seed`);
    console.log(`target deposit  T tokens : ${tk(T)}`);
    console.log(`target deposit  U usdc   : ${usd(U)}`);
    console.log(`pair reserves   rT       : ${tk(rT)}`);
    console.log(`pair reserves   rU       : ${usd(rU)}`);
    console.log(`pair implied price       : ${rT > 0n ? (Number(rU) / 1e6) / (Number(rT) / 1e18) : 0} USDC/token`);
    console.log(`launch  implied price    : ${(Number(U) / 1e6) / (Number(T) / 1e18)} USDC/token`);

    // A. Donation-only correction, approximated (the exact-integer nudge is <= 1 unit).
    const needUsdc = (rT * U) / T - rU;
    const needTok = (rU * T) / U - rT;
    if (needUsdc > 0n) {
      console.log(`\nA. DONATE: add ~${usd(needUsdc)} USDC to the pair and sync()`);
      console.log(`   cost to payer         : ${usd(needUsdc)} USDC, unrecoverable (absorbed into reserves)`);
    } else {
      console.log(`\nA. DONATE: add ~${tk(needTok)} tokens to the pair and sync()`);
      console.log(`   cost to payer         : ${tk(needTok)} tokens, unrecoverable`);
    }

    // B. Swap-based correction.
    const s = solveSwapIn(rT, rU, T, U);
    if (s && s.dIn > 0n) {
      const tokensWorth = (s.dOut * U) / T; // value at launch price
      const net = tokensWorth - s.dIn;
      console.log(`\nB. SWAP : send ${usd(s.dIn)} USDC into the pair`);
      console.log(`   receive               : ${tk(s.dOut)} tokens`);
      console.log(`   worth at launch price : ${usd(tokensWorth)} USDC`);
      console.log(`   NET to corrector      : ${net >= 0n ? '+' : ''}${usd(net)} USDC`);
    } else {
      console.log('\nB. SWAP : pair is already at or below the target ratio; a token-side swap is needed');
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
