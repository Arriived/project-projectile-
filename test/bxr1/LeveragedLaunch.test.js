const { expect } = require('chai');
const { ethers } = require('hardhat');
const { activateRouter } = require('../routerHelper');
const {
  deployRegistryWithAsset,
  setGraduationThreshold,
  setAssetKind,
  getBXR1Factory,
  ASSET_KIND,
} = require('./assetRegistryHelper');

// CLAUDE.md section 27. A LEVERAGED asset's registry figures are USD at 6 decimals --
// the SAME raw numbers a USDC entry would carry -- converted to the asset's own native
// units by AssetRegistry.launchTerms() at the exact moment createToken() calls it.
// Everything below verifies that conversion, its rounding direction, what it does and
// does not pin, and that trading itself needed no changes at all -- sell() and
// claimCreatorFees() already pay out whatever c.quoteAsset is.
describe('BXR1 — LEVERAGED launches: USD-denominated registry terms converted at createToken', function () {
  this.timeout(600000);

  const WAD = 1_000_000_000_000_000_000n;
  const USD_VIRTUAL = 2_667_000_000n;      // $2,667 at 6dp
  const USD_THRESHOLD = 8_000_000_000n;    // $8,000 at 6dp
  const USD_CREATION_FEE = 500_000n;       // $0.5 at 6dp
  const LT_DECIMALS = 18n;

  const ACTIVE = 0n;
  const GRADUATED = 2n;

  function ceilDiv(a, b) {
    return (a + b - 1n) / b;
  }

  // Mirrors AssetRegistry.launchTerms()'s LEVERAGED branch exactly, so tests can
  // compute an EXPECTED native figure independently of the value under test.
  function nativeFor(usd6, rate) {
    const scale = (10n ** LT_DECIMALS) * WAD;
    const denom = rate * 1_000_000n;
    return ceilDiv(usd6 * scale, denom);
  }

  async function env(initialRate = WAD) {
    const [deployer, treasury, creator, trader] = await ethers.getSigners();

    const lt = await (await ethers.getContractFactory('MockLeveragedToken')).deploy(initialRate);
    const registry = await deployRegistryWithAsset(await lt.getAddress(), {
      decimals: 18,
      initialVirtualReserve: USD_VIRTUAL,
      defaultGraduationThreshold: USD_THRESHOLD,
      creationFee: USD_CREATION_FEE,
      kind: ASSET_KIND.LEVERAGED,
    });

    const ballista = await (await getBXR1Factory())
      .deploy(await registry.getAddress(), treasury.address, ethers.ZeroAddress);
    const router = await (await ethers.getContractFactory('MockRouter')).deploy();
    await activateRouter(ballista, await router.getAddress());
    // Steady-state economics, not sniping -- matches every sibling suite's fixture.
    await ballista.publishSnipeTaxTable([]);

    for (const s of [creator, trader]) {
      await lt.mint(s.address, 10_000_000n * WAD);
      await lt.connect(s).approve(await ballista.getAddress(), ethers.MaxUint256);
    }

    return { deployer, treasury, creator, trader, lt, registry, ballista, router };
  }

  async function launch(ballista, lt, creator, symbol) {
    const ltAddress = await lt.getAddress();
    const hash = await ballista.currentEconomicsHash(ltAddress);
    const rc = await (await ballista.connect(creator)
      .createToken('Leveraged', symbol, 'ipfs://a', ltAddress, hash)).wait();
    return rc.logs.map((l) => { try { return ballista.interface.parseLog(l); } catch { return null; } })
      .find((l) => l && l.name === 'TokenCreated').args.token;
  }

  it('at rate 1e18 the curve snapshots 2,667e18 virtual, 8,000e18 threshold, and charges 0.5e18 LT creation fee', async function () {
    const { ballista, lt, creator } = await env(WAD);
    const before = await lt.balanceOf(creator.address);
    const token = await launch(ballista, lt, creator, 'LT1');
    const after = await lt.balanceOf(creator.address);
    const curve = await ballista.curves(token);

    expect(curve.virtualQuoteReserves, 'virtual reserve').to.equal(2_667n * WAD);
    expect(curve.graduationThreshold, 'graduation threshold').to.equal(8_000n * WAD);
    expect(before - after, 'creation fee pulled').to.equal(WAD / 2n);
  });

  it('at rate 2e18 (1 LT = 2 USD) every figure is exactly half', async function () {
    const { ballista, lt, creator } = await env(2n * WAD);
    const before = await lt.balanceOf(creator.address);
    const token = await launch(ballista, lt, creator, 'LT2');
    const after = await lt.balanceOf(creator.address);
    const curve = await ballista.curves(token);

    expect(curve.virtualQuoteReserves).to.equal((2_667n * WAD) / 2n);
    expect(curve.graduationThreshold).to.equal((8_000n * WAD) / 2n);
    expect(before - after).to.equal(WAD / 4n);
  });

  it('two launches at different rates open at the same USD price, within rounding', async function () {
    // Neither rate is a round number relative to the USD figures, deliberately --
    // this must hold in general, not only when the arithmetic happens to be exact.
    const rateA = 3n * WAD;
    const rateB = 1_234_567_890_123_456_789n;

    const a = await env(rateA);
    const tokenA = await launch(a.ballista, a.lt, a.creator, 'RA');
    const curveA = await a.ballista.curves(tokenA);

    const b = await env(rateB);
    const tokenB = await launch(b.ballista, b.lt, b.creator, 'RB');
    const curveB = await b.ballista.curves(tokenB);

    const scale = (10n ** LT_DECIMALS) * WAD;
    // The inverse of launchTerms()'s formula: recover the implied USD-6dp figure
    // from the native amount the curve actually snapshotted.
    const usdImpliedA = (curveA.virtualQuoteReserves * rateA * 1_000_000n) / scale;
    const usdImpliedB = (curveB.virtualQuoteReserves * rateB * 1_000_000n) / scale;

    // TOLERANCE: at most 1 raw usd6 unit (one millionth of a dollar), never below
    // the true value. ceil() can only push the NATIVE amount up by strictly LESS
    // than one raw native unit (1e-18 of one whole LT) relative to the exact real
    // number. Multiplying that residual back by rate*1e6/scale to return to usd6
    // terms scales it down by many orders of magnitude at any realistic rate, so
    // the recovered figure can only ever land on the true value or one unit above
    // it -- never below, and never by more than 1.
    expect(usdImpliedA >= USD_VIRTUAL, 'implied USD must not round below the true value').to.equal(true);
    expect(usdImpliedA - USD_VIRTUAL <= 1n, 'implied USD must be within 1 unit').to.equal(true);
    expect(usdImpliedB >= USD_VIRTUAL, 'implied USD must not round below the true value').to.equal(true);
    expect(usdImpliedB - USD_VIRTUAL <= 1n, 'implied USD must be within 1 unit').to.equal(true);
    console.log(
      `        rate ${rateA} -> native ${curveA.virtualQuoteReserves} -> implied $${usdImpliedA}e-6; ` +
      `rate ${rateB} -> native ${curveB.virtualQuoteReserves} -> implied $${usdImpliedB}e-6 ` +
      `(registered $${USD_VIRTUAL}e-6)`
    );
  });

  it('a rate change after launch leaves the curve snapshot untouched and graduates nothing by itself', async function () {
    const { ballista, lt, creator, trader } = await env(WAD);
    const token = await launch(ballista, lt, creator, 'RC');
    const before = await ballista.curves(token);
    expect(before.state).to.equal(ACTIVE);

    // The NAV a keeper would post moves wildly after launch -- the whole point of
    // fixing the curve's amounts at createToken rather than reading live.
    await lt.setRate(50n * WAD);
    const afterRateMove = await ballista.curves(token);
    expect(afterRateMove.virtualQuoteReserves, 'virtual reserve must not move').to.equal(before.virtualQuoteReserves);
    expect(afterRateMove.graduationThreshold, 'threshold must not move').to.equal(before.graduationThreshold);
    expect(afterRateMove.state, 'a rate move alone graduates nothing').to.equal(ACTIVE);

    // Graduation still happens only through a buy crossing the FIXED, native
    // threshold -- exactly the same mechanism as a STANDARD curve.
    await ballista.connect(trader).buy(token, 9_000n * WAD, 0);
    expect((await ballista.curves(token)).state).to.equal(GRADUATED);
  });

  it('currentEconomicsHash is unchanged by a rate change, changed by new USD values or a kind flip', async function () {
    const { ballista, lt, registry } = await env(WAD);
    const ltAddress = await lt.getAddress();
    const hash = await ballista.currentEconomicsHash(ltAddress);

    await lt.setRate(9n * WAD);
    expect(await ballista.currentEconomicsHash(ltAddress), 'a rate move must not move the hash').to.equal(hash);

    await setGraduationThreshold(registry, ltAddress, USD_THRESHOLD + 1_000_000n);
    expect(await ballista.currentEconomicsHash(ltAddress), 're-registering the USD figures must move the hash').to.not.equal(hash);

    // Restore the USD figure, confirm the hash is back, then prove kind ALONE moves it.
    await setGraduationThreshold(registry, ltAddress, USD_THRESHOLD);
    const restoredHash = await ballista.currentEconomicsHash(ltAddress);
    await setAssetKind(registry, ltAddress, ASSET_KIND.STANDARD);
    expect(await ballista.currentEconomicsHash(ltAddress), 'flipping kind alone must move the hash').to.not.equal(restoredHash);
  });

  it('a live rate of 0 makes createToken revert', async function () {
    const { ballista, lt, registry, creator } = await env(WAD);
    await lt.setRate(0n);
    const ltAddress = await lt.getAddress();
    const hash = await ballista.currentEconomicsHash(ltAddress);
    await expect(
      ballista.connect(creator).createToken('Zero', 'Z', 'u', ltAddress, hash)
    ).to.be.revertedWithCustomError(registry, 'ZeroExchangeRate');
  });

  it('a reverting exchangeRate() makes createToken revert', async function () {
    const { ballista, lt, creator } = await env(WAD);
    await lt.setShouldRevert(true);
    const ltAddress = await lt.getAddress();
    const hash = await ballista.currentEconomicsHash(ltAddress);
    await expect(
      ballista.connect(creator).createToken('Revert', 'RV', 'u', ltAddress, hash)
    ).to.be.revertedWithCustomError(lt, 'MockLeveragedTokenReverts');
  });

  it('registering a LEVERAGED asset with a zero exchangeRate() reverts', async function () {
    const lt = await (await ethers.getContractFactory('MockLeveragedToken')).deploy(0n);
    const registry = await (await ethers.getContractFactory('AssetRegistry')).deploy();
    await expect(
      registry.registerAsset(
        await lt.getAddress(), 18, true, false, false, false,
        USD_VIRTUAL, USD_THRESHOLD, USD_CREATION_FEE, ASSET_KIND.LEVERAGED
      )
    ).to.be.revertedWithCustomError(registry, 'ZeroExchangeRate');
  });

  it('registering a LEVERAGED asset with a reverting exchangeRate() reverts', async function () {
    const lt = await (await ethers.getContractFactory('MockLeveragedToken')).deploy(WAD);
    await lt.setShouldRevert(true);
    const registry = await (await ethers.getContractFactory('AssetRegistry')).deploy();
    await expect(
      registry.registerAsset(
        await lt.getAddress(), 18, true, false, false, false,
        USD_VIRTUAL, USD_THRESHOLD, USD_CREATION_FEE, ASSET_KIND.LEVERAGED
      )
    ).to.be.revertedWithCustomError(lt, 'MockLeveragedTokenReverts');
  });

  // A STANDARD registration must NOT call exchangeRate() at all -- it would revert
  // (or worse, silently misbehave) against a plain ERC20 with no such function. Using
  // a plain MockUSDC here, which has no exchangeRate(), is itself the proof: if
  // registerAsset ever called it unconditionally, this would revert with no
  // matching function, not merely fail an assertion.
  it('registering a STANDARD asset never calls exchangeRate()', async function () {
    const usdc = await (await ethers.getContractFactory('MockUSDC')).deploy();
    const registry = await (await ethers.getContractFactory('AssetRegistry')).deploy();
    await expect(
      registry.registerAsset(
        await usdc.getAddress(), 6, true, false, false, false,
        USD_VIRTUAL, USD_THRESHOLD, USD_CREATION_FEE, ASSET_KIND.STANDARD
      )
    ).to.not.be.reverted;
  });

  it('a rate that does not divide evenly proves ceil rounding, not floor', async function () {
    const rate = 1_234_567_890_123_456_789n;
    const { ballista, lt, creator } = await env(rate);
    const token = await launch(ballista, lt, creator, 'CEIL');
    const curve = await ballista.curves(token);

    const scale = (10n ** LT_DECIMALS) * WAD;
    const denom = rate * 1_000_000n;
    const numerator = USD_VIRTUAL * scale;
    const floorResult = numerator / denom;
    const ceilResult = (numerator + denom - 1n) / denom;

    expect(ceilResult, 'this rate must not divide evenly, or it proves nothing').to.not.equal(floorResult);
    expect(curve.virtualQuoteReserves, 'the curve must use ceil, not floor').to.equal(ceilResult);
    expect(curve.virtualQuoteReserves).to.not.equal(floorResult);
    console.log(`        rate=${rate}: floor=${floorResult} ceil=${ceilResult} (curve snapshotted ceil)`);
  });

  it('on a LEVERAGED curve, claimCreatorFees(lt) pays LT and sell() pays LT', async function () {
    const { ballista, lt, creator, trader } = await env(WAD);
    const token = await launch(ballista, lt, creator, 'PAY');
    const ltAddress = await lt.getAddress();

    await ballista.connect(trader).buy(token, 100n * WAD, 0);
    const accrued = await ballista.creatorFeesAccrued(creator.address, ltAddress);
    expect(accrued, 'a buy on a LEVERAGED curve must accrue creator fees in the LT').to.be.greaterThan(0n);

    const creatorLtBefore = await lt.balanceOf(creator.address);
    await ballista.connect(creator).claimCreatorFees(ltAddress);
    const creatorLtAfter = await lt.balanceOf(creator.address);
    expect(creatorLtAfter - creatorLtBefore, 'claimCreatorFees must pay out in the LT').to.equal(accrued);

    const launchedToken = await ethers.getContractAt('BXR1Token', token);
    const traderTokenBalance = await launchedToken.balanceOf(trader.address);
    await launchedToken.connect(trader).approve(await ballista.getAddress(), traderTokenBalance);
    const traderLtBefore = await lt.balanceOf(trader.address);
    await ballista.connect(trader).sell(token, traderTokenBalance, 0);
    const traderLtAfter = await lt.balanceOf(trader.address);
    expect(traderLtAfter, 'sell() must pay out in the LT').to.be.greaterThan(traderLtBefore);
  });

  // TokenCreated carries quoteAsset (3rd indexed topic, added alongside this test --
  // see CLAUDE.md's TokenCreated section). This is the one place an off-chain indexer
  // can learn a curve's quote asset without a separate curves(token) call; it must
  // read out the LT for a LEVERAGED launch and USDC for a STANDARD one, from the SAME
  // factory instance, so nothing about the emit site special-cases either kind.
  it("TokenCreated carries the LT's address for a LEVERAGED launch and USDC's for a STANDARD one", async function () {
    const { ballista, lt, registry, creator } = await env(WAD);
    const ltAddress = await lt.getAddress();

    const usdc = await (await ethers.getContractFactory('MockUSDC')).deploy();
    const usdcAddress = await usdc.getAddress();
    await registry.registerAsset(
      usdcAddress, 6, true, false, false, false,
      2_667_000_000n, 8_000_000_000n, 500_000n, ASSET_KIND.STANDARD
    );
    await usdc.mint(creator.address, 10_000_000n * 1_000_000n);
    await usdc.connect(creator).approve(await ballista.getAddress(), ethers.MaxUint256);

    async function tokenCreatedQuoteAsset(quoteAssetAddress, symbol) {
      const hash = await ballista.currentEconomicsHash(quoteAssetAddress);
      const rc = await (await ballista.connect(creator)
        .createToken('QA', symbol, 'ipfs://a', quoteAssetAddress, hash)).wait();
      return rc.logs.map((l) => { try { return ballista.interface.parseLog(l); } catch { return null; } })
        .find((l) => l && l.name === 'TokenCreated').args.quoteAsset;
    }

    expect(await tokenCreatedQuoteAsset(ltAddress, 'LTQA'), 'LEVERAGED launch must carry the LT address').to.equal(ltAddress);
    expect(await tokenCreatedQuoteAsset(usdcAddress, 'USQA'), 'STANDARD launch must carry the USDC address').to.equal(usdcAddress);
  });
});
