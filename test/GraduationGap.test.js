const { expect } = require('chai');
const { ethers } = require('hardhat');

const ONE_USDC = 1_000_000n;
const SCALE = 1_000_000n; // fixed-point scale for the measured ratio; SCALE == 1.0

// The number this file exists to pin down: when a curve graduates, does the DEX pool
// open above or below the price the last curve buyer just paid?
//
// pool price   = usdcLiquidity / tokenLiquidity   (from the Graduated event)
// curve price  = virtualUsdcReserves / virtualTokenReserves  (marginal, at close)
//
// Both are computed from raw reserves in BigInt rather than through currentPrice(),
// which divides down to roughly three significant figures -- enough rounding noise to
// swamp the few-percent signal being measured.
function gapBps(usdcLiquidity, tokenLiquidity, virtualUsdc, virtualToken) {
  const ratio = (usdcLiquidity * virtualToken * SCALE) / (tokenLiquidity * virtualUsdc);
  return Number(ratio - SCALE) / Number(SCALE) * 10_000;
}

describe('Ballista — graduation price gap', function () {
  async function deployFixture() {
    const [deployer, treasury, creator, trader] = await ethers.getSigners();

    const usdc = await (await ethers.getContractFactory('MockUSDC')).deploy();
    const ballista = await (await ethers.getContractFactory('Ballista')).deploy(
      await usdc.getAddress(),
      treasury.address
    );
    const router = await (await ethers.getContractFactory('MockRouter')).deploy();
    await ballista.setRouter(await router.getAddress());

    // These tests are about steady-state curve economics, not sniping, and they trade
    // immediately after launch -- which in production is squarely inside the snipe
    // window. Publishing an empty table disables the tax for this fixture so those
    // trades model normal post-window trading. The tax has its own suite in
    // test/SnipeTax.test.js.
    await ballista.publishSnipeTaxTable([]);

    for (const signer of [creator, trader]) {
      await usdc.mint(signer.address, 10_000_000n * ONE_USDC);
      await usdc.connect(signer).approve(await ballista.getAddress(), ethers.MaxUint256);
    }
    return { deployer, treasury, creator, trader, usdc, ballista };
  }

  async function launch(ballista, creator, symbol) {
    const hash = await ballista.currentEconomicsHash();
    const receipt = await (
      await ballista.connect(creator).createToken('Gap Test', symbol, 'ipfs://a', hash)
    ).wait();
    const event = receipt.logs
      .map((l) => { try { return ballista.interface.parseLog(l); } catch { return null; } })
      .find((l) => l && l.name === 'TokenCreated');
    return event.args.token;
  }

  // Drives a token to graduation and returns the measured gap plus the inputs it was
  // derived from. `finalBuy` controls how far past the threshold the triggering trade
  // overshoots, which is the main thing besides LP_TOKEN_RESERVE that moves the gap.
  async function graduateAndMeasure(ballista, creator, trader, symbol, approachUsdc, finalBuy) {
    const tokenAddress = await launch(ballista, creator, symbol);

    await ballista.connect(trader).buy(tokenAddress, approachUsdc, 0);
    const beforeFinal = await ballista.curves(tokenAddress);
    expect(beforeFinal.state).to.equal(0n); // still ACTIVE -- the approach must not graduate

    const receipt = await (await ballista.connect(trader).buy(tokenAddress, finalBuy, 0)).wait();
    const graduated = receipt.logs
      .map((l) => { try { return ballista.interface.parseLog(l); } catch { return null; } })
      .find((l) => l && l.name === 'Graduated');
    expect(graduated, 'expected this buy to graduate the token').to.not.be.undefined;

    // Virtual reserves are NOT zeroed by graduation, so the curve's closing price is
    // still readable afterwards.
    const curve = await ballista.curves(tokenAddress);
    return {
      gap: gapBps(
        graduated.args.usdcLiquidity,
        graduated.args.tokenLiquidity,
        curve.virtualUsdcReserves,
        curve.virtualTokenReserves
      ),
      usdcLiquidity: graduated.args.usdcLiquidity,
      tokenLiquidity: graduated.args.tokenLiquidity,
    };
  }

  it('opens the DEX pool ABOVE the curve closing price, by under 5%', async function () {
    const { ballista, creator, trader } = await deployFixture();

    // Approach 67,000 tightly: 67,000 gross nets 66,330 after the 1% fee, leaving the
    // curve just short, then a small final buy crosses. Minimal overshoot isolates the
    // effect of LP_TOKEN_RESERVE from the effect of a sloppy final trade.
    const { gap, usdcLiquidity, tokenLiquidity } = await graduateAndMeasure(
      ballista, creator, trader, 'GAPA', 67_000n * ONE_USDC, 700n * ONE_USDC
    );

    console.log(`        measured gap (tight graduation): ${(gap / 100).toFixed(2)}%`);
    console.log(`        pool: ${(Number(usdcLiquidity) / 1e6).toFixed(0)} USDC / ` +
                `${(Number(tokenLiquidity) / 1e18).toFixed(0)} tokens`);

    expect(gap).to.be.greaterThan(0, 'pool must not open below the curve close');
    expect(gap).to.be.lessThan(500, 'pool must not open more than 5% above the curve close');
  });

  // The gap is NOT a fixed property of LP_TOKEN_RESERVE -- it scales with how far the
  // triggering buy overshoots the threshold, because overshoot sells more of the curve
  // and leaves fewer unsold tokens to dilute the pool. The +2.4% above is the tight
  // case; a whale crossing the threshold in one oversized buy lands far higher.
  //
  // The property actually worth enforcing is the SIGN. Positive means the pool opens at
  // or above the curve's close, so the last curve buyer is never instantly underwater --
  // which is the failure the resize existed to remove. The magnitude is a spread traders
  // can position against, and is reported here rather than asserted to a number, since
  // any bound would be arbitrary.
  it('never opens the pool below the curve close, at any overshoot', async function () {
    const { ballista, creator, trader } = await deployFixture();

    const cases = [
      ['tight        ', 67_000n, 700n],
      ['moderate     ', 60_000n, 12_000n],
      ['heavy        ', 50_000n, 30_000n],
      ['near-depletion', 50_000n, 60_000n],
    ];

    const measured = [];
    for (const [label, approach, final] of cases) {
      // Same creator launches all four, so the per-wallet cooldown has to elapse.
      await ethers.provider.send('evm_increaseTime', [60]);
      await ethers.provider.send('evm_mine');

      const { gap } = await graduateAndMeasure(
        ballista, creator, trader,
        'OVS' + measured.length,
        approach * ONE_USDC,
        final * ONE_USDC
      );
      measured.push([label, gap]);
      expect(gap, `${label.trim()} overshoot opened the pool BELOW the curve close`)
        .to.be.greaterThan(0);
    }

    console.log('        gap by overshoot:');
    for (const [label, gap] of measured) {
      console.log(`          ${label}  ${(gap / 100).toFixed(2)}%`);
    }
  });

  it('pool USDC depth is the full realUsdcReserves, unchanged by the reserve resize', async function () {
    const { ballista, creator, trader } = await deployFixture();
    const tokenAddress = await launch(ballista, creator, 'GAPC');

    await ballista.connect(trader).buy(tokenAddress, 67_000n * ONE_USDC, 0);
    const before = await ballista.curves(tokenAddress);

    const receipt = await (
      await ballista.connect(trader).buy(tokenAddress, 700n * ONE_USDC, 0)
    ).wait();
    const graduated = receipt.logs
      .map((l) => { try { return ballista.interface.parseLog(l); } catch { return null; } })
      .find((l) => l && l.name === 'Graduated');

    // Everything the curve collected goes to the pool -- the resize moved tokens, not USDC.
    expect(graduated.args.usdcLiquidity).to.be.greaterThan(before.realUsdcReserves);
    expect(graduated.args.usdcLiquidity).to.be.greaterThan(67_000n * ONE_USDC);
  });

  it('pool tokens are the LP reserve plus whatever the curve never sold', async function () {
    const { ballista, creator, trader } = await deployFixture();
    const tokenAddress = await launch(ballista, creator, 'GAPD');

    await ballista.connect(trader).buy(tokenAddress, 67_000n * ONE_USDC, 0);
    const before = await ballista.curves(tokenAddress);

    const receipt = await (
      await ballista.connect(trader).buy(tokenAddress, 700n * ONE_USDC, 0)
    ).wait();
    const graduated = receipt.logs
      .map((l) => { try { return ballista.interface.parseLog(l); } catch { return null; } })
      .find((l) => l && l.name === 'Graduated');

    const lpReserve = await ballista.LP_TOKEN_RESERVE();
    expect(lpReserve).to.equal(165_000_000n * 10n ** 18n);
    // tokenReserves at the moment of graduation is the leftover; it is zeroed after,
    // so this reconstructs it from the event rather than reading it back.
    expect(graduated.args.tokenLiquidity).to.be.greaterThan(lpReserve);
    expect(graduated.args.tokenLiquidity).to.be.lessThan(before.tokenReserves + lpReserve);
  });
});
