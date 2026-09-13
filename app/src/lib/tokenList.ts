// List-page logic: sorting, time windows, duplicate-symbol detection, pagination.
//
// Pure. No React, no network. Everything here is decided by what the INDEXER can actually
// serve, which was measured before any of this was written -- see the SORTS table below.

/** One row as the list page uses it. `approx*` names carry trap 21's warning. */
export type ListToken = {
  address: string;
  name: string;
  symbol: string;
  metadataUri: string | null;
  createdAt: string;
  graduated: boolean;
  /** APPROXIMATE. PostgREST serialises uint256 as a JSON number, already truncated. */
  approxRealUsdcReserves: bigint;
  approxVirtualUsdcReserves: bigint;
  approxVirtualTokenReserves: bigint;
  approxThresholdUsdc: bigint;
  approxVolume1hUsdc: bigint;
  /** Block of this token's most recent BUY, or null if it has never been bought. */
  lastBuyBlock: bigint | null;
  /** True when another LIVE token shares this symbol. Computed across the whole set. */
  symbolCollision: boolean;
};

export type SortKey = "recentBuys" | "newest" | "oldest" | "marketCap" | "volume";
export type TimeWindow = "all" | "24h" | "7d";

/**
 * What the indexer can serve TODAY, measured against tokens_with_volume with the anon key.
 *
 * The view has no recency-of-buy column, no 24h or 7d volume, and no total_supply. Rather
 * than quietly degrade -- showing 1h data under a "24h" label, which is the interface
 * asserting something the data does not support -- the unavailable options are DISABLED
 * with a reason, pending migration 003.
 *
 * `derived` means we can serve it today without the view, by a second query.
 */
export const SORT_AVAILABILITY: Record<SortKey, "view" | "derived" | "blocked"> = {
  // No last_buy_at / last_buy_block on the view. Derived from the trades table:
  // trades?is_buy=eq.true&order=block_number.desc, deduped by token. Proven against live
  // data before this was written.
  recentBuys: "derived",
  newest: "view", // created_at
  oldest: "view", // created_at
  // mcap = virtualUsdc * totalSupply / virtualToken. total_supply is ABSENT from the view,
  // and ordering by virtual_usdc_reserves alone is NOT equivalent because
  // virtual_token_reserves differs per token. Computed client-side from the page's rows,
  // which is honest for a page but is not a global ordering -- 003 fixes it properly.
  marketCap: "derived",
  volume: "view", // volume_1h_usdc only
};

export const WINDOW_AVAILABILITY: Record<TimeWindow, boolean> = {
  all: true,
  // Only volume_1h_usdc exists. Serving 1h data under a "24h" label would be the
  // interface showing a number the data does not support.
  "24h": false,
  "7d": false,
};

/**
 * THE DEFAULT IS RECENT BUYS, SET EXPLICITLY (C2).
 *
 * Not Newest, and not whatever the query happens to return. Newest ranks by creation, so
 * the feed fills with tokens nobody has traded -- a wall of "27s ago" cards, several with
 * broken images, which is what the reference's own Newest view looks like. Recent buys
 * ranks by activity, so spam is INVISIBLE rather than merely expensive to produce.
 *
 * Anyone changing this should read that sentence first.
 */
export const DEFAULT_SORT: SortKey = "recentBuys";
export const DEFAULT_WINDOW: TimeWindow = "all";

export const LIVE_PAGE_SIZE = 10;
export const GRADUATED_PAGE_SIZE = 6;

/**
 * Market cap, approximate, for DISPLAY and ordering only.
 *
 * mcap = virtualUsdc * totalSupply / virtualToken. Every input here came from the indexer
 * as a truncated JSON number (trap 21), so the result is approximate and is rendered with
 * a leading `~`. Nothing a user acts on uses it -- the token page recomputes from the
 * chain.
 */
export function approxMarketCapUsdc6(t: ListToken, curveSupply: bigint): bigint {
  if (t.approxVirtualTokenReserves === 0n) return 0n;
  return (t.approxVirtualUsdcReserves * curveSupply) / t.approxVirtualTokenReserves;
}

/**
 * Progress toward graduation in bps, approximate, clamped. Display only.
 *
 * ⚠ TRUNCATES. The division is in bigint, so this returns whole basis points: a curve
 * holding 0.48 USDC against an 8,000 USDC threshold is 0.6 bps and comes back as **0**.
 * That is fine for a progress BAR and fatal for any "has anyone bought this" test --
 * see progressLabelKind below.
 */
export function approxProgressBps(t: ListToken): number {
  if (t.approxThresholdUsdc === 0n) return 10_000;
  if (t.approxRealUsdcReserves >= t.approxThresholdUsdc) return 10_000;
  return Number((t.approxRealUsdcReserves * 10_000n) / t.approxThresholdUsdc);
}

/**
 * The smallest percentage the card actually renders, at one decimal place.
 *
 * Exported so the label and the threshold that triggers it are the SAME number.
 * Hardcoding it in the component and again here would be two constants that agree right
 * up until someone changes the decimal places and only one of them moves.
 */
