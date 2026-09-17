const { expect } = require('chai');
const { ethers } = require('hardhat');
const { activateRouter } = require('../routerHelper');
const { deployRegistryWithAsset, setGraduationThreshold, getBXR1Factory, USDC_EQUIVALENT_INITIAL_VIRTUAL_RESERVE } = require('./assetRegistryHelper');

const ONE_USDC = 1_000_000n;
const SCALE = 1_000_000n; // fixed-point scale for the measured ratio; SCALE == 1.0

// When a curve graduates, does the DEX pool open above or below the price the last
// curve buyer just paid?
//
//   pool price  = usdcLiquidity / tokenLiquidity        (from the Graduated event)
//   curve price = virtualQuoteReserves / virtualTokenReserves  (marginal, at close)
//
// Both from raw reserves in BigInt rather than currentPrice(), which divides down to
// roughly three significant figures -- enough rounding noise to swamp a few-percent
// signal.
function gapBps(usdcLiquidity, tokenLiquidity, virtualUsdc, virtualToken) {
  const ratio = (usdcLiquidity * virtualToken * SCALE) / (tokenLiquidity * virtualUsdc);
  return (Number(ratio - SCALE) / Number(SCALE)) * 10_000;
}

describe('Ballista — graduation gap and the dual trigger', function () {
  async function deployFixture() {
    const [deployer, treasury, creator, trader] = await ethers.getSigners();
    const usdc = await (await ethers.getContractFactory('MockUSDC')).deploy();
    const registry = await deployRegistryWithAsset(await usdc.getAddress());
    const ballista = await (await getBXR1Factory()).deploy(
      await registry.getAddress(),
      treasury.address,
      ethers.ZeroAddress
    );
    const router = await (await ethers.getContractFactory('MockRouter')).deploy();
    await activateRouter(ballista, await router.getAddress());
    await ballista.publishSnipeTaxTable([]); // steady-state economics, not sniping
    await ballista.setLaunchCooldown(0);

    for (const s of [creator, trader]) {
      await usdc.mint(s.address, 10_000_000n * ONE_USDC);
      await usdc.connect(s).approve(await ballista.getAddress(), ethers.MaxUint256);
    }
    return { deployer, treasury, creator, trader, usdc, registry, ballista };
  }

  async function launch(ballista, usdc, creator, symbol) {
    const hash = await ballista.currentEconomicsHash(await usdc.getAddress());
    const rc = await (
      await ballista.connect(creator).createToken('Gap Test', symbol, 'ipfs://a', await usdc.getAddress(), hash, false)
    ).wait();
    return rc.logs
      .map((l) => { try { return ballista.interface.parseLog(l); } catch { return null; } })
      .find((l) => l && l.name === 'TokenCreated').args.token;
  }

  function findEvent(ballista, rc, name) {
    return rc.logs
      .map((l) => { try { return ballista.interface.parseLog(l); } catch { return null; } })
      .find((l) => l && l.name === name);
  }

  // Drives a token to graduation and measures the gap. `approach` is a first buy that
  // must NOT graduate; `finalBuy` is the one that crosses.
  async function graduateAndMeasure(ballista, usdc, creator, trader, symbol, approach, finalBuy) {
    const tokenAddress = await launch(ballista, usdc, creator, symbol);
    if (approach > 0n) {
      await ballista.connect(trader).buy(tokenAddress, approach, 0);
      expect((await ballista.curves(tokenAddress)).state, 'approach must not graduate').to.equal(0n);
    }
    const rc = await (await ballista.connect(trader).buy(tokenAddress, finalBuy, 0)).wait();
    const grad = findEvent(ballista, rc, 'Graduated');
    expect(grad, 'expected this buy to graduate').to.not.be.undefined;

    const curve = await ballista.curves(tokenAddress);
    return {
      gap: gapBps(
        grad.args.quoteLiquidity, grad.args.tokenLiquidity,
        curve.virtualQuoteReserves, curve.virtualTokenReserves
      ),
      usdcLiquidity: grad.args.quoteLiquidity,
      tokenLiquidity: grad.args.tokenLiquidity,
      tokenAddress,
    };
  }

  // INITIAL_VIRTUAL_USDC_RESERVES no longer exists on BXR1 -- that figure is
  // asset-specific now (AssetRegistry.AssetConfig.initialVirtualReserve), read once at
  // createToken and never exposed as a global constant. registerAsset's default in
  // assetRegistryHelper.js reproduces the historic value exactly, so this checks the
  // registry entry the fixture actually registered rather than a constant that moved.
  it('the new constants are exactly as derived', async function () {
    const { ballista, usdc, registry } = await deployFixture();
    const assetCfg = await registry.getAsset(await usdc.getAddress());
    expect(assetCfg.initialVirtualReserve).to.equal(USDC_EQUIVALENT_INITIAL_VIRTUAL_RESERVE);
    expect(USDC_EQUIVALENT_INITIAL_VIRTUAL_RESERVE).to.equal(2_667n * ONE_USDC);
    expect(await ballista.INITIAL_VIRTUAL_TOKEN_RESERVES()).to.equal(1_075_000_000n * 10n ** 18n);
    expect(await ballista.CURVE_TOKEN_SUPPLY()).to.equal(807_000_000n * 10n ** 18n);
    expect(await ballista.LP_TOKEN_RESERVE()).to.equal(193_000_000n * 10n ** 18n);
    expect(await ballista.TOTAL_TOKEN_SUPPLY()).to.equal(1_000_000_000n * 10n ** 18n);
    expect(assetCfg.defaultGraduationThreshold).to.equal(8_000n * ONE_USDC);
  });

  it('opens the DEX pool ABOVE the curve close, by under 5%', async function () {
    const { ballista, usdc, creator, trader } = await deployFixture();
    // 8,000 gross nets 7,920 after the 1% fee -- just short. A small second buy crosses.
    const r = await graduateAndMeasure(
      ballista, usdc, creator, trader, 'GAPA', 8_000n * ONE_USDC, 100n * ONE_USDC
    );
    console.log(`        measured gap (tight graduation): ${(r.gap / 100).toFixed(3)}%`);
    console.log(`        pool: ${(Number(r.usdcLiquidity) / 1e6).toFixed(2)} USDC / ` +
                `${(Number(r.tokenLiquidity) / 1e18).toFixed(0)} tokens`);
    expect(r.gap).to.be.greaterThan(0, 'pool must not open below the curve close');
    expect(r.gap).to.be.lessThan(500, 'pool must not open more than 5% above the close');
  });

  it('the gap stays positive across the whole overshoot range', async function () {
    const { ballista, usdc, creator, trader } = await deployFixture();
    const cases = [
      ['tight        ', 8_000n, 100n],
      ['moderate     ', 6_000n, 3_000n],
      ['heavy        ', 4_000n, 6_000n],
      ['single buy   ', 0n, 12_000n],
      ['massive      ', 0n, 500_000n],
    ];
    const measured = [];
    for (const [label, approach, final] of cases) {
      await ethers.provider.send('evm_increaseTime', [60]);
      await ethers.provider.send('evm_mine');
      const r = await graduateAndMeasure(
        ballista, usdc, creator, trader, 'OVS' + measured.length, approach * ONE_USDC, final * ONE_USDC
      );
      measured.push([label, r.gap]);
      expect(r.gap, `${label.trim()} opened the pool BELOW the curve close`).to.be.greaterThan(0);
    }
    console.log('        gap by overshoot:');
    for (const [label, gap] of measured) console.log(`          ${label}  ${(gap / 100).toFixed(3)}%`);
  });

  it('measures the real launch-to-graduation price multiple', async function () {
    const { ballista, usdc, creator, trader } = await deployFixture();
    const tokenAddress = await launch(ballista, usdc, creator, 'MULT');
    const c0 = await ballista.curves(tokenAddress);

    await ballista.connect(trader).buy(tokenAddress, 8_000n * ONE_USDC, 0);
    await ballista.connect(trader).buy(tokenAddress, 100n * ONE_USDC, 0);
    const c1 = await ballista.curves(tokenAddress);

    // Computed from raw reserves, NOT currentPrice(): on this curve currentPrice()
    // returns 2 at launch, so a ratio taken from it is dominated by truncation and
    // reads ~19.5x for a curve whose real multiple is 16x. See the report.
    const SC = 1_000_000n;
    const startScaled = (c0.virtualQuoteReserves * SC * 10n ** 18n) / c0.virtualTokenReserves;
    const endScaled = (c1.virtualQuoteReserves * SC * 10n ** 18n) / c1.virtualTokenReserves;
    const multiple = Number(endScaled) / Number(startScaled);
    console.log(`        launch->graduation price multiple: ${multiple.toFixed(3)}x`);
    console.log(`        (currentPrice() view reads ${await ballista.currentPrice(tokenAddress)} vs ` +
                `${c0.virtualQuoteReserves * 10n ** 18n / c0.virtualTokenReserves} at launch -- lossy)`);
    expect(multiple).to.be.greaterThan(15);
    expect(multiple).to.be.lessThan(17);
  });

  describe('dual graduation trigger', function () {
    it('the depletion ceiling sits ABOVE the threshold, so the threshold is reachable', async function () {
      const { ballista, usdc, creator, trader } = await deployFixture();
      const tokenAddress = await launch(ballista, usdc, creator, 'CEIL');
      // One enormous buy: clamps to the entire remaining supply and graduates.
      const rc = await (
        await ballista.connect(trader).buy(tokenAddress, 1_000_000n * ONE_USDC, 0)
      ).wait();
      const grad = findEvent(ballista, rc, 'Graduated');
      const ceiling = grad.args.quoteLiquidity;
      console.log(`        depletion ceiling: ${(Number(ceiling) / 1e6).toFixed(2)} USDC`);
      // Derivation says $8,030.85 against an $8,000 threshold.
      expect(ceiling).to.be.greaterThan(8_000n * ONE_USDC);
      expect(ceiling).to.be.lessThan(8_100n * ONE_USDC);
    });

    it('PROVES THE DEPLETION ARM FIRES: an unreachable threshold still graduates', async function () {
      const { ballista, usdc, creator, trader, registry } = await deployFixture();
      // Threshold far beyond anything the curve can ever accumulate. Without the
      // depletion arm this token would be permanently stuck: no tokens left to sell,
      // threshold unreachable, holders trapped, forever.
      await setGraduationThreshold(registry, await usdc.getAddress(), 10_000_000n * ONE_USDC);
      const tokenAddress = await launch(ballista, usdc, creator, 'DEPL');

      const rc = await (
        await ballista.connect(trader).buy(tokenAddress, 1_000_000n * ONE_USDC, 0)
      ).wait();

      const curve = await ballista.curves(tokenAddress);
      expect(curve.tokenReserves).to.equal(0n);
      expect(curve.state, 'depletion must graduate even with the threshold unreachable')
        .to.equal(2n);
      expect(findEvent(ballista, rc, 'Graduated')).to.not.be.undefined;
    });

    it('the old permanently-stuck scenario is now impossible', async function () {
      const { ballista, usdc, creator, trader, registry } = await deployFixture();
      await setGraduationThreshold(registry, await usdc.getAddress(), 10_000_000n * ONE_USDC);
      const tokenAddress = await launch(ballista, usdc, creator, 'STUCK');

      await ballista.connect(trader).buy(tokenAddress, 1_000_000n * ONE_USDC, 0);
      // Fully depleted AND graduated -- there is no state where tokenReserves is zero
      // and the curve is still ACTIVE waiting for a threshold it can never reach.
      const curve = await ballista.curves(tokenAddress);
      expect(curve.tokenReserves).to.equal(0n);
      expect(curve.state).to.not.equal(0n);
    });

    it('a clamped buy ALWAYS graduates -- the clamp takes every remaining token', async function () {
      const { ballista, usdc, creator, trader } = await deployFixture();
      const tokenAddress = await launch(ballista, usdc, creator, 'CLMP');
      const huge = 1_000_000n * ONE_USDC;

      const quote = await ballista.quoteBuy(tokenAddress, huge);
      expect(quote.actualQuoteIn, 'expected the clamp path').to.be.lessThan(huge);
      expect(quote.tokensOut).to.equal((await ballista.curves(tokenAddress)).tokenReserves);

      await ballista.connect(trader).buy(tokenAddress, huge, 0);
      expect((await ballista.curves(tokenAddress)).state).to.equal(2n);
    });

    it('graduationProgressBps reaches 100% and reflects whichever arm is closer', async function () {
      const { ballista, usdc, creator, trader } = await deployFixture();
      const tokenAddress = await launch(ballista, usdc, creator, 'PROG');
      expect(await ballista.graduationProgressBps(tokenAddress)).to.equal(0n);

      await ballista.connect(trader).buy(tokenAddress, 4_000n * ONE_USDC, 0);
      const mid = await ballista.graduationProgressBps(tokenAddress);
      expect(mid).to.be.greaterThan(0n);
      expect(mid).to.be.lessThan(10_000n);

      await ballista.connect(trader).buy(tokenAddress, 8_000n * ONE_USDC, 0);
      expect(await ballista.graduationProgressBps(tokenAddress)).to.equal(10_000n);
    });

    it('sell() needs no depletion handling: a sell can never see a depleted ACTIVE curve', async function () {
      const { ballista, usdc, creator, trader } = await deployFixture();
      const tokenAddress = await launch(ballista, usdc, creator, 'SELL');
      const token = await ethers.getContractAt('BXR1Token', tokenAddress);
      await token.connect(trader).approve(await ballista.getAddress(), ethers.MaxUint256);

      // Deplete in one buy; the same transaction graduates it.
      await ballista.connect(trader).buy(tokenAddress, 1_000_000n * ONE_USDC, 0);
      expect((await ballista.curves(tokenAddress)).tokenReserves).to.equal(0n);

      // Trading is closed, so no sell can push tokenReserves back above zero.
      await expect(
        ballista.connect(trader).sell(tokenAddress, 1_000n * 10n ** 18n, 0)
      ).to.be.revertedWithCustomError(ballista, 'CurveNotActive');
    });
  });

  it('the pool receives the full realQuoteReserves', async function () {
    const { ballista, usdc, creator, trader } = await deployFixture();
    const tokenAddress = await launch(ballista, usdc, creator, 'DEPTH');
    await ballista.connect(trader).buy(tokenAddress, 8_000n * ONE_USDC, 0);
    const before = await ballista.curves(tokenAddress);

    const rc = await (await ballista.connect(trader).buy(tokenAddress, 100n * ONE_USDC, 0)).wait();
    const grad = findEvent(ballista, rc, 'Graduated');
    expect(grad.args.quoteLiquidity).to.be.greaterThan(before.realQuoteReserves);
    expect(grad.args.quoteLiquidity).to.be.greaterThanOrEqual(8_000n * ONE_USDC);
  });

  it('pool tokens are the LP reserve plus whatever the curve never sold', async function () {
    const { ballista, usdc, creator, trader } = await deployFixture();
    const tokenAddress = await launch(ballista, usdc, creator, 'PTOK');
    await ballista.connect(trader).buy(tokenAddress, 8_000n * ONE_USDC, 0);
    const before = await ballista.curves(tokenAddress);

    const rc = await (await ballista.connect(trader).buy(tokenAddress, 100n * ONE_USDC, 0)).wait();
    const grad = findEvent(ballista, rc, 'Graduated');
    const lpReserve = await ballista.LP_TOKEN_RESERVE();

    expect(lpReserve).to.equal(193_000_000n * 10n ** 18n);
    expect(grad.args.tokenLiquidity).to.be.greaterThan(lpReserve);
    expect(grad.args.tokenLiquidity).to.be.lessThan(before.tokenReserves + lpReserve);
  });
});
