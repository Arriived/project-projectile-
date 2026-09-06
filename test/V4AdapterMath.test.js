const { expect } = require('chai');
const { ethers } = require('hardhat');

// Local, unforked unit tests for the adapter's price derivation.
//
// The fork suite is the real deliverable and it asserts the pool price end to end, but
// it costs an archive RPC and several minutes. These run in seconds and cover the parts
// a single fork scenario cannot: the square root across the whole 256-bit range, and
// the sqrtPriceX96 derivation at ratios far outside anything one graduation produces.
//
// WHY A SQUARE ROOT IS TESTED AT ALL: v4 ships no integer sqrt and no amounts-to-price
// helper anywhere in v4-core or v4-periphery, so the adapter had to implement one. That
// makes it the only piece of the price path not taken from Uniswap's own source.

// Reference floor-sqrt over BigInt, written independently of the Solidity. Newton from
// a bit-length seed, iterated to a fixed point -- deliberately NOT the same shape as
// the contract's fixed seven rounds, so a fault in the iteration count cannot be shared
// by both. CLAUDE.md 1.3's warning about a reference transcribed from the thing it
// checks applies here, and this avoids it.
function refSqrt(n) {
  if (n < 0n) throw new Error('negative');
  if (n < 2n) return n;
  let x = 1n << (BigInt(n.toString(2).length) / 2n + 1n);
  for (;;) {
    const y = (x + n / x) >> 1n;
    if (y >= x) break;
    x = y;
  }
  return x;
}

const Q96 = 1n << 96n;
const MIN_SQRT_PRICE = 4295128739n;
const MAX_SQRT_PRICE = 1461446703485210103287273052203988822378723970342n;

