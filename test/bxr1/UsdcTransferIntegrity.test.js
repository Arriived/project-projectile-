const { expect } = require('chai');
const { ethers } = require('hardhat');
const { activateRouter } = require('../routerHelper');
const { deployRegistryWithAsset, getBXR1Factory } = require('./assetRegistryHelper');

const ONE = 1_000_000n;

// The standing accepted risk was that _settleBuy credits realQuoteReserves from the
// REQUESTED amount and never measured what actually arrived. Safe for Circle USDC;
// silently catastrophic for anything fee-on-transfer or rebasing, because the shortfall
// is socialised across every curve sharing the pooled balance and surfaces only when the
// last sellers and claimants find the pot short.
//
// The fix does NOT keep the launchpad working under such a token -- trading halts either
// way. It converts a silent, unbounded, socialised loss into a loud revert.
describe('BXR1 — USDC transfer integrity', function () {
  this.timeout(600000);

  async function env(usdcArtifact) {
    const [deployer, treasury, creator, a] = await ethers.getSigners();
    const usdc = await (await ethers.getContractFactory(usdcArtifact)).deploy();
    // Registered as well-behaved regardless of usdcArtifact -- these tests are precisely
    // about the balance-delta check catching a transfer shortfall the registry gate did
    // NOT flag (a registry mistake, or an asset that turns fee-on-transfer after it was
    // registered). Registering MockFeeOnTransferUSDC with transferFee: true would make
    // createToken's asset gate refuse it outright, which is a different test entirely.
    const registry = await deployRegistryWithAsset(await usdc.getAddress());
    const ballista = await (await getBXR1Factory())
      .deploy(await registry.getAddress(), treasury.address, ethers.ZeroAddress);
    const router = await (await ethers.getContractFactory('MockRouter')).deploy();
    await activateRouter(ballista, await router.getAddress());
    for (const s of [creator, a]) {
      await usdc.mint(s.address, 50_000_000n * ONE);
      await usdc.connect(s).approve(await ballista.getAddress(), ethers.MaxUint256);
    }
    return { deployer, treasury, creator, a, usdc, registry, ballista };
  }

  async function launch(ballista, usdc, creator, symbol) {
    const hash = await ballista.currentEconomicsHash(await usdc.getAddress());
    const rc = await (await ballista.connect(creator)
      .createToken('Fot', symbol, 'u', await usdc.getAddress(), hash)).wait();
    return rc.logs.map((l) => { try { return ballista.interface.parseLog(l); } catch { return null; } })
      .find((l) => l && l.name === 'TokenCreated').args.token;
  }
  const past = async (s = 30) => {
    await ethers.provider.send('evm_increaseTime', [s]);
    await ethers.provider.send('evm_mine');
  };

  it('a fee-on-transfer USDC is rejected LOUDLY on buy, not credited silently', async function () {
    const { ballista, usdc, creator, a } = await env('MockFeeOnTransferUSDC');
    const t = await launch(ballista, usdc, creator, 'FOT');
    await past();
    await expect(ballista.connect(a).buy(t, 500n * ONE, 0))
      .to.be.revertedWithCustomError(ballista, 'QuoteTransferMismatch');
  });

  // KNOWN RESIDUAL, deliberately not closed. createToken credits treasuryFeesAccrued
  // from the requested creation fee without measuring what arrived, so a launch still
  // SUCCEEDS under a fee-on-transfer token and over-credits the treasury by the fee --
  // 1bp of 0.5 USDC here. Covering that site too was measured at +339 bytes, dropping
  // headroom from 557 to 218, to protect a rounding error in a scenario where buys
  // already revert and the launchpad is therefore dead. Not worth the budget.
  it('the creation-fee site is NOT covered -- launches still succeed, over-crediting', async function () {
    const { ballista, usdc, creator } = await env('MockFeeOnTransferUSDC');
    const before = await ballista.treasuryFeesAccrued(await usdc.getAddress());
    // launch() resolves to an address, not a transaction -- chai-matchers cannot read
    // it. Second time I have made this exact mistake; it fails loudly rather than
    // silently, which is the only reason it is cheap.
    const t = await launch(ballista, usdc, creator, 'FOT2');
    expect(t).to.properAddress;
    const credited = (await ballista.treasuryFeesAccrued(await usdc.getAddress())) - before;
    expect(credited, 'credited the full requested fee').to.equal(500_000n);
  });

  it('a well-behaved USDC is entirely unaffected', async function () {
    const { ballista, creator, a, usdc } = await env('MockUSDC');
    const t = await launch(ballista, usdc, creator, 'OK');
    await past();
    await expect(ballista.connect(a).buy(t, 500n * ONE, 0)).to.not.be.reverted;

    // And the pooled balance still backs every obligation exactly.
    const addr = await ballista.getAddress();
    const curve = await ballista.curves(t);
    const owed = curve.realQuoteReserves
      + (await ballista.creatorFeesAccrued(creator.address, await usdc.getAddress()))
      + (await ballista.treasuryFeesAccrued(await usdc.getAddress()));
    expect(await usdc.balanceOf(addr)).to.equal(owed);
  });

  it('measures the gas the check costs on a buy', async function () {
    const { ballista, usdc, creator, a } = await env('MockUSDC');
    const t = await launch(ballista, usdc, creator, 'GAS');
    await past();
    const rc = await (await ballista.connect(a).buy(t, 500n * ONE, 0)).wait();
    console.log(`        buy gasUsed with the balance-delta check: ${rc.gasUsed}`);
    // Not an assertion on an absolute figure -- that would break on any unrelated
    // change. The number is reported so the frontend's gas headroom can be sized.
    expect(rc.gasUsed).to.be.greaterThan(0n);
  });
});
