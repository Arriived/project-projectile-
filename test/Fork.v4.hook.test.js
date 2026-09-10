const { expect } = require('chai');
const { ethers } = require('hardhat');
const { deployBoundPair } = require('./helpers/v4deploy');

// BallistaFeeHook against REAL Uniswap v4, on a pinned Base mainnet fork.
// Gated behind FORK_BASE=1; ordinary runs skip this file entirely.
//
//   FORK_BASE=1 npx hardhat test test/Fork.v4.hook.test.js
//
// ⚠ RUN IT ALONE. CLAUDE.md 16.2: two fork suites in one mocha process interleave their
// archive fetches, the public Base endpoint rate-limits, and the run HANGS rather than
// failing -- which reads as a bug in the test and is a property of the endpoint.
//
// WHY A FORK AND NOT A MOCK. Every claim here is a claim about how real v4 responds: which
// side of a swap is "unspecified", whether poolManager.take inside afterSwap settles, what
// PoolManager hands the hook versus what it hands the swapper. A mock of v4 is a mock of
// exactly the thing in doubt (CLAUDE.md 4).
const FORK_BLOCK = 50900000;
const POOL_MANAGER = '0x498581ff718922c3f8e6a244956af099b2652b2b';
const POSITION_MANAGER = '0x7c5f5a4bbd8fd63184577525326123b519429bdc';
const PERMIT2 = '0x000000000022D473030F116dDEE9F6B43aC78BA3';
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

const ONE = 1_000_000n; // 1 USDC, 6dp
const FEE_BPS = 100n;
const BPS = 10_000n;
const POOL_FEE = 0;
const TICK_SPACING = 60;

const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function transfer(address,uint256) returns (bool)',
  'function approve(address,uint256) returns (bool)',
  'function decimals() view returns (uint8)',
];