describe('BallistaV4Adapter — price math (local)', function () {
  let math;

  before(async function () {
    math = await (await ethers.getContractFactory('V4AdapterMathHarness')).deploy();
  });

  it('M1. _sqrt matches an independent reference across the 256-bit range', async function () {
    const cases = [
      0n, 1n, 2n, 3n, 4n, 5n, 8n, 9n, 15n, 16n, 17n, 99n, 100n, 101n,
      (1n << 64n) - 1n, 1n << 64n, (1n << 64n) + 1n,
      (1n << 128n) - 1n, 1n << 128n, (1n << 128n) + 1n,
      (1n << 200n) + 12345n,
      (1n << 255n),
      (1n << 256n) - 1n, // the maximum uint256, where a bad seed overflows
      10n ** 18n, 10n ** 27n, 10n ** 40n, 10n ** 60n, 10n ** 76n,
    ];
    for (const x of cases) {
      expect(await math.sqrt(x), `sqrt(${x})`).to.equal(refSqrt(x));
    }
  });

  it('M2. _sqrt returns the FLOOR, never a rounded-up value', async function () {
    // A sqrt that rounds up would put the pool price fractionally above the ratio the
    // amounts imply. Check either side of a perfect square, where rounding shows.
    for (const root of [2n, 3n, 1000n, 10n ** 12n, 10n ** 24n]) {
      const sq = root * root;
      expect(await math.sqrt(sq), `exact ${root}`).to.equal(root);
      expect(await math.sqrt(sq - 1n), `just below ${root}`).to.equal(root - 1n);
      expect(await math.sqrt(sq + 1n), `just above ${root}`).to.equal(root);
    }
  });

  // THE 1e12 CHECK, in its cheapest form.
  //
  // A launched token is 18dp and USDC is 6dp, so the raw amounts already differ by 1e12
  // and the price derived from them is a raw-unit price -- which is what v4 stores. The
  // tempting "fix" is to normalise USDC to 18 decimals first. That is wrong by exactly
  // 1e12 in price, i.e. 1e6 in sqrtPriceX96, and it is invisible on chain: the pool
  // still initialises, still mints, still returns a non-zero liquidity.
  it('M3. sqrtPriceX96 is a RAW-unit price, and a decimal normalisation is 1e6 off', async function () {
    const tokenAmount = 193_297_304n * 10n ** 18n; // a real graduation, token side
    const usdcAmount = 8_019n * 10n ** 6n; //         a real graduation, USDC side

    // Token sorts below USDC: currency0 = token (18dp), currency1 = USDC (6dp).
    const got = await math.sqrtPriceX96(tokenAmount, usdcAmount);
    const want = refSqrt((usdcAmount * (Q96 * Q96)) / tokenAmount);
    expect(got, 'raw-unit derivation').to.equal(want);

    // What the plausible-but-wrong version would have produced.
    const normalised = refSqrt(((usdcAmount * 10n ** 12n) * (Q96 * Q96)) / tokenAmount);
    const ratio = Number(normalised) / Number(got);
    expect(ratio, 'a decimal normalisation must be ~1e6 in sqrt space').to.be.closeTo(1e6, 1e3);
    expect(got, 'the two must not coincide').to.not.equal(normalised);
  });

  it('M4. sqrtPriceX96 inverts correctly when the token sorts ABOVE USDC', async function () {
    const tokenAmount = 193_297_304n * 10n ** 18n;
    const usdcAmount = 8_019n * 10n ** 6n;

    // currency0 = USDC, currency1 = token. price1/0 is now token-per-USDC, a LARGE
    // number, where the raw derivation runs near the top of its range.
    const got = await math.sqrtPriceX96(usdcAmount, tokenAmount);
    expect(got).to.equal(refSqrt((tokenAmount * (Q96 * Q96)) / usdcAmount));

    // Both orderings must land inside v4's own bounds, or initialize() reverts.
    const other = await math.sqrtPriceX96(tokenAmount, usdcAmount);
    for (const [label, v] of [['token below USDC', other], ['token above USDC', got]]) {
      expect(v, `${label}: below MIN_SQRT_PRICE`).to.be.greaterThanOrEqual(MIN_SQRT_PRICE);
      expect(v, `${label}: at or above MAX_SQRT_PRICE`).to.be.lessThan(MAX_SQRT_PRICE);
    }
  });

  it('M5. the price round-trips, and NEVER above the ratio the amounts imply', async function () {
    // sqrtPriceX96 -> implied ratio -> compare with amount1/amount0. Same relation the
    // fork test asserts against the real pool, checked here in isolation so a failure
    // there points at the pool rather than at the arithmetic.
    //
    // The bound is ABSOLUTE (raw units), not relative, and the direction is asserted
    // separately. Both are properties of the floor, not arbitrary epsilons:
    // floor(sqrt(x))^2 <= x, so the implied amount1 can only ever come out AT or BELOW
    // the amount actually supplied -- the pool is never initialised at a price richer
    // than the deposit justifies. A relative tolerance hides that direction and also
    // misreads the quantisation, which is a fixed handful of raw units however small
    // the amounts are: on the 1e18/1e6 pair a single unit IS 1e-6 relative.
    const pairs = [
      [193_297_304n * 10n ** 18n, 8_019n * 10n ** 6n],
      [900_000_000n * 10n ** 18n, 8_000n * 10n ** 6n],
      [193_000_000n * 10n ** 18n, 50_000n * 10n ** 6n],
      [10n ** 18n, 10n ** 6n],
    ];
    for (const [a0, a1] of pairs) {
      const sp = await math.sqrtPriceX96(a0, a1);
      // price = (sp / 2^96)^2, so implied a1 = a0 * sp^2 / 2^192
      const impliedA1 = (a0 * sp * sp) / (Q96 * Q96);
      expect(impliedA1, `${a0}/${a1}: price ABOVE the supplied ratio`).to.be.at.most(a1);
      expect(a1 - impliedA1, `${a0}/${a1}: shortfall ${a1 - impliedA1} raw units`).to.be.at.most(4n);
    }
  });

  // The wide branch exists because the ratio bound is REACHABLE: tokenLiquidity tops
  // out near 1e27, so any graduation threshold below ~54 USDC pushes past 2**64. The
  // threshold is snapshotted per curve with no way to change it afterwards, so without
  // this branch a single mis-set threshold parks every token launched under it at
  // GRADUATION_READY forever.
  it('M7. the wide branch agrees with the precise one where they overlap', async function () {
    // Straddle the 2**63 switch. Either side of it the answer must be continuous --
    // a branch that disagreed would make the pool price jump at an arbitrary threshold.
    const boundary = 1n << 63n;
    for (const ratio of [boundary - 2n, boundary - 1n, boundary, boundary + 1n, boundary * 2n]) {
      const a0 = 10n ** 30n;
      const a1 = ratio * a0;
      const got = await math.sqrtPriceX96(a0, a1);
      const want = refSqrt((a1 * (Q96 * Q96)) / a0);
      // The wide branch discards 32 low bits by construction, so agreement is to
      // within one unit in the 2**64 place, not exact.
      const diff = got > want ? got - want : want - got;
      const rel = Number(diff) / Number(want);
      expect(rel, `ratio ${ratio}: branches disagree by ${rel} relative`).to.be.lessThan(1e-18);
    }
  });

  it('M8. an extreme-but-real threshold prices correctly instead of reverting', async function () {
    // The exact shape test 4 of the fork suite drives: a 10 USDC graduation threshold
    // leaves ~1e27 tokens against ~1.2e7 raw USDC, a ratio of ~8.3e19 -- past 2**64.
    const tokenSide = 10n ** 27n;
    const usdcSide = 12n * 10n ** 6n;
    const sp = await math.sqrtPriceX96(usdcSide, tokenSide); // USDC sorts first here
    expect(sp, 'extreme ratio reverted instead of pricing').to.be.greaterThan(0n);
    expect(sp).to.be.lessThan(MAX_SQRT_PRICE);

    const impliedA1 = (usdcSide * sp * sp) / (Q96 * Q96);
    const rel = Number(impliedA1 - tokenSide) / Number(tokenSide);
    expect(Math.abs(rel), `extreme ratio round-trip err ${rel}`).to.be.lessThan(1e-15);
  });

  it('M9. a ratio beyond ANY representable price is a named revert, not a panic', async function () {
    // Past 2**191 even the wide branch cannot hold the intermediate. Without the guard
    // this reaches FullMath.mulDiv and reverts there with nothing to say about why.
    await expect(math.sqrtPriceX96(1n, 1n << 191n)).to.be.revertedWithCustomError(
      math, 'AmountRatioOutOfRange'
    );
    // And a ratio v4 itself cannot express is refused by the price bound, separately.
    await expect(math.sqrtPriceX96(1n, 1n << 160n)).to.be.revertedWithCustomError(
      math, 'SqrtPriceOutOfRange'
    );
  });
});
