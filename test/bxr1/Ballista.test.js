const { expect } = require('chai');
const { ethers } = require('hardhat');
const { activateRouter } = require('../routerHelper');
const { deployRegistryWithAsset, setGraduationThreshold, setInitialVirtualReserve, setCreationFee, getBXR1Factory } = require('./assetRegistryHelper');

const ONE_USDC = 1_000_000n;

describe('Ballista — changes since the original build', function () {
  async function deployFixture() {
    const [deployer, treasury, creator, trader] = await ethers.getSigners();

    const USDC = await ethers.getContractFactory('MockUSDC');
    const usdc = await USDC.deploy();

    const registry = await deployRegistryWithAsset(await usdc.getAddress());
    const Ballista = await getBXR1Factory();
    const ballista = await Ballista.deploy(await registry.getAddress(), treasury.address, ethers.ZeroAddress);

    // createToken() refuses to launch while router is unset, so the fixture has to
    // configure one. Tests that care about a specific router override this.
    const FixtureRouter = await ethers.getContractFactory('MockRouter');
    const fixtureRouter = await FixtureRouter.deploy();
    await activateRouter(ballista, await fixtureRouter.getAddress());

    // These tests are about steady-state curve economics, not sniping, and they trade
    // immediately after launch -- which in production is squarely inside the snipe
    // window. Publishing an empty table disables the tax for this fixture so those
    // trades model normal post-window trading. The tax has its own suite in
    // test/SnipeTax.test.js.
    await ballista.publishSnipeTaxTable([]);

    for (const signer of [creator, trader]) {
      await usdc.mint(signer.address, 1_000_000n * ONE_USDC);
      await usdc.connect(signer).approve(await ballista.getAddress(), ethers.MaxUint256);
    }

    return { deployer, treasury, creator, trader, usdc, registry, ballista };
  }

  // Every createToken() call needs the current economics hash as of the
  // moment it's sent -- this helper keeps that from being duplicated (and
  // potentially forgotten) at every call site.
  async function create(ballista, usdc, creator, name, symbol, uri) {
    const hash = await ballista.currentEconomicsHash(await usdc.getAddress());
    return ballista.connect(creator).createToken(name, symbol, uri, await usdc.getAddress(), hash);
  }

  // create(), plus digging the new token's address back out of the receipt.
  async function launch(ballista, usdc, creator, name, symbol, uri = 'ipfs://a') {
    const receipt = await (await create(ballista, usdc, creator, name, symbol, uri)).wait();
    const event = receipt.logs
      .map((l) => { try { return ballista.interface.parseLog(l); } catch { return null; } })
      .find((l) => l && l.name === 'TokenCreated');
    return event.args.token;
  }

  it('the BXR1 artifact resolves -- contracts/ keeps the neutral name', async function () {
    const { ballista } = await deployFixture();
    const artifact = await getBXR1Factory();
    expect(artifact).to.not.be.undefined;
  });

  it('launches with an 8,000 USDC graduation default', async function () {
    const { usdc, registry } = await deployFixture();
    expect((await registry.getAsset(await usdc.getAddress())).defaultGraduationThreshold)
      .to.equal(8_000n * ONE_USDC);
  });

  // The symbol case-sensitivity toggle and the symbol lock it gated were removed
  // 2026-09-18 -- see CLAUDE.md section 26 and BXR1.sol's own comment above the
  // removed state variables. "Cat" and "cat" can now both launch, unconditionally
  // and always, and nothing on chain stops a second launch of the same symbol.
  // Collision detection is a frontend concern now.
  it('two launches of the same symbol both succeed -- no on-chain collision guard any more', async function () {
    const { ballista, creator, usdc } = await deployFixture();
    await expect(create(ballista, usdc, creator, 'Cat Coin', 'CAT', 'ipfs://a')).to.not.be.reverted;
    await expect(create(ballista, usdc, creator, 'Copycat Coin', 'CAT', 'ipfs://b')).to.not.be.reverted;
  });

  describe('economics snapshot / pinning', function () {
    it('createToken succeeds when the pinned hash still matches current defaults', async function () {
      const { ballista, creator, usdc } = await deployFixture();
      await expect(create(ballista, usdc, creator, 'Pinned Coin', 'PIN', 'ipfs://a')).to.not.be.reverted;
    });

    it('reverts if the buy fee changes between fetching the hash and the tx mining', async function () {
      const { ballista, creator, usdc } = await deployFixture();
      const staleHash = await ballista.currentEconomicsHash(await usdc.getAddress());

      // Simulates the actual race: creator fetched terms, then before their
      // tx mined, the owner changed a default.
      await ballista.setDefaultFees(200, 100); // was 100/100

      await expect(
        ballista.connect(creator).createToken('Stale Coin', 'STL', 'ipfs://a', await usdc.getAddress(), staleHash),
      ).to.be.revertedWithCustomError(ballista, 'EconomicsChanged');
    });

    it('reverts if the graduation threshold changes underneath a pinned hash', async function () {
      const { ballista, creator, usdc, registry } = await deployFixture();
      const staleHash = await ballista.currentEconomicsHash(await usdc.getAddress());
      await setGraduationThreshold(registry, await usdc.getAddress(), 80_000n * ONE_USDC);

      await expect(
        ballista.connect(creator).createToken('Stale Threshold Coin', 'STH', 'ipfs://a', await usdc.getAddress(), staleHash),
      ).to.be.revertedWithCustomError(ballista, 'EconomicsChanged');
    });

    it('reverts if the opening virtual reserve changes underneath a pinned hash', async function () {
      const { ballista, creator, usdc, registry } = await deployFixture();
      const staleHash = await ballista.currentEconomicsHash(await usdc.getAddress());
      await setInitialVirtualReserve(registry, await usdc.getAddress(), 5_334_000_000n);

      await expect(
        ballista.connect(creator).createToken('Stale Reserve Coin', 'STR', 'ipfs://a', await usdc.getAddress(), staleHash),
      ).to.be.revertedWithCustomError(ballista, 'EconomicsChanged');
    });

    it('a fresh hash fetched AFTER the change works fine -- this protects against surprise, not against change itself', async function () {
      const { ballista, creator, usdc } = await deployFixture();
      await ballista.setDefaultFees(500, 500);
      // Creator re-checks, sees the new terms, and explicitly proceeds anyway.
      await expect(create(ballista, usdc, creator, 'Reconfirmed Coin', 'RCC', 'ipfs://a')).to.not.be.reverted;
    });

    it('does NOT pin creationFee -- that gates eligibility to launch, not token economics', async function () {
      const { ballista, creator, usdc, registry } = await deployFixture();
      const staleHash = await ballista.currentEconomicsHash(await usdc.getAddress());
      await setCreationFee(registry, await usdc.getAddress(), 50n * ONE_USDC);

      // creationFee is not part of the pinned hash, so this should still
      // succeed on the stale hash -- confirms the pin is scoped to what was
      // actually documented (fees, threshold, snipe tax table/split), not
      // everything adjustable in the contract.
      await expect(
        ballista.connect(creator).createToken('Unpinned Coin', 'UPC', 'ipfs://a', await usdc.getAddress(), staleHash),
      ).to.not.be.reverted;
    });
  });

  describe('quoteBuy / quoteSell', function () {
    it('quoteBuy predicts exactly what buy() actually does, including the clamp case', async function () {
      const { ballista, creator, trader, usdc } = await deployFixture();
      const createTx = await create(ballista, usdc, creator, 'Quote Coin', 'QTC', 'ipfs://a');
      const receipt = await createTx.wait();
      const event = receipt.logs
        .map((l) => { try { return ballista.interface.parseLog(l); } catch { return null; } })
        .find((l) => l && l.name === 'TokenCreated');
      const tokenAddress = event.args.token;

      const usdcIn = 500n * ONE_USDC;
      const quote = await ballista.quoteBuy(tokenAddress, usdcIn);

      const tx = await ballista.connect(trader).buy(tokenAddress, usdcIn, 0);
      const buyReceipt = await tx.wait();
      const tradeEvent = buyReceipt.logs
        .map((l) => { try { return ballista.interface.parseLog(l); } catch { return null; } })
        .find((l) => l && l.name === 'Trade');

      expect(tradeEvent.args.tokenAmount).to.equal(quote.tokensOut);
      expect(tradeEvent.args.quoteAmount).to.equal(quote.actualQuoteIn);
    });

    it('quoteBuy rejects a graduated/closed curve rather than returning a misleading number', async function () {
      const { ballista, creator, trader, usdc } = await deployFixture();
      const Router = await ethers.getContractFactory('MockRouter');
      const router = await Router.deploy();
      await activateRouter(ballista, await router.getAddress());

      const createTx = await create(ballista, usdc, creator, 'Closed Quote Coin', 'CQC', 'ipfs://a');
      const receipt = await createTx.wait();
      const event = receipt.logs
        .map((l) => { try { return ballista.interface.parseLog(l); } catch { return null; } })
        .find((l) => l && l.name === 'TokenCreated');
      const tokenAddress = event.args.token;

      await usdc.mint(trader.address, 200_000n * ONE_USDC);
      await ballista.connect(trader).buy(tokenAddress, 68_000n * ONE_USDC, 0);
      expect((await ballista.curves(tokenAddress)).state).to.equal(2n); // GRADUATED

      await expect(ballista.quoteBuy(tokenAddress, 100n * ONE_USDC)).to.be.revertedWithCustomError(ballista, 'CurveNotActive',
      );
    });

    it('quoteSell predicts exactly what sell() actually does, including the clamp case', async function () {
      const { ballista, creator, trader, usdc } = await deployFixture();
      const ballistaAddress = await ballista.getAddress();
      const createTx = await create(ballista, usdc, creator, 'Quote Sell Coin', 'QSC', 'ipfs://a');
      const receipt = await createTx.wait();
      const event = receipt.logs
        .map((l) => { try { return ballista.interface.parseLog(l); } catch { return null; } })
        .find((l) => l && l.name === 'TokenCreated');
      const tokenAddress = event.args.token;
      const token = await ethers.getContractAt('BXR1Token', tokenAddress);

      await ballista.connect(trader).buy(tokenAddress, 1_000n * ONE_USDC, 0);
      const tokensHeld = await token.balanceOf(trader.address);
      await token.connect(trader).approve(ballistaAddress, tokensHeld);

      const quote = await ballista.quoteSell(tokenAddress, tokensHeld);

      const tx = await ballista.connect(trader).sell(tokenAddress, tokensHeld, 0);
      const sellReceipt = await tx.wait();
      const tradeEvent = sellReceipt.logs
        .map((l) => { try { return ballista.interface.parseLog(l); } catch { return null; } })
        .find((l) => l && l.name === 'Trade');

      expect(tradeEvent.args.tokenAmount).to.equal(quote.actualTokensIn);
      expect(tradeEvent.args.quoteAmount).to.equal(quote.quoteOutGross - quote.fee);
    });
  });

  // A curve that reaches GRADUATION_READY has buy() and sell() both closed and can
  // only move forward via a successful graduate(). If no router exists at that point,
  // holders are stuck with no exit. These two rules together make that unreachable:
  // a token cannot launch without a router, and a router cannot be taken away.
  describe('router gate — nothing can launch into a state it cannot leave', function () {
    async function bareDeploy() {
      const [deployer, treasury, creator] = await ethers.getSigners();
      const usdc = await (await ethers.getContractFactory('MockUSDC')).deploy();
      const registry = await deployRegistryWithAsset(await usdc.getAddress());
      const ballista = await (await getBXR1Factory()).deploy(
        await registry.getAddress(),
        treasury.address,
        ethers.ZeroAddress
      );
      await usdc.mint(creator.address, 1_000_000n * ONE_USDC);
      await usdc.connect(creator).approve(await ballista.getAddress(), ethers.MaxUint256);
      return { deployer, treasury, creator, usdc, registry, ballista };
    }

    it('createToken reverts while router is unset', async function () {
      const { ballista, creator, usdc } = await bareDeploy();
      await expect(create(ballista, usdc, creator, 'No Router', 'NRTR', 'ipfs://a')).to.be.revertedWithCustomError(ballista, 'RouterNotSet'
      );
    });

    it('proposeRouter/activateRouter/revokeRouter all reject the zero address', async function () {
      const { ballista } = await deployFixture();
      const msg = 'ZeroAddress';
      await expect(ballista.proposeRouter(ethers.ZeroAddress)).to.be.revertedWithCustomError(ballista, msg);
      await expect(ballista.activateRouter(ethers.ZeroAddress)).to.be.revertedWithCustomError(ballista, msg);
      await expect(ballista.revokeRouter(ethers.ZeroAddress)).to.be.revertedWithCustomError(ballista, msg);
    });

    it('TIMELOCK: activation before the delay reverts, after it succeeds', async function () {
      const { ballista } = await deployFixture();
      const next = await (await ethers.getContractFactory('MockRouter')).deploy();
      const addr = await next.getAddress();

      const delay = await ballista.ROUTER_TIMELOCK();
      expect(delay).to.equal(24n * 3600n);

      await ballista.proposeRouter(addr);
      await expect(ballista.activateRouter(addr)).to.be.revertedWithCustomError(ballista, 'RouterTimelockPending'
      );

      // One second short is still short.
      await ethers.provider.send('evm_increaseTime', [Number(delay) - 5]);
      await ethers.provider.send('evm_mine');
      await expect(ballista.activateRouter(addr)).to.be.revertedWithCustomError(ballista, 'RouterTimelockPending'
      );

      await ethers.provider.send('evm_increaseTime', [10]);
      await ethers.provider.send('evm_mine');
      await expect(ballista.activateRouter(addr)).to.not.be.reverted;
      expect(await ballista.router()).to.equal(addr);
    });

    it('activating a never-proposed address reverts', async function () {
      const { ballista } = await deployFixture();
      const stranger = await (await ethers.getContractFactory('MockRouter')).deploy();
      await expect(ballista.activateRouter(await stranger.getAddress())).to.be.revertedWithCustomError(ballista, 'RouterNotProposed'
      );
    });

    it('propose, revoke, then activate reverts -- revocation kills a pending proposal', async function () {
      const { ballista } = await deployFixture();
      const next = await (await ethers.getContractFactory('MockRouter')).deploy();
      const addr = await next.getAddress();

      await ballista.proposeRouter(addr);
      await ballista.revokeRouter(addr);
      expect(await ballista.routerProposedAt(addr)).to.equal(0n);

      await ethers.provider.send('evm_increaseTime', [24 * 3600 + 1]);
      await ethers.provider.send('evm_mine');
      await expect(ballista.activateRouter(addr)).to.be.revertedWithCustomError(ballista, 'RouterNotProposed'
      );
    });

    it('revoking the LIVE router clears router and blocks new launches', async function () {
      const { ballista, creator, usdc } = await deployFixture();
      const live = await ballista.router();
      expect(live).to.not.equal(ethers.ZeroAddress);

      await expect(ballista.revokeRouter(live))
        .to.emit(ballista, 'RouterRevoked')
        .withArgs(live, true);

      expect(await ballista.router()).to.equal(ethers.ZeroAddress);
      await expect(create(ballista, usdc, creator, 'After Revoke', 'ARV', 'ipfs://a')).to.be.revertedWithCustomError(ballista, 'RouterNotSet'
      );
    });

    it('revoking a non-live, non-proposed address is a harmless no-op', async function () {
      const { ballista } = await deployFixture();
      const live = await ballista.router();
      const stranger = ethers.Wallet.createRandom().address;
      // Must never revert -- this is the function reached for in an emergency.
      await expect(ballista.revokeRouter(stranger))
        .to.emit(ballista, 'RouterRevoked')
        .withArgs(stranger, false);
      expect(await ballista.router()).to.equal(live);
    });

    it('the proposal event carries the timestamp it becomes activatable', async function () {
      const { ballista } = await deployFixture();
      const next = await (await ethers.getContractFactory('MockRouter')).deploy();
      const addr = await next.getAddress();

      const rc = await (await ballista.proposeRouter(addr)).wait();
      const evt = rc.logs
        .map((l) => { try { return ballista.interface.parseLog(l); } catch { return null; } })
        .find((l) => l && l.name === 'RouterProposed');
      const blk = await ethers.provider.getBlock(rc.blockNumber);
      expect(evt.args.router).to.equal(addr);
      expect(evt.args.activatableAt).to.equal(BigInt(blk.timestamp) + 24n * 3600n);
    });

    it('only the owner can propose, activate or revoke', async function () {
      const { ballista, creator, usdc } = await deployFixture();
      const next = await (await ethers.getContractFactory('MockRouter')).deploy();
      const addr = await next.getAddress();
      await expect(ballista.connect(creator).proposeRouter(addr)).to.be.reverted;
      await expect(ballista.connect(creator).activateRouter(addr)).to.be.reverted;
      await expect(ballista.connect(creator).revokeRouter(addr)).to.be.reverted;
    });

    it('swapping one live router for another still works, through the timelock', async function () {
      const { ballista } = await deployFixture();
      const replacement = await (await ethers.getContractFactory('MockRouter')).deploy();
      const addr = await replacement.getAddress();
      await activateRouter(ballista, addr);
      expect(await ballista.router()).to.equal(addr);
    });

    // The launch gate's guarantee is now WEAKER than before by design: a launched token
    // can be stranded at GRADUATION_READY if the live router is revoked, until a
    // replacement clears the timelock. Losing a day of graduation beats losing the pot.
    it('a launched token still graduates normally while its router stays live', async function () {
      const { ballista, creator, trader, usdc } = await deployFixture();
      const tokenAddress = await launch(ballista, usdc, creator, 'Safe Coin', 'SAFE');
      await usdc.mint(trader.address, 200_000n * ONE_USDC);
      await ballista.connect(trader).buy(tokenAddress, 9_000n * ONE_USDC, 0);
      expect((await ballista.curves(tokenAddress)).state).to.equal(2n); // GRADUATED
    });
  });

  describe('block-0 trading restriction', function () {
    it('rejects a buy queued in the same block the token was created', async function () {
      const { ballista, creator, trader, usdc } = await deployFixture();
      const ballistaAddress = await ballista.getAddress();

      const nonce = await ethers.provider.getTransactionCount(ballistaAddress);
      const predictedToken = ethers.getCreateAddress({ from: ballistaAddress, nonce });

      await ethers.provider.send('evm_setAutomine', [false]);

      const createTx = await create(ballista, usdc, creator, 'Same Block Coin', 'SBC', 'ipfs://a');
      const buyTx = await ballista.connect(trader).buy(predictedToken, 10n * ONE_USDC, 0);

      await ethers.provider.send('evm_mine', []);
      await ethers.provider.send('evm_setAutomine', [true]);

      const createReceipt = await createTx.wait();
      expect(createReceipt.status).to.equal(1);

      let buyReverted = false;
      try {
        await buyTx.wait();
      } catch {
        buyReverted = true;
      }
      expect(buyReverted, 'expected the same-block buy to revert, but it succeeded').to.equal(true);

      await expect(
        ballista.connect(trader).buy.staticCall(predictedToken, 10n * ONE_USDC, 0, {
          blockTag: createReceipt.blockNumber,
        }),
      ).to.be.revertedWithCustomError(ballista, 'TradingNotOpenYet');
    });

    it('allows trading starting the block after creation', async function () {
      const { ballista, creator, trader, usdc } = await deployFixture();

      const createTx = await create(ballista, usdc, creator, 'Normal Coin', 'NRM', 'ipfs://a');
      const receipt = await createTx.wait();
      const event = receipt.logs
        .map((l) => { try { return ballista.interface.parseLog(l); } catch { return null; } })
        .find((l) => l && l.name === 'TokenCreated');
      const tokenAddress = event.args.token;

      await expect(
        ballista.connect(trader).buy(tokenAddress, 10n * ONE_USDC, 0),
      ).to.not.be.reverted;
    });
  });

  it('sanity check: buy, sell, and graduation still work end to end after these edits', async function () {
    const { ballista, creator, trader, usdc, treasury } = await deployFixture();
    const ballistaAddress = await ballista.getAddress();

    const Router = await ethers.getContractFactory('MockRouter');
    const router = await Router.deploy();
    await activateRouter(ballista, await router.getAddress());

    const createTx = await create(ballista, usdc, creator, 'Sanity Coin', 'SANE', 'ipfs://a');
    const receipt = await createTx.wait();
    const event = receipt.logs
      .map((l) => { try { return ballista.interface.parseLog(l); } catch { return null; } })
      .find((l) => l && l.name === 'TokenCreated');
    const tokenAddress = event.args.token;
    const token = await ethers.getContractAt('BXR1Token', tokenAddress);

    await ballista.connect(trader).buy(tokenAddress, 100n * ONE_USDC, 0);
    const tokensHeld = await token.balanceOf(trader.address);
    expect(tokensHeld).to.be.gt(0n);

    await token.connect(trader).approve(ballistaAddress, tokensHeld);
    await ballista.connect(trader).sell(tokenAddress, tokensHeld / 2n, 0);
    expect(await token.balanceOf(trader.address)).to.equal(tokensHeld - tokensHeld / 2n);

    await usdc.mint(trader.address, 200_000n * ONE_USDC);
    await ballista.connect(trader).buy(tokenAddress, 9_000n * ONE_USDC, 0);

    const curve = await ballista.curves(tokenAddress);
    expect(curve.state).to.equal(2n); // GRADUATED

    await expect(
      ballista.connect(trader).buy(tokenAddress, 1n * ONE_USDC, 0),
    ).to.be.revertedWithCustomError(ballista, 'CurveNotActive');

    expect(await ballista.treasuryFeesAccrued(await usdc.getAddress())).to.be.gt(0n);
  });
});
