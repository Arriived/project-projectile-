const { expect } = require("chai");
const { ethers } = require("hardhat");

const USDC = (n) => ethers.parseUnits(n.toString(), 6);
const TOKENS = (n) => ethers.parseUnits(n.toString(), 18);
const ZERO = "0x0000000000000000000000000000000000000000";

// Curve.state enum, mirrored from Ballista.sol.
const GRADUATION_READY = 1n;
const GRADUATED = 2n;

// Originally this suite loaded hand-built bytecode out of artifacts-manual/ via a
// local loadArtifact() helper. That directory is a frozen snapshot, so the suite
// silently kept testing July's ArcLaunchFactory no matter what contracts/ said.
// Everything now goes through hardhat's own compiled output, which is what makes
// these tests actually exercise Ballista.sol.
async function deployFixture() {
  const [owner, treasury, alice, bob] = await ethers.getSigners();

  const usdc = await (await ethers.getContractFactory("MockUSDC")).deploy();
  const factory = await (await ethers.getContractFactory("Ballista")).deploy(
    await usdc.getAddress(),
    treasury.address
  );
  const router = await (await ethers.getContractFactory("MockRouter")).deploy();
  const brokenRouter = await (await ethers.getContractFactory("MockBrokenRouter")).deploy();

  // createToken() now refuses to launch while router is unset, so every fixture has
  // to configure one up front. Tests that care about a specific router's behavior
  // override this with their own setRouter() call.
  await factory.connect(owner).setRouter(await router.getAddress());

  // These tests are about steady-state curve economics, not sniping, and they trade
  // immediately after launch -- which in production is squarely inside the snipe
  // window. Publishing an empty table disables the tax for this fixture so those
  // trades model normal post-window trading. The tax has its own suite in
  // test/SnipeTax.test.js.
  await factory.connect(owner).publishSnipeTaxTable([]);

  // Fund alice and bob generously, approve the factory.
  for (const wallet of [alice, bob]) {
    await usdc.mint(wallet.address, USDC(1_000_000));
    await usdc.connect(wallet).approve(await factory.getAddress(), ethers.MaxUint256);
  }

  return { owner, treasury, alice, bob, usdc, factory, router, brokenRouter };
}

// createToken() now pins the economics the creator agreed to. The hash has to be read
// immediately before the call, or an unrelated admin change lands in between and the
// create reverts.
async function createToken(factory, creator, name, symbol, uri = "uri") {
  return factory
    .connect(creator)
    .createToken(name, symbol, uri, await factory.currentEconomicsHash());
}

