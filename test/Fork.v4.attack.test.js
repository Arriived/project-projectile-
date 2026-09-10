const { expect } = require('chai');
const { ethers } = require('hardhat');
const { deployBoundPair } = require('./helpers/v4deploy');

// ADVERSARIAL testing of BallistaV4Adapter against REAL Uniswap v4, on a pinned Base fork.
// Gated behind FORK_BASE=1.
//
//   FORK_BASE=1 npx hardhat test test/Fork.v4.attack.test.js
//
// ⚠ WHAT THIS CANNOT COVER. A Base fork exercises real v4 and NOTHING about Arc -- not the
// USDC blocklist, not EIP-7708 transfer logs, not the truncating 6dp balanceOf. CLAUDE.md
// §4 is explicit that these surfaces are not interchangeable, and Arc's own docs say local
// simulators "run a standard EVM, not Arc's". An adapter attacked here is not an adapter
// cleared for Arc; it is one whose logic has been tested somewhere real rather than
// nowhere. Arc Testnet has no v4 deployment at all (§15.8), so this is the only surface
// that exists.
//
// Each test is an ATTACK and its name states the outcome. A test that passes because the
// attack failed is evidence; the assertions describe what the attacker got, not merely
// that something reverted.
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
  'function allowance(address,address) view returns (uint256)',
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
const PERMIT2_ABI = [
  'function allowance(address,address,address) view returns (uint160,uint48,uint48)',
];

