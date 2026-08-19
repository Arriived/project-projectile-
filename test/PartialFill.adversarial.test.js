const { expect } = require('chai');
const { ethers } = require('hardhat');

const ONE_USDC = 1_000_000n;

describe('Ballista — partial-fill adversarial testing', function () {
  async function deployFixture() {
    const [deployer, treasury, creator, trader, griefer, other] = await ethers.getSigners();

    const USDC = await ethers.getContractFactory('MockUSDC');
    const usdc = await USDC.deploy();

    const Ballista = await ethers.getContractFactory('Ballista');
    const ballista = await Ballista.deploy(await usdc.getAddress(), treasury.address);
    const ballistaAddress = await ballista.getAddress();

    const Router = await ethers.getContractFactory('MockRouter');
    const router = await Router.deploy();
    await ballista.setRouter(await router.getAddress());

    // These tests are about steady-state curve economics, not sniping, and they trade
    // immediately after launch -- which in production is squarely inside the snipe
    // window. Publishing an empty table disables the tax for this fixture so those
    // trades model normal post-window trading. The tax has its own suite in
    // test/SnipeTax.test.js.
    await ballista.publishSnipeTaxTable([]);

    for (const signer of [creator, trader, griefer, other]) {
      await usdc.mint(signer.address, 20_000_000n * ONE_USDC);
      await usdc.connect(signer).approve(ballistaAddress, ethers.MaxUint256);
    }

    return { deployer, treasury, creator, trader, griefer, other, usdc, ballista, ballistaAddress };
  }

  async function launchToken(ballista, creator, name, symbol, signersToApprove) {
    const expectedHash = await ballista.currentEconomicsHash();
    const createTx = await ballista.connect(creator).createToken(name, symbol, 'ipfs://a', expectedHash);
    const receipt = await createTx.wait();
    const event = receipt.logs
      .map((l) => { try { return ballista.interface.parseLog(l); } catch { return null; } })
      .find((l) => l && l.name === 'TokenCreated');
    const tokenAddress = event.args.token;
    const token = await ethers.getContractAt('ArcLaunchToken', tokenAddress);

    const ballistaAddress = await ballista.getAddress();
    for (const signer of signersToApprove) {
      await token.connect(signer).approve(ballistaAddress, ethers.MaxUint256);
    }

    return { tokenAddress, token };
  }

  function findEvent(ballista, receipt, name) {
    return receipt.logs
      .map((l) => { try { return ballista.interface.parseLog(l); } catch { return null; } })
      .find((l) => l && l.name === name);
  }

  it('THE ACTUAL BUG: a small front-run purchase no longer reverts the large buy behind it', async function () {
    const { ballista, creator, trader, griefer } = await deployFixture();
    await ballista.setDefaultGraduationThreshold(10_000_000n * ONE_USDC);
    const { tokenAddress } = await launchToken(ballista, creator, 'Adversary Coin', 'ADV', [trader, griefer]);

    await ballista.connect(trader).buy(tokenAddress, 80_000n * ONE_USDC, 0);
    const remaining = (await ballista.curves(tokenAddress)).tokenReserves;
    expect(remaining).to.be.gt(0n);

    await ballista.connect(griefer).buy(tokenAddress, 500n * ONE_USDC, 0);
    const curveAfterGrief = await ballista.curves(tokenAddress);
    expect(curveAfterGrief.tokenReserves).to.be.lt(remaining);
    if (curveAfterGrief.state !== 0n) return;

    const oversizedRequest = 500_000n * ONE_USDC;
    const usdcContract = await ethers.getContractAt('MockUSDC', await ballista.usdc());
    const traderBalanceBefore = await usdcContract.balanceOf(trader.address);

    const tx = await ballista.connect(trader).buy(tokenAddress, oversizedRequest, 0);
    const receipt = await tx.wait();
    const tradeEvent = findEvent(ballista, receipt, 'Trade');

    expect(tradeEvent.args.tokenAmount).to.equal(curveAfterGrief.tokenReserves);

    const finalCurve = await ballista.curves(tokenAddress);
    expect(finalCurve.tokenReserves).to.equal(0n);
    expect(tradeEvent.args.usdcAmount).to.be.lt(oversizedRequest);

    const traderBalanceAfter = await usdcContract.balanceOf(trader.address);
    expect(traderBalanceBefore - traderBalanceAfter).to.equal(tradeEvent.args.usdcAmount);
  });

  it('ISOLATED: the clamp fires purely from token-supply exhaustion, independent of graduation', async function () {
    const { ballista, creator, trader, griefer } = await deployFixture();
    await ballista.setDefaultGraduationThreshold(10_000_000n * ONE_USDC);
    const { tokenAddress } = await launchToken(ballista, creator, 'Isolated Coin', 'ISO', [trader, griefer]);

    await ballista.connect(trader).buy(tokenAddress, 80_000n * ONE_USDC, 0);
    const remaining = (await ballista.curves(tokenAddress)).tokenReserves;
    expect(remaining).to.be.gt(0n);

    await ballista.connect(griefer).buy(tokenAddress, 500n * ONE_USDC, 0);
    const curveAfterGrief = await ballista.curves(tokenAddress);
    expect(curveAfterGrief.state).to.equal(0n); // ACTIVE

    const tx = await ballista.connect(trader).buy(tokenAddress, 500_000n * ONE_USDC, 0);
    const tradeEvent = findEvent(ballista, await tx.wait(), 'Trade');

    expect(tradeEvent.args.tokenAmount).to.equal(curveAfterGrief.tokenReserves);
    const finalCurve = await ballista.curves(tokenAddress);
    expect(finalCurve.tokenReserves).to.equal(0n);
    expect(finalCurve.state).to.equal(0n); // ACTIVE
  });

  it('the excess is never pulled at all -- not pulled-then-refunded, simply never taken', async function () {
    const { ballista, creator, trader } = await deployFixture();
    await ballista.setDefaultGraduationThreshold(10_000_000n * ONE_USDC);
    const { tokenAddress } = await launchToken(ballista, creator, 'Excess Coin', 'EXC', [trader]);
    const usdcContract = await ethers.getContractAt('MockUSDC', await ballista.usdc());

    await ballista.connect(trader).buy(tokenAddress, 80_000n * ONE_USDC, 0);
    const remainingBefore = (await ballista.curves(tokenAddress)).tokenReserves;

    const balanceBefore = await usdcContract.balanceOf(trader.address);
    const massivelyOversized = 50_000_000n * ONE_USDC;
    const tx = await ballista.connect(trader).buy(tokenAddress, massivelyOversized, 0);
    const receipt = await tx.wait();
    const balanceAfter = await usdcContract.balanceOf(trader.address);

    const actuallySpent = balanceBefore - balanceAfter;
    expect(actuallySpent).to.be.lt(massivelyOversized / 1000n);

    const tradeEvent = findEvent(ballista, receipt, 'Trade');
    expect(tradeEvent.args.tokenAmount).to.equal(remainingBefore);
  });

  it('clamped price cannot be manipulated by offering more than needed', async function () {
    const fixtureA = await deployFixture();
    const fixtureB = await deployFixture();
    await fixtureA.ballista.setDefaultGraduationThreshold(10_000_000n * ONE_USDC);
    await fixtureB.ballista.setDefaultGraduationThreshold(10_000_000n * ONE_USDC);

    const a = await launchToken(fixtureA.ballista, fixtureA.creator, 'Coin A', 'CA', [fixtureA.trader, fixtureA.other]);
    const b = await launchToken(fixtureB.ballista, fixtureB.creator, 'Coin B', 'CB', [fixtureB.trader, fixtureB.other]);

    await fixtureA.ballista.connect(fixtureA.trader).buy(a.tokenAddress, 80_000n * ONE_USDC, 0);
    await fixtureB.ballista.connect(fixtureB.trader).buy(b.tokenAddress, 80_000n * ONE_USDC, 0);

    const remainingA = (await fixtureA.ballista.curves(a.tokenAddress)).tokenReserves;
    const remainingB = (await fixtureB.ballista.curves(b.tokenAddress)).tokenReserves;
    expect(remainingA).to.equal(remainingB);

    const txA = await fixtureA.ballista.connect(fixtureA.other).buy(a.tokenAddress, 200_000n * ONE_USDC, 0);
    const txB = await fixtureB.ballista.connect(fixtureB.other).buy(b.tokenAddress, 15_000_000n * ONE_USDC, 0);

    const eventA = findEvent(fixtureA.ballista, await txA.wait(), 'Trade');
    const eventB = findEvent(fixtureB.ballista, await txB.wait(), 'Trade');

    expect(eventA.args.tokenAmount).to.equal(eventB.args.tokenAmount);
    expect(eventA.args.usdcAmount).to.equal(eventB.args.usdcAmount);
  });

  it("slippage protection still applies to a clamped fill -- the buyer's own floor is not silently overridden", async function () {
    const { ballista, creator, trader, griefer } = await deployFixture();
    await ballista.setDefaultGraduationThreshold(10_000_000n * ONE_USDC);
    const { tokenAddress } = await launchToken(ballista, creator, 'Slippage Coin', 'SLP', [trader, griefer]);

    await ballista.connect(trader).buy(tokenAddress, 80_000n * ONE_USDC, 0);
    await ballista.connect(griefer).buy(tokenAddress, 500n * ONE_USDC, 0);
    const remainingAfterGrief = (await ballista.curves(tokenAddress)).tokenReserves;

    const impossibleMinimum = remainingAfterGrief + 1n;
    await expect(
      ballista.connect(trader).buy(tokenAddress, 500_000n * ONE_USDC, impossibleMinimum),
    ).to.be.revertedWith('slippage exceeded');
  });

  it('a fully depleted curve treats a further buy as a harmless zero-fill when minTokensOut is 0, but rejects it the moment a real floor is set', async function () {
    const { ballista, creator, trader, griefer } = await deployFixture();
    await ballista.setDefaultGraduationThreshold(10_000_000n * ONE_USDC);
    const { tokenAddress } = await launchToken(ballista, creator, 'Depleted Coin', 'DEP', [trader, griefer]);

    await ballista.connect(trader).buy(tokenAddress, 80_000n * ONE_USDC, 0);
    await ballista.connect(griefer).buy(tokenAddress, 500n * ONE_USDC, 0);
    await ballista.connect(trader).buy(tokenAddress, 10_000_000n * ONE_USDC, 0);
    expect((await ballista.curves(tokenAddress)).tokenReserves).to.equal(0n);

    const usdcContract = await ethers.getContractAt('MockUSDC', await ballista.usdc());
    const balanceBefore = await usdcContract.balanceOf(trader.address);

    await expect(ballista.connect(trader).buy(tokenAddress, 100n * ONE_USDC, 0)).to.not.be.reverted;
    expect(await usdcContract.balanceOf(trader.address)).to.equal(balanceBefore);

    await expect(
      ballista.connect(trader).buy(tokenAddress, 100n * ONE_USDC, 1),
    ).to.be.revertedWith('slippage exceeded');
  });

  it('a clamped buy that also crosses the graduation threshold graduates correctly, in the same transaction', async function () {
    const { ballista, creator, trader, griefer } = await deployFixture();
    const { tokenAddress } = await launchToken(ballista, creator, 'Graduating Coin', 'GRD', [trader, griefer]);

    await ballista.connect(trader).buy(tokenAddress, 60_000n * ONE_USDC, 0);
    let curve = await ballista.curves(tokenAddress);
    if (curve.state !== 0n) return;

    await ballista.connect(griefer).buy(tokenAddress, 200n * ONE_USDC, 0);
    await ballista.connect(trader).buy(tokenAddress, 200_000n * ONE_USDC, 0);

    const finalCurve = await ballista.curves(tokenAddress);
    expect(finalCurve.state).to.equal(2n); // GRADUATED
    expect(finalCurve.tokenReserves).to.equal(0n);
  });

  describe('sell-side clamp — is it actually reachable?', function () {
    it('a single buyer round-tripping their own exact position never triggers the clamp (expected, not a bug)', async function () {
      const { ballista, creator, trader } = await deployFixture();
      const { tokenAddress, token } = await launchToken(ballista, creator, 'RoundTrip Coin', 'RTC', [trader]);

      await ballista.connect(trader).buy(tokenAddress, 1_000n * ONE_USDC, 0);
      const tokensHeld = await token.balanceOf(trader.address);

      const tx = await ballista.connect(trader).sell(tokenAddress, tokensHeld, 0);
      const tradeEvent = findEvent(ballista, await tx.wait(), 'Trade');

      expect(tradeEvent.args.tokenAmount).to.equal(tokensHeld);
      expect(await token.balanceOf(trader.address)).to.equal(0n);
    });

    it('ADVERSARIAL: multiple buyers at different curve positions, then everyone sells, largest holder first', async function () {
      const { ballista, creator, trader, griefer, other } = await deployFixture();
      await ballista.setDefaultGraduationThreshold(10_000_000n * ONE_USDC);
      const { tokenAddress, token } = await launchToken(ballista, creator, 'Multi Coin', 'MLT', [trader, griefer, other]);

      await ballista.connect(trader).buy(tokenAddress, 50_000n * ONE_USDC, 0);
      await ballista.connect(griefer).buy(tokenAddress, 30_000n * ONE_USDC, 0);
      await ballista.connect(other).buy(tokenAddress, 10_000n * ONE_USDC, 0);

      const curveBefore = await ballista.curves(tokenAddress);
      expect(curveBefore.realUsdcReserves).to.be.gt(0n);

      const tradersInOrder = [trader, griefer, other];
      for (const signer of tradersInOrder) {
        const held = await token.balanceOf(signer.address);
        if (held === 0n) continue;
        const tx = await ballista.connect(signer).sell(tokenAddress, held, 0);
        const tradeEvent = findEvent(ballista, await tx.wait(), 'Trade');
        expect(tradeEvent.args.tokenAmount).to.be.lte(held);
      }

      const finalCurve = await ballista.curves(tokenAddress);
      // If the clamp path is genuinely unreachable here, realUsdcReserves
      // lands at (at most) a few wei of dust -- ceiling rounding is
      // deliberately biased toward the curve on every trade, so a few wei
      // of residue after 6 trades is expected, not a sign of a problem.
      // What matters is it's not LARGE, and every sell() call above
      // succeeded rather than reverting or under-filling.
      expect(finalCurve.realUsdcReserves).to.be.lte(10n);
    });
  });

  it('STRESS: repeated irregular buys down to full depletion never break an invariant, at a punishing 10% fee', async function () {
    const { creator, ballista, usdc } = await deployFixture();
    await ballista.setDefaultGraduationThreshold(10_000_000n * ONE_USDC);
    await ballista.setDefaultFees(1000, 1000);
    await ballista.setLaunchCooldown(0);

    const [, , , trader] = await ethers.getSigners();
    const { tokenAddress } = await launchToken(ballista, creator, 'Stress Coin', 'STR', [trader]);
    await usdc.mint(trader.address, 100_000_000n * ONE_USDC);
    await usdc.connect(trader).approve(await ballista.getAddress(), ethers.MaxUint256);

    let lastPrice = 0n;
    for (let i = 0; i < 60; i++) {
      const curveBefore = await ballista.curves(tokenAddress);
      if (curveBefore.tokenReserves === 0n) break;

      const amount = (BigInt(i) * 3_333n + 777n) * ONE_USDC;

      const tx = await ballista.connect(trader).buy(tokenAddress, amount, 0);
      const tradeEvent = findEvent(ballista, await tx.wait(), 'Trade');
      const curveAfter = await ballista.curves(tokenAddress);

      expect(tradeEvent.args.usdcAmount).to.be.lte(amount);

      if (curveAfter.tokenReserves > 0n) {
        const price = await ballista.currentPrice(tokenAddress);
        expect(price).to.be.gte(lastPrice);
        lastPrice = price;
      }
    }

    expect((await ballista.curves(tokenAddress)).tokenReserves).to.equal(0n);
  });
});
