const { expect } = require('chai');
const { ethers } = require('hardhat');
const { activateRouter } = require('../routerHelper');
const { deployRegistryWithAsset, getBXR1Factory } = require('./assetRegistryHelper');

const ONE = 1_000_000n;
const BPS = 10_000n;

// ── Independent reference implementation of the bonding curve ────────────────
//
// SOURCE: transcribed from BXR1.sol's own _quoteBuy / _quoteSell, NOT from the
// derivation written up in CLAUDE.md. The standing rule is never to re-derive this
// math, and the documented numbers have been wrong before; the contract is the
// authority. Transcribing from the contract is deliberate.
//
// WHAT THIS CAN AND CANNOT CATCH. It cannot catch a conceptual error in the formula,
// because it shares the formula's source -- if the curve design itself is wrong, both
// agree and both are wrong. What it does catch is EVM arithmetic behaving differently
// from the plain-integer reading (truncation order, rounding direction, an overflow
// boundary), and any future edit to the contract that changes behaviour without
// changing this file. It is a regression and arithmetic oracle, not a design oracle.

const ceilDiv = (a, b) => (a + b - 1n) / b;

function refQuoteBuy(usdcIn, buyFeeBps, vUsdc, vToken, tokensAvailable) {
  const k = vUsdc * vToken;
  const fee = (usdcIn * buyFeeBps) / BPS;
  const afterFee = usdcIn - fee;
  const newVUsdc = vUsdc + afterFee;

  const newVToken = ceilDiv(k, newVUsdc);
  if (newVToken > vToken) return { revert: 'CurveMathError' };
  const tokensOut = vToken - newVToken;

  if (tokensOut <= tokensAvailable) {
    return { tokensOut, newVirtualUsdc: newVUsdc, newVirtualToken: newVToken,
             actualUsdcIn: usdcIn, actualFee: fee };
  }
  const clampedOut = tokensAvailable;
  const clampedVToken = vToken - clampedOut;
  const clampedVUsdc = ceilDiv(k, clampedVToken);
  const clampedAfterFee = clampedVUsdc - vUsdc;
  const actualUsdcIn = ceilDiv(clampedAfterFee * BPS, BPS - buyFeeBps);
  const actualFee = actualUsdcIn - clampedAfterFee;
  if (actualUsdcIn > usdcIn) return { revert: 'ClampCostExceededOffer' };
  return { tokensOut: clampedOut, newVirtualUsdc: clampedVUsdc,
           newVirtualToken: clampedVToken, actualUsdcIn, actualFee };
}

function refQuoteSell(tokensIn, sellFeeBps, vUsdc, vToken, realUsdcAvailable) {
  const k = vUsdc * vToken;
  const newVToken = vToken + tokensIn;
  const newVUsdc = ceilDiv(k, newVToken);
  if (newVUsdc > vUsdc) return { revert: 'CurveMathError' };
  const grossOut = vUsdc - newVUsdc;

  if (grossOut <= realUsdcAvailable) {
    return { actualTokensIn: tokensIn, newVirtualToken: newVToken,
             newVirtualUsdc: newVUsdc, usdcOutGross: grossOut,
             fee: (grossOut * sellFeeBps) / BPS };
  }
  const clampedGross = realUsdcAvailable;
  const clampedVUsdc = vUsdc - clampedGross;
  const clampedVToken = ceilDiv(k, clampedVUsdc);
  const actualTokensIn = clampedVToken - vToken;
  if (actualTokensIn > tokensIn) return { revert: 'ClampInputExceededOffer' };
  return { actualTokensIn, newVirtualToken: clampedVToken, newVirtualUsdc: clampedVUsdc,
           usdcOutGross: clampedGross, fee: (clampedGross * sellFeeBps) / BPS };
}

// Deterministic PRNG so a failure is reproducible from the seed alone.
function rng(seed) {
  let s = BigInt(seed);
  return () => {
    s = (s * 6364136223846793005n + 1442695040888963407n) & ((1n << 64n) - 1n);
    return s >> 11n;
  };
}

