const { expect } = require('chai');
const { ethers } = require('hardhat');

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
  let usdc, posm, pm, lens, math, adapter, ballista, corrector;

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
    math = await (await ethers.getContractFactory('V4AdapterMathHarness')).deploy();
    adapter = await (await ethers.getContractFactory('BallistaV4Adapter')).deploy(
      POOL_MANAGER, POSITION_MANAGER, PERMIT2
    );
    corrector = await (await ethers.getContractFactory('BallistaPoolCorrector')).deploy(POOL_MANAGER);
    ballista = await (await ethers.getContractFactory('LFX1')).deploy(
      USDC, treasury.address, await adapter.getAddress()
    );
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

  function poolKeyFor(token) {
    const t0 = BigInt(token) < BigInt(USDC);
    return {
      key: {
        currency0: t0 ? token : USDC, currency1: t0 ? USDC : token,
        fee: POOL_FEE, tickSpacing: TICK_SPACING, hooks: ethers.ZeroAddress,
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

  it('C1. poison, correct, graduate — end to end', async function () {
    await deployAll();
    const token = await launch('C1');
    const { key } = poolKeyFor(token);

    // Poison: initialise the pool at ~1e12x the correct price, before graduation.
    await pm.initialize(keyTuple(key), Q96);

    const first = await tryGraduate(token);
    expect(first.graduated, 'graduated into a poisoned pool').to.be.undefined;
    expect(first.curve.state, 'not parked at GRADUATION_READY').to.equal(1n);

    // Correct it. One call, from an account with no special standing.
    const target = await targetFor(token, first.curve);
    const rc = await (await corrector.connect(attacker).correct(keyTuple(key), target)).wait();

    const [after] = await lens.slot0(POOL_MANAGER, key);
    expect(after, 'the pool was not moved to the target').to.equal(target);

    const ev = rc.logs.map((l) => { try { return corrector.interface.parseLog(l); } catch { return null; } })
      .filter(Boolean).find((l) => l.name === 'PoolCorrected');
    expect(ev, 'no PoolCorrected event').to.not.be.undefined;
    expect(ev.args.toSqrtPriceX96).to.equal(target);
    expect(ev.args.fromSqrtPriceX96).to.equal(Q96);

    // And graduation now completes on the same parked reserves.
    const tokenId = await posm.nextTokenId();
    const rc2 = await (await ballista.connect(buyer).graduate(token)).wait();
    const g = rc2.logs.map((l) => { try { return ballista.interface.parseLog(l); } catch { return null; } })
      .filter(Boolean).find((l) => l.name === 'Graduated');
    expect(g, 'still blocked after correction').to.not.be.undefined;
    expect((await ballista.curves(token)).state, 'not GRADUATED').to.equal(2n);
    expect(await posm.ownerOf(tokenId), 'position not burned').to.equal(BURN);

    console.log(`      C1  poisoned -> corrected (${rc.gasUsed} gas) -> graduated (${rc2.gasUsed} gas)`);
  });

  it('C2. correcting a pool that HOLDS LIQUIDITY reverts with CurrencyNotSettled', async function () {
    await deployAll();
    const token = await launch('C2');
    const { key } = poolKeyFor(token);
    const adapterAddr = await adapter.getAddress();

    // Give the pool real liquidity at a wrong price, using the adapter itself: it derives
    // the price from the amounts it is handed, so choosing the amounts chooses the price.
    await ethers.provider.send('evm_increaseTime', [30]);
    await ethers.provider.send('evm_mine', []);
    await ballista.connect(attacker).buy(token, 2_000n * ONE, 0);
    const launched = new ethers.Contract(token, ERC20_ABI, attacker);
    const atkTokens = await launched.balanceOf(attacker.address);
    await launched.approve(adapterAddr, ethers.MaxUint256);
    await usdc.connect(attacker).approve(adapterAddr, ethers.MaxUint256);
    const deadline = (await ethers.provider.getBlock('latest')).timestamp + 3600;
    await adapter.connect(attacker).addLiquidity(
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
    const { key } = poolKeyFor(token);

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
    const { key } = poolKeyFor(token);
    const addr = await corrector.getAddress();

    const before = await correctorBalances(token);
    expect(before.token + before.usdc + before.native, 'corrector started non-empty').to.equal(0n);

    // Success path.
    await pm.initialize(keyTuple(key), Q96);
    const parked = await tryGraduate(token);
    const target = await targetFor(token, parked.curve);
    await corrector.connect(attacker).correct(keyTuple(key), target);
    let after = await correctorBalances(token);
    expect(after.token, 'held token after a successful correction').to.equal(0n);
    expect(after.usdc, 'held usdc after a successful correction').to.equal(0n);
    expect(after.native, 'held native after a successful correction').to.equal(0n);

    // Failure path: a target the pool cannot reach without trading. Graduate first so the
    // pool has real liquidity, then try to move it.
    await ballista.connect(buyer).graduate(token);
    const [live] = await lens.slot0(POOL_MANAGER, key);
    await expect(corrector.connect(attacker).correct(keyTuple(key), live / 2n)).to.be.reverted;

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

  it('C6. after a correction the adapter\'s equality check PASSES and the mint succeeds', async function () {
    await deployAll();
    const token = await launch('C6');
    const { key, tokenIsCurrency0 } = poolKeyFor(token);

    await pm.initialize(keyTuple(key), Q96);
    const parked = await tryGraduate(token);
    expect(parked.curve.state).to.equal(1n);

    const target = await targetFor(token, parked.curve);
    await corrector.connect(attacker).correct(keyTuple(key), target);

    const tokenId = await posm.nextTokenId();
    const adapterAddr = await adapter.getAddress();
    const launched = new ethers.Contract(token, ERC20_ABI, ethers.provider);
    const bT = await launched.balanceOf(adapterAddr);
    const bU = await usdc.balanceOf(adapterAddr);

    const rc = await (await ballista.connect(buyer).graduate(token)).wait();
    const g = rc.logs.map((l) => { try { return ballista.interface.parseLog(l); } catch { return null; } })
      .filter(Boolean).find((l) => l.name === 'Graduated');
    expect(g, 'the mint did not succeed after correction').to.not.be.undefined;

    // ⚠ §15.6: compare the pool price against what the adapter was HANDED, never against
    // what the mint consumed -- for a full-range mint the consumed amounts are DERIVED from
    // the pool price, so that comparison is circular and passed at rel=-7.5e-13 on a pool
    // priced 1e12 wrong.
    const pulledToken = g.args[1] + ((await launched.balanceOf(adapterAddr)) - bT);
    const pulledUsdc = g.args[2] + ((await usdc.balanceOf(adapterAddr)) - bU);
    const [p0, p1] = tokenIsCurrency0 ? [pulledToken, pulledUsdc] : [pulledUsdc, pulledToken];
    const [sp] = await lens.slot0(POOL_MANAGER, key);
    const rel = Number(((sp * sp * p0 - p1 * Q96 * Q96) * 10n ** 18n) / (p1 * Q96 * Q96)) / 1e18;
    expect(Math.abs(rel), `pool price off by ${rel} after a corrected graduation`).to.be.lessThan(1e-9);

    expect(await posm.ownerOf(tokenId), 'position not burned').to.equal(BURN);
    expect(await posm.getPositionLiquidity(tokenId), 'no liquidity minted').to.be.greaterThan(0n);
    console.log(`      C6  adapter accepted the corrected price, rel=${rel}, LP burned`);
  });
});
