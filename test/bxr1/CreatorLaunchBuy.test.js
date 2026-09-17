const { expect } = require('chai');
const { ethers } = require('hardhat');
const { activateRouter } = require('../routerHelper');
const { deployRegistryWithAsset, getBXR1Factory } = require('./assetRegistryHelper');

const ONE = 1_000_000n;
const BPS = 10_000n;
const CURVE_SUPPLY = 807_000_000n * 10n ** 18n;

describe('Ballista — creator launch buy (timed window)', function () {
  async function env() {
    const [deployer, treasury, creator, sniper, other] = await ethers.getSigners();
    const usdc = await (await ethers.getContractFactory('MockUSDC')).deploy();
    const registry = await deployRegistryWithAsset(await usdc.getAddress());
    const ballista = await (await getBXR1Factory())
      .deploy(await registry.getAddress(), treasury.address, ethers.ZeroAddress);
    const router = await (await ethers.getContractFactory('MockRouter')).deploy();
    await activateRouter(ballista, await router.getAddress());
    await ballista.setLaunchCooldown(0);
    for (const s of [creator, sniper, other]) {
      await usdc.mint(s.address, 5_000_000n * ONE);
      await usdc.connect(s).approve(await ballista.getAddress(), ethers.MaxUint256);
    }
    return { deployer, treasury, creator, sniper, other, usdc, registry, ballista };
  }

  // createToken and creatorLaunchBuy must land in the SAME block, so automine is
  // disabled and both are mined together. This is exactly what a creator's own
  // frontend would do with a multicall or a bundled transaction.
  async function launchAndBuyInSameBlock(ballista, usdc, creator, symbol, buys) {
    await ethers.provider.send('evm_setAutomine', [false]);
    const hash = await ballista.currentEconomicsHash(await usdc.getAddress());
    const createTx = await ballista.connect(creator)
      .createToken('Launch', symbol, 'ipfs://a', await usdc.getAddress(), hash, false);

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
    const { ballista, usdc, creator } = await env();
    expect(await ballista.maxCreatorLaunchBps()).to.equal(250);

    const stale = await ballista.currentEconomicsHash(await usdc.getAddress());
    await ballista.setMaxCreatorLaunchBps(500);
    await expect(
      ballista.connect(creator).createToken('Late', 'LATE', 'u', await usdc.getAddress(), stale, false)
    ).to.be.revertedWithCustomError(ballista, 'EconomicsChanged'
    );
  });

  it('a live token keeps the cap it launched with', async function () {
    const { ballista, usdc, creator } = await env();
    const hash = await ballista.currentEconomicsHash(await usdc.getAddress());
    const rc = await (await ballista.connect(creator)
      .createToken('Pinned', 'PIN', 'u', await usdc.getAddress(), hash, false)).wait();
    const t = rc.logs.map((l) => { try { return ballista.interface.parseLog(l); } catch { return null; } })
      .find((l) => l && l.name === 'TokenCreated').args.token;

    expect((await ballista.curves(t)).maxCreatorLaunchBps).to.equal(250);
    await ballista.setMaxCreatorLaunchBps(1000);
    expect((await ballista.curves(t)).maxCreatorLaunchBps).to.equal(250);
  });

  it('a non-creator cannot use the privileged path at all', async function () {
    const { ballista, usdc, creator, sniper } = await env();
    const hash = await ballista.currentEconomicsHash(await usdc.getAddress());
    const rc = await (await ballista.connect(creator)
      .createToken('Guard', 'GRD', 'u', await usdc.getAddress(), hash, false)).wait();
    const t = rc.logs.map((l) => { try { return ballista.interface.parseLog(l); } catch { return null; } })
      .find((l) => l && l.name === 'TokenCreated').args.token;

    await expect(ballista.connect(sniper).creatorLaunchBuy(t, ONE, 0)).to.be.revertedWithCustomError(ballista, 'NotCreator'
    );
  });

  // THE REGRESSION TEST FOR OPEN ITEM 1. Under the old block.number == creationBlock
  // rule this was impossible from a plain wallet: two sequential transactions from one
  // EOA always land in consecutive blocks on Arc, so the creator could never reach
  // their own privileged path without a bundling contract.
  it('THE POINT: a plain EOA creator reaches the privileged path in a LATER block', async function () {
    const { ballista, usdc, creator } = await env();
    const hash = await ballista.currentEconomicsHash(await usdc.getAddress());
    const rc = await (await ballista.connect(creator)
      .createToken('Eoa', 'EOA', 'u', await usdc.getAddress(), hash, false)).wait();
    const t = rc.logs.map((l) => { try { return ballista.interface.parseLog(l); } catch { return null; } })
      .find((l) => l && l.name === 'TokenCreated').args.token;

    // Pin the buy one second after creation. Without this the test depends on how
    // fast the machine runs: hardhat stamps blocks from the wall clock, so on a slow
    // run more than 3 real seconds elapse between these two transactions and the
    // window shuts for reasons that have nothing to do with the contract. Observed
    // failing exactly that way on a 43s suite run. One second is what Arc's 500ms
    // blocks actually produce between two sequential transactions from one wallet.
    const created = Number((await ballista.curves(t)).creationTimestamp);
    await ethers.provider.send('evm_setNextBlockTimestamp', [created + 1]);
    const buyRc = await (await ballista.connect(creator)
      .creatorLaunchBuy(t, 50n * ONE, 0)).wait();

    expect(buyRc.blockNumber, 'must be a strictly later block, like a real wallet')
      .to.be.greaterThan(rc.blockNumber);
    expect(buyRc.status).to.equal(1);
    expect((await ballista.curves(t)).creatorLaunchPurchased).to.be.greaterThan(0n);
  });

  it('the window closes on elapsed SECONDS, and the ordinary path still works after', async function () {
    const { ballista, usdc, creator } = await env();
    const hash = await ballista.currentEconomicsHash(await usdc.getAddress());
    const rc = await (await ballista.connect(creator)
      .createToken('Late', 'LTE', 'u', await usdc.getAddress(), hash, false)).wait();
    const t = rc.logs.map((l) => { try { return ballista.interface.parseLog(l); } catch { return null; } })
      .find((l) => l && l.name === 'TokenCreated').args.token;

    await ethers.provider.send('evm_increaseTime', [30]);
    await ethers.provider.send('evm_mine');

    await expect(ballista.connect(creator).creatorLaunchBuy(t, ONE, 0))
      .to.be.revertedWithCustomError(ballista, 'LaunchWindowClosed');
    await expect(ballista.connect(creator).buy(t, ONE, 0)).to.not.be.reverted;
  });

  it('the LAST second of the window is inclusive, the next one is not', async function () {
    const { ballista, usdc, creator } = await env();
    const hash = await ballista.currentEconomicsHash(await usdc.getAddress());
    const rc = await (await ballista.connect(creator)
      .createToken('Edge', 'EDG', 'u', await usdc.getAddress(), hash, false)).wait();
    const t = rc.logs.map((l) => { try { return ballista.interface.parseLog(l); } catch { return null; } })
      .find((l) => l && l.name === 'TokenCreated').args.token;
    const created = (await ballista.curves(t)).creationTimestamp;
    const window = (await ballista.curves(t)).creatorLaunchWindow;

    // Land exactly on creationTimestamp + window: still inside.
    await ethers.provider.send('evm_setNextBlockTimestamp', [Number(created + window)]);
    await expect(ballista.connect(creator).creatorLaunchBuy(t, ONE, 0)).to.not.be.reverted;

    // One second past it: outside.
    await ethers.provider.send('evm_setNextBlockTimestamp', [Number(created + window) + 1]);
    await expect(ballista.connect(creator).creatorLaunchBuy(t, ONE, 0))
      .to.be.revertedWithCustomError(ballista, 'LaunchWindowClosed');
  });

  // These two must separate the SNAPSHOT from the GLOBAL, not merely observe that the
  // struct field was written. Asserting curves(t).creatorLaunchWindow == 3 passes even
  // if the require reads the global -- found by mutating the contract to do exactly
  // that and watching this test stay green.
  it('the window is snapshotted -- narrowing the global cannot shorten a live token', async function () {
    const { ballista, usdc, creator } = await env();
    const hash = await ballista.currentEconomicsHash(await usdc.getAddress());
    const rc = await (await ballista.connect(creator)
      .createToken('Snap', 'SNP', 'u', await usdc.getAddress(), hash, false)).wait();
    const t = rc.logs.map((l) => { try { return ballista.interface.parseLog(l); } catch { return null; } })
      .find((l) => l && l.name === 'TokenCreated').args.token;
    const created = (await ballista.curves(t)).creationTimestamp;

    expect((await ballista.curves(t)).creatorLaunchWindow).to.equal(3);
    await ballista.setCreatorLaunchWindow(0);
    expect((await ballista.curves(t)).creatorLaunchWindow).to.equal(3);

    // Elapsed 2s: inside the snapshotted 3, outside the global 0. Only a contract
    // reading the snapshot lets this through.
    await ethers.provider.send('evm_setNextBlockTimestamp', [Number(created) + 2]);
    await expect(ballista.connect(creator).creatorLaunchBuy(t, ONE, 0)).to.not.be.reverted;
  });

  it('the window is snapshotted -- widening the global cannot lengthen a live token', async function () {
    const { ballista, usdc, creator } = await env();
    await ballista.setCreatorLaunchWindow(1);
    const hash = await ballista.currentEconomicsHash(await usdc.getAddress());
    const rc = await (await ballista.connect(creator)
      .createToken('Wide', 'WID', 'u', await usdc.getAddress(), hash, false)).wait();
    const t = rc.logs.map((l) => { try { return ballista.interface.parseLog(l); } catch { return null; } })
      .find((l) => l && l.name === 'TokenCreated').args.token;
    const created = (await ballista.curves(t)).creationTimestamp;

    await ballista.setCreatorLaunchWindow(600);
    expect((await ballista.curves(t)).creatorLaunchWindow).to.equal(1);

    // Elapsed 5s: outside the snapshotted 1, well inside the global 600. An owner
    // must not be able to reopen a closed window on a token already trading.
    await ethers.provider.send('evm_setNextBlockTimestamp', [Number(created) + 5]);
    await expect(ballista.connect(creator).creatorLaunchBuy(t, ONE, 0))
      .to.be.revertedWithCustomError(ballista, 'LaunchWindowClosed');
  });

  it('the window is pinned by the economics hash', async function () {
    const { ballista, usdc, creator } = await env();
    expect(await ballista.creatorLaunchWindow()).to.equal(3);

    const stale = await ballista.currentEconomicsHash(await usdc.getAddress());
    await ballista.setCreatorLaunchWindow(9);
    await expect(
      ballista.connect(creator).createToken('W', 'WIN', 'u', await usdc.getAddress(), stale, false)
    ).to.be.revertedWithCustomError(ballista, 'EconomicsChanged'
    );
  });

  it('only the owner can move the window', async function () {
    const { ballista, usdc, creator } = await env();
    await expect(ballista.connect(creator).setCreatorLaunchWindow(60)).to.be.reverted;
    await expect(ballista.setCreatorLaunchWindow(60)).to.emit(ballista, 'CreatorLaunchWindowSet');
  });

  // A zero window is same-SECOND, which is NOT the same as same-BLOCK. Arc targets
  // 500ms blocks, so two consecutive blocks routinely share a whole-second timestamp
  // (hardhat.config.js sets allowBlocksWithSameTimestamp to reproduce that). Anyone
  // reading "window 0" as "one block" would be wrong on the real chain.
  it('a zero window is same-SECOND, which still spans more than one block on Arc', async function () {
    const { ballista, usdc, creator } = await env();
    await ballista.setCreatorLaunchWindow(0);
    const hash = await ballista.currentEconomicsHash(await usdc.getAddress());
    const rc = await (await ballista.connect(creator)
      .createToken('Zero', 'ZRO', 'u', await usdc.getAddress(), hash, false)).wait();
    const t = rc.logs.map((l) => { try { return ballista.interface.parseLog(l); } catch { return null; } })
      .find((l) => l && l.name === 'TokenCreated').args.token;
    const created = (await ballista.curves(t)).creationTimestamp;

    // A LATER BLOCK carrying the SAME timestamp is still inside a zero window.
    await ethers.provider.send('evm_setNextBlockTimestamp', [Number(created)]);
    const buyRc = await (await ballista.connect(creator).creatorLaunchBuy(t, ONE, 0)).wait();
    expect(buyRc.blockNumber).to.be.greaterThan(rc.blockNumber);

    // The moment the second ticks over, it is shut.
    await ethers.provider.send('evm_setNextBlockTimestamp', [Number(created) + 1]);
    await expect(ballista.connect(creator).creatorLaunchBuy(t, ONE, 0))
      .to.be.revertedWithCustomError(ballista, 'LaunchWindowClosed');
  });

  it('works in block 0 and reports the percentage bought', async function () {
    const { ballista, usdc, creator } = await env();
    const { tokenAddress, results } = await launchAndBuyInSameBlock(
      ballista, usdc, creator, 'OK', [50n * ONE]
    );
    expect(results[0].status).to.equal(1);

    const evt = results[0].logs
      .map((l) => { try { return ballista.interface.parseLog(l); } catch { return null; } })
      .find((l) => l && l.name === 'CreatorLaunchBuy');
    expect(evt, 'CreatorLaunchBuy must fire').to.not.be.undefined;

    const token = await ethers.getContractAt('BXR1Token', tokenAddress);
    const held = await token.balanceOf(creator.address);
    expect(evt.args.tokensReceived).to.equal(held);
    // The reported bps must match the tokens actually received.
    expect(evt.args.bpsOfCurveSupply).to.equal((held * BPS) / CURVE_SUPPLY);
    console.log(`        creator bought ${(Number(evt.args.bpsOfCurveSupply) / 100).toFixed(2)}% ` +
                `of curve supply for ${ethers.formatUnits(evt.args.quoteSpent, 6)} USDC`);
  });

  it('is EXEMPT from the snipe tax, unlike an identical block-1 buy', async function () {
    const { ballista, usdc, creator, sniper } = await env();
    // Default table is live: 9800 bps at t=0.
    const { tokenAddress, results } = await launchAndBuyInSameBlock(
      ballista, usdc, creator, 'TAXF', [50n * ONE]
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
    expect(curve.realQuoteReserves).to.be.greaterThan((50n * ONE * 98n) / 100n);
  });

  describe('THE CAP', function () {
    it('EXPLOIT ATTEMPT: loop the privileged buy many times inside ONE block', async function () {
      const { ballista, usdc, creator } = await env();
      const CL = await ethers.getContractFactory('BXR1CreatorLauncher');
      const cl = await CL.deploy(await ballista.getAddress(), await usdc.getAddress());
      await usdc.mint(await cl.getAddress(), 1_000_000n * ONE);
      await cl.approveAll();

      // Each buy is individually well under the 2.5% cap (~8 USDC against the ~52 that
      // buys the whole thing), so reaching the cap requires ACCUMULATION. At 200 USDC
      // a call the first buy saturated the cap on its own and the rest bounced off the
      // "already used" guard -- which left this test green even against a per-call cap,
      // i.e. blind to the exact regression it exists to catch. Found by mutation.
      await cl.launchAndLoop('LOOP', 8n * ONE, 10);
      const tokenAddress = await cl.token();

      const token = await ethers.getContractAt('BXR1Token', tokenAddress);
      const held = await token.balanceOf(await cl.getAddress());
      const curve = await ballista.curves(tokenAddress);

      const heldBps = (held * BPS) / CURVE_SUPPLY;
      console.log(`        looped 10 buys in one block -> ${(Number(heldBps) / 100).toFixed(3)}% of curve supply`);

      expect(curve.creatorLaunchPurchased).to.equal(held);
      expect(heldBps).to.be.lessThanOrEqual(250n);
      expect(curve.creatorLaunchPurchased * BPS / CURVE_SUPPLY).to.be.lessThanOrEqual(250n);
    });

    // The widened window is the point of the change, so the cap has to hold across it,
    // not just inside one block. Arc targets 500ms blocks, so a 3-second window is
    // roughly 6-7 blocks; timestamps are pinned here to put TEN separate blocks inside
    // it, which is worse than the real chain allows.
    it('EXPLOIT ATTEMPT: loop the privileged buy across TEN blocks inside the widened window', async function () {
      const { ballista, usdc, creator } = await env();
      const hash = await ballista.currentEconomicsHash(await usdc.getAddress());
      const rc = await (await ballista.connect(creator)
        .createToken('Loop2', 'LP2', 'u', await usdc.getAddress(), hash, false)).wait();
      const t = rc.logs.map((l) => { try { return ballista.interface.parseLog(l); } catch { return null; } })
        .find((l) => l && l.name === 'TokenCreated').args.token;
      const created = Number((await ballista.curves(t)).creationTimestamp);

      // Each buy is individually FAR UNDER the cap (~8 USDC against the ~52 that buys
      // the whole 2.5%), so only accumulation across calls can reach it. Sizing these
      // large enough to saturate the cap in one call makes the test pass against a
      // per-call cap too, which is exactly the regression it is supposed to catch.
      let landed = 0, reverted = 0;
      for (let i = 0; i < 10; i++) {
        await ethers.provider.send('evm_setNextBlockTimestamp', [created + Math.floor(i / 3)]);
        try {
          await (await ballista.connect(creator).creatorLaunchBuy(t, 8n * ONE, 0)).wait();
          landed++;
        } catch {
          reverted++;
        }
      }

      const curve = await ballista.curves(t);
      const token = await ethers.getContractAt('BXR1Token', t);
      const held = await token.balanceOf(creator.address);
      const heldBps = (held * BPS) / CURVE_SUPPLY;
      console.log(`        ${landed} landed / ${reverted} reverted across 10 blocks -> ${(Number(heldBps) / 100).toFixed(3)}% of curve supply`);

      expect(curve.creatorLaunchPurchased).to.equal(held);
      expect(heldBps).to.be.lessThanOrEqual(250n);
    });

    it('the cap accumulates across separate transactions in the same block', async function () {
      const { ballista, usdc, creator } = await env();
      const { tokenAddress, results } = await launchAndBuyInSameBlock(
        ballista, usdc, creator, 'CUM', [100n * ONE, 100n * ONE, 100n * ONE, 100n * ONE]
      );
      const succeeded = results.filter((r) => r.status === 1).length;
      expect(succeeded, 'at least one buy should land').to.be.greaterThan(0);

      const curve = await ballista.curves(tokenAddress);
      const cap = (CURVE_SUPPLY * 250n) / BPS;
      expect(curve.creatorLaunchPurchased).to.be.lessThanOrEqual(cap);

      const token = await ethers.getContractAt('BXR1Token', tokenAddress);
      expect(await token.balanceOf(creator.address)).to.equal(curve.creatorLaunchPurchased);
    });

    it('CLAMPS rather than reverting when the creator asks for more than the cap', async function () {
      const { ballista, creator, usdc } = await env();
      const before = await usdc.balanceOf(creator.address);
      // Vastly more than the cap allows -- must fill to the cap and take only what
      // that actually cost, never pulling the excess.
      const { tokenAddress, results } = await launchAndBuyInSameBlock(
        ballista, usdc, creator, 'CLMP', [500_000n * ONE]
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
      const { ballista, usdc, creator } = await env();
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
        ballista, usdc, creator, 'FEEC', [500_000n * ONE]
      );
      expect(results[0].status, 'clamped buy at max base fee must not revert').to.equal(1);

      const curve = await ballista.curves(tokenAddress);
      expect(curve.creatorLaunchPurchased).to.equal((CURVE_SUPPLY * 250n) / BPS);
    });

    it('a second call after the cap is used up reverts cleanly', async function () {
      const { ballista, usdc, creator } = await env();
      const { tokenAddress, results } = await launchAndBuyInSameBlock(
        ballista, usdc, creator, 'USED', [500_000n * ONE, 10n * ONE]
      );
      expect(results[0].status).to.equal(1);
      expect(results[1].status, 'second call must fail once the cap is exhausted').to.equal(0);
      const cap = (CURVE_SUPPLY * 250n) / BPS;
      expect((await ballista.curves(tokenAddress)).creatorLaunchPurchased).to.equal(cap);
    });

    it('a raised cap applies only to tokens launched after the change', async function () {
      const { ballista, usdc, creator } = await env();
      await ballista.setMaxCreatorLaunchBps(1000); // 10%
      const { tokenAddress, results } = await launchAndBuyInSameBlock(
        ballista, usdc, creator, 'BIG', [500_000n * ONE]
      );
      expect(results[0].status).to.equal(1);
      const curve = await ballista.curves(tokenAddress);
      expect(curve.maxCreatorLaunchBps).to.equal(1000);
      expect(curve.creatorLaunchPurchased).to.equal((CURVE_SUPPLY * 1000n) / BPS);
    });

    it('only the owner can move the cap', async function () {
      const { ballista, usdc, creator } = await env();
      await expect(ballista.connect(creator).setMaxCreatorLaunchBps(500)).to.be.reverted;
      await expect(ballista.setMaxCreatorLaunchBps(10_001)).to.be.revertedWithCustomError(ballista, 'BpsExceedsDenominator'
      );
    });
  });
});
