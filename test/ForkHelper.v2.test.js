const { expect } = require('chai');
const { ethers } = require('hardhat');

// GraduationHelper against real Uniswap V2 on the pinned fork. FORK=1 only.
//
// The point of the helper is atomicity, so the tests are built around trying to break
// that: a re-skew between correction and graduation, an attacker who re-skews EVERY time,
// and an attacker who front-runs the helper's own transaction. A happy-path "it graduated"
// assertion would prove nothing the fork suite does not already prove.
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const V2_FACTORY = '0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f';
const V2_ROUTER = '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D';
const ONE = 1_000_000n;

const ERC20 = [
  'function balanceOf(address) view returns (uint256)',
  'function transfer(address,uint256) returns (bool)',
  'function approve(address,uint256) returns (bool)',
];
const FACTORY = [
  'function getPair(address,address) view returns (address)',
  'function createPair(address,address) returns (address)',
];
const PAIR = [
  'function token0() view returns (address)',
  'function getReserves() view returns (uint112,uint112,uint32)',
  'function mint(address) returns (uint256)',
  'function sync()',
];

describe('GraduationHelper — against REAL Uniswap V2 (fork)', function () {
  this.timeout(600000);

  let treasury, creator, buyer, attacker, searcher;
  let usdc, factory, ballista, helper, token, pair, tok;

  before(async function () {
    if (!process.env.FORK) this.skip();
  });

  async function fundUsdc(addr, amount) {
    const t = new ethers.Contract(USDC, ERC20, ethers.provider);
    for (let slot = 0; slot < 20; slot++) {
      const key = ethers.solidityPackedKeccak256(['uint256', 'uint256'], [addr, slot]);
      const before = await ethers.provider.send('eth_getStorageAt', [USDC, key, 'latest']);
      await ethers.provider.send('hardhat_setStorageAt', [USDC, key, ethers.toBeHex(amount, 32)]);
      if ((await t.balanceOf(addr)) === amount) return;
      await ethers.provider.send('hardhat_setStorageAt', [USDC, key, before]);
    }
    throw new Error('USDC balance slot not found');
  }

  // Build a curve parked at GRADUATION_READY behind an attacker-skewed real pair.
  async function strandedCurve(symbol) {
    [, treasury, creator, buyer, attacker, searcher] = await ethers.getSigners();
    usdc = new ethers.Contract(USDC, ERC20, ethers.provider);
    factory = new ethers.Contract(V2_FACTORY, FACTORY, ethers.provider);

    ballista = await (await ethers.getContractFactory('LFX1')).deploy(
      USDC, treasury.address, V2_ROUTER
    );
    helper = await (await ethers.getContractFactory('GraduationHelper')).deploy(
      await ballista.getAddress(), V2_FACTORY, USDC
    );
    for (const s of [creator, buyer, attacker, searcher]) {
      await fundUsdc(s.address, 200_000n * ONE);
      await usdc.connect(s).approve(await ballista.getAddress(), ethers.MaxUint256);
      await usdc.connect(s).approve(await helper.getAddress(), ethers.MaxUint256);
    }

    const hash = await ballista.currentEconomicsHash();
    const rc = await (await ballista.connect(creator).createToken('H', symbol, '', hash, false)).wait();
    token = rc.logs.map((l) => { try { return ballista.interface.parseLog(l); } catch { return null; } })
      .filter(Boolean).find((l) => l.name === 'TokenCreated').args.token;
    tok = new ethers.Contract(token, ERC20, ethers.provider);

    await ethers.provider.send('evm_mine', []);
    await ethers.provider.send('evm_increaseTime', [30]);
    await ethers.provider.send('evm_mine', []);

    // Attacker acquires tokens and seeds a skewed real pair.
    await ballista.connect(attacker).buy(token, 50n * ONE, 0);
    await factory.connect(attacker).createPair(token, USDC);
    const pairAddr = await factory.getPair(token, USDC);
    pair = new ethers.Contract(pairAddr, PAIR, ethers.provider);
    const half = (await tok.balanceOf(attacker.address)) / 2n;
    await tok.connect(attacker).transfer(pairAddr, half);
    await usdc.connect(attacker).transfer(pairAddr, 1n);
    await pair.connect(attacker).mint(attacker.address);
    await tok.connect(attacker).approve(await helper.getAddress(), ethers.MaxUint256);
    await tok.connect(searcher).approve(await helper.getAddress(), ethers.MaxUint256);

    // Push over the threshold; strict mins refuse the deposit.
    await ballista.connect(buyer).buy(token, 8_100n * ONE, 0);
    const c = await ballista.curves(token);
    expect(c.state, 'setup: curve must be stranded at GRADUATION_READY').to.equal(1n);

    // The searcher needs a token float: the correction places D coarsely with USDC and
    // then finely with tokens, so a bundle can require a small token donation as well.
    const buyerBal = await tok.balanceOf(buyer.address);
    await tok.connect(buyer).transfer(searcher.address, buyerBal / 2n);
    return c;
  }

  // Attacker re-skews by donating tokens to the pair and syncing. Costs them dust.
  async function reskew() {
    const bal = await tok.balanceOf(attacker.address);
    expect(bal, 'attacker out of ammunition').to.be.greaterThan(0n);
    await tok.connect(attacker).transfer(await pair.getAddress(), bal / 4n);
    await pair.connect(attacker).sync();
  }

  it('the UNBUNDLED sequence is griefable: correct, get re-skewed, graduate fails', async function () {
    await strandedCurve('UNB');

    // A searcher corrects the pair by hand, exactly as they could today.
    const [needU] = await helper.correctionNeeded(token);
    expect(needU, 'a correction should be required').to.be.greaterThan(0n);
    await usdc.connect(searcher).transfer(await pair.getAddress(), needU);
    await pair.connect(searcher).sync();
    expect((await helper.correctionNeeded(token))[0], 'pair should now be in range').to.equal(0n);

    // The attacker re-skews before anyone graduates. This is the gap R6 describes.
    await reskew();
    expect((await helper.correctionNeeded(token))[0], 'attacker re-opened the gap')
      .to.be.greaterThan(0n);

    await expect(ballista.graduate(token))
      .to.be.revertedWithCustomError(ballista, 'GraduationFailed');

    // The searcher paid, and the curve is no better off. This is what the helper closes.
    const c = await ballista.curves(token);
    expect(c.state).to.equal(1n);
  });

  it('BUNDLED: correction and graduation land together, with no gap to interleave into', async function () {
    await strandedCurve('BUN');
    const [needU] = await helper.correctionNeeded(token);

    await helper.connect(searcher).correctAndGraduate({ token, swapUsdcIn: 0, swapTokenIn: 0, maxUsdcSpend: needU * 2n, maxTokenSpend: ethers.MaxUint256, beneficiary: searcher.address });

    const c = await ballista.curves(token);
    expect(c.state, 'must be GRADUATED').to.equal(2n);
    expect(c.realUsdcReserves).to.equal(0n);
  });

  it('an attacker who re-skews EVERY block cannot stop it -- each attempt is self-contained', async function () {
    await strandedCurve('REP');

    // Three rounds of: attacker re-skews, searcher bundles anyway.
    for (let i = 0; i < 3; i++) {
      await reskew();
      const [needU] = await helper.correctionNeeded(token);
      if (i < 2) {
        // Deliberately abandon the attempt to prove no state carries between tries.
        expect(needU).to.be.greaterThan(0n);
        continue;
      }
      await helper.connect(searcher).correctAndGraduate({ token, swapUsdcIn: 0, swapTokenIn: 0, maxUsdcSpend: needU * 2n, maxTokenSpend: ethers.MaxUint256, beneficiary: searcher.address });
    }
    expect((await ballista.curves(token)).state, 'graduated despite repeated re-skews').to.equal(2n);
  });

  it('a re-skew INSIDE the same block still cannot split the bundle', async function () {
    await strandedCurve('SAME');
    const [needU] = await helper.correctionNeeded(token);

    // Attacker and searcher act in the same block, attacker FIRST. Automine off so both
    // land together, which is the strongest ordering available to the attacker.
    await ethers.provider.send('evm_setAutomine', [false]);
    const attackTx = await tok.connect(attacker).transfer(
      await pair.getAddress(), (await tok.balanceOf(attacker.address)) / 4n
    );
    const syncTx = await pair.connect(attacker).sync();
    // The searcher reads the correction AFTER the attacker's skew by using a generous cap
    // and letting the helper recompute in-transaction -- which is the whole point.
    const bundleTx = await helper.connect(searcher).correctAndGraduate({ token, swapUsdcIn: 0, swapTokenIn: 0, maxUsdcSpend: needU * 50n, maxTokenSpend: ethers.MaxUint256, beneficiary: searcher.address });
    await ethers.provider.send('evm_mine', []);
    await ethers.provider.send('evm_setAutomine', [true]);

    for (const t of [attackTx, syncTx, bundleTx]) await t.wait();
    expect((await ballista.curves(token)).state, 'bundle survived a same-block re-skew')
      .to.equal(2n);
  });

  it('the cap error reports the REQUIRED amount, so the next attempt is sized not guessed', async function () {
    await strandedCurve('CAP');
    const [needU] = await helper.correctionNeeded(token);

    await expect(
      helper.connect(searcher).correctAndGraduate({ token, swapUsdcIn: 0, swapTokenIn: 0, maxUsdcSpend: 1n, maxTokenSpend: ethers.MaxUint256, beneficiary: searcher.address })
    ).to.be.revertedWithCustomError(helper, 'UsdcCorrectionExceedsCap')
      .withArgs(needU, 1n);

    // And the reported figure is directly usable.
    await helper.connect(searcher).correctAndGraduate({ token, swapUsdcIn: 0, swapTokenIn: 0, maxUsdcSpend: needU, maxTokenSpend: ethers.MaxUint256, beneficiary: searcher.address });
    expect((await ballista.curves(token)).state).to.equal(2n);
  });

  it('a failed bundle leaves the curve EXACTLY as it was -- nothing half-applied', async function () {
    await strandedCurve('FAIL');
    const before = await ballista.curves(token);
    const [rTb, rUb] = await pair.getReserves();
    const searcherUsdcBefore = await usdc.balanceOf(searcher.address);

    await expect(
      helper.connect(searcher).correctAndGraduate({ token, swapUsdcIn: 0, swapTokenIn: 0, maxUsdcSpend: 1n, maxTokenSpend: ethers.MaxUint256, beneficiary: searcher.address })
    ).to.be.reverted;

    const after = await ballista.curves(token);
    const [rTa, rUa] = await pair.getReserves();
    expect(after.state).to.equal(before.state);
    expect(after.realUsdcReserves).to.equal(before.realUsdcReserves);
    expect(after.tokenReserves).to.equal(before.tokenReserves);
    expect(rTa).to.equal(rTb);
    expect(rUa).to.equal(rUb);
    expect(await usdc.balanceOf(searcher.address), 'searcher must not have paid')
      .to.equal(searcherUsdcBefore);
  });

  it('the swap path funds the correction and pays the caller -- the arbitrage lands on them', async function () {
    await strandedCurve('SWAP');
    const [needUNoSwap] = await helper.correctionNeeded(token);

    const tokBefore = await tok.balanceOf(searcher.address);
    const usdcBefore = await usdc.balanceOf(searcher.address);

    // A small swap in place of a large donation.
    await helper.connect(searcher).correctAndGraduate({ token, swapUsdcIn: 1n * ONE, swapTokenIn: 0, maxUsdcSpend: needUNoSwap, maxTokenSpend: ethers.MaxUint256, beneficiary: searcher.address });

    expect((await ballista.curves(token)).state).to.equal(2n);
    const tokGained = (await tok.balanceOf(searcher.address)) - tokBefore;
    const usdcSpent = usdcBefore - (await usdc.balanceOf(searcher.address));

    expect(tokGained, 'searcher received the swap output').to.be.greaterThan(0n);
    expect(usdcSpent, 'and spent strictly less than the donation-only route')
      .to.be.lessThan(needUNoSwap);
  });
});
