const { expect } = require('chai');
const { ethers } = require('hardhat');
const { activateRouter } = require('./routerHelper');

const ONE = 1_000_000n;

// The standing accepted risk was that _settleBuy credits realUsdcReserves from the
// REQUESTED amount and never measured what actually arrived. Safe for Circle USDC;
// silently catastrophic for anything fee-on-transfer or rebasing, because the shortfall
// is socialised across every curve sharing the pooled balance and surfaces only when the
// last sellers and claimants find the pot short.
//
// The fix does NOT keep the launchpad working under such a token -- trading halts either
// way. It converts a silent, unbounded, socialised loss into a loud revert.
describe('LFX1 — USDC transfer integrity', function () {
  this.timeout(600000);

  async function env(usdcArtifact) {
    const [deployer, treasury, creator, a] = await ethers.getSigners();
    const usdc = await (await ethers.getContractFactory(usdcArtifact)).deploy();
    const ballista = await (await ethers.getContractFactory('LFX1'))
      .deploy(await usdc.getAddress(), treasury.address, ethers.ZeroAddress);
    const router = await (await ethers.getContractFactory('MockRouter')).deploy();
    await activateRouter(ballista, await router.getAddress());
    await ballista.setLaunchCooldown(0);
    for (const s of [creator, a]) {
      await usdc.mint(s.address, 50_000_000n * ONE);
      await usdc.connect(s).approve(await ballista.getAddress(), ethers.MaxUint256);
    }
    return { deployer, treasury, creator, a, usdc, ballista };
  }

  async function launch(ballista, creator, symbol) {
    const hash = await ballista.currentEconomicsHash();
    const rc = await (await ballista.connect(creator)
      .createToken('Fot', symbol, 'u', hash, false)).wait();
    return rc.logs.map((l) => { try { return ballista.interface.parseLog(l); } catch { return null; } })
      .find((l) => l && l.name === 'TokenCreated').args.token;
  }
  const past = async (s = 30) => {
    await ethers.provider.send('evm_increaseTime', [s]);
    await ethers.provider.send('evm_mine');
  };

  it('a fee-on-transfer USDC is rejected LOUDLY on buy, not credited silently', async function () {
    const { ballista, creator, a } = await env('MockFeeOnTransferUSDC');
    const t = await launch(ballista, creator, 'FOT');
    await past();
    await expect(ballista.connect(a).buy(t, 500n * ONE, 0))
      .to.be.revertedWithCustomError(ballista, 'UsdcTransferMismatch');
  });

  // KNOWN RESIDUAL, deliberately not closed. createToken credits treasuryFeesAccrued
  // from the requested creation fee without measuring what arrived, so a launch still
  // SUCCEEDS under a fee-on-transfer token and over-credits the treasury by the fee --
  // 1bp of 0.5 USDC here. Covering that site too was measured at +339 bytes, dropping
  // headroom from 557 to 218, to protect a rounding error in a scenario where buys
  // already revert and the launchpad is therefore dead. Not worth the budget.
  it('the creation-fee site is NOT covered -- launches still succeed, over-crediting', async function () {
    const { ballista, creator } = await env('MockFeeOnTransferUSDC');
    const before = await ballista.treasuryFeesAccrued();
    // launch() resolves to an address, not a transaction -- chai-matchers cannot read
    // it. Second time I have made this exact mistake; it fails loudly rather than
    // silently, which is the only reason it is cheap.
    const t = await launch(ballista, creator, 'FOT2');
    expect(t).to.properAddress;
    const credited = (await ballista.treasuryFeesAccrued()) - before;
    expect(credited, 'credited the full requested fee').to.equal(500_000n);
  });

  it('a well-behaved USDC is entirely unaffected', async function () {
    const { ballista, creator, a, usdc } = await env('MockUSDC');
    const t = await launch(ballista, creator, 'OK');
    await past();
    await expect(ballista.connect(a).buy(t, 500n * ONE, 0)).to.not.be.reverted;

    // And the pooled balance still backs every obligation exactly.
    const addr = await ballista.getAddress();
    const curve = await ballista.curves(t);
    const owed = curve.realUsdcReserves
      + (await ballista.creatorFeesAccrued(creator.address))
      + (await ballista.treasuryFeesAccrued());
    expect(await usdc.balanceOf(addr)).to.equal(owed);
  });

  it('measures the gas the check costs on a buy', async function () {
    const { ballista, creator, a } = await env('MockUSDC');
    const t = await launch(ballista, creator, 'GAS');
    await past();
    const rc = await (await ballista.connect(a).buy(t, 500n * ONE, 0)).wait();
    console.log(`        buy gasUsed with the balance-delta check: ${rc.gasUsed}`);
    // Not an assertion on an absolute figure -- that would break on any unrelated
    // change. The number is reported so the frontend's gas headroom can be sized.
    expect(rc.gasUsed).to.be.greaterThan(0n);
  });
});
