const { expect } = require('chai');
const { ethers } = require('hardhat');
const { deployBoundPair } = require('./helpers/v4deploy');

// BallistaPoolCorrector against REAL Uniswap v4, on a pinned Base fork.
//
//   FORK_BASE=1 npx hardhat test test/Fork.v4.corrector.test.js
//
// ⚠ RUN THIS FILE ALONE. Two fork suites in one mocha process time out --
// mainnet.base.org rate-limits once their archive fetches interleave, and it presents as a
// hang rather than a failure (CLAUDE.md §16.2).
//
// ⚠ WHAT THIS CANNOT COVER. Real v4, and NOTHING about Arc -- not the blocklist, not
// EIP-7708, not the truncating 6dp balanceOf (§4). Arc Testnet has no v4 at all (§15.8).
//
// The safety argument is that the corrector has NO SETTLE PATH, so a correction that would
// cost anything reverts on CurrencyNotSettled rather than being paid for. C2 is that
// argument as an assertion rather than a comment claiming it.
const FORK_BLOCK = 50900000;
const POOL_MANAGER = '0x498581ff718922c3f8e6a244956af099b2652b2b';
const POSITION_MANAGER = '0x7c5f5a4bbd8fd63184577525326123b519429bdc';
const PERMIT2 = '0x000000000022D473030F116dDEE9F6B43aC78BA3';
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const BURN = '0x000000000000000000000000000000000000dEaD';

const ONE = 1_000_000n;
const Q96 = 1n << 96n;
const POOL_FEE = 0;
const TICK_SPACING = 60;

const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function transfer(address,uint256) returns (bool)',
  'function approve(address,uint256) returns (bool)',
  'function decimals() view returns (uint8)',
];
const POSM_ABI = [
  'function nextTokenId() view returns (uint256)',
  'function ownerOf(uint256) view returns (address)',
  'function getPositionLiquidity(uint256) view returns (uint128)',
];
const PM_ABI = [
  'function initialize((address,address,uint24,int24,address) key, uint160 sqrtPriceX96) returns (int24)',
];

