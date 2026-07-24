const { expect } = require("chai");
const { ethers } = require("hardhat");
const fs = require("fs");
const path = require("path");

const USDC = (n) => ethers.parseUnits(n.toString(), 6);
const TOKENS = (n) => ethers.parseUnits(n.toString(), 18);
const ZERO = "0x0000000000000000000000000000000000000000";
const BURN = "0x000000000000000000000000000000000000dEaD";

function loadArtifact(name) {
  const p = path.join(__dirname, "..", "artifacts-manual", name + ".json");
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

async function deployByName(name, signer, ...args) {
  const { abi, bytecode } = loadArtifact(name);
  const factory = new ethers.ContractFactory(abi, bytecode, signer);
  const contract = await factory.deploy(...args);
  await contract.waitForDeployment();
  return contract;
}

async function deployFixture() {
  const [owner, treasury, alice, bob] = await ethers.getSigners();

  const usdc = await deployByName("MockUSDC", owner);
  const factory = await deployByName("ArcLaunchFactory", owner, await usdc.getAddress(), treasury.address);
  const router = await deployByName("MockRouter", owner);
  const brokenRouter = await deployByName("MockBrokenRouter", owner);

  // Fund alice and bob generously, approve the factory.
  for (const wallet of [alice, bob]) {
    await usdc.mint(wallet.address, USDC(1_000_000));
    await usdc.connect(wallet).approve(await factory.getAddress(), ethers.MaxUint256);
  }

  return { owner, treasury, alice, bob, usdc, factory, router, brokenRouter };
}

describe("ArcLaunchFactory", function () {
  describe("createToken", function () {
    it("mints the full fixed supply to the factory, not the creator", async function () {
      const { factory, alice, usdc } = await deployFixture();
      const tx = await factory.connect(alice).createToken("Test Cat", "CAT", "ipfs://meta");
      const receipt = await tx.wait();
      const event = receipt.logs
        .map((l) => { try { return factory.interface.parseLog(l); } catch { return null; } })
        .find((l) => l && l.name === "TokenCreated");
      const tokenAddr = event.args.token;

      const token = new ethers.Contract(tokenAddr, loadArtifact("ArcLaunchToken").abi, alice);
      expect(await token.balanceOf(await factory.getAddress())).to.equal(TOKENS(1_000_000_000));
      expect(await token.balanceOf(alice.address)).to.equal(0n);
      expect(await token.creator()).to.equal(alice.address);
    });

    it("has no mint function reachable from outside the constructor", async function () {
      const { factory, alice } = await deployFixture();
      await factory.connect(alice).createToken("Test Cat", "CAT", "ipfs://meta");
      const abi = loadArtifact("ArcLaunchToken").abi;
      const hasMint = abi.some((f) => f.type === "function" && f.name === "mint");
      expect(hasMint).to.equal(false);
    });

    it("enforces the per-wallet launch cooldown", async function () {
      const { factory, alice } = await deployFixture();
      await factory.connect(alice).createToken("First", "FIRST", "uri");
      await expect(
        factory.connect(alice).createToken("Second", "SECOND", "uri")
      ).to.be.revertedWith("cooldown: wait before launching again");
    });

    it("allows a new launch after the cooldown elapses", async function () {
      const { factory, alice } = await deployFixture();
      await factory.connect(alice).createToken("First", "FIRST", "uri");
      await ethers.provider.send("evm_increaseTime", [3600]);
      await ethers.provider.send("evm_mine");
      await expect(factory.connect(alice).createToken("Second", "SECOND", "uri")).to.not.be.reverted;
    });

    it("blocks exact-duplicate symbols", async function () {
      const { factory, alice, bob } = await deployFixture();
      await factory.connect(alice).createToken("First", "DUPE", "uri");
      await expect(
        factory.connect(bob).createToken("Copycat", "DUPE", "uri")
      ).to.be.revertedWith("symbol already launched");
    });

    it("blocks case-variant duplicate symbols (CAT vs cat)", async function () {
      const { factory, alice, bob } = await deployFixture();
      await factory.connect(alice).createToken("First", "CAT", "uri");
      await expect(
        factory.connect(bob).createToken("Copycat", "cat", "uri")
      ).to.be.revertedWith("symbol already launched");
    });

    it("charges the creation fee to treasury", async function () {
      const { factory, alice, treasury, usdc } = await deployFixture();
      const before = await usdc.balanceOf(treasury.address);
      await factory.connect(alice).createToken("First", "CAT", "uri");
      const after = await usdc.balanceOf(treasury.address);
      expect(after - before).to.equal(USDC(5));
    });

    it("snapshots the current default fees/threshold into the new curve", async function () {
      const { factory, alice } = await deployFixture();
      await factory.connect(alice).createToken("First", "CAT", "uri");
      const tokenAddr = await getLastToken(factory, alice);
      const curve = await factory.curves(tokenAddr);
      expect(curve.buyFeeBps).to.equal(100);
      expect(curve.sellFeeBps).to.equal(100);
      expect(curve.graduationThresholdUsdc).to.equal(USDC(69_000));
    });
  });

  describe("fee changes do not retroactively affect live tokens", function () {
    it("a token launched before a fee change keeps its original fee", async function () {
      const { factory, alice, bob, owner, usdc, treasury } = await deployFixture();
      await factory.connect(alice).createToken("First", "CAT", "uri");
      const tokenAddr = await getLastToken(factory, alice);

      // Owner cranks the default fee up for future launches.
      await factory.connect(owner).setDefaultFees(900, 900); // 9%

      // Bob buys into the OLD token — should still be charged the 1% it launched with,
      // not the new 9% default.
      const treasuryBefore = await usdc.balanceOf(treasury.address);
      await factory.connect(bob).buy(tokenAddr, USDC(1000), 0);
      const treasuryAfter = await usdc.balanceOf(treasury.address);
      const feeCharged = treasuryAfter - treasuryBefore;
      expect(feeCharged).to.equal(USDC(10)); // 1% of 1000, not 9%
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
      await factory.connect(alice).createToken("First", "CAT", "uri");
      const tokenAddr = await getLastToken(factory, alice);

      const priceBefore = await factory.currentPrice(tokenAddr);
      await factory.connect(bob).buy(tokenAddr, USDC(5000), 0);
      const priceAfter = await factory.currentPrice(tokenAddr);
      expect(priceAfter).to.be.gt(priceBefore);
    });

    it("does not let a trader extract more value than they put in via rounding (buy then sell)", async function () {
      const { factory, alice, bob, usdc } = await deployFixture();
      await factory.connect(alice).createToken("First", "CAT", "uri");
      const tokenAddr = await getLastToken(factory, alice);
      const token = new ethers.Contract(tokenAddr, loadArtifact("ArcLaunchToken").abi, bob);

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
      await factory.connect(alice).createToken("First", "CAT", "uri");
      const tokenAddr = await getLastToken(factory, alice);
      await expect(
        factory.connect(bob).buy(tokenAddr, USDC(1000), TOKENS(999_999_999))
      ).to.be.revertedWith("slippage exceeded");
    });
  });

  describe("pause", function () {
    it("blocks createToken, buy, and sell while paused", async function () {
      const { factory, owner, alice, bob } = await deployFixture();
      await factory.connect(alice).createToken("First", "CAT", "uri");
      const tokenAddr = await getLastToken(factory, alice);

      await factory.connect(owner).pause();
      await expect(factory.connect(bob).createToken("X", "X", "uri")).to.be.reverted;
      await expect(factory.connect(bob).buy(tokenAddr, USDC(100), 0)).to.be.reverted;

      await factory.connect(owner).unpause();
      await expect(factory.connect(bob).buy(tokenAddr, USDC(100), 0)).to.not.be.reverted;
    });
  });

  describe("graduation", function () {
    it("graduates once the threshold is crossed and disables further curve trading", async function () {
      const { factory, owner, alice, bob, router } = await deployFixture();
      await factory.connect(owner).setRouter(await router.getAddress());
      await factory.connect(alice).createToken("First", "CAT", "uri");
      const tokenAddr = await getLastToken(factory, alice);

      // Buy enough to blow past the 69,000 USDC threshold in one shot.
      await factory.connect(bob).buy(tokenAddr, USDC(75_000), 0);

      const curve = await factory.curves(tokenAddr);
      expect(curve.graduated).to.equal(true);

      await expect(factory.connect(bob).buy(tokenAddr, USDC(100), 0)).to.be.revertedWith(
        "already graduated: trade on the DEX"
      );
    });

    it("reverts the whole graduation if the router returns zero liquidity", async function () {
      const { factory, owner, alice, bob, brokenRouter } = await deployFixture();
      await factory.connect(owner).setRouter(await brokenRouter.getAddress());
      await factory.connect(alice).createToken("First", "CAT", "uri");
      const tokenAddr = await getLastToken(factory, alice);

      await expect(factory.connect(bob).buy(tokenAddr, USDC(75_000), 0)).to.be.revertedWith(
        "graduation failed: router returned no liquidity"
      );
    });

    it("fails clearly if no router has been set yet", async function () {
      const { factory, alice, bob } = await deployFixture();
      await factory.connect(alice).createToken("First", "CAT", "uri");
      const tokenAddr = await getLastToken(factory, alice);
      await expect(factory.connect(bob).buy(tokenAddr, USDC(75_000), 0)).to.be.revertedWith(
        "router not set: no confirmed Arc DEX yet"
      );
    });
  });

  describe("constructor validation", function () {
    it("rejects zero addresses", async function () {
      const [owner, treasury] = await ethers.getSigners();
      const { abi, bytecode } = loadArtifact("ArcLaunchFactory");
      const Factory = new ethers.ContractFactory(abi, bytecode, owner);
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
