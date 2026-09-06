const { expect } = require('chai');
const { ethers } = require('hardhat');

// Graduation into a REAL Uniswap v4 pool, on a pinned Base mainnet fork.
// Gated behind FORK_BASE=1; ordinary runs skip this file entirely.
//
//   FORK_BASE=1 npx hardhat test test/Fork.v4.test.js
//
// WHY BASE. Arc mainnet does not exist yet, and v4 is live on Base today. Base also
// reproduces the decimal ratio that makes this dangerous -- 6dp USDC against an 18dp
// launched token, the same 1e12 gap as Arc -- so the scale factor under test is the
// real one and not a rehearsal of it.
//
// WHY THIS FILE IS THE DELIVERABLE AND THE ADAPTER IS NOT. Every claim about the
// adapter that matters is a claim about how REAL v4 responds to it: whether the pool
// initialises at the price we derived, whether PositionManager settles through Permit2
// the way its source says, whether the position lands with the burn address. None of
// that can be shown by a mock, because a mock of v4 is a mock of exactly the thing in
// doubt. CLAUDE.md section 4 is explicit that test surfaces are not interchangeable.
const FORK_BLOCK = 50900000;
const POOL_MANAGER = '0x498581ff718922c3f8e6a244956af099b2652b2b';
const POSITION_MANAGER = '0x7c5f5a4bbd8fd63184577525326123b519429bdc';
const PERMIT2 = '0x000000000022D473030F116dDEE9F6B43aC78BA3';
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const BURN = '0x000000000000000000000000000000000000dEaD';

const ONE = 1_000_000n; // 1 USDC, 6dp
const Q96 = 1n << 96n;
const POOL_FEE = 0;
const TICK_SPACING = 60;

const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function transfer(address,uint256) returns (bool)',
  'function approve(address,uint256) returns (bool)',
  'function decimals() view returns (uint8)',
  'function totalSupply() view returns (uint256)',
];
const POSM_ABI = [
  'function nextTokenId() view returns (uint256)',
  'function ownerOf(uint256) view returns (address)',
  'function getPositionLiquidity(uint256) view returns (uint128)',
];

