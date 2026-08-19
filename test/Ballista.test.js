const { expect } = require('chai');
const { ethers } = require('hardhat');

const ONE_USDC = 1_000_000n;

describe('Ballista — changes from ArcLaunchFactory', function () {
  async function deployFixture() {
    const [deployer, treasury, creator, trader] = await ethers.getSigners();

    const USDC = await ethers.getContractFactory('MockUSDC');
    const usdc = await USDC.deploy();

    const Ballista = await ethers.getContractFactory('Ballista');
    const ballista = await Ballista.deploy(await usdc.getAddress(), treasury.address);

    // createToken() refuses to launch while router is unset, so the fixture has to
    // configure one. Tests that care about a specific router override this.
    const FixtureRouter = await ethers.getContractFactory('MockRouter');
    const fixtureRouter = await FixtureRouter.deploy();
    await ballista.setRouter(await fixtureRouter.getAddress());

    for (const signer of [creator, trader]) {
      await usdc.mint(signer.address, 1_000_000n * ONE_USDC);
      await usdc.connect(signer).approve(await ballista.getAddress(), ethers.MaxUint256);
    }

    return { deployer, treasury, creator, trader, usdc, ballista };
  }

  // Every createToken() call needs the current economics hash as of the
  // moment it's sent -- this helper keeps that from being duplicated (and
  // potentially forgotten) at every call site.
  async function create(ballista, creator, name, symbol, uri) {
    const hash = await ballista.currentEconomicsHash();
    return ballista.connect(creator).createToken(name, symbol, uri, hash);
  }

  // create(), plus digging the new token's address back out of the receipt.
  async function launch(ballista, creator, name, symbol, uri = 'ipfs://a') {
    const receipt = await (await create(ballista, creator, name, symbol, uri)).wait();
    const event = receipt.logs
      .map((l) => { try { return ballista.interface.parseLog(l); } catch { return null; } })
      .find((l) => l && l.name === 'TokenCreated');
    return event.args.token;
  }

  it('is actually named Ballista, not ArcLaunchFactory', async function () {
    const { ballista } = await deployFixture();
    const artifact = await ethers.getContractFactory('Ballista');
    expect(artifact).to.not.be.undefined;
  });

  it('launches with a 67,000 USDC graduation default, not 69,000', async function () {
    const { ballista } = await deployFixture();
    expect(await ballista.defaultGraduationThresholdUsdc()).to.equal(67_000n * ONE_USDC);
  });

  describe('symbol case-sensitivity toggle', function () {
    it('defaults to case-sensitive: "Cat" and "cat" can both launch', async function () {
      const { ballista, creator } = await deployFixture();
      expect(await ballista.caseSensitiveSymbols()).to.equal(true);

      await expect(create(ballista, creator, 'Cat Coin', 'Cat', 'ipfs://a')).to.not.be.reverted;

      await ballista.setLaunchCooldown(0);

      await expect(create(ballista, creator, 'cat coin two', 'cat', 'ipfs://b')).to.not.be.reverted;
    });

    it('once toggled off, "Cat" and "cat" collide as the same symbol', async function () {
      const { ballista, creator } = await deployFixture();
      await ballista.setLaunchCooldown(0);

      await expect(ballista.setCaseSensitiveSymbols(false))
        .to.emit(ballista, 'CaseSensitiveSymbolsSet')
        .withArgs(false);

      await create(ballista, creator, 'Cat Coin', 'Cat', 'ipfs://a');

      await expect(
        create(ballista, creator, 'cat coin two', 'cat', 'ipfs://b'),
      ).to.be.revertedWith("symbol locked: still within another launch's protection window");
    });

    it('only owner can toggle it', async function () {
      const { ballista, creator } = await deployFixture();
      await expect(ballista.connect(creator).setCaseSensitiveSymbols(false)).to.be.reverted;
    });
  });

  describe('economics snapshot / pinning', function () {
    it('createToken succeeds when the pinned hash still matches current defaults', async function () {
      const { ballista, creator } = await deployFixture();
      await expect(create(ballista, creator, 'Pinned Coin', 'PIN', 'ipfs://a')).to.not.be.reverted;
    });

    it('reverts if the buy fee changes between fetching the hash and the tx mining', async function () {
      const { ballista, creator } = await deployFixture();
      const staleHash = await ballista.currentEconomicsHash();

      // Simulates the actual race: creator fetched terms, then before their
      // tx mined, the owner changed a default.
      await ballista.setDefaultFees(200, 100); // was 100/100

      await expect(
        ballista.connect(creator).createToken('Stale Coin', 'STL', 'ipfs://a', staleHash),
      ).to.be.revertedWith('economics changed since you last checked -- refresh and confirm the new terms');
    });

    it('reverts if the graduation threshold changes underneath a pinned hash', async function () {
      const { ballista, creator } = await deployFixture();
      const staleHash = await ballista.currentEconomicsHash();
      await ballista.setDefaultGraduationThreshold(80_000n * ONE_USDC);

      await expect(
        ballista.connect(creator).createToken('Stale Threshold Coin', 'STH', 'ipfs://a', staleHash),
      ).to.be.revertedWith('economics changed since you last checked -- refresh and confirm the new terms');
    });

    it('reverts if symbol case-sensitivity changes underneath a pinned hash', async function () {
      const { ballista, creator } = await deployFixture();
      const staleHash = await ballista.currentEconomicsHash();
      await ballista.setCaseSensitiveSymbols(false);

      await expect(
        ballista.connect(creator).createToken('Stale Symbol Coin', 'SSC', 'ipfs://a', staleHash),
      ).to.be.revertedWith('economics changed since you last checked -- refresh and confirm the new terms');
    });

    it('reverts if the symbol lock duration changes underneath a pinned hash', async function () {
      const { ballista, creator } = await deployFixture();
      const staleHash = await ballista.currentEconomicsHash();
      await ballista.setSymbolLockDuration(600);

      await expect(
        ballista.connect(creator).createToken('Stale Lock Coin', 'SLC', 'ipfs://a', staleHash),
      ).to.be.revertedWith('economics changed since you last checked -- refresh and confirm the new terms');
    });

    it('a fresh hash fetched AFTER the change works fine -- this protects against surprise, not against change itself', async function () {
      const { ballista, creator } = await deployFixture();
      await ballista.setDefaultFees(500, 500);
      // Creator re-checks, sees the new terms, and explicitly proceeds anyway.
      await expect(create(ballista, creator, 'Reconfirmed Coin', 'RCC', 'ipfs://a')).to.not.be.reverted;
    });

    it('does NOT pin launchCooldown or creationFeeUsdc -- those gate eligibility to launch, not token economics', async function () {
      const { ballista, creator } = await deployFixture();
      const staleHash = await ballista.currentEconomicsHash();
      await ballista.setLaunchCooldown(999);
      await ballista.setCreationFee(50n * ONE_USDC);

      // Neither of these is part of the pinned hash, so this should still
      // succeed on the stale hash -- confirms the pin is scoped to what was
      // actually documented (fees, threshold, symbol policy), not everything
      // adjustable in the contract.
      await expect(
        ballista.connect(creator).createToken('Unpinned Coin', 'UPC', 'ipfs://a', staleHash),
      ).to.not.be.reverted;
    });
  });

  describe('quoteBuy / quoteSell', function () {
    it('quoteBuy predicts exactly what buy() actually does, including the clamp case', async function () {
      const { ballista, creator, trader } = await deployFixture();
      const createTx = await create(ballista, creator, 'Quote Coin', 'QTC', 'ipfs://a');
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
      expect(tradeEvent.args.usdcAmount).to.equal(quote.actualUsdcIn);
    });

    it('quoteBuy rejects a graduated/closed curve rather than returning a misleading number', async function () {
      const { ballista, creator, trader, usdc } = await deployFixture();
      const Router = await ethers.getContractFactory('MockRouter');
      const router = await Router.deploy();
      await ballista.setRouter(await router.getAddress());

      const createTx = await create(ballista, creator, 'Closed Quote Coin', 'CQC', 'ipfs://a');
      const receipt = await createTx.wait();
      const event = receipt.logs
        .map((l) => { try { return ballista.interface.parseLog(l); } catch { return null; } })
        .find((l) => l && l.name === 'TokenCreated');
      const tokenAddress = event.args.token;

      await usdc.mint(trader.address, 200_000n * ONE_USDC);
      await ballista.connect(trader).buy(tokenAddress, 68_000n * ONE_USDC, 0);
      expect((await ballista.curves(tokenAddress)).state).to.equal(2n); // GRADUATED

      await expect(ballista.quoteBuy(tokenAddress, 100n * ONE_USDC)).to.be.revertedWith(
        'curve not open for trading: check DEX or wait for graduation',
      );
    });

    it('quoteSell predicts exactly what sell() actually does, including the clamp case', async function () {
      const { ballista, creator, trader } = await deployFixture();
      const ballistaAddress = await ballista.getAddress();
      const createTx = await create(ballista, creator, 'Quote Sell Coin', 'QSC', 'ipfs://a');
      const receipt = await createTx.wait();
      const event = receipt.logs
        .map((l) => { try { return ballista.interface.parseLog(l); } catch { return null; } })
        .find((l) => l && l.name === 'TokenCreated');
      const tokenAddress = event.args.token;
      const token = await ethers.getContractAt('ArcLaunchToken', tokenAddress);

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
      expect(tradeEvent.args.usdcAmount).to.equal(quote.usdcOutGross - quote.fee);
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
      const ballista = await (await ethers.getContractFactory('Ballista')).deploy(
        await usdc.getAddress(),
        treasury.address
      );
      await usdc.mint(creator.address, 1_000_000n * ONE_USDC);
      await usdc.connect(creator).approve(await ballista.getAddress(), ethers.MaxUint256);
      return { deployer, treasury, creator, usdc, ballista };
    }

    it('createToken reverts while router is unset', async function () {
      const { ballista, creator } = await bareDeploy();
      await expect(create(ballista, creator, 'No Router', 'NRTR', 'ipfs://a')).to.be.revertedWith(
        'router not set: launches are closed until a DEX is configured'
      );
    });

    it('setRouter rejects the zero address, so a configured router cannot be taken away', async function () {
      const { ballista } = await deployFixture();
      await expect(ballista.setRouter(ethers.ZeroAddress)).to.be.revertedWith(
        'router cannot be unset: use pause() to halt instead'
      );
    });

    it('setRouter still allows swapping one live router for another', async function () {
      const { ballista } = await deployFixture();
      const Replacement = await ethers.getContractFactory('MockRouter');
      const replacement = await Replacement.deploy();
      const replacementAddress = await replacement.getAddress();

      await ballista.setRouter(replacementAddress);
      expect(await ballista.router()).to.equal(replacementAddress);
    });

    it('only the owner can set the router', async function () {
      const { ballista, creator } = await deployFixture();
      const Replacement = await ethers.getContractFactory('MockRouter');
      const replacement = await Replacement.deploy();
      await expect(ballista.connect(creator).setRouter(await replacement.getAddress())).to.be
        .reverted;
    });

    // The whole point of the gate: a token that exists is always a token that has
    // somewhere to graduate into, for the entire life of the curve.
    it('a launched token can always still reach a router, even after an owner tries to clear it', async function () {
      const { ballista, creator, trader, usdc } = await deployFixture();
      const tokenAddress = await launch(ballista, creator, 'Safe Coin', 'SAFE');

      await expect(ballista.setRouter(ethers.ZeroAddress)).to.be.reverted;

      await usdc.mint(trader.address, 200_000n * ONE_USDC);
      await ballista.connect(trader).buy(tokenAddress, 70_000n * ONE_USDC, 0);
      expect((await ballista.curves(tokenAddress)).state).to.equal(2n); // GRADUATED
    });
  });

  describe('block-0 trading restriction', function () {
    it('rejects a buy queued in the same block the token was created', async function () {
      const { ballista, creator, trader } = await deployFixture();
      const ballistaAddress = await ballista.getAddress();

      const nonce = await ethers.provider.getTransactionCount(ballistaAddress);
      const predictedToken = ethers.getCreateAddress({ from: ballistaAddress, nonce });

      await ethers.provider.send('evm_setAutomine', [false]);

      const createTx = await create(ballista, creator, 'Same Block Coin', 'SBC', 'ipfs://a');
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
      ).to.be.revertedWith('trading opens next block');
    });

    it('allows trading starting the block after creation', async function () {
      const { ballista, creator, trader } = await deployFixture();

      const createTx = await create(ballista, creator, 'Normal Coin', 'NRM', 'ipfs://a');
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
    await ballista.setRouter(await router.getAddress());

    const createTx = await create(ballista, creator, 'Sanity Coin', 'SANE', 'ipfs://a');
    const receipt = await createTx.wait();
    const event = receipt.logs
      .map((l) => { try { return ballista.interface.parseLog(l); } catch { return null; } })
      .find((l) => l && l.name === 'TokenCreated');
    const tokenAddress = event.args.token;
    const token = await ethers.getContractAt('ArcLaunchToken', tokenAddress);

    await ballista.connect(trader).buy(tokenAddress, 100n * ONE_USDC, 0);
    const tokensHeld = await token.balanceOf(trader.address);
    expect(tokensHeld).to.be.gt(0n);

    await token.connect(trader).approve(ballistaAddress, tokensHeld);
    await ballista.connect(trader).sell(tokenAddress, tokensHeld / 2n, 0);
    expect(await token.balanceOf(trader.address)).to.equal(tokensHeld - tokensHeld / 2n);

    await usdc.mint(trader.address, 200_000n * ONE_USDC);
    await ballista.connect(trader).buy(tokenAddress, 70_000n * ONE_USDC, 0);

    const curve = await ballista.curves(tokenAddress);
    expect(curve.state).to.equal(2n); // GRADUATED

    await expect(
      ballista.connect(trader).buy(tokenAddress, 1n * ONE_USDC, 0),
    ).to.be.revertedWith('curve not open for trading: check DEX or wait for graduation');

    expect(await usdc.balanceOf(treasury.address)).to.be.gt(0n);
  });
});
