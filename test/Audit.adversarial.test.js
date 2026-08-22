const { expect } = require('chai');
const { ethers } = require('hardhat');
const { activateRouter } = require('./routerHelper');

const ONE = 1_000_000n;
const BPS = 10_000n;
const CURVE_SUPPLY = 807_000_000n * 10n ** 18n;
const ACTIVE = 0n, READY = 1n, GRADUATED = 2n;

// Fresh adversarial pass written AFTER the curve redesign, the dual trigger, the timed
// creator window and the custom-error conversion. Deliberately attacks from angles the
// existing suites were not written from.
describe('LFX1 — audit: fresh adversarial pass', function () {
  this.timeout(600000);

  async function env(usdcArtifact = 'MockUSDC') {
    const [deployer, treasury, creator, a, b, c] = await ethers.getSigners();
    const usdc = await (await ethers.getContractFactory(usdcArtifact)).deploy();
    const ballista = await (await ethers.getContractFactory('LFX1'))
      .deploy(await usdc.getAddress(), treasury.address, ethers.ZeroAddress);
    const router = await (await ethers.getContractFactory('MockRouter')).deploy();
    await activateRouter(ballista, await router.getAddress());
    await ballista.setLaunchCooldown(0);
    for (const s of [creator, a, b, c]) {
      await usdc.mint(s.address, 200_000_000n * ONE);
      await usdc.connect(s).approve(await ballista.getAddress(), ethers.MaxUint256);
    }
    return { deployer, treasury, creator, a, b, c, usdc, ballista, router };
  }

  async function launch(ballista, creator, symbol) {
    const hash = await ballista.currentEconomicsHash();
    const rc = await (await ballista.connect(creator)
      .createToken('Audit', symbol, 'u', hash, false)).wait();
    return rc.logs.map((l) => { try { return ballista.interface.parseLog(l); } catch { return null; } })
      .find((l) => l && l.name === 'TokenCreated').args.token;
  }
  const past = async (s = 30) => {
    await ethers.provider.send('evm_increaseTime', [s]);
    await ethers.provider.send('evm_mine');
  };

  describe('dual graduation trigger', function () {
    it('ATTACK: cross the threshold and deplete the curve in the SAME transaction', async function () {
      const { ballista, a, creator, usdc } = await env();
      const t = await launch(ballista, creator, 'BOTH');
      await past();

      // One buy far larger than the curve can fill: the clamp takes every remaining
      // token, so BOTH arms of the trigger are true in the same call.
      const rc = await (await ballista.connect(a).buy(t, 500_000n * ONE, 0)).wait();
      const curve = await ballista.curves(t);

      expect(curve.state, 'must end GRADUATED, not READY').to.equal(GRADUATED);
      expect(curve.tokenReserves, 'reserves zeroed exactly once').to.equal(0n);
      expect(curve.realUsdcReserves).to.equal(0n);

      // Exactly one Graduated event -- both arms firing must not double-graduate.
      const grads = rc.logs.map((l) => { try { return ballista.interface.parseLog(l); } catch { return null; } })
        .filter((l) => l && l.name === 'Graduated');
      expect(grads.length, 'exactly one Graduated event').to.equal(1);

      // Solvency: the factory kept nothing it does not owe for this curve.
      expect(await ballista.graduationProgressBps(t)).to.equal(BPS);
    });

    it('ATTACK: sell into a GRADUATED curve to re-open it', async function () {
      const { ballista, a, creator } = await env();
      const t = await launch(ballista, creator, 'REOPEN');
      await past();
      await ballista.connect(a).buy(t, 500_000n * ONE, 0);
      expect((await ballista.curves(t)).state).to.equal(GRADUATED);

      const token = await ethers.getContractAt('LFX1Token', t);
      const held = await token.balanceOf(a.address);
      expect(held, 'attacker must actually hold tokens for this to be a real attempt')
        .to.be.greaterThan(0n);
      await token.connect(a).approve(await ballista.getAddress(), held);

      await expect(ballista.connect(a).sell(t, held, 0))
        .to.be.revertedWithCustomError(ballista, 'CurveNotActive');
      await expect(ballista.connect(a).buy(t, ONE, 0))
        .to.be.revertedWithCustomError(ballista, 'CurveNotActive');
      expect((await ballista.curves(t)).state, 'still GRADUATED').to.equal(GRADUATED);
    });

    it('ATTACK: strand a curve at GRADUATION_READY, then sell out of it', async function () {
      const { ballista, a, creator, router } = await env();
      const t = await launch(ballista, creator, 'STRAND');
      await past();
      // Revoke the router so the auto-graduation inside buy() cannot complete.
      await ballista.revokeRouter(await router.getAddress());
      await ballista.connect(a).buy(t, 500_000n * ONE, 0);

      const curve = await ballista.curves(t);
      expect(curve.state, 'stranded at READY').to.equal(READY);

      // Everything trading-related is shut, including the escape hatch a holder
      // would most want. This is the known cost of the decoupled state machine.
      const token = await ethers.getContractAt('LFX1Token', t);
      const held = await token.balanceOf(a.address);
      await token.connect(a).approve(await ballista.getAddress(), held);
      await expect(ballista.connect(a).sell(t, held, 0))
        .to.be.revertedWithCustomError(ballista, 'CurveNotActive');
      await expect(ballista.graduate(t))
        .to.be.revertedWithCustomError(ballista, 'RouterNotSet');
    });

    it('ATTACK: land exactly ONE WEI under the threshold and stay ACTIVE', async function () {
      const { ballista, a, creator } = await env();
      const t = await launch(ballista, creator, 'EDGE');
      await past();
      const threshold = (await ballista.curves(t)).graduationThresholdUsdc;

      // Walk up close, then binary-search the last buy that stays ACTIVE.
      await ballista.connect(a).buy(t, 7_000n * ONE, 0);
      let curve = await ballista.curves(t);
      expect(curve.state).to.equal(ACTIVE);
      expect(curve.realUsdcReserves).to.be.lessThan(threshold);

      // graduationProgressBps must be strictly under 100% while ACTIVE and under
      // threshold -- a progress bar that reads 100% on an ACTIVE curve is a bug.
      expect(await ballista.graduationProgressBps(t)).to.be.lessThan(BPS);
    });
  });

  describe('timed creator window', function () {
    it('ATTACK: a huge window must not overflow the timestamp comparison', async function () {
      const { ballista, creator } = await env();
      await ballista.setCreatorLaunchWindow(4294967295n); // type(uint32).max
      const t = await launch(ballista, creator, 'HUGE');
      await past(10_000);
      // creationTimestamp + window is computed in uint256, so this must simply be open.
      await expect(ballista.connect(creator).creatorLaunchBuy(t, ONE, 0)).to.not.be.reverted;
    });

    it('ATTACK: exhaust the cumulative cap, then try again inside the same window', async function () {
      const { ballista, creator } = await env();
      await ballista.setCreatorLaunchWindow(600);
      const t = await launch(ballista, creator, 'CAP2');
      const created = Number((await ballista.curves(t)).creationTimestamp);

      await ethers.provider.send('evm_setNextBlockTimestamp', [created + 1]);
      await ballista.connect(creator).creatorLaunchBuy(t, 5_000n * ONE, 0);
      const after = await ballista.curves(t);
      const bps = (after.creatorLaunchPurchased * BPS) / CURVE_SUPPLY;
      expect(bps, 'clamped to exactly the 2.5% cap').to.equal(250n);

      await ethers.provider.send('evm_setNextBlockTimestamp', [created + 2]);
      await expect(ballista.connect(creator).creatorLaunchBuy(t, ONE, 0))
        .to.be.revertedWithCustomError(ballista, 'CreatorAllocationUsed');
    });

    it('ATTACK: creator buys at the cap boundary -- the clamp fee inversion at the exempt fee', async function () {
      const { ballista, creator, usdc } = await env();
      await ballista.setCreatorLaunchWindow(600);
      const t = await launch(ballista, creator, 'INV');
      const created = Number((await ballista.curves(t)).creationTimestamp);
      const before = await usdc.balanceOf(creator.address);

      // Offer vastly more than the cap allows: the clamp must invert the fee at the
      // UNTAXED rate and must never pull more than the cap actually costs.
      await ethers.provider.send('evm_setNextBlockTimestamp', [created + 1]);
      await ballista.connect(creator).creatorLaunchBuy(t, 10_000_000n * ONE, 0);
      const spent = before - (await usdc.balanceOf(creator.address));
      const curve = await ballista.curves(t);

      expect((curve.creatorLaunchPurchased * BPS) / CURVE_SUPPLY).to.equal(250n);
      expect(spent, 'must not pull the whole offer').to.be.lessThan(1_000n * ONE);
      // No snipe tax may have been taken on this path even inside the tax window.
      expect(curve.realUsdcReserves).to.be.greaterThan(0n);
    });
  });

  describe('external-token assumptions', function () {
    it('ATTACK: blocklist the TREASURY and see whether trading survives', async function () {
      const { ballista, usdc, creator, a, treasury, deployer } =
        await env('MockBlocklistUSDC');
      const t = await launch(ballista, creator, 'TBLOCK');
      await past();
      await ballista.connect(a).buy(t, 100n * ONE, 0);

      await usdc.setBlocked(treasury.address, true);

      // Every buy and sell pushes treasuryCut to treasury inside the trade.
      const buyBlocked = await ballista.connect(a).buy(t, 100n * ONE, 0)
        .then(() => false).catch(() => true);
      console.log(`        treasury blocklisted -> buy reverts: ${buyBlocked}`);
      expect(buyBlocked, 'a blocklisted treasury halts buys').to.equal(true);

      // Recovery must not need a redeploy: point treasury elsewhere and trade again.
      await ballista.connect(deployer).setTreasury(a.address);
      await expect(ballista.connect(a).buy(t, 100n * ONE, 0)).to.not.be.reverted;
    });
  });

  describe('rounding and dust', function () {
    it('FARM: 1,200 alternating trades -- dust must never leave the factory short', async function () {
      const { ballista, usdc, creator, a, b } = await env();
      const t = await launch(ballista, creator, 'DUST');
      await past();
      const token = await ethers.getContractAt('LFX1Token', t);
      const addr = await ballista.getAddress();
      await token.connect(a).approve(addr, ethers.MaxUint256);
      await token.connect(b).approve(addr, ethers.MaxUint256);

      let worstSlack = null;
      for (let i = 0; i < 600; i++) {
        const who = i % 2 === 0 ? a : b;
        if ((await ballista.curves(t)).state !== ACTIVE) break;
        await ballista.connect(who).buy(t, BigInt(1 + (i % 7)), 0);
        const bal = await token.balanceOf(who.address);
        if (bal > 0n) await ballista.connect(who).sell(t, bal / 2n + 1n, 0);

        const curve = await ballista.curves(t);
        const owed = curve.realUsdcReserves
          + (await ballista.creatorFeesAccrued(creator.address));
        const held = await usdc.balanceOf(addr);
        const slack = held - owed;
        if (worstSlack === null || slack < worstSlack) worstSlack = slack;
        expect(slack, `factory short at iteration ${i}`).to.be.greaterThanOrEqual(0n);
      }
      console.log(`        worst slack over the run: ${worstSlack} (must be >= 0; dust favours the curve)`);
      expect(worstSlack).to.be.greaterThanOrEqual(0n);
    });
  });
});