describe("Ballista — original ArcLaunchFactory suite", function () {
  describe("createToken", function () {
    it("mints the full fixed supply to the factory, not the creator", async function () {
      const { factory, alice } = await deployFixture();
      const receipt = await (
        await createToken(factory, alice, "Test Cat", "CAT", "ipfs://meta")
      ).wait();
      const event = receipt.logs
        .map((l) => {
          try {
            return factory.interface.parseLog(l);
          } catch {
            return null;
          }
        })
        .find((l) => l && l.name === "TokenCreated");
      const tokenAddr = event.args.token;

      const token = await ethers.getContractAt("ArcLaunchToken", tokenAddr);
      // 965M = 800M curve supply + 165M LP reserve. Was 1B when the LP reserve was
      // 200M; the reserve was resized to fit where the curve actually graduates.
      expect(await token.balanceOf(await factory.getAddress())).to.equal(TOKENS(965_000_000));
      expect(await token.balanceOf(alice.address)).to.equal(0n);
      expect(await token.creator()).to.equal(alice.address);
    });

    it("has no mint function reachable from outside the constructor", async function () {
      const token = await ethers.getContractFactory("ArcLaunchToken");
      const hasMint = token.interface.fragments.some(
        (f) => f.type === "function" && f.name === "mint"
      );
      expect(hasMint).to.equal(false);
    });

    it("enforces the per-wallet launch cooldown", async function () {
      const { factory, alice } = await deployFixture();
      await createToken(factory, alice, "First", "FIRST");
      await expect(createToken(factory, alice, "Second", "SECOND")).to.be.revertedWith(
        "cooldown: wait before launching again"
      );
    });

    it("allows a new launch after the cooldown elapses", async function () {
      const { factory, alice } = await deployFixture();
      await createToken(factory, alice, "First", "FIRST");
      await ethers.provider.send("evm_increaseTime", [3600]);
      await ethers.provider.send("evm_mine");
      await expect(createToken(factory, alice, "Second", "SECOND")).to.not.be.reverted;
    });

    it("blocks exact-duplicate symbols", async function () {
      const { factory, alice, bob } = await deployFixture();
      await createToken(factory, alice, "First", "DUPE");
      await expect(createToken(factory, bob, "Copycat", "DUPE")).to.be.revertedWith(
        "symbol locked: still within another launch's protection window"
      );
    });

    // The old suite asserted CAT/cat always collide. Ballista ships lenient by design
    // (caseSensitiveSymbols = true), so both variants launching is now correct
    // behavior, and the collision is what the tightened mode buys you. Both halves are
    // asserted here so the toggle cannot silently flip without a test noticing.
    it("treats case-variant symbols per the caseSensitiveSymbols toggle", async function () {
      const lenient = await deployFixture();
      expect(await lenient.factory.caseSensitiveSymbols()).to.equal(true);
      await createToken(lenient.factory, lenient.alice, "First", "CAT");
      await expect(createToken(lenient.factory, lenient.bob, "Copycat", "cat")).to.not.be
        .reverted;

      const strict = await deployFixture();
      await strict.factory.connect(strict.owner).setCaseSensitiveSymbols(false);
      await createToken(strict.factory, strict.alice, "First", "CAT");
      await expect(createToken(strict.factory, strict.bob, "Copycat", "cat")).to.be.revertedWith(
        "symbol locked: still within another launch's protection window"
      );
    });

    it("charges the creation fee to treasury", async function () {
      const { factory, alice, treasury, usdc } = await deployFixture();
      const before = await usdc.balanceOf(treasury.address);
      await createToken(factory, alice, "First", "CAT");
      const after = await usdc.balanceOf(treasury.address);
      expect(after - before).to.equal(USDC(5));
    });

    it("snapshots the current default fees/threshold into the new curve", async function () {
      const { factory, alice } = await deployFixture();
      await createToken(factory, alice, "First", "CAT");
      const tokenAddr = await getLastToken(factory, alice);
      const curve = await factory.curves(tokenAddr);
      expect(curve.buyFeeBps).to.equal(100);
      expect(curve.sellFeeBps).to.equal(100);
      expect(curve.graduationThresholdUsdc).to.equal(USDC(67_000));
    });
  });

  describe("fee changes do not retroactively affect live tokens", function () {
    it("a token launched before a fee change keeps its original fee", async function () {
      const { factory, alice, bob, owner, usdc, treasury } = await deployFixture();
      await createToken(factory, alice, "First", "CAT");
      const tokenAddr = await getLastToken(factory, alice);

      // Owner cranks the default fee up for future launches.
      await factory.connect(owner).setDefaultFees(900, 900); // 9%

      // Bob buys into the OLD token — should still be charged the 1% it launched with,
      // not the new 9% default.
      const treasuryBefore = await usdc.balanceOf(treasury.address);
      const creatorBefore = await factory.creatorFeesAccrued(alice.address);
      await factory.connect(bob).buy(tokenAddr, USDC(1000), 0);
      const treasuryAfter = await usdc.balanceOf(treasury.address);
      const creatorAfter = await factory.creatorFeesAccrued(alice.address);

      // The 1% fee is now split 0.7% treasury / 0.3% to the creator (alice), so the
      // total charged is what this test is really about -- it must still be the 1% the
      // token launched with, not the new 9% default.
      const totalFee = (treasuryAfter - treasuryBefore) + (creatorAfter - creatorBefore);
      expect(totalFee).to.equal(USDC(10));
    });
  });

  describe("fee hard cap", function () {
    it("rejects any attempt to set default fees above 10%", async function () {
      const { factory, owner } = await deployFixture();
      await expect(factory.connect(owner).setDefaultFees(1001, 100)).to.be.revertedWith(
        "fee exceeds hard ceiling"
      );
    });

    it("rejects non-owner calls entirely", async function () {
      const { factory, alice } = await deployFixture();
      await expect(factory.connect(alice).setDefaultFees(200, 200)).to.be.reverted;
    });
  });

  describe("buy / sell math", function () {
    it("price increases as more is bought", async function () {
      const { factory, alice, bob } = await deployFixture();
      await createToken(factory, alice, "First", "CAT");
      const tokenAddr = await getLastToken(factory, alice);

      const priceBefore = await factory.currentPrice(tokenAddr);
      await factory.connect(bob).buy(tokenAddr, USDC(5000), 0);
      const priceAfter = await factory.currentPrice(tokenAddr);
      expect(priceAfter).to.be.gt(priceBefore);
    });

    it("does not let a trader extract more value than they put in via rounding (buy then sell)", async function () {
      const { factory, alice, bob, usdc } = await deployFixture();
      await createToken(factory, alice, "First", "CAT");
      const tokenAddr = await getLastToken(factory, alice);
      const token = await ethers.getContractAt("ArcLaunchToken", tokenAddr);

      const startBalance = await usdc.balanceOf(bob.address);
      await factory.connect(bob).buy(tokenAddr, USDC(1000), 0);
      const tokensReceived = await token.balanceOf(bob.address);

      await token.connect(bob).approve(await factory.getAddress(), tokensReceived);
      await factory.connect(bob).sell(tokenAddr, tokensReceived, 0);

      const endBalance = await usdc.balanceOf(bob.address);
      // Round-tripping through both fees should always cost the trader money, never
      // hand them a profit purely from rounding.
      expect(endBalance).to.be.lt(startBalance);
    });

    it("enforces slippage protection on buy", async function () {
      const { factory, alice, bob } = await deployFixture();
      await createToken(factory, alice, "First", "CAT");
      const tokenAddr = await getLastToken(factory, alice);
      await expect(
        factory.connect(bob).buy(tokenAddr, USDC(1000), TOKENS(999_999_999))
      ).to.be.revertedWith("slippage exceeded");
    });
  });

  describe("pause", function () {
    it("blocks createToken, buy, and sell while paused", async function () {
      const { factory, owner, alice, bob } = await deployFixture();
      await createToken(factory, alice, "First", "CAT");
      const tokenAddr = await getLastToken(factory, alice);

      await factory.connect(owner).pause();
      await expect(createToken(factory, bob, "X", "X")).to.be.reverted;
      await expect(factory.connect(bob).buy(tokenAddr, USDC(100), 0)).to.be.reverted;

      await factory.connect(owner).unpause();
      await expect(factory.connect(bob).buy(tokenAddr, USDC(100), 0)).to.not.be.reverted;
    });
  });

  describe("graduation", function () {
    it("graduates once the threshold is crossed and disables further curve trading", async function () {
      const { factory, owner, alice, bob, router } = await deployFixture();
      await factory.connect(owner).setRouter(await router.getAddress());
      await createToken(factory, alice, "First", "CAT");
      const tokenAddr = await getLastToken(factory, alice);

      // Buy enough to blow past the 67,000 USDC threshold in one shot.
      await factory.connect(bob).buy(tokenAddr, USDC(75_000), 0);

      const curve = await factory.curves(tokenAddr);
      expect(curve.state).to.equal(GRADUATED);

      await expect(factory.connect(bob).buy(tokenAddr, USDC(100), 0)).to.be.revertedWith(
        "curve not open for trading: check DEX or wait for graduation"
      );
    });

    // Behavior deliberately changed: graduation is now decoupled, so a router that
    // returns zero liquidity no longer unwinds the buy that triggered it. The trade
    // stands, the curve parks in GRADUATION_READY, and graduate() is what reports the
    // failure — retryably.
    it("does not unwind the triggering trade when the router returns zero liquidity", async function () {
      const { factory, owner, alice, bob, brokenRouter } = await deployFixture();
      await factory.connect(owner).setRouter(await brokenRouter.getAddress());
      await createToken(factory, alice, "First", "CAT");
      const tokenAddr = await getLastToken(factory, alice);

      await expect(factory.connect(bob).buy(tokenAddr, USDC(75_000), 0)).to.not.be.reverted;

      const curve = await factory.curves(tokenAddr);
      expect(curve.state).to.equal(GRADUATION_READY);

      await expect(factory.graduate(tokenAddr)).to.be.revertedWith(
        "graduation attempt failed -- check router and liquidity conditions"
      );
    });

    // Replaces the old "fails clearly if no router has been set yet" test, which
    // asserted that a token could launch and trade to its threshold with no router
    // configured, failing only at the graduation step. That is exactly the trap the
    // launch gate now removes: the failure has been moved forward to createToken(),
    // where nobody has money in the curve yet.
    it("refuses to launch at all while no router is configured", async function () {
      const [owner, treasury, alice] = await ethers.getSigners();
      const usdc = await (await ethers.getContractFactory("MockUSDC")).deploy();
      const bare = await (await ethers.getContractFactory("Ballista")).deploy(
        await usdc.getAddress(),
        treasury.address
      );
      await usdc.mint(alice.address, USDC(1_000_000));
      await usdc.connect(alice).approve(await bare.getAddress(), ethers.MaxUint256);

      await expect(createToken(bare, alice, "First", "CAT")).to.be.revertedWith(
        "router not set: launches are closed until a DEX is configured"
      );

      // ...and once a router exists, the same launch goes through unchanged.
      const router = await (await ethers.getContractFactory("MockRouter")).deploy();
      await bare.connect(owner).setRouter(await router.getAddress());
      await expect(createToken(bare, alice, "First", "CAT")).to.not.be.reverted;
    });
  });

  describe("constructor validation", function () {
    it("rejects zero addresses", async function () {
      const [, treasury] = await ethers.getSigners();
      const Factory = await ethers.getContractFactory("Ballista");
      await expect(Factory.deploy(ZERO, treasury.address)).to.be.reverted;
    });
  });
});

// Helper: pull the most recently created token address for a given creator by scanning
// TokenCreated events. Keeps tests readable instead of re-deriving addresses by hand.
async function getLastToken(factory, creator) {
  const filter = factory.filters.TokenCreated(null, creator.address);
  const events = await factory.queryFilter(filter);
  return events[events.length - 1].args.token;
}
