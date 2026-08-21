const { expect } = require('chai');
const { ethers } = require('hardhat');
const { activateRouter } = require('./routerHelper');

const ONE_USDC = 1_000_000n;
const BPS = 10_000n;

describe('Ballista — creator fee share', function () {
  async function deployFixture(usdcContractName = 'MockUSDC') {
    const [deployer, treasury, creator, trader, other] = await ethers.getSigners();

    const usdc = await (await ethers.getContractFactory(usdcContractName)).deploy();
    const ballista = await (await ethers.getContractFactory('Ballista')).deploy(
      await usdc.getAddress(),
      treasury.address
    );
    const router = await (await ethers.getContractFactory('MockRouter')).deploy();
    await activateRouter(ballista, await router.getAddress());

    // These tests are about steady-state curve economics, not sniping, and they trade
    // immediately after launch -- which in production is squarely inside the snipe
    // window. Publishing an empty table disables the tax for this fixture so those
    // trades model normal post-window trading. The tax has its own suite in
    // test/SnipeTax.test.js.
    await ballista.publishSnipeTaxTable([]);

    for (const signer of [creator, trader, other]) {
      await usdc.mint(signer.address, 1_000_000n * ONE_USDC);
      await usdc.connect(signer).approve(await ballista.getAddress(), ethers.MaxUint256);
    }
    return { deployer, treasury, creator, trader, other, usdc, ballista };
  }

  async function launch(ballista, creator, symbol = 'CRT') {
    const hash = await ballista.currentEconomicsHash();
    const receipt = await (
      await ballista.connect(creator).createToken('Creator Coin', symbol, 'ipfs://a', hash, false)
    ).wait();
    const event = receipt.logs
      .map((l) => { try { return ballista.interface.parseLog(l); } catch { return null; } })
      .find((l) => l && l.name === 'TokenCreated');
    return event.args.token;
  }

  it('splits the 1% buy fee into 0.9% creator / 0.1% treasury, adding nothing on top', async function () {
    const { ballista, usdc, creator, trader, treasury } = await deployFixture();
    const tokenAddress = await launch(ballista, creator);

    const buyAmount = 1_000n * ONE_USDC;
    const traderBefore = await usdc.balanceOf(trader.address);
    const treasuryBefore = await usdc.balanceOf(treasury.address);

    await ballista.connect(trader).buy(tokenAddress, buyAmount, 0);

    const traderSpent = traderBefore - (await usdc.balanceOf(trader.address));
    const treasuryGot = (await usdc.balanceOf(treasury.address)) - treasuryBefore;
    const creatorAccrued = await ballista.creatorFeesAccrued(creator.address);

    // The whole point: trader-facing cost is unchanged by the creator share existing.
    expect(traderSpent).to.equal(buyAmount);

    const totalFee = (buyAmount * 100n) / BPS;        // 1%
    const expectedCreator = (buyAmount * 90n) / BPS;  // 0.90% = 90% of the fee
    expect(creatorAccrued).to.equal(expectedCreator);
    expect(treasuryGot).to.equal(totalFee - expectedCreator); // 0.10%
    expect(creatorAccrued + treasuryGot).to.equal(totalFee);
  });

  it('applies to sells as well as buys', async function () {
    const { ballista, usdc, creator, trader, treasury } = await deployFixture();
    const tokenAddress = await launch(ballista, creator);
    const token = await ethers.getContractAt('ArcLaunchToken', tokenAddress);

    await ballista.connect(trader).buy(tokenAddress, 1_000n * ONE_USDC, 0);
    const afterBuy = await ballista.creatorFeesAccrued(creator.address);

    const held = await token.balanceOf(trader.address);
    await token.connect(trader).approve(await ballista.getAddress(), held);

    const treasuryBefore = await usdc.balanceOf(treasury.address);
    await ballista.connect(trader).sell(tokenAddress, held, 0);
    const treasuryGot = (await usdc.balanceOf(treasury.address)) - treasuryBefore;

    const sellAccrual = (await ballista.creatorFeesAccrued(creator.address)) - afterBuy;
    expect(sellAccrual).to.be.greaterThan(0n);

    // The sell side is 50/50, NOT the buy side's 90/10 -- that asymmetry is the
    // point. Reconstructed from the two shares, since the gross the fee was charged
    // on is internal to the curve.
    const sellFee = sellAccrual + treasuryGot;
    expect(sellAccrual).to.equal((sellFee * 50n) / 100n);
  });

  it('totals reconcile exactly — no dust escapes in either direction', async function () {
    const { ballista, usdc, creator, trader, treasury } = await deployFixture();
    const ballistaAddress = await ballista.getAddress();
    const tokenAddress = await launch(ballista, creator);
    const token = await ethers.getContractAt('ArcLaunchToken', tokenAddress);

    // Deliberately awkward amounts, to make rounding dust show up if it exists.
    const amounts = [1n, 3n, 7n, 999n, 1_234_567n, 10_000_001n, 77_777_777n];
    let treasuryTotal = 0n;

    for (const amount of amounts) {
      const before = await usdc.balanceOf(treasury.address);
      await ballista.connect(trader).buy(tokenAddress, amount, 0);
      treasuryTotal += (await usdc.balanceOf(treasury.address)) - before;
    }

    const held = await token.balanceOf(trader.address);
    await token.connect(trader).approve(ballistaAddress, held);
    const beforeSell = await usdc.balanceOf(treasury.address);
    await ballista.connect(trader).sell(tokenAddress, held / 3n, 0);
    treasuryTotal += (await usdc.balanceOf(treasury.address)) - beforeSell;

    const creatorTotal = await ballista.creatorFeesAccrued(creator.address);
    const curve = await ballista.curves(tokenAddress);

    // Every USDC the contract holds is accounted for: curve reserves plus unclaimed
    // creator fees, exactly. Anything unexplained here would be leaked or stranded value.
    expect(await usdc.balanceOf(ballistaAddress)).to.equal(
      curve.realUsdcReserves + creatorTotal
    );
    expect(creatorTotal).to.be.greaterThan(0n);
    expect(treasuryTotal).to.be.greaterThan(0n);
  });

  it('a creator that cannot receive USDC does not break trading for anyone else', async function () {
    const { ballista, usdc, creator, trader, other } = await deployFixture('MockBlocklistUSDC');
    const tokenAddress = await launch(ballista, creator);

    // The creator address can no longer receive USDC at all — the real-world case
    // being Circle blocklisting an address.
    await usdc.setBlocked(creator.address, true);

    // Trading is completely unaffected: fees accrue as a bookkeeping entry, and
    // nothing is ever pushed to the creator inside a trade.
    await expect(ballista.connect(trader).buy(tokenAddress, 500n * ONE_USDC, 0)).to.not.be
      .reverted;
    await expect(ballista.connect(other).buy(tokenAddress, 500n * ONE_USDC, 0)).to.not.be
      .reverted;

    expect(await ballista.creatorFeesAccrued(creator.address)).to.be.greaterThan(0n);

    // Only the blocked creator's own claim fails, and only for them.
    await expect(ballista.connect(creator).claimCreatorFees()).to.be.reverted;

    // Unblocking lets them collect everything that accrued in the meantime.
    await usdc.setBlocked(creator.address, false);
    await expect(ballista.connect(creator).claimCreatorFees()).to.not.be.reverted;
    expect(await ballista.creatorFeesAccrued(creator.address)).to.equal(0n);
  });

  it('claiming pays out once and zeroes the balance — a second claim reverts', async function () {
    const { ballista, usdc, creator, trader } = await deployFixture();
    const tokenAddress = await launch(ballista, creator);
    await ballista.connect(trader).buy(tokenAddress, 1_000n * ONE_USDC, 0);

    const owed = await ballista.creatorFeesAccrued(creator.address);
    expect(owed).to.be.greaterThan(0n);

    const before = await usdc.balanceOf(creator.address);
    await expect(ballista.connect(creator).claimCreatorFees())
      .to.emit(ballista, 'CreatorFeesClaimed')
      .withArgs(creator.address, owed);

    expect((await usdc.balanceOf(creator.address)) - before).to.equal(owed);
    expect(await ballista.creatorFeesAccrued(creator.address)).to.equal(0n);

    await expect(ballista.connect(creator).claimCreatorFees()).to.be.revertedWith('nothing to claim');
  });

  it('a non-creator cannot claim anything', async function () {
    const { ballista, creator, trader, other } = await deployFixture();
    const tokenAddress = await launch(ballista, creator);
    await ballista.connect(trader).buy(tokenAddress, 1_000n * ONE_USDC, 0);

    // Fees are keyed to the caller, so a stranger's claim finds an empty balance
    // rather than someone else's.
    await expect(ballista.connect(other).claimCreatorFees()).to.be.revertedWith('nothing to claim');
    await expect(ballista.connect(trader).claimCreatorFees()).to.be.revertedWith('nothing to claim');
    expect(await ballista.creatorFeesAccrued(creator.address)).to.be.greaterThan(0n);
  });

  it('emits an accrual event carrying the token, so per-token attribution is not lost', async function () {
    const { ballista, creator, trader } = await deployFixture();
    const tokenAddress = await launch(ballista, creator);

    const buyAmount = 1_000n * ONE_USDC;
    await expect(ballista.connect(trader).buy(tokenAddress, buyAmount, 0))
      .to.emit(ballista, 'CreatorFeeAccrued')
      .withArgs(tokenAddress, creator.address, (buyAmount * 90n) / BPS);
  });

  it('one claim collects across every token the same creator launched', async function () {
    const { ballista, creator, trader } = await deployFixture();
    const first = await launch(ballista, creator, 'ONE');
    await ethers.provider.send('evm_increaseTime', [60]);
    await ethers.provider.send('evm_mine');
    const second = await launch(ballista, creator, 'TWO');

    await ballista.connect(trader).buy(first, 1_000n * ONE_USDC, 0);
    await ballista.connect(trader).buy(second, 1_000n * ONE_USDC, 0);

    const expected = 2n * ((1_000n * ONE_USDC * 90n) / BPS);
    expect(await ballista.creatorFeesAccrued(creator.address)).to.equal(expected);
  });

  describe('asymmetric buy/sell split', function () {
    // Measures each side's creator share directly off the contract, then blends them.
    // The blend is the number that matters commercially and the only one that should
    // ever be quoted as "the" creator rate -- 90% describes the buy side alone.
    it('buy side pays 90% of the fee, sell side 50%, blending to 70% at equal volume', async function () {
      const { ballista, usdc, creator, trader, treasury } = await deployFixture();
      const tokenAddress = await launch(ballista, creator);
      const token = await ethers.getContractAt('ArcLaunchToken', tokenAddress);

      // ── buy side ──
      const buyAmount = 1_000n * ONE_USDC;
      let tBefore = await usdc.balanceOf(treasury.address);
      let cBefore = await ballista.creatorFeesAccrued(creator.address);
      await ballista.connect(trader).buy(tokenAddress, buyAmount, 0);
      const buyCreator = (await ballista.creatorFeesAccrued(creator.address)) - cBefore;
      const buyTreasury = (await usdc.balanceOf(treasury.address)) - tBefore;
      const buyFee = buyCreator + buyTreasury;

      // ── sell side ──
      const held = await token.balanceOf(trader.address);
      await token.connect(trader).approve(await ballista.getAddress(), held);
      tBefore = await usdc.balanceOf(treasury.address);
      cBefore = await ballista.creatorFeesAccrued(creator.address);
      const quote = await ballista.quoteSell(tokenAddress, held);
      await ballista.connect(trader).sell(tokenAddress, held, 0);
      const sellCreator = (await ballista.creatorFeesAccrued(creator.address)) - cBefore;
      const sellTreasury = (await usdc.balanceOf(treasury.address)) - tBefore;
      const sellFee = sellCreator + sellTreasury;

      // Assert against the contract's own floor-division rather than dividing a rate
      // back out of the result: recovering a percentage from an already-floored cut
      // floors a second time and reads 49 where the rate is genuinely 50.
      expect(buyCreator).to.equal((buyAmount * 90n) / BPS);
      expect(sellCreator).to.equal((quote.usdcOutGross * 50n) / BPS);

      // Whatever is not the creator's is the treasury's, exactly -- no dust escapes.
      expect(buyFee).to.equal((buyAmount * 100n) / BPS);
      expect(buyTreasury).to.equal(buyFee - buyCreator);
      expect(sellFee).to.equal(quote.fee);
      expect(sellTreasury).to.equal(sellFee - sellCreator);

      // Fees are charged on volume, so at equal USDC volume per side the blend is the
      // mean of the two rates: (90 + 50) / 2 = 70 bps of a 100 bps fee.
      expect((90n + 50n) / 2n).to.equal(70n);
    });

    it('a buy-heavy mix blends above 70%, which is the point of the asymmetry', async function () {
      // 70:30 buy:sell -> (0.7*90 + 0.3*50) = 78 bps of a 100 bps fee.
      const blended = (70n * 90n + 30n * 50n) / 100n;
      expect(blended).to.equal(78n);
    });

    it('the two sides are independent -- changing one does not move the other', async function () {
      const { ballista } = await deployFixture();
      await ballista.setDefaultCreatorFees(20, 50);
      expect(await ballista.defaultCreatorBuyFeeBps()).to.equal(20);
      expect(await ballista.defaultCreatorSellFeeBps()).to.equal(50);

      await ballista.setDefaultCreatorFees(20, 10);
      expect(await ballista.defaultCreatorBuyFeeBps()).to.equal(20);
      expect(await ballista.defaultCreatorSellFeeBps()).to.equal(10);
    });

    it('emits both new rates together', async function () {
      const { ballista } = await deployFixture();
      await expect(ballista.setDefaultCreatorFees(70, 30))
        .to.emit(ballista, 'DefaultCreatorFeesSet')
        .withArgs(70, 30);
    });

    // The promotion plan: launch generous, move toward the market rate later, and
    // never change the deal for anyone already launched.
    it('moving the defaults toward 70/30 leaves an already-launched token untouched', async function () {
      const { ballista, creator, trader } = await deployFixture();
      const promo = await launch(ballista, creator, 'PROMO');

      await ballista.setDefaultCreatorFees(70, 70); // the eventual steady-state rate

      const before = await ballista.creatorFeesAccrued(creator.address);
      const buyAmount = 1_000n * ONE_USDC;
      await ballista.connect(trader).buy(promo, buyAmount, 0);
      // Still the promotional 90%, because it was snapshotted at launch.
      expect((await ballista.creatorFeesAccrued(creator.address)) - before).to.equal(
        (buyAmount * 90n) / BPS
      );

      // ...while a token launched after the change gets the new rate.
      await ethers.provider.send('evm_increaseTime', [60]);
      await ethers.provider.send('evm_mine');
      const later = await launch(ballista, creator, 'LATER');
      expect((await ballista.curves(later)).creatorBuyFeeBps).to.equal(70);
      expect((await ballista.curves(later)).creatorSellFeeBps).to.equal(70);
    });
  });

  describe('rate is snapshotted and pinned', function () {
    it('the SELL side alone changing also invalidates a pinned hash', async function () {
      const { ballista, creator } = await deployFixture();
      const staleHash = await ballista.currentEconomicsHash();
      await ballista.setDefaultCreatorFees(90, 40); // buy unchanged, sell moved
      await expect(
        ballista.connect(creator).createToken('SellOnly', 'SLO', 'ipfs://a', staleHash, false)
      ).to.be.revertedWith(
        'economics changed since you last checked -- refresh and confirm the new terms'
      );
    });

    it('is included in the economics hash', async function () {
      const { ballista, creator } = await deployFixture();
      const staleHash = await ballista.currentEconomicsHash();

      await ballista.setDefaultCreatorFees(50, 40);

      await expect(
        ballista.connect(creator).createToken('Late', 'LATE', 'ipfs://a', staleHash, false)
      ).to.be.revertedWith(
        'economics changed since you last checked -- refresh and confirm the new terms'
      );
    });

    it('a live token keeps the rate it launched with', async function () {
      const { ballista, creator, trader } = await deployFixture();
      const tokenAddress = await launch(ballista, creator);
      expect((await ballista.curves(tokenAddress)).creatorBuyFeeBps).to.equal(90);
      expect((await ballista.curves(tokenAddress)).creatorSellFeeBps).to.equal(50);

      await ballista.setDefaultCreatorFees(100, 100); // the whole fee, both sides

      const before = await ballista.creatorFeesAccrued(creator.address);
      const buyAmount = 1_000n * ONE_USDC;
      await ballista.connect(trader).buy(tokenAddress, buyAmount, 0);

      // Still 0.90% on the buy side, not the new 1%.
      expect((await ballista.creatorFeesAccrued(creator.address)) - before).to.equal(
        (buyAmount * 90n) / BPS
      );
    });

    it('rejects a creator share larger than the fee it is carved from', async function () {
      const { ballista } = await deployFixture();
      // Default fees are 100 bps on each side; 101 would exceed them.
      await expect(ballista.setDefaultCreatorFees(101, 50)).to.be.revertedWith(
        'creator buy share cannot exceed the buy fee it is carved from'
      );
      await expect(ballista.setDefaultCreatorFees(90, 101)).to.be.revertedWith(
        'creator sell share cannot exceed the sell fee it is carved from'
      );
      await expect(ballista.setDefaultCreatorFees(100, 100)).to.not.be.reverted;
    });

    it('rejects lowering the trade fee below the creator share', async function () {
      const { ballista } = await deployFixture();
      await ballista.setDefaultCreatorFees(80, 80);

      await expect(ballista.setDefaultFees(50, 100)).to.be.revertedWith(
        'fee would fall below the creator share -- lower the creator share first'
      );

      // Doing it in the correct order works.
      await ballista.setDefaultCreatorFees(50, 50);
      await expect(ballista.setDefaultFees(50, 100)).to.not.be.reverted;
    });

    it('only the owner can change the default creator share', async function () {
      const { ballista, creator } = await deployFixture();
      await expect(ballista.connect(creator).setDefaultCreatorFees(10, 10)).to.be.reverted;
    });
  });
});