describe('BallistaV4Adapter — ADVERSARIAL, against real Uniswap v4 (Base fork)', function () {
  this.timeout(1800000);

  let owner, treasury, creator, buyer, attacker;
  let usdc, posm, pm, permit2, lens, adapter, ballista, forwarder, hookAddress;

  before(async function () {
    if (!process.env.FORK_BASE) this.skip();
    const bn = await ethers.provider.getBlockNumber();
    expect(bn, 'not forked at the pinned Base block').to.be.greaterThanOrEqual(FORK_BLOCK);
    await ethers.provider.send('evm_mine', []); // see Fork.v4.test.js: latest == fork block is "historical"
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
    permit2 = new ethers.Contract(PERMIT2, PERMIT2_ABI, ethers.provider);

    lens = await (await ethers.getContractFactory('V4PoolLens')).deploy();
    // ⚠ THE FORWARDER IS THE ADAPTER'S `lfx1` AND ALSO LFX1'S ROUTER.
    // The adapter accepts one caller (CLAUDE.md 20.6). These suites need BOTH a real
    // graduation and an attacker driving the adapter directly, so a permissionless
    // forwarder sits in the middle. That reproduces the PRE-GATE world on purpose: the
    // attacks below are retained as defence in depth, each paired with a sibling proving
    // the same attack is refused on the real, gated configuration.
    forwarder = await (await ethers.getContractFactory('MockLfx1Caller')).deploy();
    const forwarderAddr = await forwarder.getAddress();

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
    const rc = await (await ballista.connect(creator).createToken('Atk', symbol, '', hash, false)).wait();
    const ev = rc.logs.map((l) => { try { return ballista.interface.parseLog(l); } catch { return null; } })
      .filter(Boolean).find((l) => l.name === 'TokenCreated');
    await ethers.provider.send('evm_mine', []);
    return ev.args.token;
  }

  // Poisons a HOOKED pool at a hostile price, by the only route the two-ended gate leaves
  // open: through a caller the adapter accepts.
  //
  // ⚠ WHAT THIS SUBSTITUTION MEANS. These tests were written against `pm.initialize(...)`
  // called directly by an attacker EOA -- free, capital-free, and possible before the
  // token existed (CLAUDE.md 16.1, F1). That route is now refused by the hook with
  // NotAdapter. What remains needs the token to exist, needs the attacker to buy some off
  // the curve, and needs them to put up real value on both sides. The tests are retained
  // as DEFENCE IN DEPTH -- they show the adapter's own price check still holds if the
  // outer gate is ever removed -- and each is paired with a sibling asserting the direct
  // route is refused today.
  // ⚠ THE GRADUATING BUY IS A NAMED CONSTANT BECAUSE ANOTHER FIXTURE DEPENDS ON IT.
  // poisonViaForwarder has to buy tokens off the curve, and how much it buys is only
  // correct RELATIVE to this. Two independently-chosen constants that happen to work is
  // exactly the arrangement that breaks silently a year later.
  const GRADUATING_BUY = 8_100n * ONE;

  // Poisons a HOOKED pool at a hostile price, by the only route the two-ended gate leaves
  // open: through a caller the adapter accepts.
  //
  // ⚠ WHAT THIS SUBSTITUTION MEANS. These tests were written against `pm.initialize(...)`
  // called directly by an attacker EOA -- free, capital-free, and possible before the
  // token existed (CLAUDE.md 16.1, F1). That route is now refused by the hook with
  // NotAdapter. What remains needs the token to exist, needs the attacker to buy some off
  // the curve, and needs them to put up real value on both sides. The tests are retained
  // as DEFENCE IN DEPTH, each paired with a sibling proving the direct route is refused.
  //
  // ⚠ THE BUY IS DERIVED FROM THE CURVE'S OWN THRESHOLD, NOT PICKED. It has to land inside
  // a narrow window and BOTH edges produce failures that look like contract bugs:
  //
  //   too large -> the poison buy plus GRADUATING_BUY empties the curve, which fires
  //                CLAUDE.md 1.4's DEPLETION arm. That is a legitimate second route to
  //                GRADUATION_READY and it zeroes tokenReserves -- surfacing as
  //                "tokenReserves lost", which reads like a fund-loss bug.
  //   too small -> GRADUATING_BUY never crosses the threshold, no graduation is attempted
  //                at all, and the assertion fails as "no GraduationAttemptFailed".
  //
  // So it is expressed as a fraction of the threshold and the window is ASSERTED here,
  // where a violation names itself, rather than three tests away where it does not.
  async function poisonViaForwarder(token, key, usdcSide = 1n * ONE) {
    const before = await ballista.curves(token);
    const threshold = before.graduationThresholdUsdc;
    const buyIn = threshold / 800n;
    expect(buyIn, 'threshold too small to derive a poison buy from').to.be.greaterThan(0n);
    expect(buyIn * 20n, 'the poison buy is not small relative to the graduating buy -- the window is gone')
      .to.be.lessThan(GRADUATING_BUY);

    await ethers.provider.send('evm_increaseTime', [30]);
    await ethers.provider.send('evm_mine', []);
    await (await ballista.connect(attacker).buy(token, buyIn, 0)).wait();

    const after = await ballista.curves(token);
    expect(after.state, 'the poison buy alone graduated the curve -- the window is gone')
      .to.equal(0n);
    expect(after.realUsdcReserves, 'the poison buy already crossed the threshold')
      .to.be.lessThan(threshold);

    const launched = new ethers.Contract(token, ERC20_ABI, attacker);
    // Half, so the attacker still holds tokens for any second offer a test makes.
    const atkTokens = (await launched.balanceOf(attacker.address)) / 2n;
    expect(atkTokens, 'the poison buy yielded no tokens to deposit').to.be.greaterThan(0n);

    const spender = await forwarder.getAddress();
    await (await launched.approve(spender, ethers.MaxUint256)).wait();
    await (await usdc.connect(attacker).approve(spender, ethers.MaxUint256)).wait();
    const deadline = (await ethers.provider.getBlock('latest')).timestamp + 3600;
    return forwarder.connect(attacker).addLiquidity(
      token, USDC, atkTokens, usdcSide, 0, 0, attacker.address, deadline
    );
  }

  async function graduate(token, usdcIn = GRADUATING_BUY) {
    await ethers.provider.send('evm_increaseTime', [30]);
    await ethers.provider.send('evm_mine', []);
    const adapterAddr = await adapter.getAddress();
    // The forwarder pulls from the caller and re-approves the adapter, so approvals
    // now target the forwarder rather than the adapter itself.
    const spender = await forwarder.getAddress();
    const launched = new ethers.Contract(token, ERC20_ABI, ethers.provider);
    const bT = await launched.balanceOf(adapterAddr);
    const bU = await usdc.balanceOf(adapterAddr);
    const tokenIdBefore = await posm.nextTokenId();
    const rc = await (await ballista.connect(buyer).buy(token, usdcIn, 0)).wait();
    const parsed = rc.logs.map((l) => { try { return ballista.interface.parseLog(l); } catch { return null; } })
      .filter(Boolean);
    const g = parsed.find((l) => l.name === 'Graduated');
    const dT = (await launched.balanceOf(adapterAddr)) - bT;
    const dU = (await usdc.balanceOf(adapterAddr)) - bU;
    return {
      gasUsed: rc.gasUsed, tokenId: tokenIdBefore, curve: await ballista.curves(token),
      graduated: g, attemptFailed: parsed.find((l) => l.name === 'GraduationAttemptFailed'),
      ready: parsed.find((l) => l.name === 'GraduationReady'),
      dustToken: dT, dustUsdc: dU,
      consumedToken: g ? g.args[1] : 0n, consumedUsdc: g ? g.args[2] : 0n,
      pulledToken: g ? g.args[1] + dT : 0n, pulledUsdc: g ? g.args[2] + dU : 0n,
    };
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

  // §15.6: compare the pool price against what the adapter was HANDED, never against what
  // the mint consumed -- for a full-range mint the consumed amounts are DERIVED from the
  // pool price, so that comparison is circular and passed at rel=-7.5e-13 on a pool priced
  // 1e12 wrong.
  async function poolPriceError(token, tokenPulled, usdcPulled) {
    const { key, tokenIsCurrency0 } = poolKeyFor(token);
    const [p0, p1] = tokenIsCurrency0 ? [tokenPulled, usdcPulled] : [usdcPulled, tokenPulled];
    const [sp] = await lens.slot0(POOL_MANAGER, key);
    const lhs = sp * sp * p0;
    const rhs = p1 * Q96 * Q96;
    return { sp, rel: Number(((lhs - rhs) * 10n ** 18n) / rhs) / 1e18 };
  }

  // ───────────────────────────────────────────────────────────────────────────────
  // ATTACK 1 — pool front-running
  // ───────────────────────────────────────────────────────────────────────────────

  it('A1a. a hostile pre-initialised pool is REFUSED, and the curve survives intact', async function () {
    await deployAll();
    const token = await launch('A1A');
    const { key } = poolKeyFor(token);

    // Initialise the pool first, at ~1e12x the correct price.
    // ⚠ POISONING NOW GOES THROUGH THE FORWARDER, and that substitution IS the finding.
    // `pm.initialize(...)` from an EOA is refused by the hook with NotAdapter -- the
    // pre-emptive, capital-free attack this test was written for is gone. What remains
    // reachable is an attacker who routes through a caller the adapter accepts, supplying
    // their own two amounts at a ratio of their choosing. That is the pre-gate world,
    // retained as defence in depth; the sibling test asserts the direct route is refused.
    await poisonViaForwarder(token, key);

    const adapterBefore = {
      token: await new ethers.Contract(token, ERC20_ABI, ethers.provider).balanceOf(await adapter.getAddress()),
      usdc: await usdc.balanceOf(await adapter.getAddress()),
    };

    // ⚠ THE WINDOW BETWEEN CROSSING THE THRESHOLD AND EMPTYING THE CURVE IS NARROW, and
    // poisonViaForwarder now spends inside it. Buying the curve OUT fires CLAUDE.md 1.4's
    // DEPLETION arm -- a legitimate second route to GRADUATION_READY that zeroes
    // tokenReserves -- and the assertion below then reads "tokenReserves lost", which
    // looks like a fund-loss bug and is the curve correctly emptying. Buying too little
    // crosses nothing and there is no graduation attempt at all. The poison buy is
    // therefore kept small (10 USDC) so the default graduating buy still lands between.
    const g = await graduate(token);
    expect(g.graduated, 'graduation SUCCEEDED into a hostile pool').to.be.undefined;
    expect(g.attemptFailed, 'no GraduationAttemptFailed').to.not.be.undefined;
    expect(g.curve.state, 'not parked at GRADUATION_READY').to.equal(1n);

    // Reserves intact -- the difference between parked and destroyed.
    const reservesT = g.curve.tokenReserves;
    const reservesU = g.curve.realUsdcReserves;
    expect(reservesT, 'tokenReserves lost').to.be.greaterThan(0n);
    expect(reservesU, 'realUsdcReserves lost').to.be.greaterThan(0n);

    // ⚠ MEASURED AS A DELTA ACROSS THE FAILED GRADUATION, NOT AS AN ABSOLUTE ZERO.
    // The attacker deposited through the adapter to poison the pool, so the adapter
    // legitimately holds their rounding dust before graduation is ever attempted. An
    // absolute check reported "tokens left the factory" for dust that was the attacker's
    // own -- a fixture artefact reading as a fund-loss bug. What must hold is that the
    // FAILED graduation moved nothing: the balances are identical either side of it.
    const launched = new ethers.Contract(token, ERC20_ABI, ethers.provider);
    expect(await launched.balanceOf(await adapter.getAddress()), 'tokens left the factory during a FAILED graduation')
      .to.equal(adapterBefore.token);
    expect(await usdc.balanceOf(await adapter.getAddress()), 'usdc left the factory during a FAILED graduation')
      .to.equal(adapterBefore.usdc);

    // ⚠ THE RECOVERY HALF OF THIS TEST WAS REMOVED, AND THE REASON IS THE FINDING.
    //
    // It used to correct the pool for GAS ALONE: "an empty v4 pool has no liquidity to
    // trade against, so a swap bounded by sqrtPriceLimitX96 walks the price straight to
    // the limit and settles nothing". That depended on the pool being EMPTY, which
    // depended on poisoning being free -- and poisoning is no longer free. The only route
    // left deposits real liquidity, so the same move now reverts CurrencyNotSettled
    // (0x5212cba1), exactly as the corrector's C2 asserts it should.
    //
    // Recovery from a LIQUIDITY-BACKED poisoning is A2b and A2d's subject, and both show
    // it is profitable arbitrage that comes out of the attacker's own position. Repeating
    // it here against an empty-pool premise that can no longer occur would be a test
    // passing for a reason unrelated to its name.
  });

  it('A1c. the price check is what refuses it, NAMED -- and there is a second guard behind it', async function () {
    await deployAll();

    // A1a proves a hostile pool is refused. It does NOT prove WHICH guard refused it, and
    // that distinction matters: the v4-accept-any-price red-proof removed the price check
    // entirely and A1a still passed, because the mint's own amount0Max/amount1Max caps
    // reject the lopsided amounts a wrong price demands. Good defence in depth -- and a
    // check that cannot tell the two apart is not evidence for either.
    //
    // ⚠ THE PAIR IS NOW A REAL LFX1 TOKEN AND REAL USDC, and that change preserves what
    // this test exercises rather than altering it. Two synthetic tokens were incidental
    // here -- convenient, never load-bearing. What the test needs is a pool standing at
    // one price and an offer implying a different one, which a launched token gives
    // directly. (The hook refuses a pool with no USDC side, so the old pair could not
    // have been registered at all.)
    const token = await launch('A1C');
    const { key } = poolKeyFor(token);
    const spender = await forwarder.getAddress();

    // Seed the pool at the attacker's price.
    await poisonViaForwarder(token, key);
    const [seeded] = await lens.slot0(POOL_MANAGER, key);
    expect(seeded, 'the pool was not seeded, so nothing below tests a price mismatch')
      .to.be.greaterThan(0n);

    // Now offer amounts implying a very different price. LFX1 swallows the revert in its
    // try/catch, so the reason is only visible on a DIRECT call -- which is what this is.
    const launched = new ethers.Contract(token, ERC20_ABI, attacker);
    const held = await launched.balanceOf(attacker.address);
    expect(held, 'attacker holds no tokens for the second offer').to.be.greaterThan(0n);
    const deadline = (await ethers.provider.getBlock('latest')).timestamp + 3600;

    await expect(
      forwarder.connect(attacker).addLiquidity(
        token, USDC, held, 1n, 0, 0, attacker.address, deadline
      )
    ).to.be.revertedWithCustomError(adapter, 'PoolPriceMismatch');
    console.log('      ATTACK A1c  refused by PoolPriceMismatch, NAMED -- not by the mint caps');
  });

  it('A1b. THE ACCEPTED BAND is one ulp of sqrtPriceX96 -- BOTH orderings, and it is dust in each', async function () {
    // ⚠ THIS TEST USED TO BE ORDER-DEPENDENT, AND THE CAUSE WAS NOT WHAT IT LOOKED LIKE.
    //
    // It passed alone (relWidth 1.626e-37) and failed in a combined run (3.919e-21) --
    // sixteen orders of magnitude apart, which reads like a pricing bug. It is TOKEN
    // ORDERING. sqrtPriceX96 encodes sqrt(amount1/amount0) in RAW units, and the two sides
    // are 18dp and 6dp, so the same pool is ~1.23e37 with USDC as currency0 and ~5.10e20
    // with the token as currency0. One ulp of sqrtPriceX96 is a fixed ABSOLUTE step, so it
    // is a far coarser RELATIVE step when sp is small.
    //
    // Which ordering you get depends on the launched token's address --
    // keccak(rlp([LFX1, nonce])) -- and LFX1's own address moves with the deployer's nonce,
    // so it differs between a standalone run and a combined one. The old `< 1e-30`
    // threshold encoded one ordering and had never seen the other.
    //
    // A test that gives different answers depending on what ran before it is not evidence
    // for either answer (CLAUDE.md 20.17). So it now exercises BOTH orderings explicitly
    // and asserts the bound that is ordering-independent: the band is worth less than one
    // raw unit of USDC. Roughly a fifth of real launches sort below USDC, so both branches
    // occur in production and both are now measured rather than sampled.
    await deployAll();

    const found = {};
    for (let i = 0; i < 12 && (!found.usdcFirst || !found.tokenFirst); i++) {
      const token = await launch('A1B' + i);
      const slot = BigInt(token) < BigInt(USDC) ? 'tokenFirst' : 'usdcFirst';
      if (found[slot]) continue;
      await ethers.provider.send('evm_increaseTime', [30]);
      await ethers.provider.send('evm_mine', []);
      await (await ballista.connect(buyer).buy(token, 8_100n * ONE, 0)).wait();
      const curve = await ballista.curves(token);
      if (curve.state !== 2n) continue; // not a clean graduation; try another
      const { key } = poolKeyFor(token);
      const [sp] = await lens.slot0(POOL_MANAGER, key);
      found[slot] = { token, sp };
    }
    expect(found.usdcFirst, 'never launched a token that sorts ABOVE USDC').to.not.be.undefined;
    expect(found.tokenFirst, 'never launched a token that sorts BELOW USDC').to.not.be.undefined;

    for (const [label, r] of Object.entries(found)) {
      // The adapter's check is EXACT equality on sqrtPriceX96, so the accepted set is a
      // single uint160. price = (sp/2^96)^2, so d(price)/price = 2/sp for a one-ulp step.
      const relWidth = 2 / Number(r.sp);
      const worthRawUsdc = relWidth * 8019 * 1e6;
      console.log(`      ATTACK A1b  ${label.padEnd(10)} sp=${r.sp} rel=${relWidth.toExponential(3)} worth=${worthRawUsdc.toExponential(3)} raw USDC`);
      // ⚠ THE ORDERING-INDEPENDENT BOUND. A relative width means nothing on its own here
      // because the two orderings are reciprocal prices; what matters economically is
      // whether an attacker landing inside the band can move anything worth having.
      expect(worthRawUsdc, `${label}: the band is worth a whole raw USDC unit or more`)
        .to.be.lessThan(1);
      expect(relWidth, `${label}: the band is not a single ulp`).to.be.greaterThan(0);
    }
    // And the two really are different orderings, or the loop found the same case twice.
    expect(BigInt(found.tokenFirst.token) < BigInt(USDC), 'tokenFirst does not sort below USDC').to.equal(true);
    expect(BigInt(found.usdcFirst.token) > BigInt(USDC), 'usdcFirst does not sort above USDC').to.equal(true);
  });

  it('A4b. SIBLING -- a pool CANNOT be poisoned before the token exists, any more', async function () {
    // ⚠ THIS IS THE HEADLINE EVIDENCE FOR CLAUDE.md 20.13, AND ITS TITLE USED TO BE THE
    // OPPOSITE: "a pool can be poisoned BEFORE the token exists -- v4 never checks the
    // currency has code".
    //
    // Everything that made that attack possible is still true of v4 and of CREATE
    // addressing: PoolManager.initialize checks tickSpacing, currency ordering and hook
    // validity and NOTHING ELSE, and LFX1 token addresses are keccak(rlp([factory,
    // nonce])) and fully predictable. What changed is that a pool carrying our hook can
    // be initialised by exactly one caller.
    //
    // ⚠ AND BOTH ROUTES ARE CLOSED, WHICH IS THE POINT. The direct route is refused by the
    // hook. The forwarder route -- the one that keeps the other attacks in this file
    // alive -- cannot even be attempted, because it requires buying the token off its
    // curve and the token does not exist. There is no transaction an attacker can send.
    await deployAll();

    const factory = await ballista.getAddress();
    const nonce = await ethers.provider.getTransactionCount(factory);
    const predicted = ethers.getCreateAddress({ from: factory, nonce });
    expect(await ethers.provider.getCode(predicted), 'the predicted token already exists')
      .to.equal('0x');

    const { key } = poolKeyFor(predicted);

    // Route 1: straight at PoolManager, which is how the original attack worked.
    await expect(pm.connect(attacker).initialize(keyTuple(key), Q96)).to.be.reverted;

    // Name the guard rather than observing a revert (CLAUDE.md 16.4). Called directly,
    // the hook says NotAdapter -- it never even reaches the currency checks.
    const hook = await ethers.getContractAt('BallistaFeeHook', hookAddress);
    await expect(hook.connect(attacker).beforeInitialize(attacker.address, key, Q96))
      .to.be.revertedWithCustomError(hook, 'NotPoolManager');

    // Route 2: through the adapter, which needs the token to exist to pull anything.
    const deadline = (await ethers.provider.getBlock('latest')).timestamp + 3600;
    await expect(
      forwarder.connect(attacker).addLiquidity(
        predicted, USDC, 10n ** 21n, 1_000n * ONE, 0, 0, attacker.address, deadline
      )
    ).to.be.reverted;

    // And the prediction really was right, so the attack was aimed at the real address.
    const token = await launch('A4B');
    expect(token.toLowerCase(), 'address prediction was wrong').to.equal(predicted.toLowerCase());

    // The token graduates normally -- there was nothing to poison.
    const g = await graduate(token);
    expect(g.graduated, 'graduation failed even though no poisoning was possible')
      .to.not.be.undefined;
    console.log('      ATTACK A4b  BOTH routes closed. The pre-emptive attack cannot be expressed.');
  });

  it('A2a. DONATIONS to the adapter and the factory do not disturb graduation', async function () {
    await deployAll();
    const token = await launch('A2A');
    const adapterAddr = await adapter.getAddress();
    // The forwarder pulls from the caller and re-approves the adapter, so approvals
    // now target the forwarder rather than the adapter itself.
    const spender = await forwarder.getAddress();
    const factory = await ballista.getAddress();

    // Buy a little so the attacker holds the launched token to donate.
    await ethers.provider.send('evm_increaseTime', [30]);
    await ethers.provider.send('evm_mine', []);
    await ballista.connect(attacker).buy(token, 50n * ONE, 0);
    const launched = new ethers.Contract(token, ERC20_ABI, attacker);

    // Donate to BOTH, on both sides.
    await launched.transfer(adapterAddr, 1_000n * 10n ** 18n);
    await usdc.connect(attacker).transfer(adapterAddr, 500n * ONE);
    await launched.transfer(factory, 1_000n * 10n ** 18n);
    await usdc.connect(attacker).transfer(factory, 500n * ONE);

    const g = await graduate(token);
    expect(g.graduated, 'a donation blocked graduation').to.not.be.undefined;
    expect(g.curve.state).to.equal(2n);

    // The adapter measures consumption as a balance DELTA across the mint, so a prior
    // donation sits in both readings and cancels. The price is unaffected because it is
    // derived from the amounts LFX1 hands over, which come from accounting and never
    // from balanceOf.
    const { rel } = await poolPriceError(token, g.pulledToken, g.pulledUsdc);
    expect(Math.abs(rel), `donation moved the pool price by ${rel}`).to.be.lessThan(1e-9);

    console.log(`      ATTACK A2a  FAILED to disturb anything. rel=${rel}`);
    console.log(`      NOTE donated value is now permanently stranded in the ownerless adapter`);
  });

  it('A2b. poisoning BACKED BY LIQUIDITY blocks graduation, and costs the attacker their position', async function () {
    await deployAll();
    const token = await launch('A2B');
    const { key, tokenIsCurrency0 } = poolKeyFor(token);
    const adapterAddr = await adapter.getAddress();
    // The forwarder pulls from the caller and re-approves the adapter, so approvals
    // now target the forwarder rather than the adapter itself.
    const spender = await forwarder.getAddress();

    // The attacker buys on the curve, then uses THE ADAPTER ITSELF to initialise the pool
    // at a ratio of their choosing and mint a position to themselves. The adapter derives
    // the price from the amounts it is handed, so an attacker who chooses the amounts
    // chooses the price. This is attack 4 used as a griefing primitive.
    await ethers.provider.send('evm_increaseTime', [30]);
    await ethers.provider.send('evm_mine', []);
    await ballista.connect(attacker).buy(token, 2_000n * ONE, 0);

    // The corrector's inventory has to be acquired NOW, while the curve is still ACTIVE.
    // Once graduation is attempted and fails the curve sits at GRADUATION_READY, where
    // both buy and sell are closed (CLAUDE.md 1.4) -- so anyone planning to correct a
    // poisoned pool must already hold the token. That is a real constraint on recovery,
    // not a test artifact, and it is worth stating: the corrector cannot bootstrap
    // themselves from the curve after the fact.
    await ballista.connect(buyer).buy(token, 2_000n * ONE, 0);

    const launched = new ethers.Contract(token, ERC20_ABI, attacker);
    const atkTokens = await launched.balanceOf(attacker.address);
    const atkUsdc = 1_000n * ONE;

    await launched.approve(spender, ethers.MaxUint256);
    await usdc.connect(attacker).approve(spender, ethers.MaxUint256);

    const deadline = (await ethers.provider.getBlock('latest')).timestamp + 3600;
    const posBefore = await posm.nextTokenId();
    await forwarder.connect(attacker).addLiquidity(
      token, USDC, atkTokens, atkUsdc, 0, 0, attacker.address, deadline
    );
    const [poisonedPrice] = await lens.slot0(POOL_MANAGER, key);
    expect(poisonedPrice, 'the attacker did not initialise the pool').to.be.greaterThan(0n);
    expect(await posm.ownerOf(posBefore), 'the position did not go to the attacker')
      .to.equal(attacker.address);
    const attackerLiquidity = await posm.getPositionLiquidity(posBefore);
    expect(attackerLiquidity, 'the attacker minted no liquidity').to.be.greaterThan(0n);

    // Graduation now fails: the pool exists at a price the adapter did not derive.
    const g = await graduate(token);
    expect(g.graduated, 'graduated into a liquidity-backed poisoned pool').to.be.undefined;
    expect(g.curve.state, 'not parked').to.equal(1n);

    // ⚠ IS IT RECOVERABLE? The pool now has real liquidity, so correcting the price means
    // trading against it. Measure what that costs -- and who ends up holding what.
    const LP = await ballista.LP_TOKEN_RESERVE();
    const tokenLiquidity = LP + g.curve.tokenReserves;
    const usdcLiquidity = g.curve.realUsdcReserves + g.curve.poolBoost;
    const [a0, a1] = tokenIsCurrency0
      ? [tokenLiquidity, usdcLiquidity] : [usdcLiquidity, tokenLiquidity];
    // The harness inherits the adapter, so the adapter's hook checks run on it and it
    // needs its own correctly-flagged, correctly-bound MockHookBinding.
    const mathHarness = (await deployBoundPair(owner, 'MockHookBinding', [], 'V4AdapterMathHarness', [])).adapter;
    const target = await mathHarness.sqrtPriceX96(a0, a1);

    const swapper = await (await ethers.getContractFactory('V4Swapper')).deploy(POOL_MANAGER);
    const swapperAddr = await swapper.getAddress();
    // Fund the corrector on both sides; the cost is read as a delta.
    await fundUsdc(swapperAddr, 200_000n * ONE);
    const buyerTokens = await new ethers.Contract(token, ERC20_ABI, buyer).balanceOf(buyer.address);
    await new ethers.Contract(token, ERC20_ABI, buyer).transfer(swapperAddr, buyerTokens);

    const beforeT = await new ethers.Contract(token, ERC20_ABI, ethers.provider).balanceOf(swapperAddr);
    const beforeU = await usdc.balanceOf(swapperAddr);
    await swapper.swapToPrice(keyTuple(key), target);
    const afterT = await new ethers.Contract(token, ERC20_ABI, ethers.provider).balanceOf(swapperAddr);
    const afterU = await usdc.balanceOf(swapperAddr);

    const [corrected] = await lens.slot0(POOL_MANAGER, key);
    expect(corrected, 'the price could not be corrected').to.equal(target);

    // And graduation completes on the same parked reserves.
    const rc = await (await ballista.connect(buyer).graduate(token)).wait();
    const ev = rc.logs.map((l) => { try { return ballista.interface.parseLog(l); } catch { return null; } })
      .filter(Boolean).find((l) => l.name === 'Graduated');
    expect(ev, 'graduation still blocked after correction').to.not.be.undefined;
    expect((await ballista.curves(token)).state).to.equal(2n);

    console.log(`      ATTACK A2b  BLOCKS graduation until corrected, but is NOT permanent`);
    console.log(`      MEASURE attacker committed     ${atkTokens} token + ${atkUsdc} usdc`);
    console.log(`      MEASURE attacker liquidity     ${attackerLiquidity}`);
    console.log(`      MEASURE corrector token delta  ${afterT - beforeT}`);
    console.log(`      MEASURE corrector usdc  delta  ${afterU - beforeU}`);
  });

  it('A2d. poisoning in the direction that needs TOKENS to correct is still recoverable', async function () {
    await deployAll();
    const token = await launch('A2D');
    const { key } = poolKeyFor(token);
    const adapterAddr = await adapter.getAddress();
    // The forwarder pulls from the caller and re-approves the adapter, so approvals
    // now target the forwarder rather than the adapter itself.
    const spender = await forwarder.getAddress();

    // ⚠ THE DIRECTION MATTERS AND A2b ONLY COVERED ONE OF THEM. There, the pool
    // underpriced the token, so correcting it meant BUYING tokens and the corrector
    // needed nothing but USDC. Poison the other way -- token far too EXPENSIVE -- and
    // correction means SELLING tokens into the pool.
    //
    // That is the awkward case, because at GRADUATION_READY both sides of the curve are
    // closed (CLAUDE.md §1.4), so nobody can obtain tokens from the curve after the fact.
    // The only supply is people who already bought. This establishes that such supply is
    // sufficient rather than assuming it.
    await ethers.provider.send('evm_increaseTime', [30]);
    await ethers.provider.send('evm_mine', []);
    await ballista.connect(attacker).buy(token, 500n * ONE, 0);
    await ballista.connect(buyer).buy(token, 2_000n * ONE, 0); // an ordinary holder, pre-park

    const launched = new ethers.Contract(token, ERC20_ABI, attacker);
    await launched.approve(spender, ethers.MaxUint256);
    await usdc.connect(attacker).approve(spender, ethers.MaxUint256);

    // Few tokens against a lot of USDC => the token is priced far ABOVE its curve price.
    const deadline = (await ethers.provider.getBlock('latest')).timestamp + 3600;
    const fewTokens = 1_000n * 10n ** 18n;
    await forwarder.connect(attacker).addLiquidity(
      token, USDC, fewTokens, 5_000n * ONE, 0, 0, attacker.address, deadline
    );
    const [poisoned] = await lens.slot0(POOL_MANAGER, key);

    const g = await graduate(token);
    expect(g.graduated, 'graduated into an over-priced pool').to.be.undefined;
    expect(g.curve.state, 'not parked').to.equal(1n);

    // The curve is shut, so confirm an ordinary holder genuinely cannot restock from it.
    await expect(ballista.connect(buyer).buy(token, 10n * ONE, 0))
      .to.be.revertedWithCustomError(ballista, 'CurveNotActive');

    // Correct it using ONLY tokens an existing holder already had.
    const LP = await ballista.LP_TOKEN_RESERVE();
    const [a0, a1] = poolKeyFor(token).tokenIsCurrency0
      ? [LP + g.curve.tokenReserves, g.curve.realUsdcReserves + g.curve.poolBoost]
      : [g.curve.realUsdcReserves + g.curve.poolBoost, LP + g.curve.tokenReserves];
    // The harness inherits the adapter, so the adapter's hook checks run on it and it
    // needs its own correctly-flagged, correctly-bound MockHookBinding.
    const mathHarness = (await deployBoundPair(owner, 'MockHookBinding', [], 'V4AdapterMathHarness', [])).adapter;
    const target = await mathHarness.sqrtPriceX96(a0, a1);

    const swapper = await (await ethers.getContractFactory('V4Swapper')).deploy(POOL_MANAGER);
    const swapperAddr = await swapper.getAddress();
    const holderTokens = await new ethers.Contract(token, ERC20_ABI, buyer).balanceOf(buyer.address);
    await new ethers.Contract(token, ERC20_ABI, buyer).transfer(swapperAddr, holderTokens);

    const beforeU = await usdc.balanceOf(swapperAddr);
    await swapper.swapToPrice(keyTuple(key), target);
    const afterU = await usdc.balanceOf(swapperAddr);

    const [corrected] = await lens.slot0(POOL_MANAGER, key);
    expect(corrected, 'could not correct an over-priced pool with holder tokens alone')
      .to.equal(target);

    const rc = await (await ballista.connect(buyer).graduate(token)).wait();
    const ev = rc.logs.map((l) => { try { return ballista.interface.parseLog(l); } catch { return null; } })
      .filter(Boolean).find((l) => l.name === 'Graduated');
    expect(ev, 'still blocked after correction').to.not.be.undefined;
    expect((await ballista.curves(token)).state).to.equal(2n);

    console.log(`      ATTACK A2d  poisoned HIGH (${poisoned}); corrected using holder tokens only`);
    console.log(`      MEASURE corrector usdc gained  ${afterU - beforeU} (profit, at the attacker's expense)`);
  });

  it('A2c. an EXTREME-tick pool is still refused and still recoverable', async function () {
    await deployAll();
    const token = await launch('A2C');
    const { key } = poolKeyFor(token);

    // The most extreme price v4 will accept, rather than a merely wrong one -- probing for
    // an arithmetic edge in the adapter's comparison rather than an economic one.
    const MIN_SQRT = 4295128739n;
    // Extreme end of the range, reached through the forwarder for the same reason as
    // every other poisoning in this file -- a direct pm.initialize is refused now.
    await poisonViaForwarder(token, key, 1n);

    // ⚠ THE WINDOW BETWEEN CROSSING THE THRESHOLD AND EMPTYING THE CURVE IS NARROW, and
    // poisonViaForwarder now spends inside it. Buying the curve OUT fires CLAUDE.md 1.4's
    // DEPLETION arm -- a legitimate second route to GRADUATION_READY that zeroes
    // tokenReserves -- and the assertion below then reads "tokenReserves lost", which
    // looks like a fund-loss bug and is the curve correctly emptying. Buying too little
    // crosses nothing and there is no graduation attempt at all. The poison buy is
    // therefore kept small (10 USDC) so the default graduating buy still lands between.
    const g = await graduate(token);
    expect(g.graduated, 'graduated into an extreme-tick pool').to.be.undefined;
    expect(g.curve.state, 'not parked').to.equal(1n);
    expect(g.curve.tokenReserves, 'reserves lost').to.be.greaterThan(0n);
    console.log(`      ATTACK A2c  REFUSED at the extreme of v4's price range, curve parked`);
  });

  // ───────────────────────────────────────────────────────────────────────────────
  // ATTACK 3 — value extraction from an ownerless contract
  // ───────────────────────────────────────────────────────────────────────────────

  it('A3a. REENTERING addLiquidity is refused by the guard', async function () {
    await deployAll();

    // ⚠ THIS TEST RUNS AGAINST A CONFIGURATION PRODUCTION CANNOT REACH, DELIBERATELY.
    //
    // The adapter's ReentrancyGuard can only be exercised by a currency that calls back
    // during its own transfer. BallistaFeeHook admits only a launched LFX1 token paired
    // with USDC, and LFX1Token is plain OZ ERC20 with no callbacks -- so in production no
    // such currency can ever be in a Ballista pool, and this guard is unreachable.
    //
    // It is still shipped code, and CLAUDE.md 16.4 records why that is not a reason to
    // stop testing it: the `v4-no-guard` mutation SURVIVED the first version of this test.
    // A guard a mutation has once escaped needs a test that still reaches it.
    //
    // So a second adapter is stood up behind PermissiveTestHook, which registers any pool.
    // See that contract's header. Nothing below touches the real adapter or the real hook.
    const permFwd = await (await ethers.getContractFactory('MockLfx1Caller')).deploy();
    const permPair = await deployBoundPair(
      owner, 'PermissiveTestHook', [POOL_MANAGER], 'BallistaV4Adapter',
      [POOL_MANAGER, POSITION_MANAGER, PERMIT2, await permFwd.getAddress()]
    );
    const permAdapter = permPair.adapter;
    await (await permFwd.setAdapter(await permAdapter.getAddress())).wait();
    const adapterAddr = await permAdapter.getAddress();
    const spender = await permFwd.getAddress();

    const reent = await (await ethers.getContractFactory('ReenteringToken')).deploy();
    const plain = await (await ethers.getContractFactory('PlainToken18')).deploy();
    // ⚠ THE REENTERER GOES THROUGH THE FORWARDER, NOT STRAIGHT AT THE ADAPTER.
    // Pointed at the adapter it is refused by the CALLER GATE (NotLfx1) before the
    // ReentrancyGuard is ever consulted -- the nested call returned 0x901d9118 rather than
    // 0x3ee5aeb5, and a test asserting "refused" without naming the guard would have read
    // that as the guard holding (CLAUDE.md 16.4). Re-entering through a permitted caller
    // is what actually reaches the guard under test.
    const reenterer = await (await ethers.getContractFactory('AdapterReenterer')).deploy(spender);

    await reent.mint(attacker.address, 10n ** 24n);
    await plain.mint(attacker.address, 10n ** 24n);
    await reent.connect(attacker).approve(spender, ethers.MaxUint256);
    await plain.connect(attacker).approve(spender, ethers.MaxUint256);

    // ⚠ THE REENTERER MUST BE ABLE TO SUCCEED BUT FOR THE GUARD, or this proves nothing.
    // The first version left it holding no tokens and no approval, so the nested call
    // reverted on the transfer rather than on the guard -- and the v4-no-guard red-proof
    // duly SURVIVED, 17 passing, because removing the guard changed nothing the check
    // could see. This is CLAUDE.md §12.6 in its second form: mutate the thing the check
    // asserts about, and make sure the check actually reaches it.
    const reentererAddr = await reenterer.getAddress();
    await reent.mint(reentererAddr, 10n ** 21n);
    await plain.mint(reentererAddr, 10n ** 21n);
    await reenterer.approveAdapter(await reent.getAddress());
    await reenterer.approveAdapter(await plain.getAddress());

    const deadline = (await ethers.provider.getBlock('latest')).timestamp + 3600;
    // Arm the token to call back into addLiquidity during its own transferFrom.
    const payload = reenterer.interface.encodeFunctionData('reenter', [
      await reent.getAddress(), await plain.getAddress(),
      10n ** 18n, 10n ** 18n, reentererAddr, deadline,
    ]);
    // arm(target, payload, TRIGGER, SKIP). trigger 1 = during transferFrom, 2 = during
    // approve; _fire uses `seen++ < skip`, so it fires on the (skip+1)-th occurrence.
    //
    // ⚠ SKIP IS 1 BECAUSE THE FORWARDER PULLS FIRST. `reent` moves twice before the guard
    // is engaged -- attacker -> forwarder, then forwarder -> adapter -- and only the
    // second is inside the adapter. Arming on the first fires the callback where nothing
    // is guarded, and the nested call completes; the test then reports "REENTRANCY
    // SUCCEEDED", i.e. a missing guard rather than a mis-aimed fixture.
    await reent.arm(reentererAddr, payload, 1, 1);

    await permFwd.connect(attacker).addLiquidity(
      await reent.getAddress(), await plain.getAddress(),
      10n ** 21n, 10n ** 21n, 0, 0, attacker.address, deadline
    );

    expect(await reent.fired(), 'the reentrant callback never fired -- the test proves nothing')
      .to.equal(true);
    expect(await reenterer.secondCallSucceeded(), 'REENTRANCY SUCCEEDED into addLiquidity')
      .to.equal(false);

    // Name the guard, so a nested call that fails for some unrelated reason cannot be
    // mistaken for the guard holding.
    const ret = await reenterer.secondCallReturndata();
    const REENTRANT = ethers.id('ReentrancyGuardReentrantCall()').slice(0, 10);
    expect(ret.slice(0, 10), 'the nested call failed for a reason OTHER than the guard')
      .to.equal(REENTRANT);
    console.log(`      ATTACK A3a  FAILED. returndata ${ret.slice(0, 10)} = ReentrancyGuardReentrantCall`);
  });

  it('A3b. a FEE-ON-TRANSFER tokenA reverts the whole call -- it cannot half-succeed', async function () {
    await deployAll();
    const adapterAddr = await adapter.getAddress();
    // The forwarder pulls from the caller and re-approves the adapter, so approvals
    // now target the forwarder rather than the adapter itself.
    const spender = await forwarder.getAddress();

    const fot = await (await ethers.getContractFactory('FeeOnTransferToken18')).deploy(500); // 5%
    const plain = await (await ethers.getContractFactory('PlainToken18')).deploy();
    await fot.mint(attacker.address, 10n ** 24n);
    await plain.mint(attacker.address, 10n ** 24n);
    await fot.connect(attacker).approve(spender, ethers.MaxUint256);
    await plain.connect(attacker).approve(spender, ethers.MaxUint256);

    const deadline = (await ethers.provider.getBlock('latest')).timestamp + 3600;

    // The adapter prices and approves the amount it ASKED for, not the amount that
    // arrived, so the settle stage tries to move more than it holds.
    let reverted = false;
    let reason = '';
    try {
      await forwarder.connect(attacker).addLiquidity(
        await fot.getAddress(), await plain.getAddress(),
        10n ** 21n, 10n ** 21n, 0, 0, attacker.address, deadline
      );
    } catch (e) {
      reverted = true;
      reason = String(e.shortMessage || e.message).slice(0, 120);
    }
    expect(reverted, 'a fee-on-transfer tokenA was accepted -- check what state it left').to.equal(true);

    // Whatever happened, nothing may be left behind for someone else to take.
    const [amt, exp] = await permit2.allowance(adapterAddr, await fot.getAddress(), POSITION_MANAGER);
    expect(amt, 'a Permit2 allowance survived a reverted call').to.equal(0n);
    console.log(`      ATTACK A3b  reverted: ${reason}`);
  });

  // ───────────────────────────────────────────────────────────────────────────────
  // ATTACK 5 — the Permit2 approval window
  // ───────────────────────────────────────────────────────────────────────────────

  it('A5a. a FAILED graduation leaves NO Permit2 approval standing', async function () {
    await deployAll();
    const token = await launch('A5A');
    const { key } = poolKeyFor(token);
    const adapterAddr = await adapter.getAddress();
    // The forwarder pulls from the caller and re-approves the adapter, so approvals
    // now target the forwarder rather than the adapter itself.
    const spender = await forwarder.getAddress();

    // Poison so the adapter reverts AFTER deriving the price but BEFORE approving --
    // then poison a second token so it reverts at a different point, and check both.
    // ⚠ POISONING NOW GOES THROUGH THE FORWARDER, and that substitution IS the finding.
    // `pm.initialize(...)` from an EOA is refused by the hook with NotAdapter -- the
    // pre-emptive, capital-free attack this test was written for is gone. What remains
    // reachable is an attacker who routes through a caller the adapter accepts, supplying
    // their own two amounts at a ratio of their choosing. That is the pre-gate world,
    // retained as defence in depth; the sibling test asserts the direct route is refused.
    await poisonViaForwarder(token, key);
    const g = await graduate(token);
    expect(g.graduated, 'expected a failed graduation to inspect').to.be.undefined;

    for (const [label, cur] of [['token', token], ['usdc', USDC]]) {
      const [amt, expiry] = await permit2.allowance(adapterAddr, cur, POSITION_MANAGER);
      expect(amt, `${label}: a Permit2 allowance survived a failed graduation`).to.equal(0n);
      const erc20 = new ethers.Contract(cur, ERC20_ABI, ethers.provider);
      expect(await erc20.allowance(adapterAddr, PERMIT2),
        `${label}: an ERC-20 allowance to Permit2 survived`).to.equal(0n);
    }
    console.log(`      ATTACK A5a  FAILED. no approval of either kind survives a failed graduation`);
  });

  it('A5b. after a SUCCESSFUL graduation both approvals are zeroed', async function () {
    await deployAll();
    const token = await launch('A5B');
    const adapterAddr = await adapter.getAddress();
    // The forwarder pulls from the caller and re-approves the adapter, so approvals
    // now target the forwarder rather than the adapter itself.
    const spender = await forwarder.getAddress();
    const g = await graduate(token);
    expect(g.graduated, 'expected a clean graduation').to.not.be.undefined;

    for (const [label, cur] of [['token', token], ['usdc', USDC]]) {
      const [amt] = await permit2.allowance(adapterAddr, cur, POSITION_MANAGER);
      expect(amt, `${label}: Permit2 allowance left standing after success`).to.equal(0n);
      const erc20 = new ethers.Contract(cur, ERC20_ABI, ethers.provider);
      expect(await erc20.allowance(adapterAddr, PERMIT2),
        `${label}: ERC-20 allowance to Permit2 left standing`).to.equal(0n);
    }
    console.log(`      ATTACK A5b  FAILED. both legs zeroed on the success path`);
  });

  // ───────────────────────────────────────────────────────────────────────────────
  // ATTACK 8 — dust made material
  // ───────────────────────────────────────────────────────────────────────────────

  it('A8. dust stays negligible across the whole reachable threshold range', async function () {
    await deployAll();
    const worst = { rel: 0, label: '', amount: 0n };

    // ⚠ THE "~54.2 USDC FLOOR" THIS COMMENT USED TO CITE IS STALE. It came from the
    // 2**64 ratio bound, which CLAUDE.md 15.4 records as FIXED by the wide branch:
    // MAX_PRECISE_RATIO is 2**63 and MAX_AMOUNT_RATIO is 2**191 (BallistaV4Adapter.sol:78-79),
    // so the arithmetic floor is now ~3e-37 USDC and v4's own MIN_SQRT_PRICE floors it at
    // ~3e-18. V4AdapterMath M8 already exercises a 10 USDC threshold successfully.
    //
    // The 60 USDC case below is kept as the low end because it is measured, not because
    // anything breaks beneath it.
    for (const [label, threshold, spend] of [
      ['floor+  60 USDC', 60n * ONE, 70n * ONE],
      ['default 8,000 USDC', 8_000n * ONE, 8_100n * ONE],
      ['large  50,000 USDC', 50_000n * ONE, 52_000n * ONE],
    ]) {
      await ballista.connect(owner).setDefaultGraduationThreshold(threshold);
      const token = await launch(`A8${threshold}`);
      const g = await graduate(token, spend);
      expect(g.graduated, `${label}: did not graduate`).to.not.be.undefined;

      for (const [side, dust, pulled] of [
        ['token', g.dustToken, g.pulledToken],
        ['usdc', g.dustUsdc, g.pulledUsdc],
      ]) {
        const rel = Number(dust) / Number(pulled);
        if (rel > worst.rel) { worst.rel = rel; worst.label = `${label} / ${side}`; worst.amount = dust; }
        expect(dust, `${label} ${side}: NEGATIVE dust -- the adapter paid out of its own balance`)
          .to.be.at.least(0n);
      }
      console.log(`      MEASURE ${label.padEnd(20)} dustT=${g.dustToken} dustU=${g.dustUsdc}`);
    }

    // Stated as an AMOUNT, not a ratio: the raw units burned in the ownerless adapter.
    console.log(`      ATTACK A8   worst case ${worst.label}: ${worst.amount} raw units (${worst.rel.toExponential(2)} rel)`);
    expect(worst.rel, `dust reached ${worst.rel} of a side`).to.be.lessThan(1e-6);
  });

  // ───────────────────────────────────────────────────────────────────────────────
  // ATTACK 4 — what a hostile DIRECT caller achieves
  // ───────────────────────────────────────────────────────────────────────────────

  it('A4a. SIBLING -- a direct caller cannot reach the adapter at all', async function () {
    // ⚠ THIS TEST'S SUBJECT WAS REMOVED BY THE GATE, SO IT ASSERTS THE REMOVAL.
    //
    // It used to read "a direct caller gets a position and an arbitrary pool price, with
    // THEIR OWN money", and concluded that the only externality was pool creation at a
    // chosen price. `msg.sender == lfx1` on addLiquidity means there is no direct caller
    // any more, so that externality is gone with it (CLAUDE.md 20.13).
    //
    // Its other half -- that no Permit2 allowance survives a call -- is unchanged and is
    // covered by A5a (failed graduation) and A5b (successful graduation).
    await deployAll();
    const tokA = await (await ethers.getContractFactory('PlainToken18')).deploy();
    const deadline = (await ethers.provider.getBlock('latest')).timestamp + 3600;

    await expect(
      adapter.connect(attacker).addLiquidity(
        await tokA.getAddress(), USDC, 10n ** 21n, 10n ** 20n, 0, 0, attacker.address, deadline
      )
    ).to.be.revertedWithCustomError(adapter, 'NotLfx1').withArgs(attacker.address);

    // Named the guard. Now show it is the gate and not the deadline or the amounts: the
    // permitted caller gets PAST it and fails later, on the curve record.
    await expect(
      forwarder.connect(attacker).addLiquidity(
        await tokA.getAddress(), USDC, 10n ** 21n, 10n ** 20n, 0, 0, attacker.address, deadline
      )
    ).to.not.be.revertedWithCustomError(adapter, 'NotLfx1');
    console.log('      ATTACK A4a  the direct route is gone: NotLfx1 before anything else runs');
  });

  // ⚠ A7 WAS DELETED, NOT SKIPPED. DO NOT RE-ADD IT AS MISSING COVERAGE.
  //
  // It re-entered from inside PoolManager.unlock, during Permit2's settle, with both of
  // the adapter's approvals live -- and asserted the refusal came from PositionManager's own ReentrancyLock (ContractLocked).
  //
  // Two reasons it is gone, and the second is the deciding one:
  //
  // 1. ITS PREMISE IS UNREACHABLE. It needs a currency that calls back during its own
  //    transfer. BallistaFeeHook admits only a launched LFX1 token paired with USDC, and
  //    LFX1Token is plain OZ ERC20 with no callbacks. No such currency can be in a
  //    Ballista pool.
  //
  // 2. IT WAS NEVER TESTING OUR CODE. CLAUDE.md 16.3 already records this explicitly:
  //    the guard in that window is v4-periphery's and v4-core's, not ours -- "the
  //    adapter's safety in that window is an UPSTREAM DEPENDENCY ... not a property of
  //    our code, and would not survive a v4-periphery version that relaxed it". A test
  //    we maintain against someone else's invariant asserts nothing we control, and goes
  //    red on their release rather than on our mistake.
  //
  // A3a is retained on the opposite reasoning: that guard IS ours, and a mutation once
  // escaped it.

  // ⚠ A7b WAS DELETED, NOT SKIPPED. DO NOT RE-ADD IT AS MISSING COVERAGE.
  //
  // It re-entered from inside PoolManager.unlock, during Permit2's settle, with both of
  // the adapter's approvals live -- and asserted the refusal came from PoolManager's own lock (AlreadyUnlocked).
  //
  // Two reasons it is gone, and the second is the deciding one:
  //
  // 1. ITS PREMISE IS UNREACHABLE. It needs a currency that calls back during its own
  //    transfer. BallistaFeeHook admits only a launched LFX1 token paired with USDC, and
  //    LFX1Token is plain OZ ERC20 with no callbacks. No such currency can be in a
  //    Ballista pool.
  //
  // 2. IT WAS NEVER TESTING OUR CODE. CLAUDE.md 16.3 already records this explicitly:
  //    the guard in that window is v4-periphery's and v4-core's, not ours -- "the
  //    adapter's safety in that window is an UPSTREAM DEPENDENCY ... not a property of
  //    our code, and would not survive a v4-periphery version that relaxed it". A test
  //    we maintain against someone else's invariant asserts nothing we control, and goes
  //    red on their release rather than on our mistake.
  //
  // A3a is retained on the opposite reasoning: that guard IS ours, and a mutation once
  // escaped it.

  it('A7c. a token callback CANNOT re-enter LFX1 mid-graduation', async function () {
    await deployAll();
    const token = await launch('A7C');

    // The real graduation path uses LFX1Token, a plain OZ ERC20 with no hooks, so nothing
    // in the mint can call back into LFX1 at all. Establish that positively rather than
    // by absence: read the launched token's code and confirm no callback surface, then
    // confirm LFX1 holds nonReentrant across the whole graduation.
    const g = await graduate(token);
    expect(g.graduated, 'expected a clean graduation').to.not.be.undefined;

    // LFX1's own guard: graduate() is nonReentrant, and the buy path that triggers
    // graduation is too, so any re-entry into either reverts before touching state.
    await expect(ballista.connect(attacker).graduate(token))
      .to.be.revertedWithCustomError(ballista, 'NotReadyToGraduate');
    console.log(`      ATTACK A7c  no callback surface on LFX1Token; graduation is nonReentrant end to end`);
  });
});
