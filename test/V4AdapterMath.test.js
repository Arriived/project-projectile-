const { expect } = require('chai');
const { ethers } = require('hardhat');
const { deployBoundPair } = require('./helpers/v4deploy');

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
    // The harness inherits the adapter, so the adapter's constructor runs -- including
    // the three hook checks. A correctly-flagged MockHookBinding bound to the harness's
    // own predicted address is therefore required even for pure-math tests. Same
    // sequence production uses; see test/helpers/v4deploy.js.
    const [signer] = await ethers.getSigners();
    const pair = await deployBoundPair(signer, 'MockHookBinding', [], 'V4AdapterMathHarness', []);
    math = pair.adapter;
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

  // ═══════════════════════════════════════════════════════════════════════════════
  // ATTACK 6 — the price derivation at the edges.
  //
  // This sqrt has no upstream review: v4 ships no integer square root and no
  // amounts-to-price helper, so it is the only part of the price path not taken from
  // Uniswap's own source (§15.2).
  //
  // ⚠ THE ONLY BUG THAT MATTERS HERE IS A WRONG PRICE THAT DOES NOT REVERT. A revert
  // leaves the curve at GRADUATION_READY with reserves intact and graduate() retryable;
  // a pool silently opened at the wrong price is permanent with the LP already burned.
  // So the sweep below asserts a DISJUNCTION -- every input either reverts, or produces
  // a price that round-trips. There is deliberately no case where "it returned something"
  // counts as a pass.
  // ═══════════════════════════════════════════════════════════════════════════════
  describe('ATTACK 6 — price derivation at the edges', function () {
    const LP_TOKEN_RESERVE = 193_000_000n * 10n ** 18n;
    const CURVE_TOKEN_SUPPLY = 807_000_000n * 10n ** 18n;

    // Every (amount0, amount1) a real graduation can reach, plus the arithmetic
    // boundaries. tokenLiquidity = LP_TOKEN_RESERVE + tokenReserves, so it runs from
    // exactly LP_TOKEN_RESERVE (the depletion arm, curve fully bought) up to
    // LP_TOKEN_RESERVE + CURVE_TOKEN_SUPPLY (nothing sold).
    function cases() {
      const out = [];
      const push = (label, t, u) => out.push({ label, t, u });

      // The reachable USDC side: the §15.4 arithmetic floor, the production default, and
      // an implausibly large threshold. poolBoost only ever ADDS to the USDC side.
      for (const [ulabel, u] of [
        ['floor 54.3 USDC', 54_300_000n],
        ['floor+ 60 USDC', 60n * 10n ** 6n],
        ['default 8,019 USDC', 8_019n * 10n ** 6n],
        ['boosted 8,340 USDC (+4%)', 8_340n * 10n ** 6n],
        ['large 50,000 USDC', 50_000n * 10n ** 6n],
        ['huge 1,000,000 USDC', 1_000_000n * 10n ** 6n],
      ]) {
        for (const [tlabel, t] of [
          ['token side == LP_TOKEN_RESERVE exactly', LP_TOKEN_RESERVE],
          ['token side one wei above LP_TOKEN_RESERVE', LP_TOKEN_RESERVE + 1n],
          ['token side measured 193,297,304e18', 193_297_304n * 10n ** 18n],
          ['token side maximal (nothing sold)', LP_TOKEN_RESERVE + CURVE_TOKEN_SUPPLY],
        ]) {
          push(`${tlabel} / ${ulabel}`, t, u);
        }
      }

      // The wide-branch boundary at 2**63, straddled exactly.
      const B = 1n << 63n;
      for (const d of [-2n, -1n, 0n, 1n, 2n]) {
        push(`ratio at 2**63 ${d >= 0n ? '+' : ''}${d}`, 10n ** 24n, (B + d) * 10n ** 24n);
      }
      return out;
    }

    it('A6. every reachable input either REVERTS or produces a round-tripping price — both orderings', async function () {
      let checked = 0;
      let reverted = 0;
      let worstRel = 0;
      let worstLabel = '';
      let wide = 0;
      let precise = 0;

      for (const c of cases()) {
        // Both orderings: roughly half of real launches sort each way, and the adapter
        // sorts by address, so the token can be currency0 or currency1.
        for (const [olabel, a0, a1] of [
          ['token first', c.t, c.u],
          ['usdc first', c.u, c.t],
        ]) {
          checked++;
          let sp;
          try {
            sp = await math.sqrtPriceX96(a0, a1);
          } catch (e) {
            reverted++;
            continue; // a revert is the SAFE outcome and needs no further check
          }

          // It returned. Now it must be right, and right to a tight bound.
          expect(sp, `${c.label} / ${olabel}: zero price`).to.be.greaterThan(0n);
          expect(sp, `${c.label} / ${olabel}: below MIN_SQRT_PRICE`)
            .to.be.greaterThanOrEqual(MIN_SQRT_PRICE);
          expect(sp, `${c.label} / ${olabel}: at or above MAX_SQRT_PRICE`).to.be.lessThan(MAX_SQRT_PRICE);

          // Round-trip: implied amount1 = a0 * sp^2 / 2^192 must match a1.
          //
          // ⚠ THE BOUND IS ABSOLUTE, IN RAW UNITS, NOT RELATIVE -- and the first version
          // of this check got that wrong in exactly the way M5 above already documents.
          // A relative bound of 1e-15 fired at the 54.3 USDC floor on an error of ONE raw
          // unit, because one unit of 5.43e7 IS 1.84e-8 relative. The quantisation is a
          // fixed handful of units at any magnitude: floor(sqrt(...)) costs a fraction of
          // a unit and the final integer division costs at most one more. Small amounts
          // make that look enormous in relative terms and it is not.
          //
          // The direction is asserted separately and is the part that matters:
          // floor(sqrt(x))^2 <= x, so the pool can only ever open AT or BELOW the ratio
          // the deposit justifies, never richer than it.
          const implied = (a0 * sp * sp) / (Q96 * Q96);
          expect(implied, `${c.label} / ${olabel}: price ABOVE the supplied ratio`).to.be.at.most(a1);
          const shortfall = a1 - implied;
          const rel = Number(shortfall) / Number(a1);
          if (rel > worstRel) { worstRel = rel; worstLabel = `${c.label} / ${olabel}`; }

          // ⚠ THE MAGNITUDE BOUND IS A DISJUNCTION, AND IT TOOK THREE TRIES TO STATE.
          //
          // The invariant that actually holds everywhere is the DIRECTIONAL one asserted
          // above: floor(sqrt(x))^2 <= x, so the pool never opens richer than the deposit
          // justifies. The magnitude is quantised two different ways depending on scale
          // and no single bound covers both:
          //
          //   small amounts -> quantised in RAW UNITS. One unit of the 54.3 USDC floor is
          //                    1.84e-8 relative, so a relative bound fires on a one-unit
          //                    error. (M5 above already records this; the first version of
          //                    this check repeated the mistake anyway.)
          //   large amounts -> quantised RELATIVELY. The wide branch gives up 32 bits by
          //                    design and loses ~1e7 raw units on a 1e27 token side, which
          //                    is 1.0e-20 relative and 1e-11 of one 18dp token. A raw-unit
          //                    bound fires on that.
          //
          // So: a handful of raw units, OR a negligible fraction. Both are still twenty
          // orders clear of the 1e12 error class that actually matters.
          const wideBranch = a1 / a0 >= (1n << 63n);
          if (wideBranch) wide++; else precise++;
          expect(
            shortfall <= 4n || rel < 1e-15,
            `${c.label} / ${olabel}: ${wideBranch ? 'WIDE' : 'PRECISE'} branch off by `
              + `${shortfall} raw units (${rel.toExponential(3)} relative)`
          ).to.equal(true);
        }
      }

      console.log(`      ATTACK A6   ${checked} inputs, ${reverted} reverted, ${checked - reverted} priced`);
      console.log(`      MEASURE branch split           ${wide} wide / ${precise} precise`);
      console.log(`      MEASURE worst round-trip error ${worstRel.toExponential(3)}  (${worstLabel})`);
      expect(checked - reverted, 'nothing was actually priced -- the sweep proves nothing')
        .to.be.greaterThan(20);
    });

    it('A6b. the wide branch never silently truncates the shift', async function () {
      // sqrtPrice = _sqrt(mulDiv(amount1, 2**64, amount0)) << 64. Solidity's << TRUNCATES
      // rather than reverting, so if _sqrt could return >= 2**192 the high bits would be
      // lost silently and the pool would open at a wrong price with no revert -- exactly
      // the failure mode this attack is looking for.
      //
      // The bound that rules it out: MAX_AMOUNT_RATIO caps the ratio at 2**191, so the
      // intermediate is < 2**255, its root is < 2**127.5, and the shift lands < 2**191.5.
      // Probe just under the cap and confirm the result is both in range and consistent.
      const justUnder = (1n << 191n) - 1n;
      const a0 = 1n;
      let sp = null;
      try { sp = await math.sqrtPriceX96(a0, justUnder); } catch { sp = null; }
      // It should refuse on the PRICE bound rather than produce a truncated number.
      expect(sp, 'a ratio near 2**191 produced a price instead of refusing').to.equal(null);

      // And the largest ratio that DOES price must still round-trip.
      let largest = null;
      for (const e of [40n, 38n, 36n, 34n, 32n]) {
        try {
          const v = await math.sqrtPriceX96(1n, 10n ** e);
          largest = { e, v };
          break;
        } catch { /* keep narrowing */ }
      }
      expect(largest, 'no large ratio priced at all').to.not.equal(null);
      const implied = (1n * largest.v * largest.v) / (Q96 * Q96);
      expect(implied, `1 : 1e${largest.e} round-trip overshoots`).to.be.at.most(10n ** largest.e);
      console.log(`      ATTACK A6b  largest priced ratio 1 : 1e${largest.e}, sqrtPriceX96 ${largest.v}`);
    });
  });
});