describe('BallistaFeeHook — against real Uniswap v4 (Base fork)', function () {
  this.timeout(1800000);

  let owner, treasury, creator, buyer, stranger;
  let usdc, adapter, ballista, hook, hookAddress, swapper, forwarder;

  before(async function () {
    if (!process.env.FORK_BASE) this.skip();
    const bn = await ethers.provider.getBlockNumber();
    expect(bn, 'not forked at the pinned Base block').to.be.greaterThanOrEqual(FORK_BLOCK);
    await ethers.provider.send('evm_mine', []);
    for (const [name, addr] of [
      ['PoolManager', POOL_MANAGER], ['PositionManager', POSITION_MANAGER],
      ['Permit2', PERMIT2], ['USDC', USDC],
    ]) {
      expect(await ethers.provider.getCode(addr), `${name} has NO CODE -- fork did not take`)
        .to.not.equal('0x');
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
    [owner, treasury, creator, buyer, stranger] = await ethers.getSigners();
    usdc = new ethers.Contract(USDC, ERC20_ABI, ethers.provider);

    swapper = await (await ethers.getContractFactory('V4ExactSwapper')).deploy(POOL_MANAGER);
    forwarder = await (await ethers.getContractFactory('MockLfx1Caller')).deploy();
    const forwarderAddr = await forwarder.getAddress();

    // Same predict/mine/deploy sequence production uses; see test/helpers/v4deploy.js and
    // CLAUDE.md 20.7. deployBoundPair sends two transactions, setAdapter is the third, so
    // LFX1 lands three nonces on.
    const n0 = await ethers.provider.getTransactionCount(owner.address);
    const predictedBallista = ethers.getCreateAddress({ from: owner.address, nonce: n0 + 3 });
    const pair = await deployBoundPair(
      owner, 'BallistaFeeHook', [POOL_MANAGER, predictedBallista, USDC, treasury.address],
      'BallistaV4Adapter', [POOL_MANAGER, POSITION_MANAGER, PERMIT2, forwarderAddr]
    );
    adapter = pair.adapter;
    hookAddress = pair.hookAddress;
    hook = await ethers.getContractAt('BallistaFeeHook', hookAddress);
    await (await forwarder.setAdapter(await adapter.getAddress())).wait();

    ballista = await (await ethers.getContractFactory('LFX1')).deploy(
      USDC, treasury.address, forwarderAddr
    );
    expect(await ballista.getAddress(), 'CREATE prediction missed').to.equal(predictedBallista);
    expect(BigInt(hookAddress) & 0x3fffn, 'hook flags').to.equal(0x2044n);

    for (const s of [creator, buyer, stranger]) {
      await fundUsdc(s.address, 200_000n * ONE);
      await usdc.connect(s).approve(await ballista.getAddress(), ethers.MaxUint256);
    }
  }

  async function launch(symbol) {
    const hash = await ballista.currentEconomicsHash();
    const rc = await (await ballista.connect(creator).createToken('Hook', symbol, '', hash, false)).wait();
    const ev = rc.logs.map((l) => { try { return ballista.interface.parseLog(l); } catch { return null; } })
      .filter(Boolean).find((l) => l.name === 'TokenCreated');
    await ethers.provider.send('evm_mine', []);
    return ev.args.token;
  }

  function keyFor(token) {
    const tokenIsCurrency0 = BigInt(token) < BigInt(USDC);
    return {
      currency0: tokenIsCurrency0 ? token : USDC,
      currency1: tokenIsCurrency0 ? USDC : token,
      fee: POOL_FEE, tickSpacing: TICK_SPACING, hooks: hookAddress,
    };
  }

  function poolIdOf(key) {
    return ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(
      ['address', 'address', 'uint24', 'int24', 'address'],
      [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks]
    ));
  }

  // Launches and graduates, leaving a live hooked pool with real liquidity.
  async function graduated(symbol) {
    const token = await launch(symbol);
    await ethers.provider.send('evm_increaseTime', [30]);
    await ethers.provider.send('evm_mine', []);
    await (await ballista.connect(buyer).buy(token, 8_100n * ONE, 0)).wait();
    const curve = await ballista.curves(token);
    expect(curve.state, 'the token did not graduate').to.equal(2n);
    const key = keyFor(token);
    return { token, key, poolId: poolIdOf(key) };
  }

  // Funds the swapper on both sides so it can trade either direction.
  async function fundSwapper(token) {
    const addr = await swapper.getAddress();
    await fundUsdc(addr, 100_000n * ONE);
    // Buy tokens on a fresh curve and hand them over -- the graduated token's own supply
    // now lives in the pool, so this is the honest way to get some.
    const spare = await launch('SPARE' + Math.floor(Math.random() * 1e6));
    await ethers.provider.send('evm_increaseTime', [30]);
    await ethers.provider.send('evm_mine', []);
    await (await ballista.connect(stranger).buy(spare, 100n * ONE, 0)).wait();
    // The graduated token itself: take it from the buyer, who bought the whole curve.
    const t = new ethers.Contract(token, ERC20_ABI, buyer);
    const bal = await t.balanceOf(buyer.address);
    expect(bal, 'buyer holds no tokens to fund the swapper with').to.be.greaterThan(0n);
    await (await t.transfer(addr, bal / 2n)).wait();
  }

  function feeEventsFrom(rc) {
    return rc.logs.map((l) => { try { return hook.interface.parseLog(l); } catch { return null; } })
      .filter(Boolean).filter((l) => l.name === 'FeeAccrued');
  }

  // ═══════════════════════════════════════════════════════════════════════════════════
  // S0 -- PROVE THE FIXTURE BEFORE ANYTHING ASSERTS AGAINST IT.
  //
  // ⚠ Rows 23, 25 and 31 all assert that a fee is a fixed fraction of an amount this
  // swapper chose. A swapper that quietly swaps something other than what it was asked
  // makes every one of them green and meaningless -- the same class as the etched Arachnid
  // runtime being one byte wrong, which produced a plausible-looking contract that threw
  // `invalid opcode`. So the swapper is checked against ITS OWN BALANCES, a source it does
  // not report and cannot fake.
  // ═══════════════════════════════════════════════════════════════════════════════════
  describe('S0. the swapper does what it claims', function () {
    let g;
    before(async function () {
      await deployAll();
      g = await graduated('S0');
      await fundSwapper(g.token);
    });

    it('S0a. an EXACT-INPUT swap spends exactly the amount specified', async function () {
      const usdcIsC0 = g.key.currency0.toLowerCase() === USDC.toLowerCase();
      const amountIn = 10n * ONE;
      // zeroForOne true means currency0 in. Choose the direction that spends USDC.
      await (await swapper.swap(g.key, usdcIsC0, -amountIn)).wait();
      const spent = usdcIsC0 ? await swapper.spent0() : await swapper.spent1();
      expect(spent, 'exact-input did not spend exactly what was specified').to.equal(amountIn);
    });

    it('S0b. an EXACT-OUTPUT swap delivers exactly the amount specified', async function () {
      const usdcIsC0 = g.key.currency0.toLowerCase() === USDC.toLowerCase();
      const amountOut = 5n * ONE;
      // Ask for USDC out: swap the token in, so zeroForOne is "token is currency0".
      await (await swapper.swap(g.key, !usdcIsC0, amountOut)).wait();
      const gained = usdcIsC0 ? await swapper.gained0() : await swapper.gained1();
      expect(gained, 'exact-output did not deliver exactly what was specified').to.equal(amountOut);
    });

    it('S0c. CONTROL: the two modes are distinguishable', async function () {
      // ⚠ Without this, S0a and S0b both pass if the swapper ignored amountSpecified and
      // always moved the same amount. An exact-input of X and an exact-output of X must
      // produce different balance movements.
      const usdcIsC0 = g.key.currency0.toLowerCase() === USDC.toLowerCase();
      const amt = 3n * ONE;
      await (await swapper.swap(g.key, usdcIsC0, -amt)).wait();
      const outFromExactIn = usdcIsC0 ? await swapper.gained1() : await swapper.gained0();
      await (await swapper.swap(g.key, usdcIsC0, amt)).wait();
      const outFromExactOut = usdcIsC0 ? await swapper.gained1() : await swapper.gained0();
      expect(outFromExactIn, 'exact-in and exact-out produced the same output')
        .to.not.equal(outFromExactOut);
      expect(outFromExactOut, 'exact-output did not deliver what was asked').to.equal(amt);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════════════
  // ROWS 22-31
  // ═══════════════════════════════════════════════════════════════════════════════════
  describe('rows 22-31. the hook on a live graduated pool', function () {
    let g, usdcIsC0, tokenC;

    before(async function () {
      await deployAll();
      g = await graduated('HOOK');
      await fundSwapper(g.token);
      usdcIsC0 = g.key.currency0.toLowerCase() === USDC.toLowerCase();
      tokenC = new ethers.Contract(g.token, ERC20_ABI, ethers.provider);
      await ethers.provider.send('hardhat_impersonateAccount', [POOL_MANAGER]);
      await ethers.provider.send('hardhat_setBalance', [POOL_MANAGER, '0x21e19e0c9bab2400000']);
    });

    async function asPoolManager() {
      return await ethers.getSigner(POOL_MANAGER);
    }

    // Magnitude of the UNSPECIFIED side, from the hook's own event -- which carries the
    // pool's GROSS deltas, not the trader's net.
    function unspecifiedGross(ev, key, zeroForOne, exactInput) {
      const specifiedIsC0 = (exactInput) === zeroForOne;
      const raw = specifiedIsC0 ? ev.args.amount1 : ev.args.amount0;
      return raw < 0n ? -raw : raw;
    }

    it('22. registration is IDEMPOTENT and does not mask PoolAlreadyInitialized', async function () {
      // ⚠ WHY THIS MATTERS. PoolManager calls beforeInitialize BEFORE it checks whether the
      // pool exists -- the hook call sits above _pools[id].initialize() in
      // PoolManager.initialize, and Pool.sol:101 is what throws PoolAlreadyInitialized. So
      // a retried graduation re-enters the hook FIRST. If the hook reverted with its own
      // "already registered" error there, it would MASK the real reason and the adapter's
      // selector-exact catch would re-raise the wrong thing.
      const pm = await asPoolManager();
      const before = await hook.launches(g.poolId);
      expect(before.registered, 'the pool is not registered, so this proves nothing').to.equal(true);

      // Re-entering registration must NOT revert, and must return the selector that tells
      // PoolManager the hook accepted. (staticCall returns the value, so this is asserted
      // on the RETURN rather than with a revert matcher.)
      const sel = await hook.connect(pm).beforeInitialize.staticCall(await adapter.getAddress(), g.key, 1n);
      expect(sel, 'the idempotent path did not return the beforeInitialize selector')
        .to.equal(hook.interface.getFunction('beforeInitialize').selector);
      // ...and must not re-register or disturb what is already there.
      const rc = await (await hook.connect(pm).beforeInitialize(await adapter.getAddress(), g.key, 1n)).wait();
      const dup = rc.logs.map((l) => { try { return hook.interface.parseLog(l); } catch { return null; } })
        .filter(Boolean).filter((l) => l.name === 'PoolRegistered');
      expect(dup.length, 'a second PoolRegistered was emitted -- registration is not idempotent')
        .to.equal(0);
      const after = await hook.launches(g.poolId);
      expect(after.token).to.equal(before.token);
      expect(after.feeRecipient).to.equal(before.feeRecipient);
      expect(after.usdcIsCurrency0).to.equal(before.usdcIsCurrency0);
    });

    it('23. afterSwap accrues exactly 100 bps -- both directions, both modes', async function () {
      const cases = [
        { zeroForOne: true, exactInput: true },
        { zeroForOne: false, exactInput: true },
        { zeroForOne: true, exactInput: false },
        { zeroForOne: false, exactInput: false },
      ];
      let seen = 0;
      for (const c of cases) {
        const snap = await ethers.provider.send('evm_snapshot', []);
        // ⚠ SIZED IN THE UNITS OF WHICHEVER CURRENCY THE SPECIFIED SIDE IS. USDC is 6dp
        // and the launch token 18dp, so a single magnitude used for both sides is either
        // dust or the whole pool. Getting this wrong shows up as "no FeeAccrued", because
        // the unspecified side rounded below the 100-unit fee floor.
        const specifiedIsC0 = c.exactInput === c.zeroForOne;
        const specifiedIsUsdc = specifiedIsC0 === usdcIsC0;
        const mag = specifiedIsUsdc ? 20n * ONE : 500n * 10n ** 18n;
        const scaled = c.exactInput ? -mag : mag;
        const rc = await (await swapper.swap(g.key, c.zeroForOne, scaled)).wait();
        const evs = feeEventsFrom(rc);
        expect(evs.length, `no FeeAccrued for ${JSON.stringify(c)}`).to.equal(1);
        const gross = unspecifiedGross(evs[0], g.key, c.zeroForOne, c.exactInput);
        const expected = (gross * FEE_BPS) / BPS;
        expect(evs[0].args.feeAmount, `fee is not 100 bps for ${JSON.stringify(c)}`)
          .to.equal(expected);
        expect(expected, 'the case produced a zero fee -- it proves nothing').to.be.greaterThan(0n);
        seen++;
        await ethers.provider.send('evm_revert', [snap]);
      }
      expect(seen, 'not all four combinations ran').to.equal(4);
    });

    it('24. afterSwap on an UNREGISTERED pool returns zero and does not revert', async function () {
      // ⚠ A REVERT HERE WOULD BRICK THE POOL PERMANENTLY -- every swap would revert, the
      // liquidity is burned so nobody can withdraw, and there is no owner. The branch
      // guards a state that should be unreachable, which is the correct place for it.
      const pm = await asPoolManager();
      const unknownKey = { ...g.key, tickSpacing: 30 }; // a different PoolId, never registered
      const sp = { zeroForOne: true, amountSpecified: -1000, sqrtPriceLimitX96: 0 };
      const zeroDelta = 0n;
      const res = await hook.connect(pm).afterSwap.staticCall(
        await adapter.getAddress(), unknownKey, sp, zeroDelta, '0x'
      );
      expect(res[1], 'an unregistered pool was charged a fee').to.equal(0n);
      await expect(hook.connect(pm).afterSwap(
        await adapter.getAddress(), unknownKey, sp, zeroDelta, '0x'
      )).to.not.be.reverted;
    });

    it('25. the rounding boundary: 99 takes NOTHING, 100 takes exactly 1', async function () {
      // ⚠ THE ABSENCE OF THE TAKE IS ASSERTED, NOT JUST A ZERO BALANCE. A zero balance is
      // also what you get if the hook took the fee and gave it straight back, or if it
      // took nothing because it was never called. The event and the balance together say
      // which: no FeeAccrued at all, and no accrual movement.
      //
      // The unspecified side is the OUTPUT of an exact-input swap, so it is derived rather
      // than chosen. It is searched for with snapshots, and the search is asserted to have
      // actually landed -- a search that silently missed would leave the row testing a
      // magnitude nobody checked.
      const tokenIsC0 = !usdcIsC0;
      const zeroForOne = tokenIsC0; // token in, USDC out -> unspecified is the USDC output

      // ⚠ THE SEARCH MUST TARGET THE GROSS, NOT WHAT THE SWAPPER RECEIVED.
      // The fee is a fraction of the pool's GROSS unspecified amount; the swapper's gained
      // balance is the NET, already short by the fee. Searching on the net finds an output
      // of 99 whose GROSS was 100 -- so the fee is 1, an event fires, and the row fails as
      // "a fee event was emitted for a sub-100 output". That is the gross/net distinction
      // documented on V4ExactSwapper, biting the test that was written to check it.
      //
      // With no fee event the two are equal, so the fallback is exact rather than an
      // approximation.
      async function grossOutFor(amountIn) {
        const snap = await ethers.provider.send('evm_snapshot', []);
        let out = -1n;
        try {
          const rc = await (await swapper.swap(g.key, zeroForOne, -amountIn)).wait();
          const evs = feeEventsFrom(rc);
          if (evs.length === 1) {
            out = unspecifiedGross(evs[0], g.key, zeroForOne, true);
          } else {
            out = usdcIsC0 ? await swapper.gained0() : await swapper.gained1();
          }
        } catch { out = -1n; }
        await ethers.provider.send('evm_revert', [snap]);
        return out;
      }
      const usdcOutFor = grossOutFor;

      // Bracket, then bisect, on a monotonic function.
      // ⚠ BRACKET IN TOKEN UNITS (18dp). At this pool's price one whole token is worth
      // ~41 RAW units of USDC, so a 1e18 upper bound produces 41 -- below the boundary the
      // search is looking for. The first version bracketed there and failed as "the upper
      // bracket produces too little output", which is the bracket and not the hook.
      let lo = 10n ** 15n, hi = 10n ** 22n;
      expect(await usdcOutFor(hi), 'the upper bracket produces too little output')
        .to.be.greaterThan(200n);
      for (let i = 0; i < 200 && hi - lo > 1n; i++) {
        const mid = (lo + hi) / 2n;
        const out = await usdcOutFor(mid);
        if (out >= 100n) hi = mid; else lo = mid;
      }
      const at100 = await usdcOutFor(hi);
      const at99 = await usdcOutFor(lo);
      expect(at100, 'the search did not land on an output of at least 100').to.be.greaterThanOrEqual(100n);
      expect(at99, 'the search did not land on an output below 100').to.be.lessThan(100n);
      expect(at99, 'the low side produced no output at all').to.be.greaterThan(0n);

      // BELOW the boundary: nothing is taken, and no event says otherwise.
      const pendBefore = usdcIsC0 ? await hook.pendingUsdc(g.poolId) : await hook.pendingUsdc(g.poolId);
      const hookUsdcBefore = await usdc.balanceOf(hookAddress);
      const snapA = await ethers.provider.send('evm_snapshot', []);
      const rcLow = await (await swapper.swap(g.key, zeroForOne, -lo)).wait();
      expect(feeEventsFrom(rcLow).length, 'a fee event was emitted for a sub-100 output')
        .to.equal(0);
      expect(await hook.pendingUsdc(g.poolId), 'accrual moved on a sub-100 output').to.equal(pendBefore);
      expect(await usdc.balanceOf(hookAddress), 'the hook took USDC on a sub-100 output')
        .to.equal(hookUsdcBefore);
      await ethers.provider.send('evm_revert', [snapA]);

      // AT the boundary: exactly floor(magnitude / 100).
      const snapB = await ethers.provider.send('evm_snapshot', []);
      const rcHigh = await (await swapper.swap(g.key, zeroForOne, -hi)).wait();
      const evs = feeEventsFrom(rcHigh);
      expect(evs.length, 'no fee event at or above the boundary').to.equal(1);
      const gross = unspecifiedGross(evs[0], g.key, zeroForOne, true);
      expect(evs[0].args.feeAmount, 'the fee is not floor(magnitude / 100)')
        .to.equal((gross * FEE_BPS) / BPS);
      expect(evs[0].args.feeAmount, 'the boundary fee is not 1').to.equal(1n);
      await ethers.provider.send('evm_revert', [snapB]);
      console.log(`      ROW 25  output ${at99} -> fee 0, nothing taken; output ${at100} -> fee 1`);
    });

    it('31. the returned delta is POSITIVE and strictly less than the unspecified amount', async function () {
      const snap = await ethers.provider.send('evm_snapshot', []);
      const rc = await (await swapper.swap(g.key, usdcIsC0, -(10n * ONE))).wait();
      const ev = feeEventsFrom(rc)[0];
      expect(ev, 'no FeeAccrued').to.not.be.undefined;
      const gross = unspecifiedGross(ev, g.key, usdcIsC0, true);
      const fee = ev.args.feeAmount;

      expect(fee, 'the fee is not positive').to.be.greaterThan(0n);
      expect(fee, 'the fee is not strictly less than the unspecified amount -- the hook could take more than the swap produced')
        .to.be.lessThan(gross);

      // ⚠ AND THE TRADER ACTUALLY PAID IT. PoolManager.swap returns the trader's NET delta,
      // already adjusted by the hook (PoolManager.sol:35 and :40); the hook's event carries
      // the GROSS. Their difference must be exactly the fee, or the delta was returned with
      // the wrong sign and the trader was credited instead of charged.
      const net = usdcIsC0 ? await swapper.netAmount1() : await swapper.netAmount0();
      const netMag = net < 0n ? -net : net;
      expect(gross - netMag, 'the trader did not pay exactly the fee').to.equal(fee);
      await ethers.provider.send('evm_revert', [snap]);
    });

    it('26/27. sweep is permissionless, splits 50/50, and zeroes the accrual', async function () {
      const snap = await ethers.provider.send('evm_snapshot', []);
      await (await swapper.swap(g.key, usdcIsC0, -(50n * ONE))).wait();
      await (await swapper.swap(g.key, !usdcIsC0, -(10n ** 20n))).wait();

      const pu = await hook.pendingUsdc(g.poolId);
      const pt = await hook.pendingToken(g.poolId);
      expect(pu + pt, 'nothing accrued, so the sweep proves nothing').to.be.greaterThan(0n);

      const protocolRecipient = await hook.protocolRecipient();
      const launch = await hook.launches(g.poolId);
      // ⚠ ROW 27: called by a signer with no standing whatsoever.
      await (await hook.connect(stranger).sweep(g.poolId)).wait();

      expect(await hook.pendingUsdc(g.poolId), 'usdc accrual not zeroed').to.equal(0n);
      expect(await hook.pendingToken(g.poolId), 'token accrual not zeroed').to.equal(0n);

      const protoU = await hook.owedUsdc(protocolRecipient);
      const credU = await hook.owedUsdc(launch.feeRecipient);
      expect(protoU + credU, 'the usdc split does not conserve').to.equal(pu);
      expect(credU - protoU, 'the usdc split is not 50/50 (odd unit to the creator)')
        .to.be.lessThanOrEqual(1n);

      const protoT = await hook.owedToken(protocolRecipient, g.token);
      const credT = await hook.owedToken(launch.feeRecipient, g.token);
      expect(protoT + credT, 'the token split does not conserve').to.equal(pt);
      expect(credT - protoT, 'the token split is not 50/50').to.be.lessThanOrEqual(1n);
      await ethers.provider.send('evm_revert', [snap]);
    });

    it('28. sweep still credits when the creator is a contract that reverts on receive', async function () {
      // ⚠ THE ESCROW IS PULL-BASED FOR EXACTLY THIS. sweep makes NO external call, so a
      // hostile recipient cannot block it, cannot block the protocol's half, and cannot
      // block any other pool. The failure lands only on their own claim().
      const snap = await ethers.provider.send('evm_snapshot', []);
      // ⚠ ANY CONTRACT WITH NO receive/fallback DOES, AND THAT IS THE POINT. sweep makes
      // no external call whatsoever, so what the recipient would do on being paid is
      // irrelevant to whether the sweep succeeds. MockHookBinding has no payable path and
      // no token hooks; if sweep ever grew a push, this address would block it.
      const hostile = await (await ethers.getContractFactory('MockHookBinding')).deploy(hookAddress);
      const hostileAddr = await hostile.getAddress();

      const launch = await hook.launches(g.poolId);
      const recipient = await ethers.getSigner(launch.feeRecipient);
      await ethers.provider.send('hardhat_impersonateAccount', [launch.feeRecipient]);
      await ethers.provider.send('hardhat_setBalance', [launch.feeRecipient, '0x21e19e0c9bab2400000']);
      await (await hook.connect(recipient).transferFeeRecipient(g.poolId, hostileAddr)).wait();

      // ⚠ BOTH DIRECTIONS, AND BIG ENOUGH TO SPLIT. sweep gives the odd unit to the
      // creator, so an accrual of 1 credits the protocol 0 -- which reads as "the protocol
      // half was blocked" when it is just integer division. Accrue on both currencies so
      // the split is unambiguous.
      await (await swapper.swap(g.key, usdcIsC0, -(200n * ONE))).wait();
      await (await swapper.swap(g.key, !usdcIsC0, -(10n ** 21n))).wait();
      const pu = await hook.pendingUsdc(g.poolId);
      const pt = await hook.pendingToken(g.poolId);
      expect(pu + pt, 'nothing accrued').to.be.greaterThan(2n);

      await expect(hook.connect(stranger).sweep(g.poolId), 'a hostile recipient blocked the sweep')
        .to.not.be.reverted;
      const proto = await hook.protocolRecipient();
      const hostileTotal = (await hook.owedUsdc(hostileAddr)) + (await hook.owedToken(hostileAddr, g.token));
      const protoTotal = (await hook.owedUsdc(proto)) + (await hook.owedToken(proto, g.token));
      expect(hostileTotal, 'the hostile recipient was not credited').to.be.greaterThan(0n);
      expect(protoTotal, 'the protocol half was blocked by a hostile recipient').to.be.greaterThan(0n);
      expect(await hook.pendingUsdc(g.poolId), 'accrual not zeroed').to.equal(0n);
      expect(await hook.pendingToken(g.poolId), 'accrual not zeroed').to.equal(0n);
      await ethers.provider.send('evm_revert', [snap]);
    });

    it('29/30. FULL PATH: swap both directions, sweep, claim -- and the hook keeps nothing', async function () {
      const snap = await ethers.provider.send('evm_snapshot', []);
      await (await swapper.swap(g.key, usdcIsC0, -(40n * ONE))).wait();
      await (await swapper.swap(g.key, !usdcIsC0, -(10n ** 20n))).wait();
      await (await hook.connect(stranger).sweep(g.poolId)).wait();

      const protocolRecipient = await hook.protocolRecipient();
      const launch = await hook.launches(g.poolId);
      await ethers.provider.send('hardhat_impersonateAccount', [protocolRecipient]);
      await ethers.provider.send('hardhat_setBalance', [protocolRecipient, '0x21e19e0c9bab2400000']);
      await ethers.provider.send('hardhat_impersonateAccount', [launch.feeRecipient]);
      await ethers.provider.send('hardhat_setBalance', [launch.feeRecipient, '0x21e19e0c9bab2400000']);
      const proto = await ethers.getSigner(protocolRecipient);
      const cred = await ethers.getSigner(launch.feeRecipient);

      for (const s of [proto, cred]) {
        if ((await hook.owedUsdc(s.address)) > 0n) await (await hook.connect(s).claim()).wait();
        if ((await hook.owedToken(s.address, g.token)) > 0n) {
          await (await hook.connect(s).claimToken(g.token)).wait();
        }
      }

      // ⚠ ROW 29. Every claim drained, so the hook must hold nothing of either currency.
      expect(await usdc.balanceOf(hookAddress), 'the hook kept USDC after all claims').to.equal(0n);
      expect(await tokenC.balanceOf(hookAddress), 'the hook kept tokens after all claims').to.equal(0n);
      expect(await hook.owedUsdc(protocolRecipient)).to.equal(0n);
      expect(await hook.owedUsdc(launch.feeRecipient)).to.equal(0n);
      await ethers.provider.send('evm_revert', [snap]);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════════════
  // ROWS 13b-21b -- the (b) half: the guard on the REAL graduation path.
  //
  // ⚠ THE NINE CONDITIONS CANNOT BE DRIVEN THROUGH GRADUATION, AND THAT IS THE FINDING.
  //
  // The pairing rule is: assert the revert BY NAME on a direct call, AND assert the same
  // condition through graduation produces the parked-curve outcome -- because a guard
  // never reached on the real path protects nothing (CLAUDE.md 16.4).
  //
  // Every one of rows 13-21's conditions is unreachable through a real graduation:
  //   13 wrong sender      -- only the adapter can reach beforeInitialize
  //   14/15/16 wrong key   -- the adapter always builds fee 0, tickSpacing 60, hooks=hook
  //   17 unknown curve     -- LFX1 only graduates tokens it created
  //   18 zero creator      -- LFX1 writes creator = msg.sender and has no setter
  //   19 no USDC side      -- LFX1 always passes address(usdc)
  //
  // Manufacturing any of them would mean weakening the gate to test the gate. So the (b)
  // half asserts the property those nine were collectively for -- that a refusal from the
  // hook arrives at LFX1 as a PARK and not as a loss -- once, with a hook that refuses.
  // ═══════════════════════════════════════════════════════════════════════════════════
  describe('rows 13b-21b. a hook refusal parks the curve, and nothing is lost', function () {
    it('13b-21b. hook reverts -> adapter reverts -> LFX1 parks, reserves intact, retryable', async function () {
      await deployAll();

      // A second stack whose hook always refuses. Same predict/mine/deploy sequence.
      const rejFwd = await (await ethers.getContractFactory('MockLfx1Caller')).deploy();
      const rejFwdAddr = await rejFwd.getAddress();
      const n0 = await ethers.provider.getTransactionCount(owner.address);
      const predicted = ethers.getCreateAddress({ from: owner.address, nonce: n0 + 3 });
      const pair = await deployBoundPair(
        owner, 'RejectingTestHook', [POOL_MANAGER],
        'BallistaV4Adapter', [POOL_MANAGER, POSITION_MANAGER, PERMIT2, rejFwdAddr]
      );
      await (await rejFwd.setAdapter(await pair.adapter.getAddress())).wait();
      const rejBallista = await (await ethers.getContractFactory('LFX1')).deploy(
        USDC, treasury.address, rejFwdAddr
      );
      expect(await rejBallista.getAddress(), 'CREATE prediction missed').to.equal(predicted);

      for (const s of [creator, buyer]) {
        await usdc.connect(s).approve(await rejBallista.getAddress(), ethers.MaxUint256);
      }

      const hash = await rejBallista.currentEconomicsHash();
      const rc0 = await (await rejBallista.connect(creator).createToken('Rej', 'REJ', '', hash, false)).wait();
      const token = rc0.logs.map((l) => { try { return rejBallista.interface.parseLog(l); } catch { return null; } })
        .filter(Boolean).find((l) => l.name === 'TokenCreated').args.token;

      await ethers.provider.send('evm_increaseTime', [30]);
      await ethers.provider.send('evm_mine', []);
      const rc = await (await rejBallista.connect(buyer).buy(token, 8_100n * ONE, 0)).wait();
      const parsed = rc.logs.map((l) => { try { return rejBallista.interface.parseLog(l); } catch { return null; } })
        .filter(Boolean);

      // The refusal reached LFX1 as a FAILED ATTEMPT, not as a revert of the buy.
      expect(parsed.find((l) => l.name === 'GraduationReady'), 'the curve never reached GRADUATION_READY')
        .to.not.be.undefined;
      expect(parsed.find((l) => l.name === 'GraduationAttemptFailed'), 'no GraduationAttemptFailed')
        .to.not.be.undefined;
      expect(parsed.find((l) => l.name === 'Graduated'), 'graduated despite a refusing hook')
        .to.be.undefined;

      // Parked, not lost.
      const curve = await rejBallista.curves(token);
      expect(curve.state, 'not parked at GRADUATION_READY').to.equal(1n);
      expect(curve.tokenReserves, 'tokenReserves lost on a refused graduation').to.be.greaterThan(0n);
      expect(curve.realUsdcReserves, 'realUsdcReserves lost on a refused graduation').to.be.greaterThan(0n);

      // Nothing reached the adapter.
      const t = new ethers.Contract(token, ERC20_ABI, ethers.provider);
      const adapterAddr = await pair.adapter.getAddress();
      expect(await t.balanceOf(adapterAddr), 'tokens left the factory').to.equal(0n);
      expect(await usdc.balanceOf(adapterAddr), 'usdc left the factory').to.equal(0n);

      // Retryable, and it still refuses -- the park is stable, not a one-off.
      await expect(rejBallista.connect(buyer).graduate(token))
        .to.be.revertedWithCustomError(rejBallista, 'GraduationFailed');
      expect((await rejBallista.curves(token)).state, 'the retry moved the state').to.equal(1n);
      console.log('      ROW 13b-21b  hook refused -> curve parked, reserves intact, retry still refuses');
    });
  });
});