export const MIN_RENDERABLE_PCT = 0.1;

/** Which of three genuinely different facts a card's progress figure should state. */
export type ProgressLabel = "none" | "below" | "exact";

/**
 * "Has anyone bought this?" is the first question a trader asks about a new launch, and
 * one decimal place answered it wrongly.
 *
 * Measured on live data: PRC4587 has never been traded and TXS2809 has had two buys and
 * two sells, and BOTH rendered as "0.0%". Those are not the same fact.
 *
 * ⚠ THE never-traded TEST READS THE RESERVES, NOT THE PERCENTAGE, and that distinction is
 * the whole function. The first version of this tested `progressBps === 0`, which reports
 * "no buys yet" for any curve under 1 basis point because approxProgressBps truncates --
 * reintroducing the exact confusion it was written to remove, one layer down.
 *
 *   none   real reserves are exactly zero. Nothing has happened.
 *   below  traded, but rounds away at the rendered precision. Show "<0.1%".
 *   exact  show the figure.
 */
export function progressLabelKind(
  t: ListToken,
  minRenderablePct = MIN_RENDERABLE_PCT
): ProgressLabel {
  if (t.approxRealUsdcReserves === 0n) return "none";
  return approxProgressBps(t) / 100 < minRenderablePct ? "below" : "exact";
}

/**
 * DUPLICATE SYMBOLS (C3 / rule 2).
 *
 * `symbolLockDuration` is 0 on the live deployment, so nothing on chain prevents one
 * launch impersonating another's ticker, and `caseSensitiveSymbols` is true -- so CAT and
 * cat are different symbols to the contract but identical to a reader. This compares
 * case-INSENSITIVELY, because the impersonation a user suffers is visual.
 *
 * Computed across the WHOLE live set, never the current page. A page-scoped scan cannot
 * see a collision on page 4, which makes it worse than nothing: it would clear tokens
 * that are in fact impersonated.
 *
 * BOTH tokens in a collision are flagged, not just the newer one. Which of two identical
 * tickers is "the real one" is not ours to assert -- the honest signal is that they
 * collide, and the address is the tiebreaker.
 */
export function findSymbolCollisions(symbols: string[]): Set<string> {
  const counts = new Map<string, number>();
  for (const s of symbols) {
    const k = s.trim().toLowerCase();
    if (!k) continue;
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const collided = new Set<string>();
  for (const [k, n] of counts) if (n > 1) collided.add(k);
  return collided;
}

export function hasCollision(symbol: string, collided: Set<string>): boolean {
  return collided.has(symbol.trim().toLowerCase());
}

/** Search across name, symbol AND address (the address is the only real identifier). */
export function matchesSearch(t: ListToken, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return (
    t.name.toLowerCase().includes(q) ||
    t.symbol.toLowerCase().includes(q) ||
    t.address.toLowerCase().includes(q)
  );
}

/**
 * Ordering.
 *
 * Recent buys puts tokens that have NEVER been bought last, in creation order, rather than
 * interleaving them by a null. A token nobody has touched is not "recently bought", and
 * sorting it as though its buy happened at block 0 would bury it below tokens that at
 * least exist -- which is the same thing, but says so.
 */
export function sortTokens(tokens: ListToken[], sort: SortKey, curveSupply: bigint | undefined): ListToken[] {
  const out = [...tokens];
  switch (sort) {
    case "recentBuys":
      return out.sort((a, b) => {
        if (a.lastBuyBlock === null && b.lastBuyBlock === null) {
          return b.createdAt.localeCompare(a.createdAt);
        }
        if (a.lastBuyBlock === null) return 1;
        if (b.lastBuyBlock === null) return -1;
        return b.lastBuyBlock > a.lastBuyBlock ? 1 : b.lastBuyBlock < a.lastBuyBlock ? -1 : 0;
      });
    case "newest":
      return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    case "oldest":
      return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    case "marketCap":
      if (curveSupply === undefined) return out;
      return out.sort((a, b) => {
        const ma = approxMarketCapUsdc6(a, curveSupply);
        const mb = approxMarketCapUsdc6(b, curveSupply);
        return mb > ma ? 1 : mb < ma ? -1 : 0;
      });
    case "volume":
      return out.sort((a, b) =>
        b.approxVolume1hUsdc > a.approxVolume1hUsdc
          ? 1
          : b.approxVolume1hUsdc < a.approxVolume1hUsdc
            ? -1
            : 0
      );
  }
}

export function pageCount(total: number, size: number): number {
  return Math.max(1, Math.ceil(total / size));
}

/** 1-indexed page, clamped so a stale page number cannot render an empty list. */
export function pageSlice<T>(items: T[], page: number, size: number): T[] {
  const pages = pageCount(items.length, size);
  const p = Math.min(Math.max(1, page), pages);
  return items.slice((p - 1) * size, p * size);
}
