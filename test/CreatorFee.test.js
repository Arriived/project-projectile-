const { expect } = require('chai');
const { ethers } = require('hardhat');

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
    await ballista.setRouter(await router.getAddress());

    for (const signer of [creator, trader, other]) {
      await usdc.mint(signer.address, 1_000_000n * ONE_USDC);
      await usdc.connect(signer).approve(await ballista.getAddress(), ethers.MaxUint256);
    }
    return { deployer, treasury, creator, trader, other, usdc, ballista };
  }

  async function launch(ballista, creator, symbol = 'CRT') {
    const hash = await ballista.currentEconomicsHash();
    const receipt = await (
      await ballista.connect(creator).createToken('Creator Coin', symbol, 'ipfs://a', hash)
    ).wait();
    const event = receipt.logs
      .map((l) => { try { return ballista.interface.parseLog(l); } catch { return null; } })
      .find((l) => l && l.name === 'TokenCreated');
    return event.args.token;
  }

  it('splits the existing 1% fee into 0.7% treasury / 0.3% creator, adding nothing on top', async function () {
    const { ballista, usdc, creator, trader, treasury } = await deployFixture();
    const tokenAddress = await launch(ballista, creator);

    const buyAmount = 10_000n * ONE_USDC;
    const traderBefore = await usdc.balanceOf(trader.address);
    const treasuryBefore = await usdc.balanceOf(treasury.address);

    await ballista.connect(trader).buy(tokenAddress, buyAmount, 0);

    const traderSpent = traderBefore - (await usdc.balanceOf(trader.address));
    const treasuryGot = (await usdc.balanceOf(treasury.address)) - treasuryBefore;
    const creatorAccrued = await ballista.creatorFeesAccrued(creator.address);

    // The whole point: trader-facing cost is unchanged by the creator share existing.
    expect(traderSpent).to.equal(buyAmount);

    const totalFee = (buyAmount * 100n) / BPS;   // 1%
    const expectedCreator = (buyAmount * 30n) / BPS;  // 0.30%
    expect(creatorAccrued).to.equal(expectedCreator);
    expect(treasuryGot).to.equal(totalFee - expectedCreator); // 0.70%
    expect(creatorAccrued + treasuryGot).to.equal(totalFee);
  });

  it('applies to sells as well as buys', async function () {
    const { ballista, usdc, creator, trader, treasury } = await deployFixture();
    const tokenAddress = await launch(ballista, creator);
    const token = await ethers.getContractAt('ArcLaunchToken', tokenAddress);

    await ballista.connect(trader).buy(tokenAddress, 10_000n * ONE_USDC, 0);
    const afterBuy = await ballista.creatorFeesAccrued(creator.address);

    const held = await token.balanceOf(trader.address);
    await token.connect(trader).approve(await ballista.getAddress(), held);

    const treasuryBefore = await usdc.balanceOf(treasury.address);
    await ballista.connect(trader).sell(tokenAddress, held, 0);
    const treasuryGot = (await usdc.balanceOf(treasury.address)) - treasuryBefore;

    const sellAccrual = (await ballista.creatorFeesAccrued(creator.address)) - afterBuy;
    expect(sellAccrual).to.be.greaterThan(0n);

    // 0.3 : 0.7 on the sell side too. Reconstructed from the two shares, since the
    // gross the fee was charged on is internal to the curve.
    const sellFee = sellAccrual + treasuryGot;
    expect(sellAccrual).to.equal((sellFee * 30n) / 100n);
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
    await expect(ballista.connect(trader).buy(tokenAddress, 5_000n * ONE_USDC, 0)).to.not.be
      .reverted;
    await expect(ballista.connect(other).buy(tokenAddress, 5_000n * ONE_USDC, 0)).to.not.be
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
    await ballista.connect(trader).buy(tokenAddress, 10_000n * ONE_USDC, 0);

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
    await ballista.connect(trader).buy(tokenAddress, 10_000n * ONE_USDC, 0);

    // Fees are keyed to the caller, so a stranger's claim finds an empty balance
    // rather than someone else's.
    await expect(ballista.connect(other).claimCreatorFees()).to.be.revertedWith('nothing to claim');
    await expect(ballista.connect(trader).claimCreatorFees()).to.be.revertedWith('nothing to claim');
    expect(await ballista.creatorFeesAccrued(creator.address)).to.be.greaterThan(0n);
  });

  it('emits an accrual event carrying the token, so per-token attribution is not lost', async function () {
    const { ballista, creator, trader } = await deployFixture();
    const tokenAddress = await launch(ballista, creator);

    const buyAmount = 10_000n * ONE_USDC;
    await expect(ballista.connect(trader).buy(tokenAddress, buyAmount, 0))
      .to.emit(ballista, 'CreatorFeeAccrued')
      .withArgs(tokenAddress, creator.address, (buyAmount * 30n) / BPS);
  });

  it('one claim collects across every token the same creator launched', async function () {
    const { ballista, creator, trader } = await deployFixture();
    const first = await launch(ballista, creator, 'ONE');
    await ethers.provider.send('evm_increaseTime', [60]);
    await ethers.provider.send('evm_mine');
    const second = await launch(ballista, creator, 'TWO');

    await ballista.connect(trader).buy(first, 10_000n * ONE_USDC, 0);
    await ballista.connect(trader).buy(second, 10_000n * ONE_USDC, 0);

    const expected = 2n * ((10_000n * ONE_USDC * 30n) / BPS);
    expect(await ballista.creatorFeesAccrued(creator.address)).to.equal(expected);
  });

  describe('rate is snapshotted and pinned', function () {
    it('is included in the economics hash', async function () {
      const { ballista, creator } = await deployFixture();
      const staleHash = await ballista.currentEconomicsHash();

      await ballista.setDefaultCreatorFeeBps(50);

      await expect(
        ballista.connect(creator).createToken('Late', 'LATE', 'ipfs://a', staleHash)
      ).to.be.revertedWith(
        'economics changed since you last checked -- refresh and confirm the new terms'
      );
    });

    it('a live token keeps the rate it launched with', async function () {
      const { ballista, creator, trader } = await deployFixture();
      const tokenAddress = await launch(ballista, creator);
      expect((await ballista.curves(tokenAddress)).creatorFeeBps).to.equal(30);

      await ballista.setDefaultCreatorFeeBps(100); // 1%, the whole fee

      const before = await ballista.creatorFeesAccrued(creator.address);
      const buyAmount = 10_000n * ONE_USDC;
      await ballista.connect(trader).buy(tokenAddress, buyAmount, 0);

      // Still 0.3%, not the new 1%.
      expect((await ballista.creatorFeesAccrued(creator.address)) - before).to.equal(
        (buyAmount * 30n) / BPS
      );
    });

    it('rejects a creator share larger than the fee it is carved from', async function () {
      const { ballista } = await deployFixture();
      // Default fees are 100 bps; 101 would exceed them.
      await expect(ballista.setDefaultCreatorFeeBps(101)).to.be.revertedWith(
        'creator share cannot exceed the fee it is carved from'
      );
      await expect(ballista.setDefaultCreatorFeeBps(100)).to.not.be.reverted;
    });

    it('rejects lowering the trade fee below the creator share', async function () {
      const { ballista } = await deployFixture();
      await ballista.setDefaultCreatorFeeBps(80);

      await expect(ballista.setDefaultFees(50, 100)).to.be.revertedWith(
        'fee would fall below the creator share -- lower the creator share first'
      );

      // Doing it in the correct order works.
      await ballista.setDefaultCreatorFeeBps(50);
      await expect(ballista.setDefaultFees(50, 100)).to.not.be.reverted;
    });

    it('only the owner can change the default creator share', async function () {
      const { ballista, creator } = await deployFixture();
      await expect(ballista.connect(creator).setDefaultCreatorFeeBps(10)).to.be.reverted;
    });
  });
});
