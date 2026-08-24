const { expect } = require('chai');
const { ethers } = require('hardhat');
const { activateRouter } = require('./routerHelper');

const ONE_USDC = 1_000_000n;
const BPS = 10_000n;

// Mirrors the opening table published in Ballista's constructor.
// Mirrors the retuned table published in Ballista's constructor. The old
// [9800, 2500, 300, 100, 0] was inherited from the $67,000 curve and stopped deterring
// once the virtual reserve dropped to $2,667 -- a $1,000 sniper took 29% of supply at
// t=1. This decays slower and runs to t=7.
const OPENING_TABLE = [9800, 9500, 9000, 8000, 6000, 4000, 2000, 0];

describe('Ballista — decaying snipe tax', function () {
  async function deployFixture() {
    const [deployer, treasury, creator, sniper, trader] = await ethers.getSigners();

    const usdc = await (await ethers.getContractFactory('MockUSDC')).deploy();
    const ballista = await (await ethers.getContractFactory('LFX1')).deploy(
      await usdc.getAddress(),
      treasury.address,
      ethers.ZeroAddress
    );
    const router = await (await ethers.getContractFactory('MockRouter')).deploy();
    await activateRouter(ballista, await router.getAddress());

    for (const signer of [creator, sniper, trader]) {
      await usdc.mint(signer.address, 5_000_000n * ONE_USDC);
      await usdc.connect(signer).approve(await ballista.getAddress(), ethers.MaxUint256);
    }
    return { deployer, treasury, creator, sniper, trader, usdc, ballista };
  }

  async function launch(ballista, creator, symbol = 'SNP') {
    const hash = await ballista.currentEconomicsHash();
    const receipt = await (
      await ballista.connect(creator).createToken('Snipe Coin', symbol, 'ipfs://a', hash, false)
    ).wait();
    const event = receipt.logs
      .map((l) => { try { return ballista.interface.parseLog(l); } catch { return null; } })
      .find((l) => l && l.name === 'TokenCreated');
    return event.args.token;
  }

  // Moves the chain to exactly `seconds` past the token's creation timestamp, so the
  // table index under test is the one actually hit.
  async function atElapsed(ballista, tokenAddress, seconds) {
    const curve = await ballista.curves(tokenAddress);
    const target = Number(curve.creationTimestamp) + seconds;
    const latest = await ethers.provider.getBlock('latest');
    // Throw loudly rather than silently testing a different second than intended --
    // a snipe tax test that quietly slid past the window would prove nothing.
    if (target < latest.timestamp) {
      throw new Error(
        `cannot rewind to elapsed=${seconds}: chain is already ${latest.timestamp - target}s past it`
      );
    }
    await ethers.provider.send('evm_setNextBlockTimestamp', [target]);
    await ethers.provider.send('evm_mine');
    // Pin the CALLER'S next transaction to the same second too. Mining a filler block
    // only fixes the timestamp that view calls see; the transaction that follows mines
    // its OWN block, and hardhat stamps that from the wall clock. On a slow machine
    // real seconds elapse between the assertion above and the trade below, so the trade
    // executes in a LOWER tax tier than the one just asserted -- the test then compares
    // a t=0 quote against a t=2 execution and fails on a contract that is behaving
    // correctly. Reproduced deliberately with a 2.5s sleep: received 35,092,491 tokens
    // against a quoted 4,015,689. allowBlocksWithSameTimestamp lets both blocks share
    // the second.
    await ethers.provider.send('evm_setNextBlockTimestamp', [target]);
    return target;
  }

  // Re-pin when a test sends MORE than one transaction at the same elapsed second.
  async function pinAgain(target) {
    await ethers.provider.send('evm_setNextBlockTimestamp', [target]);
  }

  it('publishes the opening table in the constructor', async function () {
    const { ballista } = await deployFixture();
    const version = await ballista.activeSnipeTaxTableVersion();
    const table = await ballista.snipeTaxTable(version);
    expect(table.map(Number)).to.deep.equal(OPENING_TABLE);
    expect(await ballista.snipeTaxTableMaxBps(version)).to.equal(9800);
  });

  it('decays across the window and reaches zero after it', async function () {
    const { ballista, creator } = await deployFixture();
    const tokenAddress = await launch(ballista, creator);

    const seen = [];
    for (let t = 0; t <= OPENING_TABLE.length + 1; t++) {
      await atElapsed(ballista, tokenAddress, t);
      seen.push(Number(await ballista.currentSnipeTaxBps(tokenAddress)));
    }
    // Table values for 0..4, then zero for anything past the end of the table.
    expect(seen).to.deep.equal([...OPENING_TABLE, 0, 0]);
  });

  it('charges the tax at t=0 and hands the buyer far less than the untaxed curve would', async function () {
    const { ballista, creator, sniper } = await deployFixture();
    const tokenAddress = await launch(ballista, creator);

    await atElapsed(ballista, tokenAddress, 0);
    expect(await ballista.currentSnipeTaxBps(tokenAddress)).to.equal(9800);

    const spend = 1_000n * ONE_USDC;
    const quoted = await ballista.quoteBuy(tokenAddress, spend);
    await ballista.connect(sniper).buy(tokenAddress, spend, 0);

    const token = await ethers.getContractAt('LFX1Token', tokenAddress);
    const received = await token.balanceOf(sniper.address);

    // quoteBuy must include the tax, or a frontend preview during the window would
    // promise several times what the trade actually delivers.
    expect(received).to.equal(quoted.tokensOut);

    // 98% tax + 1% fee means only ~1% of the spend reaches the curve.
    expect(quoted.actualFee).to.equal((spend * 9900n) / BPS);
  });

  it('a sniper at t=0 does far worse than the same spend after the window closes', async function () {
    const { ballista, creator, sniper, trader } = await deployFixture();
    const token0 = await launch(ballista, creator, 'EARLY');

    await atElapsed(ballista, token0, 0);
    await ballista.connect(sniper).buy(token0, 1_000n * ONE_USDC, 0);
    const early = await (await ethers.getContractAt('LFX1Token', token0)).balanceOf(
      sniper.address
    );

    await ethers.provider.send('evm_increaseTime', [120]);
    await ethers.provider.send('evm_mine');
    const token1 = await launch(ballista, creator, 'LATE');
    await atElapsed(ballista, token1, 10); // past the window
    await ballista.connect(trader).buy(token1, 1_000n * ONE_USDC, 0);
    const late = await (await ethers.getContractAt('LFX1Token', token1)).balanceOf(
      trader.address
    );

    // Same spend, same curve position -- sniping is simply unprofitable, not delayed.
    expect(early * 10n).to.be.lessThan(late);
  });

  it('splits the tax 70/30 treasury/curve, adding USDC to the curve without releasing tokens', async function () {
    const { ballista, usdc, creator, sniper, treasury } = await deployFixture();
    const tokenAddress = await launch(ballista, creator);
    await atElapsed(ballista, tokenAddress, 6); // 20% tax, small enough to reason about

    const before = await ballista.curves(tokenAddress);
    const treasuryBefore = await ballista.treasuryFeesAccrued();

    const spend = 1_000n * ONE_USDC;
    const receipt = await (await ballista.connect(sniper).buy(tokenAddress, spend, 0)).wait();
    const taxEvent = receipt.logs
      .map((l) => { try { return ballista.interface.parseLog(l); } catch { return null; } })
      .find((l) => l && l.name === 'SnipeTaxCollected');

    const snipeTax = (spend * 2000n) / BPS;
    const expectedToTreasury = (snipeTax * 7000n) / BPS;
    const expectedToCurve = snipeTax - expectedToTreasury;

    expect(taxEvent.args.toTreasury).to.equal(expectedToTreasury);
    expect(taxEvent.args.toCurve).to.equal(expectedToCurve);
    expect(taxEvent.args.toTreasury + taxEvent.args.toCurve).to.equal(snipeTax);

    // Treasury receives its snipe share plus the base fee net of the creator carve-out.
    const baseFee = (spend * 100n) / BPS;
    const creatorCut = (spend * 90n) / BPS; // buy side: 0.90%
    expect((await ballista.treasuryFeesAccrued()) - treasuryBefore).to.equal(
      baseFee - creatorCut + expectedToTreasury
    );

    // The curve's share is pure reserve growth: USDC in, no extra tokens out.
    const after = await ballista.curves(tokenAddress);
    const totalFee = (spend * (2000n + 100n)) / BPS; // tax + base fee
    expect(after.realUsdcReserves - before.realUsdcReserves).to.equal(
      spend - totalFee + expectedToCurve
    );
    expect(before.tokenReserves - after.tokenReserves).to.be.greaterThan(0n);
  });

  it('the curve share raises reserves without moving the virtual reserves', async function () {
    const { ballista, creator, sniper } = await deployFixture();
    const taxed = await launch(ballista, creator, 'TAXED');
    await atElapsed(ballista, taxed, 6);

    const before = await ballista.curves(taxed);
    const spend = 1_000n * ONE_USDC;
    await ballista.connect(sniper).buy(taxed, spend, 0);
    const after = await ballista.curves(taxed);

    const snipeTax = (spend * 2000n) / BPS;
    const toCurve = snipeTax - (snipeTax * 7000n) / BPS;
    const totalFee = (spend * (2000n + 100n)) / BPS;

    // Reserves grow by the post-fee spend PLUS the tax share.
    expect(after.realUsdcReserves - before.realUsdcReserves).to.equal(
      spend - totalFee + toCurve
    );

    // Virtual reserves moved only by the post-fee spend -- the tax share bought nothing.
    expect(after.virtualUsdcReserves - before.virtualUsdcReserves).to.equal(spend - totalFee);
  });

  it('applies to buys only, never to sells', async function () {
    const { ballista, usdc, creator, trader, treasury } = await deployFixture();
    const tokenAddress = await launch(ballista, creator);

    await atElapsed(ballista, tokenAddress, 10); // buy cleanly, outside the window
    await ballista.connect(trader).buy(tokenAddress, 2_000n * ONE_USDC, 0);

    const token = await ethers.getContractAt('LFX1Token', tokenAddress);
    const held = await token.balanceOf(trader.address);
    await token.connect(trader).approve(await ballista.getAddress(), held);

    // A fresh token whose window is open, to prove sells are untaxed even then.
    await ethers.provider.send('evm_increaseTime', [120]);
    await ethers.provider.send('evm_mine');
    const fresh = await launch(ballista, creator, 'FRSH');
    await atElapsed(ballista, fresh, 0);
    expect(await ballista.currentSnipeTaxBps(fresh)).to.equal(9800);

    // Selling the FIRST token while a window is open elsewhere is unaffected either way;
    // what matters is that this token's own sell path charges only sellFeeBps.
    const treasuryBefore = await ballista.treasuryFeesAccrued();
    const quote = await ballista.quoteSell(tokenAddress, held);
    await ballista.connect(trader).sell(tokenAddress, held, 0);
    const treasuryGot = (await ballista.treasuryFeesAccrued()) - treasuryBefore;

    const creatorShare = (quote.usdcOutGross * 50n) / BPS; // sell side: 0.50%
    expect(quote.fee).to.equal((quote.usdcOutGross * 100n) / BPS); // 1%, no tax added
    expect(treasuryGot).to.equal(quote.fee - creatorShare);
  });

  describe('the combined-fee ceiling', function () {
    it('CRITICAL: a clamped buy at max tax and max base fee does not revert', async function () {
      const { ballista, usdc, creator, sniper } = await deployFixture();

      // Base fee at its ceiling, plus the largest table that can coexist with it:
      // 1000 + 8900 == 9900 == MAX_TOTAL_FEE_BPS, the exact boundary. One bps more
      // anywhere and the clamp path divides by zero.
      await ballista.setDefaultFees(1000, 1000);
      await ballista.publishSnipeTaxTable([8900, 8900, 8900]);

      const tokenAddress = await launch(ballista, creator, 'MAXF');
      await atElapsed(ballista, tokenAddress, 0);
      expect(await ballista.currentSnipeTaxBps(tokenAddress)).to.equal(8900);

      // At a 99% total fee only 1% of the spend reaches the curve, so reaching full
      // depletion takes ~8.8M USDC gross. 20M guarantees the request exceeds the
      // entire remaining token supply and MUST take the clamp branch.
      await usdc.mint(sniper.address, 30_000_000n * ONE_USDC);
      const huge = 20_000_000n * ONE_USDC;

      // Prove the clamp actually fires rather than assuming it. If actualUsdcIn came
      // back equal to the request, this test would be exercising the ordinary path and
      // proving nothing about the division that motivated the whole ceiling.
      const quoted = await ballista.quoteBuy(tokenAddress, huge);
      expect(quoted.actualUsdcIn, 'expected the clamp path, got a full fill').to.be.lessThan(huge);
      expect(quoted.tokensOut).to.equal((await ballista.curves(tokenAddress)).tokenReserves);

      await expect(ballista.connect(sniper).buy(tokenAddress, huge, 0)).to.not.be.reverted;

      // Execution matched the clamped quote exactly, at the maximum possible fee.
      const token = await ethers.getContractAt('LFX1Token', tokenAddress);
      expect(await token.balanceOf(sniper.address)).to.equal(quoted.tokensOut);
    });

    it('rejects publishing a table that could not coexist with the base fee', async function () {
      const { ballista } = await deployFixture();
      await ballista.setDefaultFees(1000, 1000);
      // 1000 + 9000 = 10000, exactly the denominator. Must be refused.
      await expect(ballista.publishSnipeTaxTable([9000])).to.be.revertedWithCustomError(ballista, 'SnipeTaxCeilingExceeded'
      );
    });

    it('refuses to launch when the active table and base fee cannot coexist', async function () {
      const { ballista, creator } = await deployFixture();
      // Publish a large table while the base fee is low enough to allow it...
      await ballista.publishSnipeTaxTable([9800]);
      // ...then raise the base fee so the pair no longer fits.
      await ballista.setDefaultFees(1000, 1000);

      await expect(launch(ballista, creator, 'BAD')).to.be.revertedWithCustomError(ballista, 'BaseFeeCeilingExceeded'
      );
    });

    it('the ceiling is strictly below the bps denominator', async function () {
      const { ballista } = await deployFixture();
      expect(await ballista.MAX_TOTAL_FEE_BPS()).to.be.lessThan(await ballista.BPS_DENOMINATOR());
    });
  });

  describe('pinning and snapshotting', function () {
    it('the table version and split are both in the economics hash', async function () {
      const { ballista, creator } = await deployFixture();

      let stale = await ballista.currentEconomicsHash();
      await ballista.publishSnipeTaxTable([5000, 1000]);
      await expect(
        ballista.connect(creator).createToken('A', 'AAA', 'u', stale, false)
      ).to.be.revertedWithCustomError(ballista, 'EconomicsChanged'
      );

      stale = await ballista.currentEconomicsHash();
      await ballista.setDefaultSnipeTaxTreasuryBps(1000);
      await expect(
        ballista.connect(creator).createToken('B', 'BBB', 'u', stale, false)
      ).to.be.revertedWithCustomError(ballista, 'EconomicsChanged'
      );
    });

    it('a live token keeps the table it launched under when a new one is published', async function () {
      const { ballista, creator } = await deployFixture();
      const tokenAddress = await launch(ballista, creator, 'OLD');
      const launchedVersion = (await ballista.curves(tokenAddress)).snipeTaxTableVersion;

      await ballista.publishSnipeTaxTable([1, 1, 1, 1, 1]);
      expect(await ballista.activeSnipeTaxTableVersion()).to.not.equal(launchedVersion);

      // Reading at t=1 rather than t=0: publishing above already consumed a second,
      // and atElapsed refuses to pretend otherwise.
      await atElapsed(ballista, tokenAddress, 1);
      // Still the OLD table's t=1 rate, not the newly published 1 bps.
      expect(await ballista.currentSnipeTaxBps(tokenAddress)).to.equal(9500);
    });

    it('changing the split does not affect a token already trading', async function () {
      const { ballista, usdc, creator, sniper, treasury } = await deployFixture();
      const tokenAddress = await launch(ballista, creator, 'SPLT');
      expect((await ballista.curves(tokenAddress)).snipeTaxTreasuryBps).to.equal(7000);

      await ballista.setDefaultSnipeTaxTreasuryBps(1000); // 10/90 for FUTURE launches

      await atElapsed(ballista, tokenAddress, 6);
      const treasuryBefore = await ballista.treasuryFeesAccrued();
      const spend = 1_000n * ONE_USDC;
      const receipt = await (await ballista.connect(sniper).buy(tokenAddress, spend, 0)).wait();
      const taxEvent = receipt.logs
        .map((l) => { try { return ballista.interface.parseLog(l); } catch { return null; } })
        .find((l) => l && l.name === 'SnipeTaxCollected');

      // Still 70/30, the split it launched with.
      const snipeTax = (spend * 2000n) / BPS;
      expect(taxEvent.args.toTreasury).to.equal((snipeTax * 7000n) / BPS);
      expect(treasuryBefore).to.be.a('bigint');
    });

    it('a new launch picks up the new split', async function () {
      const { ballista, creator } = await deployFixture();
      await ballista.setDefaultSnipeTaxTreasuryBps(1000);
      const tokenAddress = await launch(ballista, creator, 'NEW');
      expect((await ballista.curves(tokenAddress)).snipeTaxTreasuryBps).to.equal(1000);
    });

    it('only the owner can publish a table or change the split', async function () {
      const { ballista, creator } = await deployFixture();
      await expect(ballista.connect(creator).publishSnipeTaxTable([100])).to.be.reverted;
      await expect(ballista.connect(creator).setDefaultSnipeTaxTreasuryBps(5000)).to.be.reverted;
    });

    it('an empty table disables the tax entirely for new launches', async function () {
      const { ballista, creator } = await deployFixture();
      await ballista.publishSnipeTaxTable([]);
      const tokenAddress = await launch(ballista, creator, 'NOTAX');
      await atElapsed(ballista, tokenAddress, 0);
      expect(await ballista.currentSnipeTaxBps(tokenAddress)).to.equal(0);
    });
  });
});