describe('BXR1 — differential curve math', function () {
  this.timeout(600000);

  async function env() {
    const [deployer, treasury, creator, t1, t2] = await ethers.getSigners();
    const usdc = await (await ethers.getContractFactory('MockUSDC')).deploy();
    const registry = await deployRegistryWithAsset(await usdc.getAddress());
    const ballista = await (await getBXR1Factory())
      .deploy(await registry.getAddress(), treasury.address, ethers.ZeroAddress);
    const router = await (await ethers.getContractFactory('MockRouter')).deploy();
    await activateRouter(ballista, await router.getAddress());
    await ballista.setLaunchCooldown(0);
    for (const s of [creator, t1, t2]) {
      await usdc.mint(s.address, 100_000_000n * ONE);
      await usdc.connect(s).approve(await ballista.getAddress(), ethers.MaxUint256);
    }
    return { ballista, usdc, creator, t1, t2 };
  }

  async function launch(ballista, usdc, creator, symbol) {
    const hash = await ballista.currentEconomicsHash();
    const rc = await (await ballista.connect(creator)
      .createToken('Diff', symbol, 'u', await usdc.getAddress(), hash, false)).wait();
    const t = rc.logs.map((l) => { try { return ballista.interface.parseLog(l); } catch { return null; } })
      .find((l) => l && l.name === 'TokenCreated').args.token;
    // Past the snipe window so the fee is the plain buy fee and the curve math is
    // isolated from the tax schedule, which is covered by its own suite.
    await ethers.provider.send('evm_increaseTime', [30]);
    await ethers.provider.send('evm_mine');
    return t;
  }

  it('agrees with the contract across a fuzzed walk of reachable curve states', async function () {
    const { ballista, usdc, creator, t1, t2 } = await env();
    let token = await launch(ballista, usdc, creator, 'DIF1');
    let tokenC = await ethers.getContractAt('BXR1Token', token);
    const next = rng(20260822);

    let compared = 0, clampsSeen = 0, sellsSeen = 0, curvesUsed = 1;
    for (let i = 0; i < 300; i++) {
      let c = await ballista.curves(token);
      if (c.state !== 0n) {
        // Graduated: roll onto a fresh curve rather than ending the walk early.
        token = await launch(ballista, usdc, creator, 'DIF1' + curvesUsed);
        tokenC = await ethers.getContractAt('BXR1Token', token);
        curvesUsed++;
        c = await ballista.curves(token);
      }

      const buying = (next() % 3n) !== 0n;
      if (buying) {
        const spend = (next() % (60n * ONE)) + 1n;
        const ref = refQuoteBuy(spend, c.buyFeeBps, c.virtualQuoteReserves,
          c.virtualTokenReserves, c.tokenReserves);
        if (ref.revert) continue;
        const got = await ballista.quoteBuy(token, spend);
        expect(got.tokensOut, `buy tokensOut i=${i}`).to.equal(ref.tokensOut);
        expect(got.actualQuoteIn, `buy actualUsdcIn i=${i}`).to.equal(ref.actualUsdcIn);
        expect(got.actualFee, `buy actualFee i=${i}`).to.equal(ref.actualFee);
        expect(got.newVirtualQuote, `buy newVirtualUsdc i=${i}`).to.equal(ref.newVirtualUsdc);
        expect(got.newVirtualToken, `buy newVirtualToken i=${i}`).to.equal(ref.newVirtualToken);
        if (ref.actualUsdcIn < spend) clampsSeen++;
        compared++;
        await ballista.connect(next() % 2n === 0n ? t1 : t2).buy(token, spend, 0);
      } else {
        const holder = next() % 2n === 0n ? t1 : t2;
        const bal = await tokenC.balanceOf(holder.address);
        if (bal === 0n) continue;
        const amount = (next() % bal) + 1n;
        const ref = refQuoteSell(amount, c.sellFeeBps, c.virtualQuoteReserves,
          c.virtualTokenReserves, c.realQuoteReserves);
        if (ref.revert) continue;
        const got = await ballista.quoteSell(token, amount);
        expect(got.actualTokensIn, `sell actualTokensIn i=${i}`).to.equal(ref.actualTokensIn);
        expect(got.quoteOutGross, `sell usdcOutGross i=${i}`).to.equal(ref.usdcOutGross);
        expect(got.fee, `sell fee i=${i}`).to.equal(ref.fee);
        expect(got.newVirtualQuote, `sell newVirtualUsdc i=${i}`).to.equal(ref.newVirtualUsdc);
        expect(got.newVirtualToken, `sell newVirtualToken i=${i}`).to.equal(ref.newVirtualToken);
        sellsSeen++; compared++;
        await tokenC.connect(holder).approve(await ballista.getAddress(), amount);
        await ballista.connect(holder).sell(token, amount, 0);
      }
    }
    console.log(`        ${compared} quotes compared across ${curvesUsed} curve(s) ` +
      `(${sellsSeen} sells, ${clampsSeen} buy-clamps), zero divergence`);
    expect(compared, 'the walk must actually compare something').to.be.greaterThan(60);
    expect(sellsSeen, 'the sell path must be exercised').to.be.greaterThan(5);
  });

  it('agrees at the boundaries: 1 wei, exact-remaining, and past-remaining buys', async function () {
    const { ballista, usdc, creator, t1 } = await env();
    const token = await launch(ballista, usdc, creator, 'DIF2');

    // Walk the curve most of the way down so the clamp is genuinely reachable.
    await ballista.connect(t1).buy(token, 7_900n * ONE, 0);
    const c = await ballista.curves(token);
    expect(c.state, 'must still be ACTIVE for the boundary probes').to.equal(0n);

    for (const spend of [1n, 2n, 999_999n, 1n * ONE, 10_000n * ONE, 1_000_000n * ONE]) {
      const ref = refQuoteBuy(spend, c.buyFeeBps, c.virtualQuoteReserves,
        c.virtualTokenReserves, c.tokenReserves);
      if (ref.revert) {
        await expect(ballista.quoteBuy(token, spend)).to.be.reverted;
        continue;
      }
      const got = await ballista.quoteBuy(token, spend);
      expect(got.tokensOut, `spend=${spend}`).to.equal(ref.tokensOut);
      expect(got.actualQuoteIn, `spend=${spend}`).to.equal(ref.actualUsdcIn);
      expect(got.actualFee, `spend=${spend}`).to.equal(ref.actualFee);
    }
  });
});
