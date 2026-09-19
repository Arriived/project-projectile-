const { expect } = require('chai');
const { ethers } = require('hardhat');
const { activateRouter } = require('../routerHelper');
const { deployRegistryWithAsset, getBXR1Factory } = require('./assetRegistryHelper');

const ONE = 1_000_000n;
const USDC = (n) => BigInt(n) * ONE;
const ACTIVE = 0n;
const GRADUATION_READY = 1n;
const GRADUATED = 2n;

// CLAUDE.md section 26.6. MockBrokenRouter (contracts/mocks/MockRouter.sol) pulls BOTH
// sides of addLiquidity and returns liquidity == 0, which self-limits the damage to the
// draining curve alone: its own launched-token balance is zeroed too, so any retry's
// token-side transferFrom fails regardless of quote-asset balance elsewhere. A router
// that drains ONLY the quote side (contracts/bxr1/mocks/QuoteOnlyDrainRouter.sol) leaves
// that self-limit intact for the TOKEN side but not the quote side -- and BXR1 pools
// every curve's quote-asset balance in one ERC-20 balance, with no per-curve
// segregation at the token-contract level. So a later graduate() retry through a
// completely honest router can still succeed, silently paying A's already-spent stale
// realQuoteReserves claim out of curve B's separate, previously-safe pooled funds.
//
// This is a materially different and stronger finding than the existing "does not
// unwind the triggering trade" characterization test, which never reads BXR1's actual
// balances or touches a second curve -- it only confirms the triggering trade survives.
describe('BXR1 — cross-curve drain via a quote-only-draining router', function () {
  this.timeout(600000);

  async function env() {
    const [deployer, treasury, creator, buyerB, buyerA, attacker] = await ethers.getSigners();

    const usdc = await (await ethers.getContractFactory('MockUSDC')).deploy();
    const registry = await deployRegistryWithAsset(await usdc.getAddress());
    const ballista = await (await getBXR1Factory())
      .deploy(await registry.getAddress(), treasury.address, ethers.ZeroAddress);

    const honestRouter = await (await ethers.getContractFactory('MockRouter')).deploy();
    const drainRouter = await (await ethers.getContractFactory('QuoteOnlyDrainRouter')).deploy();

    await activateRouter(ballista, await honestRouter.getAddress());

    // Steady-state curve economics, not sniping -- disable the tax so the buys below
    // model normal post-window trading, exactly as the sibling suites do.
    await ballista.connect(deployer).publishSnipeTaxTable([]);

    for (const s of [creator, buyerB, buyerA]) {
      await usdc.mint(s.address, USDC(1_000_000));
      await usdc.connect(s).approve(await ballista.getAddress(), ethers.MaxUint256);
    }

    return { deployer, treasury, creator, buyerB, buyerA, attacker, usdc, registry, ballista, honestRouter, drainRouter };
  }

  async function launch(ballista, usdc, creator, symbol) {
    const hash = await ballista.currentEconomicsHash(await usdc.getAddress());
    const rc = await (await ballista.connect(creator)
      .createToken('Cross Curve', symbol, 'ipfs://a', await usdc.getAddress(), hash)).wait();
    return rc.logs.map((l) => { try { return ballista.interface.parseLog(l); } catch { return null; } })
      .find((l) => l && l.name === 'TokenCreated').args.token;
  }

  const advance = async (s = 30) => {
    await ethers.provider.send('evm_increaseTime', [s]);
    await ethers.provider.send('evm_mine');
  };

  // BXR1's actual quote-asset balance must always be enough to honor every curve's
  // own recorded realQuoteReserves plus every fee genuinely owed against that asset --
  // the same identity CLAUDE.md section 1.7 states for the original LFX1 contract,
  // now checked explicitly across TWO curves that never interacted with each other.
  async function assertSolvent(ballista, usdc, curveTokens, creators, label) {
    const asset = await usdc.getAddress();
    const balance = await usdc.balanceOf(await ballista.getAddress());

    let owed = await ballista.treasuryFeesAccrued(asset);
    for (const t of curveTokens) {
      owed += (await ballista.curves(t)).realQuoteReserves;
    }
    for (const c of creators) {
      owed += await ballista.creatorFeesAccrued(c, asset);
    }

    expect(balance, `${label}: BXR1's quote balance must cover every curve's recorded reserves plus accrued fees`)
      .to.be.gte(owed);
  }

  it('a quote-only drain on curve A lets graduate(A) siphon curve B\'s separate, untouched funds', async function () {
    const { creator, buyerB, buyerA, attacker, usdc, ballista, honestRouter, drainRouter } = await env();

    const tokenB = await launch(ballista, usdc, creator, 'CVB');
    const tokenA = await launch(ballista, usdc, creator, 'CVA');
    await advance();

    // B trades on the honest router, buying just under its own 8,000 USDC threshold
    // so it stays ACTIVE -- and so its own real reserves (~7,919 net of the 1% fee)
    // are large enough, combined with the ~162 USDC of fee/leftover the drain itself
    // generates, to cover the ~8,030.85 USDC A's stale claim will demand on retry.
    // B must never be touched by anything that happens to A.
    await ballista.connect(buyerB).buy(tokenB, USDC(7_999), 0);
    expect((await ballista.curves(tokenB)).state, 'B must stay ACTIVE').to.equal(ACTIVE);
    const bReservesBeforeAttack = (await ballista.curves(tokenB)).realQuoteReserves;

    await assertSolvent(ballista, usdc, [tokenA, tokenB], [creator], 'before the drain');

    // Swap to the quote-only drain router, then buy A past its own threshold. The
    // buy's own auto-graduation attempt runs against the drain router: it reports
    // liquidity == 0 (a legitimate-looking "graduation didn't take" outcome) but has
    // already pulled A's real quote reserves out of BXR1 via transferFrom.
    await activateRouter(ballista, await drainRouter.getAddress());

    let aBuyReverted = false;
    try {
      await ballista.connect(buyerA).buy(tokenA, USDC(9_000), 0);
    } catch (e) {
      aBuyReverted = true;
    }

    if (aBuyReverted) {
      // The fixed contract: the drain is refused at the source, inside A's own
      // triggering buy, so nothing about B is ever reachable. Confirm exactly that
      // and stop -- there is no attack left to continue.
      expect((await ballista.curves(tokenB)).realQuoteReserves, 'B must be completely untouched')
        .to.equal(bReservesBeforeAttack);
      await assertSolvent(ballista, usdc, [tokenA, tokenB], [creator], 'after the refused drain');
      const tokenBContract = await ethers.getContractAt('BXR1Token', tokenB);
      const bBalance = await tokenBContract.balanceOf(buyerB.address);
      await tokenBContract.connect(buyerB).approve(await ballista.getAddress(), bBalance);
      await expect(ballista.connect(buyerB).sell(tokenB, bBalance, 0), 'B must still be able to exit fully')
        .to.not.be.reverted;
      return;
    }

    // The unfixed contract: the buy itself is not unwound, A parks at
    // GRADUATION_READY, and its recorded realQuoteReserves is unchanged even though
    // the drain router already took the real money out of BXR1.
    expect((await ballista.curves(tokenA)).state, 'A must park at GRADUATION_READY').to.equal(GRADUATION_READY);

    // The invariant already breaks here, before graduate(A) is ever called: A's
    // stale claim has left the building, but the accounting still says it is owed.
    await assertSolvent(ballista, usdc, [tokenA, tokenB], [creator], 'immediately after the drain, before graduate(A)');

    // Swap back to the honest router and let an UNPRIVILEGED address retry -- exactly
    // as the permissionless-retry design intends, except the retry is now paid for
    // out of curve B's money rather than curve A's own (long-gone) money. Whether this
    // call itself reverts or succeeds is not the property under test -- either way,
    // B's solvency and B's ability to exit are what must hold, asserted next.
    await activateRouter(ballista, await honestRouter.getAddress());
    try {
      await ballista.connect(attacker).graduate(tokenA);
    } catch (e) {
      // Falls through to the assertions below regardless.
    }

    await assertSolvent(ballista, usdc, [tokenA, tokenB], [creator], 'after graduate(A)');

    // The concrete harm: B's own holder, who never touched A, cannot fully exit.
    const tokenBContract = await ethers.getContractAt('BXR1Token', tokenB);
    const bBalance = await tokenBContract.balanceOf(buyerB.address);
    await tokenBContract.connect(buyerB).approve(await ballista.getAddress(), bBalance);
    await expect(ballista.connect(buyerB).sell(tokenB, bBalance, 0), 'B must be able to sell its full position')
      .to.not.be.reverted;
  });
});
