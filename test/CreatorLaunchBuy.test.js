const { expect } = require('chai');
const { ethers } = require('hardhat');
const { activateRouter } = require('./routerHelper');

const ONE = 1_000_000n;
const BPS = 10_000n;
const CURVE_SUPPLY = 807_000_000n * 10n ** 18n;

describe('Ballista — creator launch buy (block 0)', function () {
  async function env() {
    const [deployer, treasury, creator, sniper, other] = await ethers.getSigners();
    const usdc = await (await ethers.getContractFactory('MockUSDC')).deploy();
    const ballista = await (await ethers.getContractFactory('Ballista'))
      .deploy(await usdc.getAddress(), treasury.address);
    const router = await (await ethers.getContractFactory('MockRouter')).deploy();
    await activateRouter(ballista, await router.getAddress());
    await ballista.setLaunchCooldown(0);
    for (const s of [creator, sniper, other]) {
      await usdc.mint(s.address, 5_000_000n * ONE);
      await usdc.connect(s).approve(await ballista.getAddress(), ethers.MaxUint256);
    }
    return { deployer, treasury, creator, sniper, other, usdc, ballista };
  }

  // createToken and creatorLaunchBuy must land in the SAME block, so automine is
  // disabled and both are mined together. This is exactly what a creator's own
  // frontend would do with a multicall or a bundled transaction.
  async function launchAndBuyInSameBlock(ballista, creator, symbol, buys) {
    await ethers.provider.send('evm_setAutomine', [false]);
    const hash = await ballista.currentEconomicsHash();
    const createTx = await ballista.connect(creator)
      .createToken('Launch', symbol, 'ipfs://a', hash);

    // The token address is deterministic from the factory nonce, so it can be
    // predicted and bought in the same block without waiting for the receipt.
    const nonce = await ethers.provider.getTransactionCount(await ballista.getAddress());
    const tokenAddress = ethers.getCreateAddress({
      from: await ballista.getAddress(), nonce,
    });

    const txs = [];
    for (const amount of buys) {
      txs.push(await ballista.connect(creator).creatorLaunchBuy(tokenAddress, amount, 0));
    }
    await ethers.provider.send('evm_mine');
    await ethers.provider.send('evm_setAutomine', [true]);

    const createRc = await createTx.wait();
    const results = [];
    for (const t of txs) {
      results.push(await ethers.provider.getTransactionReceipt(t.hash));
    }
    return { tokenAddress, createRc, results };
  }

  it('the cap is snapshotted and pinned by the economics hash', async function () {
    const { ballista, creator } = await env();
    expect(await ballista.maxCreatorLaunchBps()).to.equal(250);

    const stale = await ballista.currentEconomicsHash();
    await ballista.setMaxCreatorLaunchBps(500);
    await expect(
      ballista.connect(creator).createToken('Late', 'LATE', 'u', stale)
    ).to.be.revertedWith(
      'economics changed since you last checked -- refresh and confirm the new terms'
    );
  });

  it('a live token keeps the cap it launched with', async function () {
    const { ballista, creator } = await env();
    const hash = await ballista.currentEconomicsHash();
    const rc = await (await ballista.connect(creator)
      .createToken('Pinned', 'PIN', 'u', hash)).wait();
    const t = rc.logs.map((l) => { try { return ballista.interface.parseLog(l); } catch { return null; } })
      .find((l) => l && l.name === 'TokenCreated').args.token;

    expect((await ballista.curves(t)).maxCreatorLaunchBps).to.equal(250);
    await ballista.setMaxCreatorLaunchBps(1000);
    expect((await ballista.curves(t)).maxCreatorLaunchBps).to.equal(250);
  });

  it('a non-creator cannot use the privileged path at all', async function () {
    const { ballista, creator, sniper } = await env();
    const hash = await ballista.currentEconomicsHash();
    const rc = await (await ballista.connect(creator)
      .createToken('Guard', 'GRD', 'u', hash)).wait();
    const t = rc.logs.map((l) => { try { return ballista.interface.parseLog(l); } catch { return null; } })
      .find((l) => l && l.name === 'TokenCreated').args.token;

    await expect(ballista.connect(sniper).creatorLaunchBuy(t, ONE, 0)).to.be.revertedWith(
      "only the token's creator may buy at launch"
    );
  });

  it('the creator is rejected on the privileged path from block 1 onward', async function () {
    const { ballista, creator } = await env();
    const hash = await ballista.currentEconomicsHash();
    const rc = await (await ballista.connect(creator)
      .createToken('Late', 'LTE', 'u', hash)).wait();
    const t = rc.logs.map((l) => { try { return ballista.interface.parseLog(l); } catch { return null; } })
      .find((l) => l && l.name === 'TokenCreated').args.token;

    // The receipt means the creation block is already behind us.
    await expect(ballista.connect(creator).creatorLaunchBuy(t, ONE, 0)).to.be.revertedWith(
      'creator launch buy is block 0 only -- use buy() from the next block'
    );
    // ...and the ordinary path works from here, like anyone else.
    await expect(ballista.connect(creator).buy(t, ONE, 0)).to.not.be.reverted;
  });

  it('works in block 0 and reports the percentage bought', async function () {
    const { ballista, creator } = await env();
    const { tokenAddress, results } = await launchAndBuyInSameBlock(
      ballista, creator, 'OK', [50n * ONE]
    );
    expect(results[0].status).to.equal(1);

    const evt = results[0].logs
      .map((l) => { try { return ballista.interface.parseLog(l); } catch { return null; } })
      .find((l) => l && l.name === 'CreatorLaunchBuy');
    expect(evt, 'CreatorLaunchBuy must fire').to.not.be.undefined;

    const token = await ethers.getContractAt('ArcLaunchToken', tokenAddress);
    const held = await token.balanceOf(creator.address);
    expect(evt.args.tokensReceived).to.equal(held);
    // The reported bps must match the tokens actually received.
    expect(evt.args.bpsOfCurveSupply).to.equal((held * BPS) / CURVE_SUPPLY);
    console.log(`        creator bought ${(Number(evt.args.bpsOfCurveSupply) / 100).toFixed(2)}% ` +
                `of curve supply for ${ethers.formatUnits(evt.args.usdcSpent, 6)} USDC`);
  });

  it('is EXEMPT from the snipe tax, unlike an identical block-1 buy', async function () {
    const { ballista, creator, sniper } = await env();
    // Default table is live: 9800 bps at t=0.
    const { tokenAddress, results } = await launchAndBuyInSameBlock(
      ballista, creator, 'TAXF', [50n * ONE]
    );
    const rc = results[0];
    const taxEvents = rc.logs
      .map((l) => { try { return ballista.interface.parseLog(l); } catch { return null; } })
      .filter((l) => l && l.name === 'SnipeTaxCollected');
    expect(taxEvents.length, 'no snipe tax on the creator launch path').to.equal(0);

    const trade = rc.logs
      .map((l) => { try { return ballista.interface.parseLog(l); } catch { return null; } })
      .find((l) => l && l.name === 'Trade');
    // Only the 1% base fee came out, not 1% + 98%.
    const curve = await ballista.curves(tokenAddress);
    expect(curve.realUsdcReserves).to.be.greaterThan((50n * ONE * 98n) / 100n);
  });

  describe('THE CAP', function () {
    it('EXPLOIT ATTEMPT: loop the privileged buy many times inside ONE block', async function () {
      const { ballista, usdc, creator } = await env();
      const CL = await ethers.getContractFactory('CreatorLauncher');
      const cl = await CL.deploy(await ballista.getAddress(), await usdc.getAddress());
      await usdc.mint(await cl.getAddress(), 1_000_000n * ONE);
      await cl.approveAll();

      // Ten buys, each individually large enough to reach the 2.5% cap on its own.
      // Under a PER-TRANSACTION cap this yields ~37% of curve supply for a few
      // hundred dollars. Under a cumulative cap it must stop at 2.5% exactly.
      await cl.launchAndLoop('LOOP', 200n * ONE, 10);
      const tokenAddress = await cl.token();

      const token = await ethers.getContractAt('ArcLaunchToken', tokenAddress);
      const held = await token.balanceOf(await cl.getAddress());
      const curve = await ballista.curves(tokenAddress);

      const heldBps = (held * BPS) / CURVE_SUPPLY;
      console.log(`        looped 10 buys in one block -> ${(Number(heldBps) / 100).toFixed(3)}% of curve supply`);

      expect(curve.creatorLaunchPurchased).to.equal(held);
      expect(heldBps).to.be.lessThanOrEqual(250n);
      expect(curve.creatorLaunchPurchased * BPS / CURVE_SUPPLY).to.be.lessThanOrEqual(250n);
    });

    it('the cap accumulates across separate transactions in the same block', async function () {
      const { ballista, creator } = await env();
      const { tokenAddress, results } = await launchAndBuyInSameBlock(
        ballista, creator, 'CUM', [100n * ONE, 100n * ONE, 100n * ONE, 100n * ONE]
      );
      const succeeded = results.filter((r) => r.status === 1).length;
      expect(succeeded, 'at least one buy should land').to.be.greaterThan(0);

      const curve = await ballista.curves(tokenAddress);
      const cap = (CURVE_SUPPLY * 250n) / BPS;
      expect(curve.creatorLaunchPurchased).to.be.lessThanOrEqual(cap);

      const token = await ethers.getContractAt('ArcLaunchToken', tokenAddress);
      expect(await token.balanceOf(creator.address)).to.equal(curve.creatorLaunchPurchased);
    });

    it('CLAMPS rather than reverting when the creator asks for more than the cap', async function () {
      const { ballista, creator, usdc } = await env();
      const before = await usdc.balanceOf(creator.address);
      // Vastly more than the cap allows -- must fill to the cap and take only what
      // that actually cost, never pulling the excess.
      const { tokenAddress, results } = await launchAndBuyInSameBlock(
        ballista, creator, 'CLMP', [500_000n * ONE]
      );
      expect(results[0].status).to.equal(1);

      const curve = await ballista.curves(tokenAddress);
      const cap = (CURVE_SUPPLY * 250n) / BPS;
      expect(curve.creatorLaunchPurchased).to.equal(cap);

      const spent = before - (await usdc.balanceOf(creator.address));
      expect(spent).to.be.lessThan(500_000n * ONE);
      console.log(`        clamped to exactly 2.5% for ${ethers.formatUnits(spent, 6)} USDC`);
    });

    it('CLAMP PATH AT THE EXEMPT FEE: the fee inversion denominator is exercised, not assumed', async function () {
      const { ballista, creator } = await env();
      // Base fee at its ceiling. The clamp inverts fees with
      // _ceilDiv(x * BPS, BPS - feeBps); with the snipe tax exempted that denominator
      // is BPS - 1000 here rather than BPS - (1000 + tax). This forces that exact path.
      // The default 9800 bps table cannot coexist with a 1000 bps base fee under
      // MAX_TOTAL_FEE_BPS, and createToken enforces that. Publish an empty table first;
      // the creator path is tax-exempt regardless, and the base fee is what this test
      // is about.
      await ballista.publishSnipeTaxTable([]);
      await ballista.setDefaultFees(1000, 1000);
      const { tokenAddress, results } = await launchAndBuyInSameBlock(
        ballista, creator, 'FEEC', [500_000n * ONE]
      );
      expect(results[0].status, 'clamped buy at max base fee must not revert').to.equal(1);

      const curve = await ballista.curves(tokenAddress);
      expect(curve.creatorLaunchPurchased).to.equal((CURVE_SUPPLY * 250n) / BPS);
    });

    it('a second call after the cap is used up reverts cleanly', async function () {
      const { ballista, creator } = await env();
      const { tokenAddress, results } = await launchAndBuyInSameBlock(
        ballista, creator, 'USED', [500_000n * ONE, 10n * ONE]
      );
      expect(results[0].status).to.equal(1);
      expect(results[1].status, 'second call must fail once the cap is exhausted').to.equal(0);
      const cap = (CURVE_SUPPLY * 250n) / BPS;
      expect((await ballista.curves(tokenAddress)).creatorLaunchPurchased).to.equal(cap);
    });

    it('a raised cap applies only to tokens launched after the change', async function () {
      const { ballista, creator } = await env();
      await ballista.setMaxCreatorLaunchBps(1000); // 10%
      const { tokenAddress, results } = await launchAndBuyInSameBlock(
        ballista, creator, 'BIG', [500_000n * ONE]
      );
      expect(results[0].status).to.equal(1);
      const curve = await ballista.curves(tokenAddress);
      expect(curve.maxCreatorLaunchBps).to.equal(1000);
      expect(curve.creatorLaunchPurchased).to.equal((CURVE_SUPPLY * 1000n) / BPS);
    });

    it('only the owner can move the cap', async function () {
      const { ballista, creator } = await env();
      await expect(ballista.connect(creator).setMaxCreatorLaunchBps(500)).to.be.reverted;
      await expect(ballista.setMaxCreatorLaunchBps(10_001)).to.be.revertedWith(
        'cap cannot exceed 100% of curve supply'
      );
    });
  });
});
