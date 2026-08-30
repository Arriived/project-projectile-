# Phase 2 and 3 — layout

Reference: pons's launchpad. Take the structure, not the code or the copy. The
nine hard rules in `FRONTEND_BUILD_V2.md` and the traps in `REACT_REBUILD.md`
govern behaviour; this governs shape.

Build Phase 2 (token page) first, then Phase 3 (list). Report at the boundary.

---

## Phase 3 — the list page, `/`

Two sections, graduated above live. That ordering is doing work: graduated
tokens are evidence the mechanism completes, so they sit above the noise. Keep
the section even when the count is zero — an empty "Graduated 0" with the
one-line explanation is honest and it teaches a first-time visitor what the
product does.

### Header

Logo, then nav, then connect on the right. Nav is thin for now — Explore is the
only live destination. **Do not build an Analytics page**; it's a real surface
but not before mainnet.

### Search and create

Full-width search across the top, with a Create button to its right. Search
matches name, symbol, **and address** — the address matters because symbols are
fully duplicable and it's the only real identifier.

### The card

The unit of the whole page. Top to bottom:

- Image, square, filling the card width. A neutral placeholder when the metadata
  URI is missing or fails — a broken-image icon reads as a broken site.
- Status pill overlaid top-left: `Graduated` on graduated cards; nothing on live
  ones, since "live" is the default state and a pill for it is noise.
- Name, then `$SYMBOL` beneath it in a lighter weight.
- **Live cards:** market cap, then a progress bar toward graduation with the
  percentage at its right end.
- **Graduated cards:** market cap and FDV on one line.
- Footer row: truncated contract address on the left, age on the right.

**The address is on every card and is not optional.** Nothing on-chain prevents
symbol impersonation — `symbolLockDuration` is 0 — so the address is the only
thing that can't be copied.

**Duplicate symbols must be visibly flagged.** If two live tokens share a
symbol, mark both. This is rule 2 and it's a hard requirement, not a nicety.

### Sorting and filtering

A row above the live section: Recent buys, Newest, Oldest, Market cap, Volume.
Then a time filter — All, 24h, 7d. Default to Recent buys.

No v1/v2 equivalent. Don't invent one.

### Pagination

Numbered pages, not infinite scroll. Simpler to build, simpler to reason about,
and it's what the reference does. Ten rows of cards per page in the live
section; a smaller page size for graduated.

### Empty and degraded states

- **No tokens at all:** say so plainly with a link to create. This is what
  launch day looks like and it should not look broken.
- **Indexer unreachable:** trap 19 — read from the chain and show
  degraded-but-correct data with a visible note, never a blank page. Say which
  fields are unavailable rather than showing zeroes.
- **Loading:** skeleton cards at the right dimensions, so the layout doesn't
  jump.

---

## Phase 2 — the token page, `/t/:address`

Deep-linkable. A launchpad whose token pages aren't shareable URLs is broken.

Order, top to bottom, because this order is the trust argument:

**1. Identity.** Image, name, `$SYMBOL`, and the **full contract address, always
visible and copyable**. Not truncated behind a tooltip, not in a drawer. Link to
the verified contract on the explorer beside it.

**2. Your position.** The connected wallet's balance of this token, prominent,
with an **Add to wallet** button (`wallet_watchAsset`, 18 decimals — trap 4 and
rule 9). This sits high because of the failure it prevents: MetaMask doesn't
autodetect launched tokens, and since USDC is the native balance the user
watches their headline number drop with nothing arriving. Without this the flow
reads as "my money left and I got nothing."

**3. Price and progress.** Current price, market cap, and progress toward the
8,000 USDC threshold as a bar with the figure beside it. Post-graduation, the
pool link replaces the bar.

**4. Trade panel.** Buy/Sell toggle, preset amounts, an input, and:

- Estimated receive, quoted from `quoteBuy`/`quoteSell` on the contract
- **Price impact as a headline number**, not buried — via the probe-quote
  method, never `currentPrice()`
- Minimum received, never zero, sized from the rate
- **The snipe tax shown explicitly with a countdown when active.** In the
  opening seconds this is most of what the buyer pays; hiding it and then
  settling at a different number is the worst thing this page can do
- Gas reserve visible, and "available to trade" as balance minus reserve
- Affordability checked by arithmetic before submitting, never by parsing a
  revert

**5. Trust panel.** Fees read per-token from `curves()`, never assumed. LP
recipient. **"Creator bought X% at launch"** from `creatorLaunchPurchased` —
this is the disclosure that protects buyers, so it is not optional and not
collapsed. No Mint and LP Auto-Burned as contract-guaranteed facts.

**6. Trades feed.** Recent buys and sells, ordered by `blockNumber` then
`logIndex`.

### States the page must handle

- **Active:** everything above.
- **`GRADUATION_READY`:** both sides closed. Say why — "this curve is awaiting
  graduation and cannot be traded until it completes" — rather than showing a
  button that reverts.
- **`GRADUATED`:** trading moved to the pool. Link out, keep the page readable.

---

## Later, not now

**Per-token comments.** One thread per token rather than a global forum — a
single forum becomes unmoderatable shilling within a week, and comments attached
to the token they're about are the natural unit. **Holders get a badge next to
their name, read from their on-chain balance.** Nobody else does this and it's
the strongest expression of the positioning: claims about holding become
verifiable rather than asserted.

Not launch-day work. It's the first thing in this product that isn't derived
from the chain — it needs a table, an auth story, and a moderation burden that
falls on one person. Design the token page so a thread can be appended beneath
the trades feed without restructuring.

---

## Ground rules

Report at each phase boundary. Nothing is done until it's been clicked through
in a browser with a real wallet — that keeps finding what the injected provider
can't. Flag anything where the interface would show a number the contract
wouldn't honour.
