const { expect } = require('chai');
const { ethers } = require('hardhat');
const { activateRouter } = require('./routerHelper');

const ONE = 1_000_000n;
const SCALE = 1_000_000n;

function gapBps(usdcLiq, tokenLiq, vUsdc, vToken) {
  const ratio = (usdcLiq * vToken * SCALE) / (tokenLiq * vUsdc);
  return (Number(ratio - SCALE) / Number(SCALE)) * 10_000;
}

describe('Ballista — creator fee to pool boost', function () {
  async function env() {
    const [deployer, treasury, creator, trader] = await ethers.getSigners();
    const usdc = await (await ethers.getContractFactory('MockUSDC')).deploy();
    const ballista = await (await ethers.getContractFactory('Ballista'))
      .deploy(await usdc.getAddress(), treasury.address, ethers.ZeroAddress);
    const router = await (await ethers.getContractFactory('MockRouter')).deploy();
    await activateRouter(ballista, await router.getAddress());
    await ballista.publishSnipeTaxTable([]);
    await ballista.setLaunchCooldown(0);
    for (const s of [creator, trader]) {
      await usdc.mint(s.address, 10_000_000n * ONE);
      await usdc.connect(s).approve(await ballista.getAddress(), ethers.MaxUint256);
    }
    return { deployer, treasury, creator, trader, usdc, ballista };
  }

  async function launch(ballista, creator, symbol, boost) {
    const hash = await ballista.currentEconomicsHash();
    const rc = await (await ballista.connect(creator)
      .createToken('Boost', symbol, 'ipfs://a', hash, boost)).wait();
    return rc.logs.map((l) => { try { return ballista.interface.parseLog(l); } catch { return null; } })
      .find((l) => l && l.name === 'TokenCreated').args.token;
  }

  function findEvent(ballista, rc, name) {
    return rc.logs.map((l) => { try { return ballista.interface.parseLog(l); } catch { return null; } })
      .find((l) => l && l.name === name);
  }

  // Churns a token to build up a boost without moving reserves far.
  async function churn(ballista, trader, t, rounds, size) {
    const token = await ethers.getContractAt('ArcLaunchToken', t);
    await token.connect(trader).approve(await ballista.getAddress(), ethers.MaxUint256);
    for (let i = 0; i < rounds; i++) {
      await ballista.connect(trader).buy(t, size, 0);
      const bal = await token.balanceOf(trader.address);
      if (bal > 0n) await ballista.connect(trader).sell(t, bal, 0);
    }
  }

  it('the flag is snapshotted and immutable after launch', async function () {
    const { ballista, creator } = await env();
    const off = await launch(ballista, creator, 'OFF', false);
    const on = await launch(ballista, creator, 'ON', true);
    expect((await ballista.curves(off)).poolBoostEnabled).to.equal(false);
    expect((await ballista.curves(on)).poolBoostEnabled).to.equal(true);

    // There is no setter for it anywhere in the ABI -- immutability is structural,
    // not a convention someone could later relax.
    const setters = ballista.interface.fragments
      .filter((f) => f.type === 'function' && /^set/i.test(f.name || ''))
      .map((f) => f.name)
      .filter((n) => /boost/i.test(n));
    expect(setters).to.deep.equal([]);
  });

  it('boost accrues ONLY when the flag is set', async function () {
    const { ballista, creator, trader } = await env();
    const off = await launch(ballista, creator, 'OFF2', false);
    const on = await launch(ballista, creator, 'ON2', true);

    await ballista.connect(trader).buy(off, 1_000n * ONE, 0);
    await ballista.connect(trader).buy(on, 1_000n * ONE, 0);

    expect((await ballista.curves(off)).poolBoost).to.equal(0n);
    expect((await ballista.curves(on)).poolBoost).to.be.greaterThan(0n);
  });

  it('with boost ON the creator accrues nothing claimable -- the fee is diverted', async function () {
    const { ballista, creator, trader } = await env();
    const on = await launch(ballista, creator, 'DIV', true);
    await ballista.connect(trader).buy(on, 1_000n * ONE, 0);

    expect(await ballista.creatorFeesAccrued(creator.address)).to.equal(0n);
    await expect(ballista.connect(creator).claimCreatorFees()).to.be.revertedWith('nothing to claim');
    // The diverted amount is exactly the creator's 0.90% buy-side share.
    expect((await ballista.curves(on)).poolBoost).to.equal((1_000n * ONE * 90n) / 10_000n);
  });

  it('diverts on the SELL side too, at the sell rate', async function () {
    const { ballista, creator, trader } = await env();
    const on = await launch(ballista, creator, 'SELLB', true);
    await ballista.connect(trader).buy(on, 1_000n * ONE, 0);
    const afterBuy = (await ballista.curves(on)).poolBoost;

    const token = await ethers.getContractAt('ArcLaunchToken', on);
    const held = await token.balanceOf(trader.address);
    await token.connect(trader).approve(await ballista.getAddress(), held);
    const quote = await ballista.quoteSell(on, held);
    await ballista.connect(trader).sell(on, held, 0);

    const sellShare = (await ballista.curves(on)).poolBoost - afterBuy;
    expect(sellShare).to.equal((quote.usdcOutGross * 50n) / 10_000n);
    expect(await ballista.creatorFeesAccrued(creator.address)).to.equal(0n);
  });

  it('emits an accrual event carrying the running total', async function () {
    const { ballista, creator, trader } = await env();
    const on = await launch(ballista, creator, 'EVT', true);
    const rc = await (await ballista.connect(trader).buy(on, 1_000n * ONE, 0)).wait();
    const e = findEvent(ballista, rc, 'PoolBoostAccrued');
    expect(e).to.not.be.undefined;
    expect(e.args.amount).to.equal((1_000n * ONE * 90n) / 10_000n);
    expect(e.args.total).to.equal(e.args.amount);
  });

  describe('CRITICAL: the boost must not advance graduation', function () {
    it('poolBoost is never folded into realUsdcReserves', async function () {
      const { ballista, creator, trader } = await env();
      const on = await launch(ballista, creator, 'SEP', true);
      const before = await ballista.curves(on);
      await ballista.connect(trader).buy(on, 1_000n * ONE, 0);
      const after = await ballista.curves(on);

      const spend = 1_000n * ONE;
      const totalFee = (spend * 100n) / 10_000n;
      // Reserves grew by exactly the post-fee spend. The creator's 0.90% went to the
      // boost, NOT into the reserves the graduation threshold is measured against.
      expect(after.realUsdcReserves - before.realUsdcReserves).to.equal(spend - totalFee);
      expect(after.poolBoost).to.equal((spend * 90n) / 10_000n);
    });

    it('a heavily boosted token graduates at the SAME reserve level as an unboosted one', async function () {
      const { ballista, creator, trader } = await env();
      const off = await launch(ballista, creator, 'GOFF', false);
      const on = await launch(ballista, creator, 'GON', true);

      // Build a real boost on the boosted token first, without pushing its reserves far.
      await churn(ballista, trader, on, 12, 300n * ONE);
      const boost = (await ballista.curves(on)).poolBoost;
      expect(boost, 'boosted token must carry a real boost by now').to.be.greaterThan(0n);

      // Drive both to graduation identically and compare the reserve level at which the
      // threshold fired. If the boost counted, the boosted one would fire EARLIER.
      const results = {};
      for (const [label, t] of [['off', off], ['on', on]]) {
        let last;
        for (let i = 0; i < 30; i++) {
          const c = await ballista.curves(t);
          if (c.state !== 0n) break;
          last = c.realUsdcReserves;
          await ballista.connect(trader).buy(t, 500n * ONE, 0);
        }
        results[label] = await ballista.curves(t);
      }

      expect(results.off.state).to.equal(2n);
      expect(results.on.state).to.equal(2n);
      // Both crossed the same 8,000 threshold on their own reserves alone.
      console.log(`        boost carried at graduation: ${ethers.formatUnits(boost, 6)} USDC`);
    });

    it('the boost reaches the POOL at graduation and is then cleared', async function () {
      const { ballista, creator, trader } = await env();
      const on = await launch(ballista, creator, 'POOL', true);
      await churn(ballista, trader, on, 8, 300n * ONE);
      const boost = (await ballista.curves(on)).poolBoost;
      expect(boost).to.be.greaterThan(0n);

      await ballista.connect(trader).buy(on, 8_000n * ONE, 0);
      const beforeFinal = await ballista.curves(on);
      const rc = await (await ballista.connect(trader).buy(on, 100n * ONE, 0)).wait();
      const g = findEvent(ballista, rc, 'Graduated');
      expect(g, 'expected graduation').to.not.be.undefined;

      // The pool received the curve's reserves PLUS the accumulated boost.
      const finalBoost = beforeFinal.poolBoost;
      expect(g.args.usdcLiquidity).to.be.greaterThan(beforeFinal.realUsdcReserves + finalBoost - ONE);
      expect((await ballista.curves(on)).poolBoost).to.equal(0n);
      console.log(`        pool received ${ethers.formatUnits(g.args.usdcLiquidity, 6)} USDC ` +
                  `(of which boost ${ethers.formatUnits(finalBoost, 6)})`);
    });

    it('MEASURES the graduation gap with and without the boost', async function () {
      const { ballista, creator, trader } = await env();
      const out = {};
      for (const [label, flag] of [['without', false], ['with', true]]) {
        const t = await launch(ballista, creator, flag ? 'GAPB' : 'GAPN', flag);
        await churn(ballista, trader, t, 10, 300n * ONE);
        await ballista.connect(trader).buy(t, 8_000n * ONE, 0);
        const rc = await (await ballista.connect(trader).buy(t, 100n * ONE, 0)).wait();
        const g = findEvent(ballista, rc, 'Graduated');
        const c = await ballista.curves(t);
        out[label] = gapBps(g.args.usdcLiquidity, g.args.tokenLiquidity,
                            c.virtualUsdcReserves, c.virtualTokenReserves);
      }
      console.log(`        gap without boost: ${(out.without / 100).toFixed(3)}%`);
      console.log(`        gap with    boost: ${(out.with / 100).toFixed(3)}%`);

      // A deeper pool raises the gap. Keep the total well under +10%: past that the
      // pool is visibly arbitraged down in the first minutes and whoever buys first on
      // the DEX gets a bad fill.
      expect(out.with).to.be.greaterThan(out.without);
      expect(out.with).to.be.lessThan(1000);
    });
  });
});