describe('Ballista — graduation into REAL Uniswap v4 (Base fork)', function () {
  this.timeout(1800000);

  let owner, treasury, creator, buyer;
  let usdc, posm, lens, adapter, ballista;

  before(async function () {
    if (!process.env.FORK_BASE) {
      this.skip();
    }
    // Guard against a silently unforked or wrongly-pinned run. Without these, every
    // assertion below would be measuring empty addresses and the suite would fail in
    // ways that look like adapter bugs. A fork at the wrong block or a bad RPC must
    // announce itself as exactly that.
    const bn = await ethers.provider.getBlockNumber();
    expect(bn, 'not forked at the pinned Base block').to.be.greaterThanOrEqual(FORK_BLOCK);

    // Hardhat starts the local chain AT the fork block, so "latest" is still a
    // HISTORICAL block as far as EDR is concerned, and any eth_call against it fails
    // with "No known hardfork for execution on historical block ... in chain with id
    // 8453" -- a message about Base's hardfork history that has nothing to do with
    // whatever the call was. Mining once moves "latest" onto a block the local node
    // owns, where the configured hardfork applies.
    await ethers.provider.send('evm_mine', []);
    expect(await ethers.provider.getBlockNumber(), 'no local block was mined')
      .to.be.greaterThan(FORK_BLOCK);

    for (const [name, addr] of [
      ['PoolManager', POOL_MANAGER],
      ['PositionManager', POSITION_MANAGER],
      ['Permit2', PERMIT2],
      ['USDC', USDC],
    ]) {
      const code = await ethers.provider.getCode(addr);
      expect(code, `${name} at ${addr} has NO CODE -- the fork did not take, or the pin is wrong`)
        .to.not.equal('0x');
    }
  });

  // USDC balances live in a mapping; find its slot empirically rather than trusting a
  // remembered constant, then write it. Impersonating a whale would bind the test to an
  // address whose balance at the pin could change meaning. (Same helper as
  // test/Fork.v2.test.js -- Base USDC is a proxy, so the slot is not the obvious one.)
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

  async function deployAll(routerOverride) {
    [owner, treasury, creator, buyer] = await ethers.getSigners();
    usdc = new ethers.Contract(USDC, ERC20_ABI, ethers.provider);
    posm = new ethers.Contract(POSITION_MANAGER, POSM_ABI, ethers.provider);

    expect(await usdc.decimals(), 'Base USDC must be 6dp for this test to mean anything')
      .to.equal(6n);

    lens = await (await ethers.getContractFactory('V4PoolLens')).deploy();
    adapter = await (await ethers.getContractFactory('BallistaV4Adapter')).deploy(
      POOL_MANAGER, POSITION_MANAGER, PERMIT2
    );
    // The adapter goes in as initialRouter_. That constructor bypass is the documented
    // one (CLAUDE.md 1.5) and is what makes a launch-day router possible at all.
    ballista = await (await ethers.getContractFactory('LFX1')).deploy(
      USDC, treasury.address, routerOverride || (await adapter.getAddress())
    );

    for (const s of [creator, buyer]) {
      await fundUsdc(s.address, 200_000n * ONE);
      await usdc.connect(s).approve(await ballista.getAddress(), ethers.MaxUint256);
    }
    return ballista;
  }

  async function launch(symbol) {
    // The hash is read here, immediately before the call that consumes it. Reading it
    // once at setup and reusing it would pin terms that may have moved (CLAUDE.md
    // 11.14) -- and setDefaultGraduationThreshold below MOVES it.
    const hash = await ballista.currentEconomicsHash();
    const rc = await (await ballista.connect(creator).createToken('Fork V4', symbol, '', hash, false)).wait();
    const ev = rc.logs
      .map((l) => { try { return ballista.interface.parseLog(l); } catch { return null; } })
      .filter(Boolean).find((l) => l.name === 'TokenCreated');
    await ethers.provider.send('evm_mine', []); // trading opens the block AFTER creation
    return ev.args.token;
  }

  // Cross the threshold in one buy, past the snipe window so the spend reaches the
  // curve rather than the tax.
  //
  // Also measures what the adapter was HANDED, by bracketing its balances. That
  // quantity is not otherwise observable -- LFX1 zeroes the curve on success, so the
  // amounts it offered are gone by the time anything can read them -- and it is the
  // only price reference independent of the pool. See assertPoolPrice.
  async function graduate(token, usdcIn = 8_100n * ONE) {
    await ethers.provider.send('evm_increaseTime', [30]);
    await ethers.provider.send('evm_mine', []);

    const adapterAddr = await adapter.getAddress();
    const launched = new ethers.Contract(token, ERC20_ABI, ethers.provider);
    const beforeToken = await launched.balanceOf(adapterAddr);
    const beforeUsdc = await usdc.balanceOf(adapterAddr);

    const tokenIdBefore = await posm.nextTokenId();
    const rc = await (await ballista.connect(buyer).buy(token, usdcIn, 0)).wait();
    const parsed = rc.logs
      .map((l) => { try { return ballista.interface.parseLog(l); } catch { return null; } })
      .filter(Boolean);

    // Whatever the adapter kept is the difference between what it pulled and what the
    // mint absorbed, so pulled = dust + consumed. Measured as a DELTA because USDC dust
    // can survive from an earlier graduation in the same run.
    const dustToken = (await launched.balanceOf(adapterAddr)) - beforeToken;
    const dustUsdc = (await usdc.balanceOf(adapterAddr)) - beforeUsdc;
    const graduated = parsed.find((l) => l.name === 'Graduated');

    return {
      receipt: rc,
      gasUsed: rc.gasUsed,
      tokenId: tokenIdBefore, // the id our position takes; read before the mint
      curve: await ballista.curves(token),
      graduated,
      attemptFailed: parsed.find((l) => l.name === 'GraduationAttemptFailed'),
      ready: parsed.find((l) => l.name === 'GraduationReady'),
      dustToken,
      dustUsdc,
      consumedToken: graduated ? graduated.args[1] : 0n,
      consumedUsdc: graduated ? graduated.args[2] : 0n,
      pulledToken: graduated ? graduated.args[1] + dustToken : 0n,
      pulledUsdc: graduated ? graduated.args[2] + dustUsdc : 0n,
    };
  }

  function poolKeyFor(token) {
    const tokenIsCurrency0 = BigInt(token) < BigInt(USDC);
    return {
      key: {
        currency0: tokenIsCurrency0 ? token : USDC,
        currency1: tokenIsCurrency0 ? USDC : token,
        fee: POOL_FEE,
        tickSpacing: TICK_SPACING,
        hooks: ethers.ZeroAddress,
      },
      tokenIsCurrency0,
    };
  }

  // THE ASSERTION THIS WHOLE FILE EXISTS FOR.
  //
  // Not "a pool exists" -- the PRICE. An adapter wrong by 1e12 in either direction
  // still initialises a pool, still mints, still returns a non-zero liquidity, and
  // still leaves LFX1 marking the token GRADUATED with the LP already burned. Nothing
  // on chain reports it. The only thing that can catch it is comparing the pool's
  // resulting price against the amounts that were actually handed over.
  //
  // ⚠ IT MUST BE THE PULLED AMOUNTS, NOT THE CONSUMED ONES, AND THE DIFFERENCE IS NOT
  // COSMETIC. The first version of this compared the pool price against what the mint
  // consumed, and the v4-decimal-normalise red-proof showed that check passing at
  // rel=-7.5e-13 on a pool priced 1e12 wrong. The reason is structural: for a
  // full-range position the amounts a mint absorbs are DERIVED from the pool price, so
  // consumed1/consumed0 equals that price identically, whatever the price is. The
  // comparison was partly circular and could not fail on the error it existed to catch.
  //
  // What the adapter was HANDED is independent of the pool, and that is the reference:
  // pulled = consumed + whatever the adapter kept. Under a scale error the mint absorbs
  // a lopsided fraction, the remainder shows up as dust, and pulled stops matching.
  //
  // TOLERANCE, stated: 1e-9 relative. The real sources of error are the floored square
  // root and the finite tick range, both around 1e-12 relative. The error this is built
  // to catch is 1e12 relative -- twenty-one orders clear of the bound -- so the
  // tolerance is nowhere near the interesting quantity in either direction.
  async function assertPoolPrice(token, tokenPulled, usdcPulled, label) {
    const { key, tokenIsCurrency0 } = poolKeyFor(token);
    const [pulled0, pulled1] = tokenIsCurrency0
      ? [tokenPulled, usdcPulled]
      : [usdcPulled, tokenPulled];

    const [sqrtPriceX96] = await lens.slot0(POOL_MANAGER, key);
    expect(sqrtPriceX96, `${label}: pool is not initialised at all`).to.be.greaterThan(0n);

    // price = (sqrtPriceX96 / 2^96)^2 = currency1 per currency0, in RAW units.
    // Compare as a cross-multiplied ratio so no precision is lost to floats:
    //     sqrtPriceX96^2 * pulled0   ==   pulled1 * 2^192
    const lhs = sqrtPriceX96 * sqrtPriceX96 * pulled0;
    const rhs = pulled1 * Q96 * Q96;
    const relE18 = ((lhs - rhs) * 10n ** 18n) / rhs;
    const rel = Number(relE18) / 1e18;

    expect(Math.abs(rel), `${label}: pool price is off by ${rel} relative (1e12 => a scale bug)`)
      .to.be.lessThan(1e-9);

    return { sqrtPriceX96, rel, key, tokenIsCurrency0 };
  }

  // The mint absorbed essentially everything it was handed.
  //
  // Independent of the price check and it fires on the same faults, which is the point
  // -- a scale error makes the mint take a lopsided fraction of one side and leave the
  // rest behind, so the dust ratio blows up even where a self-consistent price would
  // not. It is also the direct statement of what step 1 of the adapter is for: the
  // residue is meant to be rounding, not a slice of the pool.
  function assertDustIsNegligible(g, label) {
    for (const [side, dust, pulled] of [
      ['token', g.dustToken, g.pulledToken],
      ['usdc', g.dustUsdc, g.pulledUsdc],
    ]) {
      expect(dust, `${label}: ${side} dust is negative -- the adapter paid out of its own balance`)
        .to.be.at.least(0n);
      const share = Number(dust) / Number(pulled);
      expect(share, `${label}: the mint left ${share} of the ${side} side behind`)
        .to.be.lessThan(1e-9);
    }
  }

  it('1. graduation seeds a real v4 pool AT THE PRICE THE AMOUNTS IMPLY', async function () {
    await deployAll();
    const token = await launch('V4PRICE');
    const g = await graduate(token);

    expect(g.attemptFailed, 'graduation was attempted and failed').to.be.undefined;
    expect(g.graduated, 'no Graduated event').to.not.be.undefined;
    expect(g.curve.state, 'curve is not GRADUATED').to.equal(2n);
    expect(g.curve.tokenReserves, 'tokenReserves not zeroed').to.equal(0n);
    expect(g.curve.realUsdcReserves, 'realUsdcReserves not zeroed').to.equal(0n);
    expect(g.curve.poolBoost, 'poolBoost not zeroed').to.equal(0n);

    // NOTHING STRANDED IN THE FACTORY -- the point of pulling 100% at step 1.
    //
    // Stated as an EXACT identity rather than "balances are zero", because the USDC
    // balance is legitimately non-zero: LFX1 accrues the creation fee and both trading
    // fees and holds them until they are claimed (CLAUDE.md 1.7). Asserting zero there
    // would be asserting a falsehood. Asserting the accrual identity is the real claim
    // -- every USDC unit left is attributable to someone, and none is unaccounted dust
    // of the kind CLAUDE.md R14 makes permanently unrecoverable.
    //
    // ⚠ THIS RUNS BEFORE THE RANGE CHECKS BELOW, DELIBERATELY. An adapter that takes a
    // computed subset instead of the full amounts strands the remainder here, but it
    // ALSO drags the token side under the LP allocation -- so with the range checks
    // first, they fire and this one never executes. The v4-pull-99pct red-proof showed
    // exactly that, reporting a masked failure at the range check and leaving the
    // assertion actually under proof unexercised. Ordering is the whole fix.
    const launched = new ethers.Contract(token, ERC20_ABI, ethers.provider);
    const factory = await ballista.getAddress();
    expect(await launched.balanceOf(factory), 'launched tokens stranded in the factory')
      .to.equal(0n);

    const accounted =
      (await ballista.treasuryFeesAccrued()) + (await ballista.creatorFeesAccrued(creator.address));
    expect(await usdc.balanceOf(factory), 'factory holds USDC that is not accrued to anyone')
      .to.equal(accounted);

    const tokenConsumed = g.consumedToken;
    const usdcConsumed = g.consumedUsdc;
    const liquidity = g.graduated.args[3];

    // Real-shaped, not a scaled-down rehearsal: the default 8,000e6 threshold is used,
    // so these are the amounts a production graduation actually produces.
    expect(tokenConsumed, 'token side below the LP allocation')
      .to.be.greaterThanOrEqual(193_000_000n * 10n ** 18n);
    expect(usdcConsumed, 'USDC side below the graduation threshold').to.be.greaterThan(8_000n * ONE);
    expect(liquidity, 'no liquidity reported').to.be.greaterThan(0n);

    const { sqrtPriceX96, rel } = await assertPoolPrice(token, g.pulledToken, g.pulledUsdc, 'test 1');
    assertDustIsNegligible(g, 'test 1');

    // Independent sanity on the ABSOLUTE price, so a self-consistent but inverted
    // derivation cannot pass the ratio check above.
    //
    // ⚠ THE TWO FIGURES BELOW DIFFER BY EXACTLY THE 1e12 UNDER TEST, AND CONFLATING
    // THEM IS THE WHOLE HAZARD. 193.3M tokens against 8,019 USDC is:
    //     4.148e-5   USDC per TOKEN        -- the human-decimal price, what a UI shows
    //     4.148e-17  raw unit per raw unit -- what v4 actually stores, 1e12 smaller
    // Both are "the price" and only the second one is what sqrtPriceX96 encodes. The
    // first version of this assertion used the human figure with the raw quantities and
    // failed by precisely 1e12, which is the error this whole file exists to catch
    // showing up in the check rather than in the contract.
    const rawRatio = Number(g.pulledUsdc) / Number(g.pulledToken);
    expect(rawRatio, 'RAW-unit price out of band -- inverted or mis-scaled?')
      .to.be.within(1e-17, 1e-16);
    expect(rawRatio * 1e12, 'human-decimal price out of band').to.be.within(1e-5, 1e-4);

    // An inverted derivation lands at ~2.4e16 raw, thirty-three orders away, so the two
    // bands above cannot both be satisfied by a flipped price.

    // The position itself, read from PositionManager and not from our own event.
    expect(await posm.ownerOf(g.tokenId), 'position is not held by the burn address').to.equal(BURN);
    expect(await posm.getPositionLiquidity(g.tokenId), 'position holds no liquidity')
      .to.be.greaterThan(0n);
    expect(await posm.getPositionLiquidity(g.tokenId), 'reported liquidity is not the minted liquidity')
      .to.equal(liquidity);

    // And the residue is where it was designed to be: in the ownerless adapter.
    console.log(`      MEASURE pool sqrtPriceX96      ${sqrtPriceX96}`);
    console.log(`      MEASURE price relative error   ${rel}`);
    console.log(`      MEASURE token side supplied    ${tokenConsumed}`);
    console.log(`      MEASURE usdc  side supplied    ${usdcConsumed}`);
    console.log(`      MEASURE liquidity minted       ${liquidity}`);
    console.log(`      MEASURE token side pulled      ${g.pulledToken}`);
    console.log(`      MEASURE adapter dust (token)   ${g.dustToken}`);
    console.log(`      MEASURE adapter dust (usdc)    ${g.dustUsdc}`);
  });

  it('2. GRADUATION GAS, measured -- and what of it is the graduation', async function () {
    await deployAll();

    // A non-graduating buy on an identical curve, as the baseline. The graduating
    // transaction is a buy() that happens to cross the threshold (LFX1.sol:462-466), so
    // its receipt covers both; the difference is what graduation actually costs.
    const baselineToken = await launch('V4GASBASE');
    await ethers.provider.send('evm_increaseTime', [30]);
    await ethers.provider.send('evm_mine', []);
    const baseline = await (await ballista.connect(buyer).buy(baselineToken, 100n * ONE, 0)).wait();

    const token = await launch('V4GAS');
    const g = await graduate(token);
    expect(g.graduated, 'the measured transaction did not graduate').to.not.be.undefined;

    console.log(`      MEASURE buy (no graduation)    ${baseline.gasUsed}`);
    console.log(`      MEASURE buy + GRADUATION       ${g.gasUsed}`);
    console.log(`      MEASURE graduation delta       ${g.gasUsed - baseline.gasUsed}`);

    // Not an assertion about the value -- there is no prior figure to compare against,
    // which is the whole reason this is being measured (CLAUDE.md 12.5 records
    // graduation gas as never having been measured on any path). The only assertion is
    // that it fits in a block, because a graduation that cannot be mined is a token
    // that can never reach the DEX.
    expect(g.gasUsed, 'graduation does not fit in a block').to.be.lessThan(30_000_000n);
  });

  it('3. BOTH token orderings: the pool is right whichever side the token sorts', async function () {
    await deployAll();

    // Token addresses come from CREATE(factory, nonce), so which side of USDC a token
    // sorts on is not something the test picks -- launch until both have appeared.
    // Roughly half of all real launches land each way, and v4 rejects a PoolKey whose
    // currencies are out of order (PoolManager.sol:121), so getting the sort wrong
    // fails one ordering and not the other.
    let below = null;
    let above = null;
    for (let i = 0; i < 40 && (!below || !above); i++) {
      const t = await launch(`ORD${i}`);
      if (BigInt(t) < BigInt(USDC)) below = below || t;
      else above = above || t;
      await ethers.provider.send('evm_increaseTime', [11]);
      await ethers.provider.send('evm_mine', []);
    }
    expect(below, 'no token sorted below USDC in 40 launches').to.not.be.null;
    expect(above, 'no token sorted above USDC in 40 launches').to.not.be.null;

    for (const [label, token] of [['token below USDC', below], ['token above USDC', above]]) {
      const g = await graduate(token);
      expect(g.graduated, `${label}: did not graduate`).to.not.be.undefined;
      expect(g.curve.state, `${label}: not GRADUATED`).to.equal(2n);

      const { tokenIsCurrency0 } = poolKeyFor(token);
      expect(tokenIsCurrency0, `${label}: sorted the wrong way, the case is mislabelled`)
        .to.equal(label === 'token below USDC');

      const { rel } = await assertPoolPrice(token, g.pulledToken, g.pulledUsdc, label);
      assertDustIsNegligible(g, label);
      expect(await posm.ownerOf(g.tokenId), `${label}: position not burned`).to.equal(BURN);
      console.log(`      MEASURE ${label.padEnd(18)} rel=${rel} gas=${g.gasUsed}`);
    }
  });

  it('4. an EXTREME amount ratio still prices correctly', async function () {
    await deployAll();

    // A tiny graduation threshold leaves almost the whole curve unsold, so the token
    // side stays near its maximum while the USDC side is minimal -- an amount ratio far
    // outside anything a default graduation produces. The price derivation is the one
    // piece of this that is ratio-dependent, and a scale bug that happened to look
    // plausible at the usual magnitudes has nowhere to hide here.
    await ballista.connect(owner).setDefaultGraduationThreshold(10n * ONE);

    const token = await launch('V4EXTREME');
    const g = await graduate(token, 12n * ONE);
    expect(g.graduated, 'did not graduate at the small threshold').to.not.be.undefined;

    const tokenConsumed = g.consumedToken;
    const usdcConsumed = g.consumedUsdc;

    // Confirm the case really is extreme, so it cannot quietly degrade into a repeat of
    // test 1 if the threshold setter stops taking effect.
    expect(usdcConsumed, 'not actually a small USDC side').to.be.lessThan(100n * ONE);
    expect(tokenConsumed, 'not actually a large token side')
      .to.be.greaterThan(900_000_000n * 10n ** 18n);

    const { rel } = await assertPoolPrice(token, g.pulledToken, g.pulledUsdc, 'extreme ratio');
    assertDustIsNegligible(g, 'extreme ratio');
    expect(await posm.ownerOf(g.tokenId), 'position not burned').to.equal(BURN);
    console.log(`      MEASURE extreme token/usdc     ${tokenConsumed} / ${usdcConsumed} rel=${rel}`);
  });

  it('5. a pool pre-seeded at a HOSTILE price parks the curve, and it still graduates after', async function () {
    await deployAll();

    // CLAUDE.md section 1.1, transplanted to v4. In v2 the attack is to create the pair
    // and seed it at a ratio of your choosing, so our deposit goes in at THEIR price and
    // the remainder is permanently stranded. v4's equivalent is cheaper still: pool
    // initialisation is permissionless, free, and takes no liquidity at all.
    //
    // The adapter's answer is the exact price check. This proves BOTH halves of what
    // section 1.1 requires: the attack does not silently succeed, AND the curve is left
    // recoverable rather than bricked.
    const token = await launch('V4HOSTILE');

    // Initialise the pool first, at a wildly wrong price -- exactly the 1e12-scale error
    // an attacker would want us to deposit into.
    const { key } = poolKeyFor(token);
    const pm = new ethers.Contract(
      POOL_MANAGER,
      ['function initialize((address,address,uint24,int24,address) key, uint160 sqrtPriceX96) returns (int24)'],
      owner
    );
    await pm.initialize(
      [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks],
      Q96 // price 1:1 in raw units, ~1e12x wrong
    );

    // Now graduate into it.
    const g = await graduate(token);

    expect(g.ready, 'the curve never reached GRADUATION_READY').to.not.be.undefined;
    expect(g.graduated, 'graduation SUCCEEDED into a hostile pool -- the price check did not hold')
      .to.be.undefined;
    expect(g.attemptFailed, 'no GraduationAttemptFailed emitted').to.not.be.undefined;

    // Parked, not lost. Reserves intact, state retryable -- the v2 recovery shape.
    expect(g.curve.state, 'curve is not GRADUATION_READY').to.equal(1n);
    expect(g.curve.tokenReserves, 'tokenReserves were zeroed on a FAILED graduation')
      .to.be.greaterThan(0n);
    expect(g.curve.realUsdcReserves, 'realUsdcReserves were zeroed on a FAILED graduation')
      .to.be.greaterThan(0n);

    // Nothing left the factory.
    const launched = new ethers.Contract(token, ERC20_ABI, ethers.provider);
    expect(await launched.balanceOf(await adapter.getAddress()), 'the adapter kept tokens from a failed attempt')
      .to.equal(0n);

    // And the permissionless retry still reverts while the pool stays hostile, rather
    // than half-completing. GraduationFailed, not a silent no-op.
    await expect(ballista.connect(buyer).graduate(token)).to.be.revertedWithCustomError(
      ballista, 'GraduationFailed'
    );

    // A DIFFERENT token, launched after, is completely unaffected -- the attack is
    // scoped to the pool key it poisoned and does not touch the factory.
    const clean = await launch('V4CLEAN');
    const g2 = await graduate(clean);
    expect(g2.graduated, 'a hostile pool on one token blocked an unrelated one').to.not.be.undefined;
    expect(g2.curve.state).to.equal(2n);
    await assertPoolPrice(clean, g2.pulledToken, g2.pulledUsdc, 'unaffected token');
    assertDustIsNegligible(g2, 'unaffected token');
  });

  it('6. a REVERTING router parks the curve, and the adapter graduates it afterwards', async function () {
    // This is the property every other revert in the adapter depends on being true.
    //
    // The price check in _initialiseAndVerifyPrice answers a hostile pool by reverting.
    // That is only the right answer if a failed graduation is RECOVERABLE -- if a
    // reverting router consumed the curve, refusing to seed a hostile pool would
    // destroy more than it saved. So the recovery path is proved end to end here, with
    // a router that cannot succeed, followed by the real adapter taking over.
    //
    // Driven with a router that always reverts rather than by mutating the adapter,
    // because the interesting half is what happens AFTER -- swapping in a working
    // router and completing the graduation. A mutation cannot express that: it would
    // have to leave the adapter broken for the retry too.
    const broken = await (await ethers.getContractFactory('RevertingRouter')).deploy();
    await deployAll(await broken.getAddress());

    const token = await launch('V4RETRY');
    const g = await graduate(token);

    expect(g.ready, 'never reached GRADUATION_READY').to.not.be.undefined;
    expect(g.graduated, 'a reverting router somehow graduated the token').to.be.undefined;
    expect(g.attemptFailed, 'no GraduationAttemptFailed emitted').to.not.be.undefined;

    // Reserves survive the failed attempt. LFX1 zeroes them only on the success path
    // (LFX1.sol:677-679), so this is the difference between parked and destroyed.
    expect(g.curve.state, 'not left at GRADUATION_READY').to.equal(1n);
    const tokenReservesParked = g.curve.tokenReserves;
    const usdcReservesParked = g.curve.realUsdcReserves;
    expect(tokenReservesParked, 'tokenReserves lost on a failed graduation').to.be.greaterThan(0n);
    expect(usdcReservesParked, 'realUsdcReserves lost on a failed graduation').to.be.greaterThan(0n);

    // Nothing moved to the broken router, and LFX1 cleared its approvals on the
    // failure path so no allowance is left standing over the pooled balance.
    const launched = new ethers.Contract(token, ERC20_ABI, ethers.provider);
    const adapterAddr = await adapter.getAddress();
    expect(await launched.balanceOf(await broken.getAddress())).to.equal(0n);
    expect(await usdc.balanceOf(await broken.getAddress())).to.equal(0n);

    // Swap in the real adapter. The 24h timelock is not skippable and approval is
    // single-use (CLAUDE.md R12), so this is the only route there is.
    await ballista.connect(owner).proposeRouter(adapterAddr);
    await expect(
      ballista.connect(owner).activateRouter(adapterAddr),
      'the 24h router timelock was skippable'
    ).to.be.revertedWithCustomError(ballista, 'RouterTimelockPending');

    await ethers.provider.send('evm_increaseTime', [24 * 60 * 60 + 1]);
    await ethers.provider.send('evm_mine', []);
    await ballista.connect(owner).activateRouter(adapterAddr);

    // The permissionless retry now completes, on the SAME reserves that were parked.
    // Bracketed the same way graduate() does it, because the price reference has to be
    // what the adapter was handed rather than what the mint absorbed -- see
    // assertPoolPrice.
    const beforeToken = await launched.balanceOf(adapterAddr);
    const beforeUsdc = await usdc.balanceOf(adapterAddr);
    const rc = await (await ballista.connect(buyer).graduate(token)).wait();
    const retryDustToken = (await launched.balanceOf(adapterAddr)) - beforeToken;
    const retryDustUsdc = (await usdc.balanceOf(adapterAddr)) - beforeUsdc;
    const ev = rc.logs
      .map((l) => { try { return ballista.interface.parseLog(l); } catch { return null; } })
      .filter(Boolean).find((l) => l.name === 'Graduated');
    expect(ev, 'the retry did not graduate').to.not.be.undefined;

    const curve = await ballista.curves(token);
    expect(curve.state, 'not GRADUATED after the retry').to.equal(2n);
    expect(curve.tokenReserves).to.equal(0n);
    expect(curve.realUsdcReserves).to.equal(0n);

    // The pool it seeded is priced off the amounts that were parked all along, so the
    // delay cost the curve nothing.
    const tokenConsumed = ev.args[1];
    const usdcConsumed = ev.args[2];
    expect(usdcConsumed, 'the retry seeded a different USDC amount than was parked')
      .to.equal(usdcReservesParked);
    await assertPoolPrice(
      token, tokenConsumed + retryDustToken, usdcConsumed + retryDustUsdc, 'after retry'
    );

    console.log(`      MEASURE parked then graduated  ${tokenConsumed} / ${usdcConsumed}`);
    console.log(`      MEASURE retry graduate() gas   ${rc.gasUsed}`);
  });
});
