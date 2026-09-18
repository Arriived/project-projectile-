const { expect } = require('chai');
const { ethers } = require('hardhat');
const { activateRouter } = require('../routerHelper');
const { deployRegistryWithAsset, getBXR1Factory } = require('./assetRegistryHelper');

const BPS = 10_000n;

// The acceptance test for "BXR1's reserve asset is generic, not USDC-shaped": register a
// SECOND asset with DIFFERENT decimals (18, via MockDAI -- OZ ERC20's own default, unlike
// MockUSDC's overridden 6) and run a full create / buy / sell cycle against it, side by
// side with a USDC-quoted curve. If genericity actually held, the two curves behave
// IDENTICALLY in percentage terms -- same fee bps, same clamp shape, same slippage
// enforcement -- despite trading in raw-unit magnitudes 1e12 apart, and BXR1 itself
// never special-cases either one: nothing in BXR1.sol references "USDC" or "6" or "18"
// on the quote-asset side any more (see the AssetRegistry import and the renamed
// reserve fields).
describe('BXR1 — a second registered asset with different decimals', function () {
  this.timeout(600000);

  async function env() {
    const [deployer, treasury, creator, trader] = await ethers.getSigners();

    const usdc = await (await ethers.getContractFactory('MockUSDC')).deploy();
    const dai = await (await ethers.getContractFactory('MockDAI')).deploy();
    expect(await usdc.decimals()).to.equal(6);
    expect(await dai.decimals()).to.equal(18); // OZ ERC20 default, unlike MockUSDC

    const registry = await (await ethers.getContractFactory('AssetRegistry')).deploy();

    // USDC: the historic INITIAL_VIRTUAL_USDC_RESERVES figure, in USDC's own 6dp, and
    // BXR1's former GLOBAL defaultGraduationThreshold (8,000 USDC), now the per-asset
    // value for this registry entry specifically.
    await registry.registerAsset(
      await usdc.getAddress(), 6, true, false, false, false,
      2_667_000_000n,  // 2,667 USDC
      8_000_000_000n   // 8,000 USDC
    );
    // DAI: the SAME real-world opening price (2,667 whole units of a ~$1 stablecoin) AND
    // the SAME real-world graduation threshold (8,000 whole units), both expressed in
    // DAI's own 18dp -- 1e12 times the raw magnitude of the USDC figures above, for
    // exactly the reason AssetRegistry.sol's own comment gives: BXR1's curve math never
    // converts between decimal scales, so the registry entry has to already be in the
    // asset's native units, for BOTH fields, to mean the same real-world thing as the
    // USDC entry. Registering the threshold correctly here -- rather than leaving it at
    // a USDC-shaped default and patching it after the fact -- is what closes the residual
    // the "graduates" test below used to have to work around.
    await registry.registerAsset(
      await dai.getAddress(), 18, true, false, false, false,
      2_667n * 10n ** 18n,  // 2,667 DAI
      8_000n * 10n ** 18n   // 8,000 DAI
    );

    const ballista = await (await getBXR1Factory())
      .deploy(await registry.getAddress(), treasury.address, ethers.ZeroAddress);
    const router = await (await ethers.getContractFactory('MockRouter')).deploy();
    await activateRouter(ballista, await router.getAddress());
    await ballista.publishSnipeTaxTable([]); // steady-state economics, not sniping

    for (const s of [creator, trader]) {
      await usdc.mint(s.address, 10_000_000n * 10n ** 6n);
      await usdc.connect(s).approve(await ballista.getAddress(), ethers.MaxUint256);
      await dai.mint(s.address, 10_000_000n * 10n ** 18n);
      await dai.connect(s).approve(await ballista.getAddress(), ethers.MaxUint256);
    }

    return { deployer, treasury, creator, trader, usdc, dai, registry, ballista, router };
  }

  async function launch(ballista, quoteAsset, creator, symbol) {
    const hash = await ballista.currentEconomicsHash(await quoteAsset.getAddress());
    const rc = await (await ballista.connect(creator)
      .createToken('Second Asset Coin', symbol, 'ipfs://a', await quoteAsset.getAddress(), hash)
    ).wait();
    return rc.logs.map((l) => { try { return ballista.interface.parseLog(l); } catch { return null; } })
      .find((l) => l && l.name === 'TokenCreated').args.token;
  }

  it('the registry reports each asset back in its own native decimals', async function () {
    const { usdc, dai, registry } = await env();
    const usdcCfg = await registry.getAsset(await usdc.getAddress());
    const daiCfg = await registry.getAsset(await dai.getAddress());

    expect(usdcCfg.decimals).to.equal(6);
    expect(usdcCfg.enabled).to.equal(true);
    expect(usdcCfg.initialVirtualReserve).to.equal(2_667_000_000n);

    expect(daiCfg.decimals).to.equal(18);
    expect(daiCfg.enabled).to.equal(true);
    expect(daiCfg.initialVirtualReserve).to.equal(2_667n * 10n ** 18n);
  });

  it('createToken snapshots the quote asset and its registry-configured opening reserve', async function () {
    const { ballista, dai, creator } = await env();
    const t = await launch(ballista, dai, creator, 'DAI1');
    const curve = await ballista.curves(t);

    expect(curve.quoteAsset).to.equal(await dai.getAddress());
    expect(curve.virtualQuoteReserves).to.equal(2_667n * 10n ** 18n);
    // The token side is the SAME constant regardless of quote asset -- the launched
    // token is always 18dp, and only the quote side varies by registry entry.
    expect(curve.virtualTokenReserves).to.equal(1_075_000_000n * 10n ** 18n);
  });

  it('a full create / buy / sell cycle works end to end against the 18-decimal asset', async function () {
    const { ballista, dai, creator, trader } = await env();
    const t = await launch(ballista, dai, creator, 'DAI2');
    const token = await ethers.getContractAt('BXR1Token', t);

    // Trade sizes scaled to DAI's 18dp -- the numeric equivalent of "1,000 USDC" in the
    // existing USDC-quoted suites is "1,000 DAI" here, 1e12 times the raw magnitude.
    const spend = 1_000n * 10n ** 18n;
    const daiBefore = await dai.balanceOf(trader.address);

    const quote = await ballista.quoteBuy(t, spend);
    const buyTx = await ballista.connect(trader).buy(t, spend, 0);
    const buyRc = await buyTx.wait();
    const buyEvent = buyRc.logs
      .map((l) => { try { return ballista.interface.parseLog(l); } catch { return null; } })
      .find((l) => l && l.name === 'Trade');

    // The Trade event, the quote, and the actual balance delta all agree, exactly as
    // they do for a USDC-quoted curve -- BXR1 does not know or care that this asset has
    // 18 decimals instead of 6.
    expect(buyEvent.args.quoteAmount).to.equal(quote.actualQuoteIn);
    expect(buyEvent.args.tokenAmount).to.equal(quote.tokensOut);
    expect(daiBefore - (await dai.balanceOf(trader.address))).to.equal(quote.actualQuoteIn);

    const held = await token.balanceOf(trader.address);
    expect(held).to.equal(quote.tokensOut);
    expect(held).to.be.greaterThan(0n);

    // The 1% buy fee is exactly 1% of the DAI spent, same as it is of USDC spent --
    // fee math is bps-based and therefore already decimal-agnostic.
    expect(quote.actualFee).to.equal((spend * 100n) / BPS);

    // Sell it back.
    await token.connect(trader).approve(await ballista.getAddress(), held);
    const sellQuote = await ballista.quoteSell(t, held);
    const daiBeforeSell = await dai.balanceOf(trader.address);
    const sellTx = await ballista.connect(trader).sell(t, held, 0);
    const sellRc = await sellTx.wait();
    const sellEvent = sellRc.logs
      .map((l) => { try { return ballista.interface.parseLog(l); } catch { return null; } })
      .find((l) => l && l.name === 'Trade');

    const netOut = sellQuote.quoteOutGross - sellQuote.fee;
    expect(sellEvent.args.quoteAmount).to.equal(netOut);
    expect((await dai.balanceOf(trader.address)) - daiBeforeSell).to.equal(netOut);
    expect(await token.balanceOf(trader.address)).to.equal(0n);

    // Round-tripping through both fees costs the trader money, never hands them a
    // profit purely from rounding -- the same invariant the USDC suites hold, now
    // checked at an entirely different raw-unit scale.
    expect((await dai.balanceOf(trader.address))).to.be.lessThan(daiBefore);
  });

  it('the exact-balance-delta check is enforced the same way regardless of decimals', async function () {
    const { ballista, dai, creator, trader } = await env();
    const t = await launch(ballista, dai, creator, 'DAI3');
    // A plain, well-behaved 18dp ERC20 never trips QuoteTransferMismatch -- the delta
    // check passes silently on every trade, which is the common case this residual
    // defence must never get in the way of.
    await expect(ballista.connect(trader).buy(t, 500n * 10n ** 18n, 0)).to.not.be.reverted;
  });

  it('slippage protection works identically on the 18-decimal curve', async function () {
    const { ballista, dai, creator, trader } = await env();
    const t = await launch(ballista, dai, creator, 'DAI4');
    await expect(
      ballista.connect(trader).buy(t, 1_000n * 10n ** 18n, 10n ** 30n) // absurdly high floor
    ).to.be.revertedWithCustomError(ballista, 'SlippageExceeded');
  });

  // Was: "graduates on the same dual trigger, purely from DAI-denominated reserves",
  // and it demonstrated the OLD bug -- defaultGraduationThreshold used to be a single
  // BXR1-wide, USDC-shaped constant, so a DAI-quoted curve graduated almost immediately
  // on its first buy. That residual is now closed: defaultGraduationThreshold moved
  // into AssetRegistry.AssetConfig, per asset, exactly like initialVirtualReserve
  // already was, and env() registers DAI with a real 8,000-DAI threshold (see above).
  // The test is kept, rewritten to prove the thing that was never actually the bug:
  // the dual trigger itself is asset-agnostic and still reaches GRADUATED correctly
  // once a DAI-quoted curve's OWN threshold is actually crossed.
  it('graduates on the same dual trigger once the DAI-denominated threshold is actually crossed', async function () {
    const { ballista, dai, creator, trader } = await env();
    const t = await launch(ballista, dai, creator, 'DAI5');

    // Comfortably past the curve's own realQuoteReserves >= 8,000 DAI threshold. Large
    // enough that whichever arm fires first -- the threshold or depletion, via the
    // partial-fill clamp -- this buy graduates the curve either way; which one is not
    // the property under test here (that split already has its own suite in
    // GraduationGap.test.js).
    const rc = await (await ballista.connect(trader).buy(t, 20_000n * 10n ** 18n, 0)).wait();
    const graduated = rc.logs
      .map((l) => { try { return ballista.interface.parseLog(l); } catch { return null; } })
      .find((l) => l && l.name === 'Graduated');
    expect(graduated, 'expected this buy to graduate the DAI-quoted curve').to.not.be.undefined;

    const curve = await ballista.curves(t);
    expect(curve.state).to.equal(2n); // GRADUATED
    expect(curve.tokenReserves).to.equal(0n);
    expect(curve.realQuoteReserves).to.equal(0n);
  });

  // The acceptance test for the fix itself: with a sensible, correctly-scaled per-asset
  // threshold in place (8,000 DAI, registered by env() above -- not a leftover
  // USDC-shaped 8,000 raw units), the SAME 1,000 DAI buy the full-cycle test above
  // uses to prove buy/sell round-tripping does NOT trip the graduation trigger. Before
  // the fix this would have graduated on the very first buy, exactly as the test this
  // one replaced demonstrated.
  it('does NOT graduate on a modest first buy now that the per-asset threshold is sensible', async function () {
    const { ballista, dai, creator, trader } = await env();
    const t = await launch(ballista, dai, creator, 'DAI6');

    const rc = await (await ballista.connect(trader).buy(t, 1_000n * 10n ** 18n, 0)).wait();
    const graduated = rc.logs
      .map((l) => { try { return ballista.interface.parseLog(l); } catch { return null; } })
      .find((l) => l && l.name === 'Graduated');
    expect(graduated, 'a 1,000 DAI buy must not graduate an 8,000 DAI curve').to.be.undefined;

    const curve = await ballista.curves(t);
    expect(curve.state).to.equal(0n); // still ACTIVE
    expect(curve.tokenReserves).to.be.greaterThan(0n);
    expect(curve.realQuoteReserves).to.be.greaterThan(0n);
    expect(curve.realQuoteReserves).to.be.lessThan(curve.graduationThreshold);
  });

  it('two curves on two different quote assets never interfere with each other', async function () {
    const { ballista, usdc, dai, creator, trader } = await env();
    const usdcToken = await launch(ballista, usdc, creator, 'USDCX');
    const daiToken = await launch(ballista, dai, creator, 'DAIX');

    await ballista.connect(trader).buy(usdcToken, 100n * 10n ** 6n, 0);
    await ballista.connect(trader).buy(daiToken, 100n * 10n ** 18n, 0);

    const usdcCurve = await ballista.curves(usdcToken);
    const daiCurve = await ballista.curves(daiToken);
    expect(usdcCurve.quoteAsset).to.equal(await usdc.getAddress());
    expect(daiCurve.quoteAsset).to.equal(await dai.getAddress());

    // Fee accrual is keyed by (asset), so USDC and DAI fees never mix into one number.
    const usdcAccrued = await ballista.treasuryFeesAccrued(await usdc.getAddress());
    const daiAccrued = await ballista.treasuryFeesAccrued(await dai.getAddress());
    expect(usdcAccrued).to.be.greaterThan(0n);
    expect(daiAccrued).to.be.greaterThan(0n);
    // Roughly 1e12 apart in raw magnitude -- if the two pools of fees had been
    // conflated under one counter, this would not hold.
    expect(daiAccrued / usdcAccrued).to.be.greaterThan(100_000n);
  });

  it('createToken refuses an asset that was never registered', async function () {
    const { ballista, creator } = await env();
    const stranger = await (await ethers.getContractFactory('MockUSDC')).deploy();
    const hash = await ballista.currentEconomicsHash(await stranger.getAddress());
    await expect(
      ballista.connect(creator).createToken('Rogue', 'RGE', 'u', await stranger.getAddress(), hash)
    ).to.be.revertedWithCustomError(ballista, 'AssetNotEnabled');
  });

  it('createToken refuses an asset registered with a misbehaviour flag set', async function () {
    const { ballista, registry, creator } = await env();
    const fee = await (await ethers.getContractFactory('MockFeeOnTransferUSDC')).deploy();
    await registry.registerAsset(
      await fee.getAddress(), 6, true, /* rebasing */ false, /* transferRestricted */ false,
      /* transferFee */ true, 2_667_000_000n, 8_000_000_000n
    );
    const hash = await ballista.currentEconomicsHash(await fee.getAddress());
    await expect(
      ballista.connect(creator).createToken('Fee', 'FEE', 'u', await fee.getAddress(), hash)
    ).to.be.revertedWithCustomError(ballista, 'AssetMisbehaves');
  });

  it('setAssetEnabled(false) blocks new launches but never touches a live curve', async function () {
    const { ballista, dai, registry, creator, trader } = await env();
    const t = await launch(ballista, dai, creator, 'LIVE');

    await registry.setAssetEnabled(await dai.getAddress(), false);

    // The live curve trades on, exactly as LFX1's own snapshotting rule requires for
    // every other admin-controlled default.
    await expect(ballista.connect(trader).buy(t, 100n * 10n ** 18n, 0)).to.not.be.reverted;

    // But no NEW curve can be created against the now-disabled asset.
    const hash = await ballista.currentEconomicsHash(await dai.getAddress());
    await expect(
      ballista.connect(creator).createToken('Blocked', 'BLK', 'u', await dai.getAddress(), hash)
    ).to.be.revertedWithCustomError(ballista, 'AssetNotEnabled');
  });
});
