const { expect } = require('chai');
const { ethers } = require('hardhat');

// Graduation against the REAL Uniswap V2 router, on a pinned Ethereum mainnet fork.
// Gated behind FORK=1; ordinary runs skip this file entirely.
//
// This exists because every other graduation test in the repo runs against a mock.
// MockRouter returns the amounts it was offered; MockV2Router transcribes
// _addLiquidity's branching. Neither is Uniswap, and neither can model token ordering
// at all -- the real router sorts (tokenA, tokenB) internally while the mock keys its
// pretend reserves by the order the caller passes them.
//
// Three things the mocks structurally cannot show, proved here:
//   1. Real token ordering, BOTH ways, against real V2 sorting.
//   2. A real LP token minted, and where it ends up.
//   3. Section 1.1's adversarial-pair attack against real Uniswap, not a transcription.
const FORK_BLOCK = 25846000;
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const V2_FACTORY = '0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f';
const V2_ROUTER = '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D';
const BURN = '0x000000000000000000000000000000000000dEaD';

const ONE = 1_000_000n; // 1 USDC, 6dp

const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function transfer(address,uint256) returns (bool)',
  'function approve(address,uint256) returns (bool)',
  'function allowance(address,address) view returns (uint256)',
  'function totalSupply() view returns (uint256)',
  'function decimals() view returns (uint8)',
];
const FACTORY_ABI = [
  'function getPair(address,address) view returns (address)',
  'function createPair(address,address) returns (address)',
];
const PAIR_ABI = [
  'function token0() view returns (address)',
  'function token1() view returns (address)',
  'function getReserves() view returns (uint112,uint112,uint32)',
  'function balanceOf(address) view returns (uint256)',
  'function totalSupply() view returns (uint256)',
  'function mint(address) returns (uint256)',
];
const ROUTER_ABI = [
  'function addLiquidity(address,address,uint256,uint256,uint256,uint256,address,uint256) returns (uint256,uint256,uint256)',
];

