// List-page logic: the default sort, duplicate-symbol detection, search, ordering,
// pagination, and the availability table that keeps the UI honest about what the indexer
// can actually serve.
//
// Run: npm run verify:list
//
// Red-proofs, each hitting a different row:
//   a) change DEFAULT_SORT to "newest"                     -> L1 fails
//   b) make findSymbolCollisions case-SENSITIVE            -> L4 fails
//   c) flag only the later token in a collision            -> L3 fails
//   d) mark "24h" available in WINDOW_AVAILABILITY         -> L9 fails
//   e) drop address matching from matchesSearch            -> L6 fails

import {
  DEFAULT_SORT,
  DEFAULT_WINDOW,
  SORT_AVAILABILITY,
  WINDOW_AVAILABILITY,
  LIVE_PAGE_SIZE,
  GRADUATED_PAGE_SIZE,
  findSymbolCollisions,
  hasCollision,
  matchesSearch,
  sortTokens,
  pageSlice,
  pageCount,
  approxMarketCapUsdc6,
  approxProgressBps,
  progressLabelKind,
  MIN_RENDERABLE_PCT,
  type ListToken,
} from "../src/lib/tokenList.ts";
import { formatUsdcCompact } from "../src/i18n/format.ts";

let failures = 0;
const check = (label: string, pass: boolean, detail = "") => {
  if (!pass) failures++;
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${label}${detail ? `  — ${detail}` : ""}`);
};

const CURVE_SUPPLY = 807_000_000_000_000_000_000_000_000n;

function tok(p: Partial<ListToken> & { address: string }): ListToken {
  return {
    name: "T",
    symbol: "TKN",
    metadataUri: null,
    createdAt: "2026-08-01T00:00:00Z",
    graduated: false,
    approxRealUsdcReserves: 0n,
    approxVirtualUsdcReserves: 1n,
    approxVirtualTokenReserves: 1n,
    approxThresholdUsdc: 8_000_000_000n,
    approxVolume1hUsdc: 0n,
    lastBuyBlock: null,
    symbolCollision: false,
    ...p,
  };
}

// ── the default (C2) ────────────────────────────────────────────────────────────
console.log("── default sort ──");
// Load-bearing, not a preference. Newest ranks by CREATION, so the feed fills with tokens
// nobody has traded; Recent buys ranks by ACTIVITY, so spam is invisible rather than
// merely expensive. Without this row, a "tidy-up" could flip it and nothing would object.
check("L1  the default sort is recentBuys, explicitly", DEFAULT_SORT === "recentBuys", DEFAULT_SORT);
check("L2  the default window is all", DEFAULT_WINDOW === "all", DEFAULT_WINDOW);

// ── duplicate symbols (C3 / rule 2) ─────────────────────────────────────────────
console.log("\n── duplicate symbols ──");
{
  const symbols = ["CAT", "DOG", "CAT", "BIRD"];
  const collided = findSymbolCollisions(symbols);
  check("L3a a repeated symbol is detected", collided.has("cat"), [...collided].join(","));
  check("L3b a unique symbol is not flagged", !collided.has("dog"));

  // BOTH tokens are flagged, not just the newer one. Which of two identical tickers is
  // "the real one" is not ours to assert.
  const a = tok({ address: "0xa", symbol: "CAT" });
  const b = tok({ address: "0xb", symbol: "CAT" });
  check(
    "L3  BOTH tokens in a collision are flagged, not just the later one",
    hasCollision(a.symbol, collided) && hasCollision(b.symbol, collided)
  );

  // caseSensitiveSymbols is TRUE on chain, so CAT and cat are different symbols to the
  // contract -- and identical to a reader. The impersonation is visual, so detection is
  // case-INSENSITIVE.
  const mixed = findSymbolCollisions(["CAT", "cat"]);
  check(
    "L4  detection is case-insensitive (CAT vs cat is the impersonation that matters)",
    mixed.has("cat"),
    `${mixed.size} collision group(s)`
  );

  check("L5  empty symbols are not treated as colliding with each other", !findSymbolCollisions(["", "  "]).size);
}

// ── search (name, symbol AND address) ───────────────────────────────────────────
console.log("\n── search ──");
{
  const t = tok({ address: "0xAbCdEf1234", name: "TxShape", symbol: "TXS1569" });
  check("L6a matches on name", matchesSearch(t, "txsh"));
  check("L6b matches on symbol", matchesSearch(t, "1569"));
  // The address is the only identifier that cannot be copied, so it MUST be searchable.
  check("L6  matches on ADDRESS, case-insensitively", matchesSearch(t, "0xabcdef"));
  check("L6c does not match unrelated text", !matchesSearch(t, "zzzz"));
  check("L6d an empty query matches everything", matchesSearch(t, "   "));
}

// ── ordering ────────────────────────────────────────────────────────────────────
console.log("\n── ordering ──");
{
  const never = tok({ address: "0xnever", createdAt: "2026-08-03T00:00:00Z", lastBuyBlock: null });
  const old = tok({ address: "0xold", createdAt: "2026-08-01T00:00:00Z", lastBuyBlock: 100n });
  const recent = tok({ address: "0xrecent", createdAt: "2026-08-02T00:00:00Z", lastBuyBlock: 900n });

  const byBuys = sortTokens([never, old, recent], "recentBuys", CURVE_SUPPLY);
  check(
    "L7  recentBuys puts the most recently bought first",
    byBuys[0].address === "0xrecent",
    byBuys.map((x) => x.address).join(" > ")
  );
  // A token nobody has bought is not "recently bought". Sorting it as though its buy
  // happened at block 0 would be the same outcome, but this says so.
  check("L7b never-bought tokens sort LAST, not interleaved", byBuys[2].address === "0xnever");

  const byNew = sortTokens([old, recent, never], "newest", CURVE_SUPPLY);
  check("L8a newest is by creation, descending", byNew[0].address === "0xnever");
  const byOld = sortTokens([never, recent, old], "oldest", CURVE_SUPPLY);
  check("L8b oldest is by creation, ascending", byOld[0].address === "0xold");

  // Market cap is NOT just virtual USDC: mcap = vUsdc * supply / vToken, and vToken
  // differs per token. A token with more USDC but far more tokens has the smaller cap.
  const bigUsdc = tok({
    address: "0xbig",
    approxVirtualUsdcReserves: 1000n,
    approxVirtualTokenReserves: 1_000_000n,
  });
  const smallUsdc = tok({
    address: "0xsmall",
    approxVirtualUsdcReserves: 100n,
    approxVirtualTokenReserves: 10n,
  });
  const byCap = sortTokens([bigUsdc, smallUsdc], "marketCap", CURVE_SUPPLY);
  check(
    "L8c marketCap uses vUsdc/vToken, not vUsdc alone",
    byCap[0].address === "0xsmall",
    `${byCap.map((x) => x.address).join(" > ")} — ordering by vUsdc alone would invert this`
  );

  const byVol = sortTokens(
    [tok({ address: "0xa", approxVolume1hUsdc: 5n }), tok({ address: "0xb", approxVolume1hUsdc: 50n })],
    "volume",
    CURVE_SUPPLY
  );
  check("L8d volume is descending", byVol[0].address === "0xb");
}

// ── availability: the UI must not offer what the data cannot serve ──────────────
console.log("\n── availability ──");
// Measured against the live view with the anon key BEFORE this was written: no
// last_buy_at, no volume_24h_usdc, no volume_7d_usdc, no total_supply.
check(
  "L9  24h and 7d are marked UNAVAILABLE (only volume_1h_usdc exists)",
  WINDOW_AVAILABILITY["24h"] === false && WINDOW_AVAILABILITY["7d"] === false,
  "serving 1h data under a 24h label would be the interface asserting what the data cannot support"
);
check("L9b 'all' is available", WINDOW_AVAILABILITY.all === true);
check(
  "L10 recentBuys is marked 'derived' -- it is NOT a view column",
  SORT_AVAILABILITY.recentBuys === "derived",
  SORT_AVAILABILITY.recentBuys
);
check("L10b newest/oldest come from the view", SORT_AVAILABILITY.newest === "view");
check(
  "L10c no sort is marked 'blocked' -- every offered sort can be served today",
  !Object.values(SORT_AVAILABILITY).includes("blocked")
);

// ── pagination ──────────────────────────────────────────────────────────────────
console.log("\n── pagination ──");
{
  const many = Array.from({ length: 25 }, (_, i) => tok({ address: `0x${i}` }));
  check("L11a live page size is 10", LIVE_PAGE_SIZE === 10, String(LIVE_PAGE_SIZE));
  check("L11b graduated page size is smaller", GRADUATED_PAGE_SIZE < LIVE_PAGE_SIZE, String(GRADUATED_PAGE_SIZE));
  check("L11c 25 rows at 10 per page is 3 pages", pageCount(25, 10) === 3);
  check("L11d page 1 returns the first 10", pageSlice(many, 1, 10).length === 10);
  check("L11e page 3 returns the remaining 5", pageSlice(many, 3, 10).length === 5);
  // A stale page number must not render an empty list -- it clamps to the last page.
  check("L11f an out-of-range page clamps rather than emptying", pageSlice(many, 99, 10).length === 5);
  check("L11g zero rows still reports one page", pageCount(0, 10) === 1);
}

// ── display maths ───────────────────────────────────────────────────────────────
console.log("\n── display figures ──");
{
  const t = tok({ address: "0xa", approxRealUsdcReserves: 4_000_000_000n, approxThresholdUsdc: 8_000_000_000n });
  check("L12a progress is half way", approxProgressBps(t) === 5000, String(approxProgressBps(t)));
  check(
    "L12b progress clamps at the threshold",
    approxProgressBps(tok({ address: "0xb", approxRealUsdcReserves: 9_000_000_000n })) === 10_000
  );
  check(
    "L12c a zero threshold does not divide by zero",
    approxProgressBps(tok({ address: "0xc", approxThresholdUsdc: 0n })) === 10_000
  );
  check(
    "L12d market cap is zero when the token side is zero, not NaN",
    approxMarketCapUsdc6(tok({ address: "0xd", approxVirtualTokenReserves: 0n }), CURVE_SUPPLY) === 0n
  );
}

// ── "has anyone bought this?" ───────────────────────────────────────────────────
console.log("\n── progress labels ──");
{
  // The live numbers this was written against. PRC4587 has never been traded; TXS2809
  // had two buys and two sells, leaving 0.48 USDC against an 8,000 USDC threshold.
  const never = tok({ address: "0xnever", approxRealUsdcReserves: 0n, approxThresholdUsdc: 8_000_000_000n });
  const tiny = tok({ address: "0xtiny", approxRealUsdcReserves: 480_001n, approxThresholdUsdc: 8_000_000_000n });
  const real = tok({ address: "0xreal", approxRealUsdcReserves: 4_000_000_000n, approxThresholdUsdc: 8_000_000_000n });

  check(
    "L13a a never-traded curve is 'none', not a percentage",
    progressLabelKind(never) === "none",
    progressLabelKind(never)
  );

  // THE ROW THAT MATTERS. approxProgressBps divides in bigint and TRUNCATES: 0.48 USDC
  // against 8,000 is 0.6 bps, which comes back as 0. A label keyed on the percentage
  // therefore reports "no buys yet" for a curve that has genuinely been traded -- the
  // exact confusion the label was added to remove, reintroduced one layer down. This
  // fails if the implementation ever goes back to testing the percentage.
  check(
    "L13  a TRADED curve below 0.1% is 'below', NOT 'none' (bps truncates to 0 here)",
    progressLabelKind(tiny) === "below",
    `bps=${approxProgressBps(tiny)} -> ${progressLabelKind(tiny)}`
  );
  check(
    "L13b the two are distinguishable at all",
    progressLabelKind(never) !== progressLabelKind(tiny),
    "a card must not say the same thing about a traded and an untraded curve"
  );
  check(
    "L13c a curve above the threshold shows the real figure",
    progressLabelKind(real) === "exact",
    `bps=${approxProgressBps(real)} -> ${progressLabelKind(real)}`
  );
  check(
    "L13d the label threshold is the exported constant, not a literal",
    MIN_RENDERABLE_PCT === 0.1,
    String(MIN_RENDERABLE_PCT)
  );
}

// ── compact formatting must not flatten real differences ────────────────────────
console.log("\n── compact market cap ──");
{
  // Measured live: four tokens at 2002.11 / 2002.40 / 2002.40 / 2002.11 USDC ALL rendered
  // as "2K", so the grid claimed four identical tokens when they were not. A launch curve
  // opens around 2,000 USDC, so the whole early life of every token sat inside the band
  // compact notation flattened -- which is the band a trader actually scans.
  const a = formatUsdcCompact("en", 2_002_110_697n);
  const b = formatUsdcCompact("en", 2_002_395_953n);
  check("L14  two market caps that differ RENDER differently", a !== b, `${a} vs ${b}`);
  check(
    "L14b sub-10K values are not compacted at all",
    !/[KMBT]/.test(formatUsdcCompact("en", 9_999_000_000n)),
    formatUsdcCompact("en", 9_999_000_000n)
  );
  check(
    "L14c above 10K compaction still applies",
    /K/.test(formatUsdcCompact("en", 12_345_000_000n)),
    formatUsdcCompact("en", 12_345_000_000n)
  );
}

const total = 39;
console.log(`\n${total - failures}/${total} checks passed`);
if (failures) process.exit(1);
