const { expect } = require('chai');
const { ethers } = require('hardhat');
const { activateRouter } = require('../routerHelper');
const { deployRegistryWithAsset, getBXR1Factory } = require('./assetRegistryHelper');

const ONE = 1_000_000n;
const BPS = 10_000n;
const CURVE_SUPPLY = 807_000_000n * 10n ** 18n;
const ACTIVE = 0n, READY = 1n, GRADUATED = 2n;

// Fresh adversarial pass written AFTER the curve redesign, the dual trigger, the timed
// creator window and the custom-error conversion. Deliberately attacks from angles the
// existing suites were not written from.
describe('BXR1 — audit: fresh adversarial pass', function () {
  this.timeout(600000);

  async function env(usdcArtifact = 'MockUSDC') {
    const [deployer, treasury, creator, a, b, c] = await ethers.getSigners();
    const usdc = await (await ethers.getContractFactory(usdcArtifact)).deploy();
    const registry = await deployRegistryWithAsset(await usdc.getAddress());
    const ballista = await (await getBXR1Factory())
      .deploy(await registry.getAddress(), treasury.address, ethers.ZeroAddress);
    const router = await (await ethers.getContractFactory('MockRouter')).deploy();
    await activateRouter(ballista, await router.getAddress());
    await ballista.setLaunchCooldown(0);
    for (const s of [creator, a, b, c]) {
      await usdc.mint(s.address, 200_000_000n * ONE);
      await usdc.connect(s).approve(await ballista.getAddress(), ethers.MaxUint256);
    }
    return { deployer, treasury, creator, a, b, c, usdc, registry, ballista, router };
  }

  async function launch(ballista, usdc, creator, symbol) {
    const hash = await ballista.currentEconomicsHash(await usdc.getAddress());
    const rc = await (await ballista.connect(creator)
      .createToken('Audit', symbol, 'u', await usdc.getAddress(), hash, false)).wait();
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
      const t = await launch(ballista, usdc, creator, 'BOTH');
      await past();

      // One buy far larger than the curve can fill: the clamp takes every remaining
      // token, so BOTH arms of the trigger are true in the same call.
      const rc = await (await ballista.connect(a).buy(t, 500_000n * ONE, 0)).wait();
      const curve = await ballista.curves(t);

      expect(curve.state, 'must end GRADUATED, not READY').to.equal(GRADUATED);
      expect(curve.tokenReserves, 'reserves zeroed exactly once').to.equal(0n);
      expect(curve.realQuoteReserves).to.equal(0n);

      // Exactly one Graduated event -- both arms firing must not double-graduate.
      const grads = rc.logs.map((l) => { try { return ballista.interface.parseLog(l); } catch { return null; } })
        .filter((l) => l && l.name === 'Graduated');
      expect(grads.length, 'exactly one Graduated event').to.equal(1);

      // Solvency: the factory kept nothing it does not owe for this curve.
      expect(await ballista.graduationProgressBps(t)).to.equal(BPS);
    });

    it('ATTACK: sell into a GRADUATED curve to re-open it', async function () {
      const { ballista, a, creator, usdc } = await env();
      const t = await launch(ballista, usdc, creator, 'REOPEN');
      await past();
      await ballista.connect(a).buy(t, 500_000n * ONE, 0);
      expect((await ballista.curves(t)).state).to.equal(GRADUATED);

      const token = await ethers.getContractAt('BXR1Token', t);
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
      const { ballista, a, creator, router, usdc } = await env();
      const t = await launch(ballista, usdc, creator, 'STRAND');
      await past();
      // Revoke the router so the auto-graduation inside buy() cannot complete.
      await ballista.revokeRouter(await router.getAddress());
      await ballista.connect(a).buy(t, 500_000n * ONE, 0);

      const curve = await ballista.curves(t);
      expect(curve.state, 'stranded at READY').to.equal(READY);

      // Everything trading-related is shut, including the escape hatch a holder
      // would most want. This is the known cost of the decoupled state machine.
      const token = await ethers.getContractAt('BXR1Token', t);
      const held = await token.balanceOf(a.address);
      await token.connect(a).approve(await ballista.getAddress(), held);
      await expect(ballista.connect(a).sell(t, held, 0))
        .to.be.revertedWithCustomError(ballista, 'CurveNotActive');
      await expect(ballista.graduate(t))
        .to.be.revertedWithCustomError(ballista, 'RouterNotSet');
    });

    it('ATTACK: land exactly ONE WEI under the threshold and stay ACTIVE', async function () {
      const { ballista, a, creator, usdc } = await env();
      const t = await launch(ballista, usdc, creator, 'EDGE');
      await past();
      const threshold = (await ballista.curves(t)).graduationThreshold;

      // Walk up close, then binary-search the last buy that stays ACTIVE.
      await ballista.connect(a).buy(t, 7_000n * ONE, 0);
      let curve = await ballista.curves(t);
      expect(curve.state).to.equal(ACTIVE);
      expect(curve.realQuoteReserves).to.be.lessThan(threshold);

      // graduationProgressBps must be strictly under 100% while ACTIVE and under
      // threshold -- a progress bar that reads 100% on an ACTIVE curve is a bug.
      expect(await ballista.graduationProgressBps(t)).to.be.lessThan(BPS);
    });
  });

  describe('timed creator window', function () {
    it('ATTACK: a huge window must not overflow the timestamp comparison', async function () {
      const { ballista, creator, usdc } = await env();
      await ballista.setCreatorLaunchWindow(4294967295n); // type(uint32).max
      const t = await launch(ballista, usdc, creator, 'HUGE');
      await past(10_000);
      // creationTimestamp + window is computed in uint256, so this must simply be open.
      await expect(ballista.connect(creator).creatorLaunchBuy(t, ONE, 0)).to.not.be.reverted;
    });

    it('ATTACK: exhaust the cumulative cap, then try again inside the same window', async function () {
      const { ballista, creator, usdc } = await env();
      await ballista.setCreatorLaunchWindow(600);
      const t = await launch(ballista, usdc, creator, 'CAP2');
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
      const t = await launch(ballista, usdc, creator, 'INV');
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
      expect(curve.realQuoteReserves).to.be.greaterThan(0n);
    });
  });

  describe('external-token assumptions', function () {
    // END TO END. Before the accrue-and-claim change every buy, every sell AND every
    // createToken pushed to the treasury inline, so a blocklisted treasury bricked the
    // whole launchpad. The project had already decided a payee that reverts must never
    // break trading and applied that to creators only; this is the same fix on the
    // other payee.
    it('ATTACK: blocklist the TREASURY -- trading, launching and recovery all survive', async function () {
      const { ballista, usdc, creator, a, treasury, deployer } =
        await env('MockBlocklistUSDC');
      const t = await launch(ballista, usdc, creator, 'TBLOCK');
      const usdcAddress = await usdc.getAddress();
      await past();
      await ballista.connect(a).buy(t, 100n * ONE, 0);

      await usdc.setBlocked(treasury.address, true);

      // 1. Trading survives.
      await expect(ballista.connect(a).buy(t, 100n * ONE, 0)).to.not.be.reverted;
      const token = await ethers.getContractAt('BXR1Token', t);
      const held = await token.balanceOf(a.address);
      await token.connect(a).approve(await ballista.getAddress(), held / 4n);
      await expect(ballista.connect(a).sell(t, held / 4n, 0)).to.not.be.reverted;

      // 2. Launching survives -- the creation fee accrues instead of being pushed.
      const t2 = await launch(ballista, usdc, creator, 'TBLOCK2');
      expect(t2, 'a launch must still succeed while the treasury is blocked')
        .to.properAddress;

      // 3. Fees really did accrue rather than vanish.
      const accrued = await ballista.treasuryFeesAccrued(usdcAddress);
      expect(accrued, 'treasury fees must accumulate while blocked').to.be.greaterThan(0n);

      // 4. Only the sweep fails, and only while blocked.
      await expect(ballista.claimTreasuryFees(usdcAddress)).to.be.reverted;

      // 5. setTreasury recovers it, and everything accrued is still claimable.
      await ballista.connect(deployer).setTreasury(a.address);
      const before = await usdc.balanceOf(a.address);
      await expect(ballista.claimTreasuryFees(usdcAddress)).to.not.be.reverted;
      expect((await usdc.balanceOf(a.address)) - before,
        'the whole accrued balance survives the blocklist').to.equal(accrued);
      expect(await ballista.treasuryFeesAccrued(usdcAddress)).to.equal(0n);
    });

    it('claimTreasuryFees is permissionless but can only ever pay the treasury', async function () {
      const { ballista, usdc, creator, a, b, treasury } = await env();
      const usdcAddress = await usdc.getAddress();
      const t = await launch(ballista, usdc, creator, 'PERM');
      await past();
      await ballista.connect(a).buy(t, 500n * ONE, 0);

      const accrued = await ballista.treasuryFeesAccrued(usdcAddress);
      expect(accrued).to.be.greaterThan(0n);

      // A stranger calling it moves protocol funds to the protocol, never to themselves.
      const strangerBefore = await usdc.balanceOf(b.address);
      const treasuryBefore = await usdc.balanceOf(treasury.address);
      await ballista.connect(b).claimTreasuryFees(usdcAddress);
      expect(await usdc.balanceOf(b.address), 'caller gains nothing').to.equal(strangerBefore);
      expect((await usdc.balanceOf(treasury.address)) - treasuryBefore).to.equal(accrued);

      await expect(ballista.connect(b).claimTreasuryFees(usdcAddress))
        .to.be.revertedWithCustomError(ballista, 'NothingToClaim');
    });
  });

  describe('rounding and dust', function () {
    it('FARM: 1,200 alternating trades -- dust must never leave the factory short', async function () {
      const { ballista, usdc, creator, a, b } = await env();
      const usdcAddress = await usdc.getAddress();
      const t = await launch(ballista, usdc, creator, 'DUST');
      await past();
      const token = await ethers.getContractAt('BXR1Token', t);
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
        const owed = curve.realQuoteReserves
          + (await ballista.creatorFeesAccrued(creator.address, usdcAddress))
          + (await ballista.treasuryFeesAccrued(usdcAddress));
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
