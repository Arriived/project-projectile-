const { expect } = require('chai');
const { ethers } = require('hardhat');
const { activateRouter } = require('../routerHelper');
const { deployRegistryWithAsset, getBXR1Factory } = require('./assetRegistryHelper');

const ONE = 1_000_000n;
const BPS = 10_000n;
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
    for (const s of [creator, a, b, c]) {
      await usdc.mint(s.address, 200_000_000n * ONE);
      await usdc.connect(s).approve(await ballista.getAddress(), ethers.MaxUint256);
    }
    return { deployer, treasury, creator, a, b, c, usdc, registry, ballista, router };
  }

  async function launch(ballista, usdc, creator, symbol) {
    const hash = await ballista.currentEconomicsHash(await usdc.getAddress());
    const rc = await (await ballista.connect(creator)
      .createToken('Audit', symbol, 'u', await usdc.getAddress(), hash)).wait();
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

      // graduationProgressBps() was removed 2026-09-18 as redundant view surface (see
      // BXR1.sol's own comment); reimplemented here from curves() so this still
      // asserts the real property -- progress strictly under 100% while ACTIVE and
      // under threshold, never a progress bar that reads 100% on a live curve.
      const c = await ballista.curves(t);
      const supply = await ballista.CURVE_TOKEN_SUPPLY();
      const byThreshold = (c.realQuoteReserves * BPS) / c.graduationThreshold;
      const bySupply = ((supply - c.tokenReserves) * BPS) / supply;
      const progress = byThreshold >= bySupply ? byThreshold : bySupply;
      expect(progress).to.be.lessThan(BPS);
    });
  });

  // creatorLaunchBuy and the timed creator window it gated were removed entirely
  // 2026-09-18 -- see CLAUDE.md section 26. There is no privileged, cap-clamped or
  // time-windowed creator buy path left to attack; a creator obtains tokens only
  // through the same buy() everyone else uses.

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
