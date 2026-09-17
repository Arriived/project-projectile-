const { expect } = require('chai');
const { ethers } = require('hardhat');
const { activateRouter } = require('../routerHelper');
const { deployRegistryWithAsset, getBXR1Factory } = require('./assetRegistryHelper');

const ONE = 1_000_000n;
const BPS = 10_000n;
const CURVE_SUPPLY = 807_000_000n * 10n ** 18n;
const GRADUATED = 2n;

// Written against the guard-coverage sweep: these are the revert branches that no test
// noticed being switched off. They are attacks on those states, not assertions that the
// guards exist -- two of them turned out to be reachable in ways that matter.
describe('BXR1 — guards the coverage sweep found untested', function () {
  this.timeout(600000);

  async function env(usdcArtifact = 'MockUSDC') {
    const [deployer, treasury, creator, a, b] = await ethers.getSigners();
    const usdc = await (await ethers.getContractFactory(usdcArtifact)).deploy();
    const registry = await deployRegistryWithAsset(await usdc.getAddress());
    const ballista = await (await getBXR1Factory())
      .deploy(await registry.getAddress(), treasury.address, ethers.ZeroAddress);
    const router = await (await ethers.getContractFactory('MockRouter')).deploy();
    await activateRouter(ballista, await router.getAddress());
    await ballista.setLaunchCooldown(0);
    for (const s of [creator, a, b]) {
      await usdc.mint(s.address, 500_000_000n * ONE);
      await usdc.connect(s).approve(await ballista.getAddress(), ethers.MaxUint256);
    }
    return { deployer, treasury, creator, a, b, usdc, registry, ballista };
  }

  async function launch(ballista, usdc, creator, symbol) {
    const hash = await ballista.currentEconomicsHash();
    const rc = await (await ballista.connect(creator)
      .createToken('Guard', symbol, 'u', await usdc.getAddress(), hash, false)).wait();
    return rc.logs.map((l) => { try { return ballista.interface.parseLog(l); } catch { return null; } })
      .find((l) => l && l.name === 'TokenCreated').args.token;
  }
  const past = async (s = 30) => {
    await ethers.provider.send('evm_increaseTime', [s]);
    await ethers.provider.send('evm_mine');
  };

  describe('creatorLaunchBuy — 4 of its 7 guards were unexercised', function () {
    it('ATTACK: reach it on an address the factory never created', async function () {
      const { ballista, usdc, creator, a } = await env();
      // A plain EOA, and a real ERC20 the factory did not deploy. Neither can satisfy
      // _curves[token].token == token, which is only ever written by createToken against
      // a CREATE result the factory produced itself.
      await expect(ballista.connect(creator).creatorLaunchBuy(a.address, ONE, 0))
        .to.be.revertedWithCustomError(ballista, 'UnknownToken');
      const rogue = await (await ethers.getContractFactory('MockUSDC')).deploy();
      await expect(ballista.connect(creator).creatorLaunchBuy(await rogue.getAddress(), ONE, 0))
        .to.be.revertedWithCustomError(ballista, 'UnknownToken');
    });

    // THIS ONE MATTERS. The window is time-based and graduation can happen inside it, so
    // a buyer who graduates the curve before the creator's launch buy lands denies the
    // creator their entire privileged allocation. Cost is measured below.
    it('ATTACK: graduate the curve INSIDE the window to deny the creator their allocation', async function () {
      const { ballista, usdc, creator, a } = await env();
      await ballista.setCreatorLaunchWindow(600); // generous, to isolate the mechanism
      const t = await launch(ballista, usdc, creator, 'DENY');
      const created = Number((await ballista.curves(t)).creationTimestamp);

      const before = await usdc.balanceOf(a.address);
      await ethers.provider.send('evm_setNextBlockTimestamp', [created + 1]);
      await ballista.connect(a).buy(t, 200_000n * ONE, 0);
      const spent = before - (await usdc.balanceOf(a.address));

      expect((await ballista.curves(t)).state,
        'attacker graduated it while the creator window was still open').to.equal(GRADUATED);

      const token = await ethers.getContractAt('BXR1Token', t);
      const got = await token.balanceOf(a.address);
      const pct = Number((got * 10000n) / CURVE_SUPPLY) / 100;
      console.log('        attacker spent ' + ethers.formatUnits(spent, 6) +
        ' USDC and received ' + pct.toFixed(3) + '% of curve supply');

      // The creator is locked out of their own allocation, still inside their window.
      await ethers.provider.send('evm_setNextBlockTimestamp', [created + 2]);
      await expect(ballista.connect(creator).creatorLaunchBuy(t, 50n * ONE, 0))
        .to.be.revertedWithCustomError(ballista, 'CurveNotActive');
      expect((await ballista.curves(t)).creatorLaunchPurchased,
        'creator received nothing').to.equal(0n);
    });

    it('ATTACK: zero-value creator buy', async function () {
      const { ballista, usdc, creator } = await env();
      const t = await launch(ballista, usdc, creator, 'ZERO');
      await expect(ballista.connect(creator).creatorLaunchBuy(t, 0, 0))
        .to.be.revertedWithCustomError(ballista, 'ZeroAmount');
    });

    // The creator path clamps to the cap, so a creator sizing minTokensOut from an
    // unclamped expectation gets less than asked. Slippage must catch that rather than
    // silently under-delivering.
    it('ATTACK: creator slippage against the CAP clamp, not merely against price', async function () {
      const { ballista, usdc, creator } = await env();
      const t = await launch(ballista, usdc, creator, 'CSLIP');
      const cap = (CURVE_SUPPLY * 250n) / BPS;
      await expect(ballista.connect(creator).creatorLaunchBuy(t, 5_000n * ONE, cap + 1n))
        .to.be.revertedWithCustomError(ballista, 'SlippageExceeded');
      await expect(ballista.connect(creator).creatorLaunchBuy(t, 5_000n * ONE, cap))
        .to.not.be.reverted;
    });
  });

  describe('sell — the buy side was tested, these were not', function () {
    // Reachable only by the creator, the one party who can hold tokens in the creation
    // block. This guard is what stops a launch-and-dump inside a single block.
    // Selling inside the creation block needs an ALLOWANCE on a token that does not
    // exist until createToken returns, so it is reachable only from a single transaction
    // that creates, buys, approves and sells. An earlier version of this test sent the
    // three calls as separate transactions with automine off; the sell reverted for lack
    // of allowance rather than on the block guard, so it passed while proving nothing --
    // disabling the guard did not make it fail.
    it('ATTACK: create, buy, approve and dump inside ONE transaction', async function () {
      const { ballista, usdc, creator } = await env();
      const CL = await ethers.getContractFactory('BXR1CreatorLauncher');
      const cl = await CL.deploy(await ballista.getAddress(), await usdc.getAddress());
      await usdc.mint(await cl.getAddress(), 1_000_000n * ONE);
      await cl.approveAll();

      const [reverted, err] = await cl.launchBuyApproveAndDump.staticCall('DUMP', 200n * ONE);
      expect(reverted, 'the same-block dump must be rejected').to.equal(true);
      // Assert WHICH guard rejected it, not merely that something did.
      const selector = ballista.interface.getError('TradingNotOpenYet').selector;
      expect(err.slice(0, 10), 'rejected by TradingNotOpenYet specifically')
        .to.equal(selector);

      // And the launch + privileged buy in that same transaction did succeed.
      await cl.launchBuyApproveAndDump('DUMP', 200n * ONE);
      const t = await cl.token();
      expect((await ballista.curves(t)).creatorLaunchPurchased).to.be.greaterThan(0n);
    });

    it('ATTACK: sell slippage', async function () {
      const { ballista, usdc, creator, a } = await env();
      const t = await launch(ballista, usdc, creator, 'SSLIP');
      await past();
      await ballista.connect(a).buy(t, 500n * ONE, 0);
      const token = await ethers.getContractAt('BXR1Token', t);
      const held = await token.balanceOf(a.address);
      await token.connect(a).approve(await ballista.getAddress(), held);

      // minUsdcOut is compared against the NET payout (gross - fee), not the gross --
      // sell() checks `q.usdcOutGross - q.fee >= minUsdcOut`. Asserting against gross
      // would pass the revert case for the wrong reason and fail the accept case.
      const quoted = await ballista.quoteSell(t, held);
      const net = quoted.quoteOutGross - quoted.fee;
      await expect(ballista.connect(a).sell(t, held, net + 1n))
        .to.be.revertedWithCustomError(ballista, 'SlippageExceeded');
      await expect(ballista.connect(a).sell(t, held, net)).to.not.be.reverted;
    });
  });

  // Slither's only undismissed finding: five owner setters changed economics with no
  // event, so an owner could move fees, the graduation threshold or the creation fee
  // with nothing observable off-chain. This project already treats monitoring
  // RouterProposed as a launch requirement, so by its own standard those were
  // unmonitorable admin actions. Old AND new values, so a watcher sees the delta.
  describe('admin changes are observable', function () {
    it('every economics setter emits old and new values', async function () {
      const { ballista } = await env();

      // env() already sets the cooldown to 0, so the pre-change value here is 0, not
      // the contract's 10-second default.
      await expect(ballista.setLaunchCooldown(99))
        .to.emit(ballista, 'LaunchCooldownSet').withArgs(0n, 99n);
      await expect(ballista.setSymbolLockDuration(1234))
        .to.emit(ballista, 'SymbolLockDurationSet').withArgs(300n, 1234n);
      await expect(ballista.setCreationFee(7_000_000n))
        .to.emit(ballista, 'CreationFeeSet').withArgs(500_000n, 7_000_000n);
      await expect(ballista.setDefaultGraduationThreshold(9_000_000_000n))
        .to.emit(ballista, 'DefaultGraduationThresholdSet')
        .withArgs(8_000_000_000n, 9_000_000_000n);
      await expect(ballista.setDefaultFees(250, 300))
        .to.emit(ballista, 'DefaultFeesSet').withArgs(100n, 250n, 100n, 300n);
    });

    it('the emitted OLD value is the pre-change value, not the new one', async function () {
      const { ballista } = await env();
      // Emitting (new, new) would satisfy a test that only checked the event fired.
      await ballista.setCreationFee(1_000_000n);
      await expect(ballista.setCreationFee(2_000_000n))
        .to.emit(ballista, 'CreationFeeSet').withArgs(1_000_000n, 2_000_000n);
    });
  });

  describe('the recovery lever and the views', function () {
    it('setTreasury rejects the zero address -- this is the blocklist recovery lever', async function () {
      const { ballista, deployer } = await env();
      await expect(ballista.connect(deployer).setTreasury(ethers.ZeroAddress))
        .to.be.revertedWithCustomError(ballista, 'ZeroAddress');
      await expect(ballista.connect(deployer).setTreasury(deployer.address)).to.not.be.reverted;
    });

    it('views reject unknown tokens rather than returning a misleading zero', async function () {
      const { ballista, a } = await env();
      // quoteBuy was MISSED here until the freeze-gate mutation run surfaced it: three of
      // the four view guards were asserted and this one was not. Without it, quoteBuy on
      // a non-existent token returns tokensOut = 0 with actualUsdcIn = the full amount
      // and does NOT revert -- "pay 1 USDC, receive nothing", which a frontend renders as
      // a real quote. That is precisely the misleading zero this test is named after.
      await expect(ballista.quoteBuy(a.address, 1_000_000n))
        .to.be.revertedWithCustomError(ballista, 'UnknownToken');
      await expect(ballista.quoteSell(a.address, 1n))
        .to.be.revertedWithCustomError(ballista, 'UnknownToken');
      await expect(ballista.currentPrice(a.address))
        .to.be.revertedWithCustomError(ballista, 'UnknownToken');
      await expect(ballista.graduationProgressBps(a.address))
        .to.be.revertedWithCustomError(ballista, 'UnknownToken');
    });

    it('the snipe-tax treasury split cannot exceed 100%', async function () {
      const { ballista } = await env();
      await expect(ballista.setDefaultSnipeTaxTreasuryBps(10001))
        .to.be.revertedWithCustomError(ballista, 'BpsExceedsDenominator');
      await expect(ballista.setDefaultSnipeTaxTreasuryBps(10000)).to.not.be.reverted;
    });
  });
});
