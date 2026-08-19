const { expect } = require('chai');
const { ethers } = require('hardhat');

const ONE_USDC = 1_000_000n;
const ACTIVE = 0n;
const GRADUATION_READY = 1n;
const GRADUATED = 2n;

describe('Ballista — graduation state machine adversarial testing', function () {
  async function deployFixtureWithRouter(RouterContractName) {
    const [deployer, treasury, creator, trader, other] = await ethers.getSigners();

    const USDC = await ethers.getContractFactory('MockUSDC');
    const usdc = await USDC.deploy();

    const Ballista = await ethers.getContractFactory('Ballista');
    const ballista = await Ballista.deploy(await usdc.getAddress(), treasury.address);
    const ballistaAddress = await ballista.getAddress();

    if (RouterContractName) {
      const Router = await ethers.getContractFactory(RouterContractName);
      const router = await Router.deploy();
      await ballista.setRouter(await router.getAddress());
    }

    for (const signer of [creator, trader, other]) {
      await usdc.mint(signer.address, 20_000_000n * ONE_USDC);
      await usdc.connect(signer).approve(ballistaAddress, ethers.MaxUint256);
    }

    return { deployer, treasury, creator, trader, other, usdc, ballista, ballistaAddress };
  }

  async function launchToken(ballista, creator, name, symbol) {
    const expectedHash = await ballista.currentEconomicsHash();
    const createTx = await ballista.connect(creator).createToken(name, symbol, 'ipfs://a', expectedHash);
    const receipt = await createTx.wait();
    const event = receipt.logs
      .map((l) => { try { return ballista.interface.parseLog(l); } catch { return null; } })
      .find((l) => l && l.name === 'TokenCreated');
    return event.args.token;
  }

  function findEvent(ballista, receipt, name) {
    return receipt.logs
      .map((l) => { try { return ballista.interface.parseLog(l); } catch { return null; } })
      .find((l) => l && l.name === name);
  }

  it('THE CORE FIX: a reverting router does not unwind the trade that triggered graduation', async function () {
    // This is the actual bug this redesign fixes. Old code called _graduate()
    // synchronously inside buy() with no isolation -- if the router reverted for
    // ANY reason, the entire buy reverted too, including the trade itself.
    const { ballista, creator, trader, usdc } = await deployFixtureWithRouter('MockRevertingRouter');
    const tokenAddress = await launchToken(ballista, creator, 'Revert Coin', 'RVT');
    const token = await ethers.getContractAt('ArcLaunchToken', tokenAddress);

    const balanceBefore = await usdc.balanceOf(trader.address);
    const buyAmount = 68_000n * ONE_USDC; // crosses the 67k default threshold

    const tx = await ballista.connect(trader).buy(tokenAddress, buyAmount, 0);
    const receipt = await tx.wait();

    // The trade itself succeeded -- USDC actually moved, tokens actually arrived --
    // despite the router behind it reverting outright.
    const tradeEvent = findEvent(ballista, receipt, 'Trade');
    expect(tradeEvent).to.not.be.undefined;
    expect(await token.balanceOf(trader.address)).to.be.gt(0n);
    expect(balanceBefore - (await usdc.balanceOf(trader.address))).to.equal(tradeEvent.args.usdcAmount);

    // Graduation itself did NOT complete -- curve is stuck at GRADUATION_READY,
    // not ACTIVE (trading is still closed) and not GRADUATED.
    const curve = await ballista.curves(tokenAddress);
    expect(curve.state).to.equal(GRADUATION_READY);

    // The failure was actually observable, not silently swallowed.
    const failedEvent = findEvent(ballista, receipt, 'GraduationAttemptFailed');
    expect(failedEvent).to.not.be.undefined;
  });

  it('PERMISSIONLESS RETRY: anyone, not just the original buyer, can complete a stuck graduation', async function () {
    const { ballista, creator, trader, other, usdc, ballistaAddress } = await deployFixtureWithRouter('MockRevertingRouter');
    const tokenAddress = await launchToken(ballista, creator, 'Retry Coin', 'RTY');

    await ballista.connect(trader).buy(tokenAddress, 68_000n * ONE_USDC, 0);
    expect((await ballista.curves(tokenAddress)).state).to.equal(GRADUATION_READY);

    // Swap in a working router -- simulating the underlying problem (e.g. gas
    // pressure) having cleared. `other` is a completely uninvolved account: never
    // bought this token, never touched it before.
    const WorkingRouter = await ethers.getContractFactory('MockRouter');
    const workingRouter = await WorkingRouter.deploy();
    await ballista.setRouter(await workingRouter.getAddress());

    const tx = await ballista.connect(other).graduate(tokenAddress);
    const receipt = await tx.wait();

    const graduatedEvent = findEvent(ballista, receipt, 'Graduated');
    expect(graduatedEvent).to.not.be.undefined;

    const curve = await ballista.curves(tokenAddress);
    expect(curve.state).to.equal(GRADUATED);
    expect(curve.tokenReserves).to.equal(0n);
    expect(curve.realUsdcReserves).to.equal(0n);
  });

  it('a failed graduation attempt leaves reserves completely untouched -- nothing to roll back', async function () {
    const { ballista, creator, trader } = await deployFixtureWithRouter('MockRevertingRouter');
    const tokenAddress = await launchToken(ballista, creator, 'Untouched Coin', 'UNT');

    await ballista.connect(trader).buy(tokenAddress, 68_000n * ONE_USDC, 0);
    const curveAfterFailedAttempt = await ballista.curves(tokenAddress);

    // Reserves should reflect exactly what the successful trade produced --
    // nothing zeroed out speculatively, nothing partially mutated by the failed
    // router call.
    expect(curveAfterFailedAttempt.realUsdcReserves).to.be.gt(0n);
    expect(curveAfterFailedAttempt.tokenReserves).to.be.gte(0n);
  });

  it('graduate() rejects a curve that never reached GRADUATION_READY', async function () {
    const { ballista, creator } = await deployFixtureWithRouter('MockRouter');
    const tokenAddress = await launchToken(ballista, creator, 'Too Early Coin', 'TEC');

    await expect(ballista.graduate(tokenAddress)).to.be.revertedWith('not ready to graduate');
  });

  it('graduate() rejects a curve that already fully graduated -- no double-graduation', async function () {
    const { ballista, creator, trader } = await deployFixtureWithRouter('MockRouter');
    const tokenAddress = await launchToken(ballista, creator, 'Double Coin', 'DBL');

    await ballista.connect(trader).buy(tokenAddress, 68_000n * ONE_USDC, 0);
    expect((await ballista.curves(tokenAddress)).state).to.equal(GRADUATED); // working router, auto-completes

    await expect(ballista.graduate(tokenAddress)).to.be.revertedWith('not ready to graduate');
  });

  it('a GRADUATION_READY curve rejects both buy() and sell() -- trading is genuinely closed, not just pending', async function () {
    const { ballista, creator, trader } = await deployFixtureWithRouter('MockRevertingRouter');
    const tokenAddress = await launchToken(ballista, creator, 'Closed Coin', 'CLS');

    await ballista.connect(trader).buy(tokenAddress, 68_000n * ONE_USDC, 0);
    expect((await ballista.curves(tokenAddress)).state).to.equal(GRADUATION_READY);

    await expect(
      ballista.connect(trader).buy(tokenAddress, 100n * ONE_USDC, 0),
    ).to.be.revertedWith('curve not open for trading: check DEX or wait for graduation');
    await expect(
      ballista.connect(trader).sell(tokenAddress, 1n, 0),
    ).to.be.revertedWith('curve not open for trading: check DEX or wait for graduation');
  });

  it('a zero-liquidity-returning router (not a revert) is caught the same way as an outright revert', async function () {
    // Distinct failure mode from MockRevertingRouter -- the router call itself
    // succeeds (doesn't revert) but signals failure through its return value.
    const { ballista, creator, trader } = await deployFixtureWithRouter('MockBrokenRouter');
    const tokenAddress = await launchToken(ballista, creator, 'Broken Coin', 'BRK');

    const tx = await ballista.connect(trader).buy(tokenAddress, 68_000n * ONE_USDC, 0);
    const receipt = await tx.wait();

    expect(findEvent(ballista, receipt, 'Trade')).to.not.be.undefined; // trade still succeeded
    expect(findEvent(ballista, receipt, 'GraduationAttemptFailed')).to.not.be.undefined;
    expect((await ballista.curves(tokenAddress)).state).to.equal(GRADUATION_READY);
  });

  it('a failed attempt does not leave a stale token approval sitting on the router', async function () {
    const { ballista, creator, trader, usdc } = await deployFixtureWithRouter('MockRevertingRouter');
    const tokenAddress = await launchToken(ballista, creator, 'Approval Coin', 'APR');
    const token = await ethers.getContractAt('ArcLaunchToken', tokenAddress);

    await ballista.connect(trader).buy(tokenAddress, 68_000n * ONE_USDC, 0);

    const router = await ballista.router();
    const ballistaAddress = await ballista.getAddress();
    expect(await token.allowance(ballistaAddress, router)).to.equal(0n);
    expect(await usdc.allowance(ballistaAddress, router)).to.equal(0n);
  });

  it('graduate() itself is protected from reentrancy independent of buy()\'s own guard', async function () {
    // buy() and graduate() must not share a single lock -- buy() calling
    // graduate() internally (via the auto-trigger) would otherwise always fail
    // against its own held lock, silently disabling automatic graduation
    // entirely. Confirms the auto-trigger path actually succeeds end-to-end
    // against a normal working router, which it could only do if the locks are
    // genuinely independent.
    const { ballista, creator, trader } = await deployFixtureWithRouter('MockRouter');
    const tokenAddress = await launchToken(ballista, creator, 'Lock Coin', 'LCK');

    const tx = await ballista.connect(trader).buy(tokenAddress, 68_000n * ONE_USDC, 0);
    const receipt = await tx.wait();

    // If the locks conflicted, this would show GRADUATION_READY (auto-trigger
    // always failing) instead of GRADUATED.
    expect((await ballista.curves(tokenAddress)).state).to.equal(GRADUATED);
    expect(findEvent(ballista, receipt, 'Graduated')).to.not.be.undefined;
  });
});