describe('BallistaPoolCorrector — real Uniswap v4 (Base fork)', function () {
  this.timeout(1800000);

  let owner, treasury, creator, buyer, attacker;
  let usdc, posm, pm, lens, math, adapter, ballista, forwarder, hookAddress, corrector;

  before(async function () {
    if (!process.env.FORK_BASE) this.skip();
    expect(await ethers.provider.getBlockNumber(), 'not forked at the pinned block')
      .to.be.greaterThanOrEqual(FORK_BLOCK);
    await ethers.provider.send('evm_mine', []); // latest == fork block reads as historical
    for (const [n, a] of [['PoolManager', POOL_MANAGER], ['PositionManager', POSITION_MANAGER],
      ['Permit2', PERMIT2], ['USDC', USDC]]) {
      expect(await ethers.provider.getCode(a), `${n} has NO CODE -- fork did not take`).to.not.equal('0x');
    }
  });

  async function fundUsdc(address, amount) {
    const token = new ethers.Contract(USDC, ERC20_ABI, ethers.provider);
    for (let slot = 0; slot < 20; slot++) {
      const key = ethers.solidityPackedKeccak256(['uint256', 'uint256'], [address, slot]);
      const before = await ethers.provider.send('eth_getStorageAt', [USDC, key, 'latest']);
      await ethers.provider.send('hardhat_setStorageAt', [USDC, key, ethers.toBeHex(amount, 32)]);
      if ((await token.balanceOf(address)) === amount) return slot;
      await ethers.provider.send('hardhat_setStorageAt', [USDC, key, before]);
    }
    throw new Error('could not locate the Base USDC balance slot');
  }

  async function deployAll() {
    [owner, treasury, creator, buyer, attacker] = await ethers.getSigners();
    usdc = new ethers.Contract(USDC, ERC20_ABI, ethers.provider);
    posm = new ethers.Contract(POSITION_MANAGER, POSM_ABI, ethers.provider);
    pm = new ethers.Contract(POOL_MANAGER, PM_ABI, attacker);

    lens = await (await ethers.getContractFactory('V4PoolLens')).deploy();
    // The harness inherits the adapter, so the adapter's hook checks run on it too and it
    // needs its own correctly-flagged, correctly-bound MockHookBinding. Deployed BEFORE
    // the nonce is read below, so it does not shift the LFX1 prediction.
    math = (await deployBoundPair(owner, 'MockHookBinding', [], 'V4AdapterMathHarness', [])).adapter;
    // ⚠ THE FORWARDER IS THE ADAPTER'S `lfx1` AND ALSO LFX1'S ROUTER.
    // The adapter accepts one caller (CLAUDE.md 20.6). These suites need BOTH a real
    // graduation and an attacker driving the adapter directly, so a permissionless
    // forwarder sits in the middle. That reproduces the PRE-GATE world on purpose: the
    // attacks below are retained as defence in depth, each paired with a sibling proving
    // the same attack is refused on the real, gated configuration.
    forwarder = await (await ethers.getContractFactory('MockLfx1Caller')).deploy();
    const forwarderAddr = await forwarder.getAddress();

    // ⚠ EVERYTHING THAT IS NOT THE PAIR OR LFX1 IS DEPLOYED BEFORE THE NONCE IS READ.
    // The prediction below counts transactions, so anything slipped in between silently
    // shifts LFX1's address -- which the hook then rejects. Keep this ordering.
    corrector = await (await ethers.getContractFactory('BallistaPoolCorrector')).deploy(POOL_MANAGER);

    const nonce0 = await ethers.provider.getTransactionCount(owner.address);
    const predictedBallista = ethers.getCreateAddress({ from: owner.address, nonce: nonce0 + 3 });
    const pair = await deployBoundPair(
      owner,
      'BallistaFeeHook',
      [POOL_MANAGER, predictedBallista, USDC, treasury.address],
      'BallistaV4Adapter',
      [POOL_MANAGER, POSITION_MANAGER, PERMIT2, forwarderAddr]
    );
    adapter = pair.adapter;
    hookAddress = pair.hookAddress;
    await (await forwarder.setAdapter(await adapter.getAddress())).wait();
    ballista = await (await ethers.getContractFactory('LFX1')).deploy(
      USDC, treasury.address, forwarderAddr
    );
    expect(await ballista.getAddress(), 'CREATE prediction missed -- the hook would reject this LFX1')
      .to.equal(predictedBallista);
    for (const s of [creator, buyer, attacker]) {
      await fundUsdc(s.address, 500_000n * ONE);
      await usdc.connect(s).approve(await ballista.getAddress(), ethers.MaxUint256);
    }
  }

  async function launch(symbol) {
    const hash = await ballista.currentEconomicsHash();
    const rc = await (await ballista.connect(creator).createToken('Corr', symbol, '', hash, false)).wait();
    const ev = rc.logs.map((l) => { try { return ballista.interface.parseLog(l); } catch { return null; } })
      .filter(Boolean).find((l) => l.name === 'TokenCreated');
    await ethers.provider.send('evm_mine', []);
    return ev.args.token;
  }

  async function tryGraduate(token, usdcIn = 8_100n * ONE) {
    await ethers.provider.send('evm_increaseTime', [30]);
    await ethers.provider.send('evm_mine', []);
    const rc = await (await ballista.connect(buyer).buy(token, usdcIn, 0)).wait();
    const parsed = rc.logs.map((l) => { try { return ballista.interface.parseLog(l); } catch { return null; } })
      .filter(Boolean);
    return { curve: await ballista.curves(token), graduated: parsed.find((l) => l.name === 'Graduated') };
  }

  // Buys up to JUST BELOW the graduation threshold and returns the live curve.
  //
  // ⚠ NEEDED BECAUSE GRADUATION NOW SUCCEEDS. These tests used to reach a populated curve
  // by attempting a graduation and having it PARK on a poisoned pool. The hooked pool is
  // unpoisonable, so that attempt completes, and a GRADUATED curve has zeroed reserves --
  // which made targetFor divide by zero. The failure read as a math bug and was a stale
  // premise. This fills the curve without crossing the threshold instead.
  async function fillCurve(token, usdcIn = 7_000n * ONE) {
    await ethers.provider.send('evm_increaseTime', [30]);
    await ethers.provider.send('evm_mine', []);
    await (await ballista.connect(buyer).buy(token, usdcIn, 0)).wait();
    const curve = await ballista.curves(token);
    expect(curve.state, 'the curve graduated early -- reduce usdcIn').to.equal(0n);
    expect(curve.realUsdcReserves, 'curve has no reserves, so no target can be derived')
      .to.be.greaterThan(0n);
    return curve;
  }

  // ⚠ THE CORRECTOR'S JOB IS NOW HOOKLESS POOLS, AND THAT IS WHY THIS EXISTS.
  //
  // It was built (CLAUDE.md 17.6) for CLAUDE.md 16.1's F1: an EMPTY pool poisoned for gas
  // alone, permissionlessly, before the token even existed. The two-ended gate closed that
  // on HOOKED pools -- BallistaFeeHook.beforeInitialize admits only `sender == adapter`,
  // so nobody else can initialise one at any price. Four tests in this file failed at
  // SETUP after the gate landed, unable to construct their own premise.
  //
  // The contract still has a real job, narrower than when it was written:
  //   - the v2 fallback is live and fully verified on Arc mainnet (CLAUDE.md 20.2), and
  //   - ANY hookless v4 pool remains poisonable by anyone, because v4 pool initialisation
  //     is permissionless when there is no hook to say otherwise.
  // It is ownerless, holds no funds and is not in the graduation path, so carrying it as
  // insurance for the v2 branch costs nothing.
  //
  // So the poisoning tests below build a HOOKLESS key. That is not a workaround for the
  // gate -- it is the configuration the contract now exists to serve.
  function hooklessKeyFor(token) {
    const k = poolKeyFor(token);
    return { key: { ...k.key, hooks: ethers.ZeroAddress }, tokenIsCurrency0: k.tokenIsCurrency0 };
  }

  function poolKeyFor(token) {
    const t0 = BigInt(token) < BigInt(USDC);
    return {
      key: {
        currency0: t0 ? token : USDC, currency1: t0 ? USDC : token,
        fee: POOL_FEE, tickSpacing: TICK_SPACING, hooks: hookAddress,
      },
      tokenIsCurrency0: t0,
    };
  }
  const keyTuple = (k) => [k.currency0, k.currency1, k.fee, k.tickSpacing, k.hooks];

  // The target the adapter will demand, derived the way it does -- from the amounts LFX1
  // will hand it. Computed OFF-CHAIN on purpose: the corrector deliberately carries no
  // price math, so there is exactly one on-chain implementation and nothing to drift
  // (§14.2.1). This uses the adapter's own math via the harness, which INHERITS the
  // adapter rather than restating it.
  async function targetFor(token, curve) {
    const LP = await ballista.LP_TOKEN_RESERVE();
    const tokenLiquidity = LP + curve.tokenReserves;
    const usdcLiquidity = curve.realUsdcReserves + curve.poolBoost;
    const { tokenIsCurrency0 } = poolKeyFor(token);
    const [a0, a1] = tokenIsCurrency0
      ? [tokenLiquidity, usdcLiquidity] : [usdcLiquidity, tokenLiquidity];
    return math.sqrtPriceX96(a0, a1);
  }

  async function correctorBalances(token) {
    const addr = await corrector.getAddress();
    return {
      token: await new ethers.Contract(token, ERC20_ABI, ethers.provider).balanceOf(addr),
      usdc: await usdc.balanceOf(addr),
      native: await ethers.provider.getBalance(addr),
    };
  }

  it('C1. poison an empty hookless pool, then correct it, in one permissionless call', async function () {
    // ⚠ RE-SCOPED, NOT WEAKENED. This used to end "...and graduate", poisoning the pool
    // graduation would use. It cannot any more: graduation uses the HOOKED key and that
    // pool is unpoisonable, while the poisoned pool here carries no hook and is therefore
    // a different PoolId entirely. Asserting graduation after correcting an unrelated
    // pool would have been a test passing for a reason unrelated to its name (16.4).
    //
    // What remains is the corrector's actual job on the configuration where the hole is
    // still open: an empty, hookless, permissionlessly-initialised pool at a hostile
    // price, moved to an exact target by anyone, for gas alone.
    await deployAll();
    const token = await launch('C1');
    const { key } = hooklessKeyFor(token);

    // Poison: initialise at ~1e12x the correct price. Permissionless, because no hook.
    await pm.initialize(keyTuple(key), Q96);
    const [poisoned] = await lens.slot0(POOL_MANAGER, key);
    expect(poisoned, 'the pool was not poisoned, so nothing below is testing a correction')
      .to.equal(Q96);

    // The target is the price the curve's own reserves imply, computed with the ADAPTER's
    // math via the harness, so there is one implementation and nothing to drift.
    const curve = await fillCurve(token);
    const target = await targetFor(token, curve);
    expect(target, 'target must differ from the poison or the correction proves nothing')
      .to.not.equal(poisoned);

    const rc = await (await corrector.connect(attacker).correct(keyTuple(key), target)).wait();

    const [after] = await lens.slot0(POOL_MANAGER, key);
    expect(after, 'the pool was not moved to the target').to.equal(target);

    const ev = rc.logs.map((l) => { try { return corrector.interface.parseLog(l); } catch { return null; } })
      .filter(Boolean).find((l) => l.name === 'PoolCorrected');
    expect(ev, 'no PoolCorrected event').to.not.be.undefined;
    expect(ev.args.toSqrtPriceX96).to.equal(target);
    expect(ev.args.fromSqrtPriceX96).to.equal(Q96);

    // The corrector is ownerless and has no settle path; it must end holding nothing.
    const bal = await correctorBalances(token);
    expect(bal.token, 'corrector kept tokens').to.equal(0n);
    expect(bal.usdc, 'corrector kept USDC').to.equal(0n);

    console.log(`      C1  poisoned -> corrected in ${rc.gasUsed} gas, by an account with no standing`);
  });

  it('C2. correcting a pool that HOLDS LIQUIDITY reverts with CurrencyNotSettled', async function () {
    await deployAll();
    const token = await launch('C2');
    const { key } = poolKeyFor(token);
    const adapterAddr = await adapter.getAddress();
    // The forwarder pulls from the caller and re-approves the adapter, so approvals
    // now target the forwarder rather than the adapter itself.
    const spender = await forwarder.getAddress();

    // Give the pool real liquidity at a wrong price, using the adapter itself: it derives
    // the price from the amounts it is handed, so choosing the amounts chooses the price.
    await ethers.provider.send('evm_increaseTime', [30]);
    await ethers.provider.send('evm_mine', []);
    await ballista.connect(attacker).buy(token, 2_000n * ONE, 0);
    const launched = new ethers.Contract(token, ERC20_ABI, attacker);
    const atkTokens = await launched.balanceOf(attacker.address);
    await launched.approve(spender, ethers.MaxUint256);
    await usdc.connect(attacker).approve(spender, ethers.MaxUint256);
    const deadline = (await ethers.provider.getBlock('latest')).timestamp + 3600;
    await forwarder.connect(attacker).addLiquidity(
      token, USDC, atkTokens, 1_000n * ONE, 0, 0, attacker.address, deadline
    );

    const [poisoned] = await lens.slot0(POOL_MANAGER, key);
    const parked = await tryGraduate(token);
    expect(parked.graduated, 'graduated into a liquidity-backed poisoned pool').to.be.undefined;

    // ⚠ THE ASSERTION THE WHOLE SAFETY ARGUMENT RESTS ON. The corrector has no settle path,
    // so a swap that moves value leaves an unsettled delta and PoolManager.unlock reverts
    // it -- with no liquidity check anywhere in the corrector.
    const target = await targetFor(token, parked.curve);
    await expect(
      corrector.connect(attacker).correct(keyTuple(key), target),
      'a liquid pool was corrected -- the no-settle-path restriction does not hold'
    ).to.be.revertedWithCustomError(
      await ethers.getContractAt('IPoolManager', POOL_MANAGER), 'CurrencyNotSettled'
    );

    // Nothing moved, and the pool is exactly where it was.
    const [stillPoisoned] = await lens.slot0(POOL_MANAGER, key);
    expect(stillPoisoned, 'the pool moved despite the revert').to.equal(poisoned);
    console.log(`      C2  liquid pool REFUSED by CurrencyNotSettled, no liquidity check needed`);
  });

  it('C3. correcting a pool ALREADY AT TARGET is a no-op, not a revert', async function () {
    await deployAll();
    const token = await launch('C3');
    const { key } = hooklessKeyFor(token); // see the note on hooklessKeyFor

    const target = 79228162514264337593543950336n * 2n; // any valid price
    await pm.initialize(keyTuple(key), target);

    // A revert here would make every caller race every other caller: two people who both
    // notice the same poisoned pool would have one of them fail for no reason. It also
    // keeps v4's PriceLimitAlreadyExceeded (Pool.sol:324, :333) unreachable from here.
    const moved = await corrector.correct.staticCall(keyTuple(key), target);
    expect(moved, 'reported a move when already at target').to.equal(false);

    const rc = await (await corrector.connect(attacker).correct(keyTuple(key), target)).wait();
    const evs = rc.logs.map((l) => { try { return corrector.interface.parseLog(l); } catch { return null; } })
      .filter(Boolean).filter((l) => l.name === 'PoolCorrected');
    expect(evs.length, 'a no-op emitted PoolCorrected').to.equal(0);

    const [after] = await lens.slot0(POOL_MANAGER, key);
    expect(after, 'a no-op moved the price').to.equal(target);
    console.log(`      C3  no-op returned false, emitted nothing, cost ${rc.gasUsed} gas`);
  });

  it('C4. the corrector holds NO balance of anything, after success and after failure', async function () {
    await deployAll();
    const token = await launch('C4');
    const { key } = hooklessKeyFor(token);
    const hooked = poolKeyFor(token).key;
    const addr = await corrector.getAddress();

    const before = await correctorBalances(token);
    expect(before.token + before.usdc + before.native, 'corrector started non-empty').to.equal(0n);

    // ⚠ THE CURVE IS READ BEFORE ANY GRADUATION. It used to be read from a PARKED curve,
    // which no longer happens -- graduation succeeds now, and a graduated curve has zeroed
    // reserves, so targetFor divided by zero. The failure looked like a math bug and was
    // a stale premise.
    const curve = await fillCurve(token);
    const target = await targetFor(token, curve);

    // Success path: an empty hookless pool, poisoned and corrected.
    await pm.initialize(keyTuple(key), Q96);
    await corrector.connect(attacker).correct(keyTuple(key), target);
    let after = await correctorBalances(token);
    expect(after.token, 'held token after a successful correction').to.equal(0n);
    expect(after.usdc, 'held usdc after a successful correction').to.equal(0n);
    expect(after.native, 'held native after a successful correction').to.equal(0n);

    // Failure path: a pool that HOLDS liquidity cannot be moved without settling, and the
    // corrector has no settle path -- so PoolManager.unlock reverts CurrencyNotSettled.
    // Graduation seeds the HOOKED pool, which is the one with liquidity.
    await (await ballista.connect(buyer).buy(token, 2_000n * ONE, 0)).wait();
    expect((await ballista.curves(token)).state, 'the curve did not graduate').to.equal(2n);
    const [live] = await lens.slot0(POOL_MANAGER, hooked);
    expect(live, 'the hooked pool was not seeded, so the failure path proves nothing')
      .to.be.greaterThan(0n);
    await expect(corrector.connect(attacker).correct(keyTuple(hooked), live / 2n)).to.be.reverted;

    after = await correctorBalances(token);
    expect(after.token, 'held token after a failed correction').to.equal(0n);
    expect(after.usdc, 'held usdc after a failed correction').to.equal(0n);
    expect(after.native, 'held native after a failed correction').to.equal(0n);
    console.log(`      C4  zero balances on both paths (${addr})`);
  });

  it('C5. a direct unlockCallback from anyone other than the PoolManager reverts', async function () {
    await deployAll();

    // Without this guard anyone could drive the swap with arbitrary parameters. It still
    // could not move value -- there is no settle path -- but it could move an arbitrary
    // pool's price while wearing the corrector's identity.
    await expect(
      corrector.connect(attacker).unlockCallback('0x'),
      'unlockCallback accepted a caller that was not the PoolManager'
    ).to.be.revertedWithCustomError(corrector, 'NotPoolManager');

    // Including from a contract, not just an EOA.
    const proxy = await (await ethers.getContractFactory('AdapterReenterer'))
      .deploy(await corrector.getAddress());
    await expect(proxy.reenter(USDC, USDC, 0, 0, attacker.address, 0)).to.not.be.reverted;
    expect(await proxy.secondCallSucceeded(), 'a contract reached the callback').to.equal(false);
    console.log(`      C5  NotPoolManager, from an EOA and from a contract`);
  });

  // ⚠ C6 WAS DELETED, NOT SKIPPED. DO NOT RE-ADD IT AS MISSING COVERAGE.
  //
  // It asserted: "after a correction the adapter's equality check PASSES and the mint
  // succeeds". Its premise is a POISONED HOOKED POOL -- the adapter only ever mints into
  // a pool carrying BallistaFeeHook, and that pool cannot be poisoned by anyone, because
  // beforeInitialize admits only `sender == adapter` and the adapter is itself callable
  // only by LFX1. The condition the test recovers from is unreachable.
  //
  // Contorting it would have meant inventing a way to poison a hooked pool purely so the
  // corrector had something to fix, which is the shape CLAUDE.md 16.4 warns about: a test
  // that passes for a reason unrelated to the thing it names.
  //
  // What it used to cover that still matters is covered elsewhere: the adapter's exact
  // price check is asserted by name in Fork.v4.attack (A1c), and the parked-then-graduated
  // recovery shape by Fork.v4 test 6 (a reverting router).

});
