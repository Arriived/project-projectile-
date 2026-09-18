const { expect } = require('chai');
const { ethers } = require('hardhat');
const { deployRegistryWithAsset, getBXR1Factory } = require('./assetRegistryHelper');

const ONE = 1_000_000n;
const GRADUATED = 2n;
const READY = 1n;

// The adversarial-pair attack on graduation.
//
// Tokens circulate freely during the curve phase, so anyone can buy a little, create the
// USDC/TOKEN pair themselves, and seed it with dust at a ratio of their choosing before
// graduation. V2's _addLiquidity then deposits at THE PAIR'S ratio, not ours -- and with
// amountAMin/amountBMin both zero, every require in that path passes unconditionally.
//
// ⚠ These run against MockV2Router, which transcribes V2's optimal-amount branching from
// the real v2-periphery source but models nothing else -- no pair contract, no LP
// accounting, no k-invariant. Conclusions here are MOCK-VERIFIED, not fork-executed.
describe('BXR1 — graduation against an adversarial pair', function () {
  this.timeout(600000);

  async function env() {
    const [deployer, treasury, creator, a] = await ethers.getSigners();
    const usdc = await (await ethers.getContractFactory('MockUSDC')).deploy();
    const registry = await deployRegistryWithAsset(await usdc.getAddress());
    const ballista = await (await getBXR1Factory())
      .deploy(await registry.getAddress(), treasury.address, ethers.ZeroAddress);
    const router = await (await ethers.getContractFactory('MockV2Router')).deploy();
    await ballista.proposeRouter(await router.getAddress());
    await ethers.provider.send('evm_increaseTime', [86500]);
    await ethers.provider.send('evm_mine');
    await ballista.activateRouter(await router.getAddress());
    for (const s of [creator, a]) {
      await usdc.mint(s.address, 500_000_000n * ONE);
      await usdc.connect(s).approve(await ballista.getAddress(), ethers.MaxUint256);
    }
    return { deployer, treasury, creator, a, usdc, registry, ballista, router };
  }

  async function launch(ballista, usdc, creator, symbol) {
    const hash = await ballista.currentEconomicsHash(await usdc.getAddress());
    const rc = await (await ballista.connect(creator)
      .createToken('Pair', symbol, 'u', await usdc.getAddress(), hash)).wait();
    return rc.logs.map((l) => { try { return ballista.interface.parseLog(l); } catch { return null; } })
      .find((l) => l && l.name === 'TokenCreated').args.token;
  }
  const past = async (s = 30) => {
    await ethers.provider.send('evm_increaseTime', [s]);
    await ethers.provider.send('evm_mine');
  };

  it('CLEAN: no pre-existing pair deposits the full intended amounts', async function () {
    const { ballista, router, creator, a, usdc } = await env();
    const t = await launch(ballista, usdc, creator, 'CLEAN');
    await past();
    await ballista.connect(a).buy(t, 8_100n * ONE, 0);

    expect((await ballista.curves(t)).state).to.equal(GRADUATED);
    const token = await ethers.getContractAt('BXR1Token', t);
    // Nothing stranded: the factory holds no leftover of this token.
    expect(await token.balanceOf(await ballista.getAddress()),
      'the whole LP allocation must have been deposited').to.equal(0n);
    console.log(`        deposited ${ethers.formatUnits(await router.lastAmountA(), 18)} tokens ` +
      `/ ${ethers.formatUnits(await router.lastAmountB(), 6)} USDC`);
  });

  // SKEW A: the pair makes the token look EXPENSIVE, so V2's A-optimal branch fires.
  // BEFORE strict mins this deposited 8,019 of 193,297,304 tokens and STRANDED the rest
  // permanently, with c.tokenReserves already zeroed -- graduation reported success.
  it('DEFENDED skew A: graduation refuses rather than depositing a sliver', async function () {
    const { ballista, router, creator, a, usdc } = await env();
    const t = await launch(ballista, usdc, creator, 'SKEWA');
    await router.seedPair(t, await usdc.getAddress(), 10n ** 18n, ONE);
    await past();
    // The buy itself still succeeds -- graduation is decoupled from the triggering trade.
    await ballista.connect(a).buy(t, 8_100n * ONE, 0);

    const curve = await ballista.curves(t);
    expect(curve.state, 'must park at GRADUATION_READY, not GRADUATED').to.equal(READY);

    // Nothing left the factory, and the accounting still says so -- the reserves are
    // intact and retryable rather than zeroed against a deposit that never happened.
    const token = await ethers.getContractAt('BXR1Token', t);
    expect(await router.lastAmountA(), 'the router took nothing').to.equal(0n);
    expect(curve.realQuoteReserves, 'USDC reserves preserved').to.be.greaterThan(0n);
    expect(await token.balanceOf(await ballista.getAddress()),
      'the full LP allocation is still held, not stranded').to.be.greaterThan(0n);

    // And an explicit retry fails loudly rather than silently mis-depositing.
    await expect(ballista.graduate(t))
      .to.be.revertedWithCustomError(ballista, 'GraduationFailed');
  });

  // SKEW B: the pair makes the token look CHEAP, so the B-optimal branch fires. BEFORE
  // strict mins this deposited 193.30 USDC of ~8,019 and stranded 97.6% of the proceeds.
  it('DEFENDED skew B: graduation refuses rather than depositing 2% of the USDC', async function () {
    const { ballista, router, creator, a, usdc } = await env();
    const t = await launch(ballista, usdc, creator, 'SKEWB');
    await router.seedPair(t, await usdc.getAddress(), 10n ** 24n, ONE);
    await past();
    await ballista.connect(a).buy(t, 8_100n * ONE, 0);

    const curve = await ballista.curves(t);
    expect(curve.state).to.equal(READY);
    expect(await router.lastAmountB(), 'no USDC reached the pool').to.equal(0n);
    expect(curve.realQuoteReserves, 'reserves preserved for a later retry')
      .to.be.greaterThan(8_000n * ONE);
  });

  // The recovery path: once the pair is at our ratio, the SAME curve graduates. This is
  // what makes the mins fix a liveness cost rather than a permanent strand -- but note it
  // is a race in the open, which is what the helper contract closes.
  it('RETRY: correcting the pair ratio lets the parked curve graduate', async function () {
    const { ballista, router, creator, a, usdc } = await env();
    const t = await launch(ballista, usdc, creator, 'RETRY');
    await router.seedPair(t, await usdc.getAddress(), 10n ** 18n, ONE);
    await past();
    await ballista.connect(a).buy(t, 8_100n * ONE, 0);
    expect((await ballista.curves(t)).state).to.equal(READY);

    // Move the pair onto the curve's closing ratio.
    const c = await ballista.curves(t);
    const lp = await ballista.LP_TOKEN_RESERVE();
    await router.seedPair(t, await usdc.getAddress(), lp + c.tokenReserves, c.realQuoteReserves);

    await expect(ballista.graduate(t)).to.not.be.reverted;
    expect((await ballista.curves(t)).state).to.equal(GRADUATED);
    console.log(`        after correction: deposited ${ethers.formatUnits(await router.lastAmountA(), 18)} tokens ` +
      `/ ${ethers.formatUnits(await router.lastAmountB(), 6)} USDC`);
  });

  it('token address ordering: works with the token both above and below USDC', async function () {
    const { ballista, router, creator, a, usdc } = await env();
    const usdcAddr = (await usdc.getAddress()).toLowerCase();
    let above = null, below = null;
    // Launch until both orderings have been seen; CREATE addresses vary by nonce.
    for (let i = 0; i < 12 && (!above || !below); i++) {
      const t = await launch(ballista, usdc, creator, 'ORD' + i);
      if (t.toLowerCase() > usdcAddr && !above) above = t;
      if (t.toLowerCase() < usdcAddr && !below) below = t;
    }
    expect(above, 'need a token sorting ABOVE usdc').to.not.equal(null);
    expect(below, 'need a token sorting BELOW usdc').to.not.equal(null);
    await past();
    for (const t of [above, below]) {
      await ballista.connect(a).buy(t, 8_100n * ONE, 0);
      expect((await ballista.curves(t)).state, `ordering case ${t}`).to.equal(GRADUATED);
    }
    console.log(`        above usdc: ${above}\n        below usdc: ${below}`);
  });
});
