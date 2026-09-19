const { expect } = require('chai');
const { ethers } = require('hardhat');
const { activateRouter } = require('../routerHelper');
const { deployRegistryWithAsset, setGraduationThreshold, setCreationFee, getBXR1Factory } = require('./assetRegistryHelper');

const ONE = 1_000_000n;

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
    for (const s of [creator, a, b]) {
      await usdc.mint(s.address, 500_000_000n * ONE);
      await usdc.connect(s).approve(await ballista.getAddress(), ethers.MaxUint256);
    }
    return { deployer, treasury, creator, a, b, usdc, registry, ballista };
  }

  async function launch(ballista, usdc, creator, symbol) {
    const hash = await ballista.currentEconomicsHash(await usdc.getAddress());
    const rc = await (await ballista.connect(creator)
      .createToken('Guard', symbol, 'u', await usdc.getAddress(), hash)).wait();
    return rc.logs.map((l) => { try { return ballista.interface.parseLog(l); } catch { return null; } })
      .find((l) => l && l.name === 'TokenCreated').args.token;
  }
  const past = async (s = 30) => {
    await ethers.provider.send('evm_increaseTime', [s]);
    await ethers.provider.send('evm_mine');
  };

  // creatorLaunchBuy was removed entirely 2026-09-18 -- see CLAUDE.md section 26. That
  // deletes both the "creatorLaunchBuy — 4 of its 7 guards were unexercised" describe
  // block above and the same-block create/buy/approve/dump attack below: the latter's
  // whole premise was the interaction between creatorLaunchBuy's block-0 EXEMPTION
  // (buy() and sell() both require block.number > creationBlock; creatorLaunchBuy alone
  // did not) and TradingNotOpenYet. With creatorLaunchBuy gone, there is no longer any
  // path -- creator or otherwise -- to hold tokens inside the creation block, so the
  // attack cannot be constructed at all any more. The block-0 restriction itself is
  // still covered, via the ordinary buy() path, in Ballista.test.js's "block-0 trading
  // restriction" suite. contracts/bxr1/mocks/CreatorLauncher.sol (BXR1CreatorLauncher),
  // this section's only consumer and entirely creatorLaunchBuy-shaped, is deleted with
  // it rather than kept as dead code.
  describe('sell — the buy side was tested, these were not', function () {
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
    // launchCooldown and the symbol lock (and their setters/events) were removed
    // 2026-09-18 -- see CLAUDE.md section 26. creationFee moved to
    // AssetRegistry.AssetConfig in the same session (per-asset, since BXR1 charges
    // it in the curve's own quoteAsset) and lost its BXR1-side setter/event along
    // with it -- see the registry-side tests below. setDefaultFees is the one
    // remaining BXR1-side economics setter with an old/new delta event.
    it('every economics setter emits old and new values', async function () {
      const { ballista } = await env();

      await expect(ballista.setDefaultFees(250, 300))
        .to.emit(ballista, 'DefaultFeesSet').withArgs(100n, 250n, 100n, 300n);
    });

    // setDefaultGraduationThreshold no longer exists on BXR1 -- the threshold moved to
    // AssetRegistry.AssetConfig, and (like initialVirtualReserve and, as of this
    // session, creationFee) has no setter of its own, only re-registration via
    // registerAsset. That is a DIFFERENT observability shape than the setters above,
    // not a smaller one: registerAsset always emits AssetRegistered with the FULL new
    // config, on every call, whether or not the threshold specifically changed --
    // there is no old-vs-new delta to assert on a single field, because
    // re-registration does not distinguish "changed" fields from unchanged ones. What
    // still holds is Slither's actual finding: no economics change is silent. This
    // asserts that property on the new path.
    it('re-registering an asset to change its graduation threshold is still observable', async function () {
      const { usdc, registry } = await env();
      const cfg = await registry.getAsset(await usdc.getAddress());
      await expect(setGraduationThreshold(registry, await usdc.getAddress(), 9_000_000_000n))
        .to.emit(registry, 'AssetRegistered')
        .withArgs(
          await usdc.getAddress(), cfg.decimals, cfg.rebasing, cfg.transferRestricted,
          cfg.transferFee, cfg.initialVirtualReserve, 9_000_000_000n, cfg.creationFee
        );
    });

    // The same observability property, on the field this session moved: creationFee.
    it('re-registering an asset to change its creation fee is still observable', async function () {
      const { usdc, registry } = await env();
      const cfg = await registry.getAsset(await usdc.getAddress());
      await expect(setCreationFee(registry, await usdc.getAddress(), 7_000_000n))
        .to.emit(registry, 'AssetRegistered')
        .withArgs(
          await usdc.getAddress(), cfg.decimals, cfg.rebasing, cfg.transferRestricted,
          cfg.transferFee, cfg.initialVirtualReserve, cfg.defaultGraduationThreshold, 7_000_000n
        );
    });

    it('the emitted OLD value is the pre-change value, not the new one', async function () {
      const { ballista } = await env();
      // Emitting (new, new) would satisfy a test that only checked the event fired.
      await ballista.setDefaultFees(150, 150);
      await expect(ballista.setDefaultFees(250, 250))
        .to.emit(ballista, 'DefaultFeesSet').withArgs(150n, 250n, 150n, 250n);
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
      // currentPrice() and graduationProgressBps() are gone (removed 2026-09-18 as
      // redundant view surface); quoteBuy/quoteSell remain the two views this guard
      // still needs to cover.
      await expect(ballista.quoteBuy(a.address, 1_000_000n))
        .to.be.revertedWithCustomError(ballista, 'UnknownToken');
      await expect(ballista.quoteSell(a.address, 1n))
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