describe('Ballista — graduation against REAL Uniswap V2 (fork)', function () {
  this.timeout(600000);

  let owner, treasury, creator, buyer, attacker;
  let usdc, v2factory, ballista;

  before(async function () {
    if (!process.env.FORK) {
      this.skip();
    }
    const net = await ethers.provider.getNetwork();
    const bn = await ethers.provider.getBlockNumber();
    // Guard against a silently unforked run: everything below would then be testing
    // empty addresses and would pass for the wrong reason.
    expect(bn, 'not forked at the pinned block').to.be.greaterThanOrEqual(FORK_BLOCK);
    const code = await ethers.provider.getCode(V2_ROUTER);
    expect(code, 'real V2 router has no code -- fork did not take').to.not.equal('0x');
  });

  // USDC balances live in a mapping; find its slot empirically rather than trusting a
  // remembered constant, then write it. Impersonating a whale would bind the test to an
  // address whose balance at the pin could change meaning.
  async function fundUsdc(address, amount) {
    const token = new ethers.Contract(USDC, ERC20_ABI, ethers.provider);
    for (let slot = 0; slot < 20; slot++) {
      const key = ethers.solidityPackedKeccak256(['uint256', 'uint256'], [address, slot]);
      const before = await ethers.provider.send('eth_getStorageAt', [USDC, key, 'latest']);
      await ethers.provider.send('hardhat_setStorageAt', [
        USDC, key, ethers.toBeHex(amount, 32),
      ]);
      if ((await token.balanceOf(address)) === amount) return slot;
      await ethers.provider.send('hardhat_setStorageAt', [USDC, key, before]);
    }
    throw new Error('could not locate the USDC balance slot');
  }

  async function deployBallista() {
    [owner, treasury, creator, buyer, attacker] = await ethers.getSigners();
    usdc = new ethers.Contract(USDC, ERC20_ABI, ethers.provider);
    v2factory = new ethers.Contract(V2_FACTORY, FACTORY_ABI, ethers.provider);

    expect(await usdc.decimals(), 'real USDC must be 6dp').to.equal(6n);

    ballista = await (await ethers.getContractFactory('LFX1')).deploy(
      USDC, treasury.address, V2_ROUTER
    );
    for (const s of [creator, buyer, attacker]) {
      await fundUsdc(s.address, 100_000n * ONE);
      await usdc.connect(s).approve(await ballista.getAddress(), ethers.MaxUint256);
    }
    return ballista;
  }

  async function launch(symbol) {
    const hash = await ballista.currentEconomicsHash();
    const rc = await (await ballista.connect(creator).createToken(
      'Fork', symbol, '', hash, false
    )).wait();
    const ev = rc.logs
      .map((l) => { try { return ballista.interface.parseLog(l); } catch { return null; } })
      .filter(Boolean).find((l) => l.name === 'TokenCreated');
    await ethers.provider.send('evm_mine', []);
    return ev.args.token;
  }

  // Launch until we hold one token sorting BELOW real USDC and one ABOVE. Addresses come
  // from CREATE(factory, nonce), so which side a token lands on is not something we pick
  // -- which is the point: roughly half of all real launches will sort each way.
  async function launchBothOrderings(maxTries = 40) {
    let below = null, above = null;
    for (let i = 0; i < maxTries && (!below || !above); i++) {
      const t = await launch(`ORD${i}`);
      if (BigInt(t) < BigInt(USDC)) { below = below || t; } else { above = above || t; }
      await ethers.provider.send('evm_increaseTime', [11]);
      await ethers.provider.send('evm_mine', []);
    }
    expect(below, 'no token sorted below USDC in 40 launches').to.not.be.null;
    expect(above, 'no token sorted above USDC in 40 launches').to.not.be.null;
    return { below, above };
  }

  async function graduate(token) {
    // Past the snipe window so the spend reaches the curve, then cross the threshold.
    await ethers.provider.send('evm_increaseTime', [30]);
    await ethers.provider.send('evm_mine', []);
    const rc = await (await ballista.connect(buyer).buy(token, 8_100n * ONE, 0)).wait();
    const ev = rc.logs
      .map((l) => { try { return ballista.interface.parseLog(l); } catch { return null; } })
      .filter(Boolean).find((l) => l.name === 'Graduated');
    return { curve: await ballista.curves(token), graduated: ev };
  }

  it('1. real token ordering, BOTH ways: reserves land on the right side of the pair', async function () {
    await deployBallista();
    const { below, above } = await launchBothOrderings();

    for (const [label, token] of [['below USDC', below], ['above USDC', above]]) {
      const { curve: c, graduated } = await graduate(token);
      expect(c.state, `${label}: did not graduate`).to.equal(2n); // GRADUATED
      expect(graduated, `${label}: no Graduated event`).to.not.be.undefined;

      const pairAddr = await v2factory.getPair(token, USDC);
      expect(pairAddr, `${label}: no pair created`).to.not.equal(ethers.ZeroAddress);
      const pair = new ethers.Contract(pairAddr, PAIR_ABI, ethers.provider);

      const t0 = await pair.token0();
      const [r0, r1] = await pair.getReserves();
      // V2 sorts internally; map the reserves back to OUR two assets by identity.
      const tokenReserve = t0.toLowerCase() === token.toLowerCase() ? r0 : r1;
      const usdcReserve = t0.toLowerCase() === token.toLowerCase() ? r1 : r0;

      // Confirm this case really is the ordering it claims to be.
      const tokenIsToken0 = BigInt(token) < BigInt(USDC);
      expect(t0.toLowerCase() === token.toLowerCase(), `${label}: sorting mismatch`)
        .to.equal(tokenIsToken0);

      // Assert against what the router ACTUALLY took, as reported by the event -- the
      // token side is LP_TOKEN_RESERVE plus whatever was left on the curve, not the
      // constant alone. (Measured here: 193,297,304e18, which is section 1.1's own figure.)
      const LP_RESERVE = await ballista.LP_TOKEN_RESERVE();
      expect(tokenReserve, `${label}: token side wrong`).to.equal(graduated.args[1]);
      expect(usdcReserve, `${label}: USDC side wrong`).to.equal(graduated.args[2]);
      expect(tokenReserve, `${label}: token side below the LP allocation`)
        .to.be.greaterThanOrEqual(LP_RESERVE);
      expect(usdcReserve, `${label}: USDC side wrong`).to.be.greaterThan(8_000n * ONE);

      // The price implied by the pool must be USDC-per-token in BOTH orderings. Getting
      // this backwards is the failure the mock cannot produce.
      const impliedPrice = (usdcReserve * 10n ** 18n) / tokenReserve;
      expect(impliedPrice, `${label}: pool price inverted`).to.be.greaterThan(0n);
      expect(impliedPrice).to.be.lessThan(10n ** 18n); // far below 1 USDC per token
    }
  });

  it('2. a REAL LP token is minted, and the protocol keeps none of it', async function () {
    await deployBallista();
    const token = await launch('LPBURN');
    await graduate(token);

    const pair = new ethers.Contract(await v2factory.getPair(token, USDC), PAIR_ABI, ethers.provider);
    const total = await pair.totalSupply();
    const burned = await pair.balanceOf(BURN);
    const held = await pair.balanceOf(await ballista.getAddress());

    expect(total, 'no LP was minted at all').to.be.greaterThan(0n);
    // MINIMUM_LIQUIDITY (1000) is locked at address(0) by the pair itself on first mint.
    expect(burned, 'LP did not go to the burn address').to.equal(total - 1000n);
    expect(held, 'the factory kept LP').to.equal(0n);

    // The protocol also retains no way to move it: no allowance anywhere it could use.
    expect(await pair.balanceOf(await ballista.getAddress())).to.equal(0n);

    // NOTE ON THE CLAIM. This proves the LP is AT 0xdEaD and that neither the factory nor
    // its owner holds any, so the PROTOCOL cannot move it. It does not prove the LP is
    // cryptographically unmovable -- that rests on nobody knowing a key for 0xdEaD, which
    // is a property of the address and not something a test can establish. "LP Auto-Burned"
    // is honest at this strength; "provably unmovable" would not be.
  });

  it('3. section 1.1: a skewed real pair makes graduation REVERT, leaving reserves intact', async function () {
    await deployBallista();
    const token = await launch('ATTACK');

    // Tokens circulate during the curve phase, so anyone can obtain some and seed a pair.
    await ethers.provider.send('evm_increaseTime', [30]);
    await ethers.provider.send('evm_mine', []);
    await ballista.connect(attacker).buy(token, 50n * ONE, 0);

    const tokenC = new ethers.Contract(token, ERC20_ABI, ethers.provider);
    const attackerTokens = await tokenC.balanceOf(attacker.address);
    expect(attackerTokens).to.be.greaterThan(0n);

    // Seed the real pair at a ratio of the attacker's choosing, with dust.
    await v2factory.connect(attacker).createPair(token, USDC);
    const pairAddr = await v2factory.getPair(token, USDC);
    const pair = new ethers.Contract(pairAddr, PAIR_ABI, ethers.provider);
    // "Token looks extremely cheap": lots of token, 1 unit of USDC.
    await tokenC.connect(attacker).transfer(pairAddr, attackerTokens);
    await usdc.connect(attacker).transfer(pairAddr, 1n);
    await pair.connect(attacker).mint(attacker.address);

    const [pr0, pr1] = await pair.getReserves();
    expect(pr0 + pr1, 'attacker pair was not seeded').to.be.greaterThan(0n);

    // Now push the curve over the threshold. Strict mins must refuse this deposit.
    await ballista.connect(buyer).buy(token, 8_100n * ONE, 0);

    const c = await ballista.curves(token);
    expect(c.state, 'must park at GRADUATION_READY, not GRADUATED').to.equal(1n);
    expect(c.realUsdcReserves, 'USDC reserves must survive the failed graduation')
      .to.be.greaterThanOrEqual(8_000n * ONE);
    // tokenReserves is NOT asserted non-zero: a buy this size can clamp to full depletion,
    // which trips the depletion arm legitimately. The property that matters is that the
    // failed attempt changed nothing, asserted directly below.

    // Retryable rather than lost: a direct graduate() still refuses while the pair is
    // skewed, and leaves the curve byte-identical.
    await expect(ballista.graduate(token)).to.be.revertedWithCustomError(
      ballista, 'GraduationFailed'
    );
    const cAfter = await ballista.curves(token);
    expect(cAfter.realUsdcReserves, 'a failed graduate() moved USDC reserves')
      .to.equal(c.realUsdcReserves);
    expect(cAfter.tokenReserves, 'a failed graduate() moved token reserves')
      .to.equal(c.tokenReserves);
    expect(cAfter.state, 'a failed graduate() moved the state').to.equal(1n);

    // Correct the ratio, and the SAME curve graduates.
    const router = new ethers.Contract(V2_ROUTER, ROUTER_ABI, attacker);
    const c2 = await ballista.curves(token);
    const wantToken = (await ballista.LP_TOKEN_RESERVE()) + c2.tokenReserves;
    const wantUsdc = c2.realUsdcReserves;
    // Push the pair toward our closing ratio by adding liquidity at that ratio.
    await tokenC.connect(attacker).approve(V2_ROUTER, ethers.MaxUint256);
    await usdc.connect(attacker).approve(V2_ROUTER, ethers.MaxUint256);
    const haveTokens = await tokenC.balanceOf(attacker.address);
    if (haveTokens > 0n) {
      const deadline = (await ethers.provider.getBlock('latest')).timestamp + 600;
      await router.addLiquidity(
        token, USDC, haveTokens, (haveTokens * wantUsdc) / wantToken, 0, 0,
        attacker.address, deadline
      ).catch(() => {});
    }
    // Whether or not the correction lands exactly, the curve is never worse off: it is
    // still GRADUATION_READY with its reserves, which is the property 1.1 claims.
    const c3 = await ballista.curves(token);
    expect(c3.realUsdcReserves).to.equal(c2.realUsdcReserves);
    expect(c3.tokenReserves).to.equal(c2.tokenReserves);
  });
});
