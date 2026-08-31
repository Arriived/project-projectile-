# Ballista

---

# RESUME HERE

| | |
|---|---|
| repo HEAD **when this was written** | `90813c5`, on branch **`ballista-migration`**, tree clean |
| deployed commit | `38e3e9e` — **not** the same thing, and it should not be. The contract is frozen; everything since is frontend. §7 carries this one. |
| contract | **FROZEN.** `0xEDeed1F05D34421Add0F59b7340588ab2BbaC04b`, verified, 24,033 / 24,576 — 543 free. Re-confirmed on chain: `eth_getCode` returns 24,033 bytes. |
| tests | **255 Hardhat passing + 10 pending** (the pending ones are the `FORK=1` suite), **13 Foundry**, **143 frontend** across seven suites, **11 anon-key RLS checks**. All re-run this session. |
| tests NOT re-run | the **10 fork** checks (need a mainnet fork RPC) and the **14 live Arc-testnet R15** checks (need a funded key). Both passed when last run; neither was re-executed here. |
| indexer | ⚠ **STALLED, NOT AT HEAD.** Checkpoint `59455052`, chain head `59663174` — **208,122 blocks behind, ~27.7 hours.** The process is not running. Migrations 000 + 001 + 002 are applied and the data it holds is correct; it is simply not advancing. |
| database | RLS re-verified with the **anon** key this session: **11/11**. View returns **4 rows**, `trades` **6 rows**, `indexer_state` **401 / 42501**, all four write paths no-ops. Both barriers confirmed live. |
| frontend | **BUILT.** React + Vite + wagmi + viem, in `app/`. List page, token page and `/about` ship; the create flow (Phase 4) does not. See §11. |

**That HEAD is stale the moment anything is committed on top of it.** It records where
this file was last updated, not where you are. `git rev-parse --short HEAD` is ground
truth; if the two differ, commits have landed since and anything below may have moved with
them. This file once carried **three different HEADs at once** — this table said `2d92cfe`,
§7 said `08be890`, and the repo was on `646e2ed`.

## The exact next action

⚠ **The previous version of this section is DONE and has been rewritten.** It said "build
the token page and the token list AS NEW FILES" against the buildless frontend. Both pages
exist, in React, in `app/` — see §11. The salvage instruction it carried was followed: the
correctness engine was lifted, and the JS curve math was **not** (§7C).

**1. Restart the indexer and let it catch up.** It is 208,122 blocks behind and not
running. `cd indexer && node src/index.js` with the env in §8. Nothing else here needs it,
but the list page reads from it, and every hour it stays down is an hour of launches the
product cannot see. **Do NOT reset the checkpoint** — the factory has not changed, so the
checkpoint is valid and resetting it would replay ~88k blocks for nothing. (Reset it only
on a redeploy; that hazard is §RESUME/1 below and it is the opposite of this case.)

**2. Click through buy, sell and create with a real wallet.** Still the only part of the
stack never exercised end to end, and still for the same reason: every browser available
in-session lacks a wallet extension, so the **signature path is unverified**. This is now
`cd app && npm run dev` at `http://localhost:5173`, not `frontend/serve.js`.

What *is* proven underneath it, against `0xEDeed1F0...`: quotes from `quoteBuy`/`quoteSell`,
the gas reserve and limit from real receipts, the blocklist check, custom-error decoding
(viem, natively — no selector map), and the transaction shapes
(`scripts/verify-frontend-txshapes.js`, 9/9). What is **not** proven is that a real wallet
signs and lands them. The chain guard itself took four rounds against a real wallet after
passing against an injected fake every time — that is the standing warning for this step.

**3. Migration 003, approved and not yet written.** The list page derives "recent buys"
from a second query against `trades` because the view cannot serve it, and disables the
24h/7d windows because the data does not exist. Both are honest today and both are
worse than the migration. Columns agreed: `last_buy_block`, `last_buy_at`,
`volume_24h_usdc`, `volume_7d_usdc`, `volume_all_usdc`, `total_supply` (or a computed
`market_cap_usdc`), `symbol_collision_count`. Confirmed absent from the live view this
session by reading its columns with the anon key.

**Phase 4 — the create flow — is explicitly gated on the operator's word.** Do not start it
unprompted. When it is started, R13 is a hard requirement on it: the creation fee must be
approved for an **exact amount**, never `MaxUint256`.

`FRONTEND_BUILD_V2.md` holds the nine rules. They are properties of the contract, not of
the rendering technology, and all nine survived the React rebuild unchanged.

## Three things that fail SILENTLY — read before touching any of them

1. **The indexer checkpoint is per-factory and is NOT reset by a redeploy.** It held
   `53995966` from July against the original factory; left alone the indexer replays
   millions of blocks of a dead contract and indexes nothing real, with no error.
   **Reset `indexer_state.last_processed_block` on every redeploy** — to one BELOW the new
   deploy block, so the deploy block itself is scanned.

2. **`tokens_with_volume` is SECURITY INVOKER, so it returns ZERO ROWS — with no error —
   if the caller lacks SELECT on `tokens` and `trades`.** The frontend shows an empty list
   and nothing looks broken. That is the correct security posture (see the rationale in
   `000_base_schema.sql`; do not revert it to DEFINER), but it must be verified with the
   **anon** key. The service-role key bypasses RLS and cannot detect the failure.

3. **A negative test that checks HTTP status cannot tell "refused" from "matched
   nothing".** PostgREST returns `204` for a DELETE that matched zero rows — exactly what
   RLS produces. A check written that way reported a breach that had not happened.
   **Compare row counts before and after**, read with the service key so RLS cannot hide
   the truth from the check itself. `indexer/scripts/verify-anon-access.js` does it right.

## Pending, small, and worth doing first

~~Apply the `REVOKE` from `000_base_schema.sql` to the live database.~~ **DONE — and it
was already done when this item was written.** Re-measured 29 August against the live
project with the anon key: **all six write paths return `42501 permission denied`**, on
both tables.

| path | before (as this file recorded it) | measured now |
|---|---|---|
| `INSERT` tokens / trades | 401, no grant | `401` `42501` |
| `UPDATE` tokens / trades | **204 — grant HELD** | `401` `42501` |
| `DELETE` tokens / trades | **204 — grant HELD** | `401` `42501` |

Postgres returns the hint `GRANT UPDATE ON public.trades TO anon` on refusal, which is
positive confirmation the privilege is **absent** rather than merely unexercised. Both
barriers are live: no grant, and no permissive RLS policy. `verify-anon-access.js` is
11/11.

✅ **Re-run 30 August 2026: still 11/11.** Reads 4 tokens / 6 trades, `indexer_state` 401,
all four write paths no-ops. Env for it lives in `app/.env.local` (`VITE_`-prefixed) plus
`indexer/.env` for the service key — the script wants unprefixed `SUPABASE_URL` /
`SUPABASE_ANON_KEY`, so export them before running or it exits with a usage message rather
than a failure.

**The status code is the whole signal here, and it is the one this file warns about.** A
`204` means "the grant is held and RLS matched nothing"; a `401`/`42501` means "refused
before RLS was consulted". Both leave the row count unchanged, so the row-count comparison
that `verify-anon-access.js` correctly judges *safety* by cannot distinguish *which
barrier* did the work. That is why the codes above were read out of the response **body**,
not inferred from the status alone — the two questions need two different probes, and the
lesson in §8 is about the first question, not this one.

⚠ **How this item came to be wrong is the reusable part.** The REVOKE was applied to the
live database and the note describing it as pending was written from the *earlier*
measurement, in the same session, and never re-measured. Nothing was broken by it, but a
future session would have spent its first move re-applying a change that was already in
place — and, worse, might have read a green result as evidence its own action worked.
**Re-measure before recording a state, not before deciding to act.**

⚠ **PENDING: re-run `scripts/smoke-r15.js` after 3 September** to confirm the state-based
assertions survive Zero8.

## First run in a fresh clone — do this before anything else

```bash
npm install
git submodule update --init          # forge-std
git config core.hooksPath .githooks  # REQUIRED: see below
npm run build                        # compile + regenerate the indexer ABI

cd app && npm install                # the React frontend is a SEPARATE package (§11)
npm run verify                       # 143 checks across seven suites; all should pass
npm run dev                          # http://localhost:5173
```

**`app/` has its own `package.json` and its own `node_modules`.** The root install does not
reach it, and `npm run verify` at the root does not run the frontend suites. `app/.env.local`
holds `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`; without them the list page falls back
to reading the chain directly and says so, which is correct behaviour rather than a broken
setup (§11.8).

**`git config core.hooksPath .githooks` is not optional.** Without it the pre-commit
mutation guard is silently inert — a fresh clone gets **no error, just no protection**,
and a red-proof mutation can reach a commit unnoticed. Nothing will tell you it is
missing.

## The contract is CLOSED

No contract work remains and none should be started without a reason written down first.
The re-freeze is done, R15 is executed, the mechanics are restored (§7A), and the inventory
is generated rather than hand-maintained. Nothing on the contract roadmap is outstanding.

**The fork is gated behind `FORK=1` and pinned to block 25,846,000.** Ordinary test runs
are local and unforked. Do not re-pin without re-running the presence checks — see §4.

---

A memecoin launchpad native to Arc (Circle's stablecoin L1, USDC as native gas).
Bonding-curve launches that graduate to a DEX pool.

**Positioning:** trust and verifiability are the moat, not feature count. Twelve
competitors are launching on Arc and several have already damaged their reputations. Ours
is the one with a deployed, verified, adversarially-tested contract anyone can read.

**Arc mainnet: 16 September 2026.** Confirmed, external, immovable. Launch-ready target
~9 September; that week is buffer, not spare capacity.

---

## HOW TO READ THIS FILE

**`CONTRACT_INVENTORY.md` is the exhaustive WHAT; this file is the WHY.** That split
exists because it failed once: a five-minute symbol lock lived in `LFX1.sol` and appeared
nowhere here, because a 437-line rewrite of a hand-maintained document dropped three whole
sections and nothing could have noticed. The inventory is **generated from the ABI and the
source** by `npm run inventory` (wired into `npm run build`) and ends with a coverage list
of every exposed identifier this file never mentions. **After any contract change, read
that list.** Do not hand-maintain a feature list here; describe reasoning here and let the
inventory enumerate.

**It is a starting point to verify, not ground truth.** It is written by the same
assistant that writes the code. Before relying on any number, address or claim here,
check it against the repo — `contracts/LFX1.sol` for constants, `git log` for
deployments, an actual test run for counts. Doing exactly that has caught real drift more
than once. **Where this file and the source disagree, the source is right and this file is
the bug.**

**Repo lives at `C:` + `\dev` + `\arc-launch`** (written split because a literal
backslash-a has been mangled by tooling twice). Pushed to a private GitHub remote. It was
moved off OneDrive after OneDrive corrupted 29 of 54 mutation results into phantom compile
failures and failed a git ref write in a single session. **Do not move it back.**

---

# 1. MUST NOT BE CHANGED WITHOUT RE-DERIVING WHY

Everything here was paid for with a real finding. Each looks like it could be simplified.
None of them can.

## 1.1 Strict mins on `addLiquidity` — `(amountADesired, amountBDesired)`

`_performGraduation` passes the **desired amounts themselves** as `amountAMin` and
`amountBMin`. They used to be literal zeros.

**The attack that motivated it, executed not theorised.** Tokens circulate freely during
the curve phase, so anyone can buy a little, create the USDC/TOKEN pair, and seed it with
dust at a ratio of their choosing. V2's `_addLiquidity` then deposits at **the pair's
ratio, not ours**, and with zero mins every `require` in that path passes unconditionally.
Measured against a real graduation (193,297,304 tokens / 8,019 USDC intended):

| attacker seeds ~$1 | we deposited | stranded, unrecoverable |
|---|---|---|
| 1 token + 1 USDC (token looks expensive) | 8,019 tokens — **0.004%** | **193,289,285 tokens** |
| 1,000,000 tokens + 1 USDC (token looks cheap) | **193.30 USDC** of 8,019 | **97.6% of proceeds** |

Both **graduated successfully**. No revert, no event, no signal. The remainder is
permanently unrecoverable because graduation zeroes `tokenReserves` and `realUsdcReserves`
first, and the factory can only move USDC and launched tokens against *accounted*
balances.

**There is deliberately NO tolerance constant.** When no pair exists, V2 takes the
`reserveA == 0 && reserveB == 0` branch and returns the desired amounts — **the requires
are never evaluated** — so strict mins are free in the normal case. `quote()`'s floor
rounding only bites if a pair already exists at *precisely* our closing ratio, which has
no legitimate reason to occur. A tolerance would be a parameter to get wrong; its absence
removes one.

**It cost −1 byte.** Passing existing stack variables is smaller than pushing two zero
constants. The tightest possible setting is also the cheapest.

**Anyone who "fixes" this by loosening mins reopens the vulnerability.** At 1% on an
8,000 USDC graduation, roughly $80 per graduation becomes extractable by a proportional
version of the same attack.

Behaviour now: an adversarial pair parks the curve at `GRADUATION_READY` with reserves
**intact and retryable**. Correcting the pair ratio lets the same curve graduate — proven.
That correction is a race in the open, which is what the (unbuilt) helper contract closes.

## 1.2 The 807M : 193M curve/LP split is LOAD-BEARING for the flash-loan bound

Not just curve economics. Measured against the real contract, snipe tax zero (attacker's
best case):

```
buy out the entire curve       8,111.97 USDC spent, 807,000,000 tokens acquired
pool seeded at graduation      193,000,000 tokens / 8,030.85 USDC
dump ALL tokens (V2 0.3% fee)  6,477.14 USDC returned
NET                           -1,634.84 USDC
```

The attacker acquires **4.18x more supply than the pool is seeded with**. The bound is
**structural, not parametric**: the pool cannot return more than the 8,030.85 it holds,
already less than the 8,111.97 spent — so even a zero-slippage, zero-fee dump loses money.
Holding cheaper tokens bought earlier does not rescue it; that is additional supply into
the same bounded pool.

**Narrowing the ratio erodes this margin. Re-derive before touching either constant.**

## 1.3 Never re-derive the curve math

Use `_quoteBuy` / `_quoteSell`. External LLMs have re-derived it incorrectly more than
once. `test/CurveDifferential.test.js` holds a reference **transcribed from the contract's
own formulas**, not from anything in this file — a regression and arithmetic oracle that
explicitly cannot catch a conceptual error in the curve design, because it shares that
source.

### It happened, in the frontend, and it was far worse than this file said

`terminal.html` carried `calculateBuyOutput` / `calculateSellOutput` / `ceilDiv` — the
curve re-derived in JavaScript. The function took `buyFeeBps` and **had no snipe-tax
parameter at all**, while `buy()` charges `c.buyFeeBps + taxBps`.

Measured against the live deployment, not estimated
(`scripts/verify-frontend-pricing.js` launches a token and compares per second):

| elapsed | snipe tax | JS error |
|---|---|---|
| t=0 | 9800 bps | **98.96x** |
| t=1 | 9500 | 11.00x |
| t=2 | 9000 | 5.21x |
| t=3 | 8000 | 2.54x |
| t=4 | 6000 | 1.68x |
| t=5+ | ≤ 4000 | 1.00x |

**This file previously said 8.7x, and in the wrong direction.** The real figure is an order
of magnitude larger, and the sign is inverted: the JS math **OVERSTATES** what the buyer
receives, it does not understate. The 8.7x number was about a *stale quote* — taken early,
executed later, as the tax decays — which is favourable to the buyer and harmless. This is
a different bug that happens to live in the same place, and conflating them hid it.

**Overstating is the direction that breaks trading.** `minTokensOut` is derived from the
quote, so a 98.96x overstatement puts the slippage floor ~97x above anything achievable and
**every buy in the first seconds reverts**. Not a display defect — a dead buy path during
exactly the window the snipe tax exists to govern.

The rule is therefore not "prefer the contract's math". It is: **the contract has
`quoteBuy` and `quoteSell` as view functions; call them.** They apply the live tax, the
partial-fill clamp and current reserves, and cannot drift, because they are the contract.

### `currentPrice()` is UNUSABLE for price impact — use a probe quote

The obvious function is a trap. `currentPrice()` returns
`virtualUsdcReserves * 1e18 / virtualTokenReserves`, which **at launch scale evaluates to
the integer `2`**. Any impact computed from it rounds to `0.00%`, so the headline number
the frontend is required to show would silently read zero on a curve where a $500 buy moves
the price ~20%. Measured, not reasoned about.

**The sanctioned method** is to compare the rate the trade actually gets against the rate a
negligible trade gets, both from `quoteBuy`, in **tokens-per-USDC** where the magnitudes are
large enough to keep precision:

```
probe     = quoteBuy(token, 0.01 USDC)
marginal  = probe.tokensOut * 1e6 / probe.actualUsdcIn
effective = quoted.tokensOut * 1e6 / quoted.actualUsdcIn
impact    = (marginal - effective) / marginal
```

Validated against an independent figure: 500 USDC returns 168.3M tokens = **20.9% of curve
supply**, matching the ~21% recorded in §8. Implemented as `buyImpactPct` in
`frontend/terminal.html`.

## 1.4 Dual graduation trigger and the one-way state machine

```
realUsdcReserves >= threshold   OR   tokenReserves == 0
ACTIVE -> GRADUATION_READY -> GRADUATED     (one-way)
```

Without the depletion arm, any rounding that puts the ceiling below the threshold strands
**every** token permanently. `graduate()` is permissionless and retryable, so our own
backend being down never blocks a token reaching the DEX.

**Both `buy` and `sell` are closed at `GRADUATION_READY`** — first check in each,
`c.state == ACTIVE`. We are stricter than Pons, who close only the sell side. Reserves
freeze the instant the trigger fires, so nobody can sell into the reserves the pool is
about to be seeded from. The cost: holders genuinely cannot exit a curve stranded at
`GRADUATION_READY`. That is the deliberate trade.

## 1.5 Router timelock is not disableable

`proposeRouter` -> 24h -> `activateRouter`. `revokeRouter` is **immediate** and clears
`router` itself. Granting trust is slow and visible; removing it is instant. A router
passed at construction is live from block zero — that bypass happens once, is visible in
the constructor args, and is what makes mainnet launch day possible at all.

**`revokeRouter()` is the lever for a malicious router, NOT `pause()`.** `graduate()` is
`nonReentrant` only, deliberately: a pausable `graduate()` would be a censorship lever
over tokens reaching the DEX while we custody their USDC, and it merely postpones handing
the pot to a router that is still approved. `graduate()` requires `router != address(0)`,
so revocation is a hard stop.

**Monitoring `RouterProposed` is a launch requirement.** Unwatched, the 24h timelock is 24
hours of decoration.

**Router approval is SINGLE-USE, and that is load-bearing (R12, fixed).** `activateRouter`
consumes `routerProposedAt` and the constructor banks nothing, so **every** route to a live
router passes through a fresh `RouterProposed` and a full 24h wait. There is no path to
`activateRouter` that skips one.

This was not true until it was fixed, and the earlier version of this section was wrong in a
way worth keeping visible: approval used to be permanent, so any address that had ever
matured stayed one transaction from live for the life of the contract, and the
re-activation emitted **only `RouterActivated`**. A compromised owner key could therefore
skip the timelock entirely by re-using a previously-approved address, and a monitor
watching `RouterProposed` — exactly what this section told you to watch — would see
nothing at all. Watching proposals is sufficient again **because** approval is now
single-use; the two facts are not independent, and neither should be changed without the
other.

## 1.6 Variant B's balance-delta check is exact despite Arc's truncating `balanceOf`

`_settleBuy` measures the actual balance delta around the USDC pull and reverts on any
shortfall. Arc's ERC-20 view **truncates** an 18-decimal native balance to 6 decimals, so
this looks unsafe. **It is exact, and here is the proof, not just the conclusion:**

```
floor((N + A·10^12)/10^12) = floor(N/10^12) + A     for any dust N
```

because the amount added is always a whole number of 6-decimal units. The delta is exact
whatever sub-6dp dust the contract carries.

Both reads sit inside `ReentrancyGuard`'s `nonReentrant`, held by `buy()` and
`creatorLaunchBuy()` — the only two callers of `_settleBuy`. A delta across a shared
pooled balance is meaningless if anything else can move USDC between the reads.

**What it does and does not do:** it does **not** keep the launchpad working under a
fee-on-transfer token — trading halts either way. It converts a silent, unbounded,
socialised loss into a loud revert. Measured without it against a 1bp mock: 30 buys of
20 USDC left the contract owing 600.5 and holding 600.43995.

**Known residual, priced and declined:** `createToken` still credits `treasuryFeesAccrued`
from the requested creation fee without measuring. +339 bytes to close, protecting a 1bp
rounding error in a scenario where buys already revert.

## 1.7 All fees accrue and are claimed — creator AND treasury

Nothing is pushed to a payee inside a trade. A payee that reverts must never break
trading. The treasury came under this rule after it was found that every buy, sell **and
`createToken`** pushed to it inline, so a blocklisted treasury bricked the launchpad.

**`claimTreasuryFees()` is deliberately permissionless.** It can only move protocol funds
to `treasury`, so there is nothing to gain and nothing to grief. Sweeping does **not**
become a 2-of-3 Safe transaction under any future multisig.

**The solvency identity is `balance >= reserves + creatorFees + treasuryFees`.** Any check
omitting treasury fees reads the accrual as surplus and stays green while a real shortfall
exists — this has already happened once in a test.

## 1.8 `lpRecipient` is snapshotted per curve, never read live

Defaults to `BURN_ADDRESS`, rejects `address(0)` and `address(this)`, owner-settable with
an indexed event, pinned by the economics hash. Read live at graduation, an owner could
let tokens launch advertising burned LP and then redirect every pending graduation — the
same magnitude of lever as swapping the router. Snapshotting removes it for anything
already launched rather than delaying it. Cost: +426 vs +278 for the global version; the
extra 148 buys the trust property.

**Consequence:** tokens launched before a flip keep burning. A locker only ever receives
from tokens launched after it.

**"LP Auto-Burned" becomes "LP Permanently Locked" the moment this points anywhere else,
and the two claims are not interchangeable.** A burn address needs zero trust. Do not
market the burn claim after a flip.

**HARD PRECONDITION — the pre-flip gate.** `setLpRecipient` is never called with a
non-burn address until the recipient is deployed, verified, and proven on a fork. The
snapshot is immutable: no owner override, no rescue path, so a wrong recipient cannot be
corrected for anything already launched. The `BURN_ADDRESS` default is safe under both V2
and V4, so this blocks no freeze.

## 1.9 `contracts/` keeps the neutral `LFX1` naming — do not "finish" the rename

Everything outside `contracts/` says Ballista. Everything inside keeps `LFX1` /
`LFX1Token`, **filenames included**, and so do the `getContractFactory('LFX1')` strings.
Blockscout publishes the **source path**, not just the contract name — renaming the files
would publish the brand to every competitor scanning ArcScan, and renaming only the
contract achieves nothing for the same reason. The switch happens at mainnet, on
instruction.

## 1.10 Cross-curve conservation is EXACT, not `>=`

`invariant_pooledUsdcExactlyBacksAllAccounting` asserts the factory's USDC **equals** every
curve's `realUsdcReserves` + `poolBoost`, plus every creator accrual, plus
`treasuryFeesAccrued`. Measured, with the treasury accrual in `_settleBuy` dropped:

| check | result |
|---|---|
| all five pre-existing invariants | **green** |
| exact conservation | **red** -- `13947770 != 13935322` |

**Unaccounted funds read as SURPLUS to a `>=` check.** Every aggregate solvency check in
the repo stays green while the factory holds money it cannot attribute to anyone. That is
1.7's warning in the direction it does not spell out: *omitting* a fee term from a check is
caught trivially, because the check then fails against correct code. *Under-accounting
inside the contract* is invisible unless the check is exact.

**Relaxing it back to `>=` reopens precisely that.** The `>=` form is kept deliberately in
`MultiCurveInvariant`; the two are not redundant, they fail on different bugs.

Its sibling `invariant_aTradeOnOneCurveDoesNotMoveAnother` covers what no aggregate can. A
zero-sum steal between curves leaves the sum identical: proven with the steal live, all
five pre-existing invariants AND the exact conservation check stayed green, and only the
isolation check fired.

---

---

# 2. ARC-SPECIFIC FACTS

**The docs path is `/arc/references/evm-differences`. `/arc/evm-differences` 404s.**
Verify Arc/Circle claims against `docs.arc.io` and `developers.circle.com`, never memory.

| fact | status |
|---|---|
| `PREVRANDAO` always returns `0` | Confirmed. We use no randomness anywhere. |
| EIP-6780 self-destruct plus native-value constraints | Confirmed. **A non-zero-value call to a self-destructed account REVERTS on Arc; it succeeds on Ethereum.** Self-destruct to self, to the zero address, with a blocklisted party, or to an already-self-destructed beneficiary all revert. |
| USDC blocklist enforced at runtime on **both** parties | Confirmed. `isBlacklisted(address)`, `blacklister()` and `paused()` all verified present on the live token at `0x3600...0000`. Reverts consume gas. |
| EIP-7708 native transfer logs | Confirmed. Every native USDC movement emits a `Transfer`. **Discriminator: the system emitter is 18 decimals from a system address; the ERC-20 contract's own `Transfer` is 6 decimals.** Our indexer filters on the factory address only, so it is unaffected. |
| Truncating `balanceOf` | Confirmed. "The ERC-20 view truncates, so it is not exact." `balanceOf(a) == 0` does not imply a zero native balance. See 1.6. |
| USDC is both gas and settlement asset | Confirmed. 18dp native view, 6dp ERC-20 view, **one balance**. Any balance-delta probe on Arc must subtract gas — a naive self-transfer probe reported an 897-wei "fee" that was purely gas. |
| Block timestamps non-decreasing, not strictly increasing | Confirmed. Hence `allowBlocksWithSameTimestamp: true`. Sub-second blocks share a timestamp; use block number for ordering. |
| Base fee paid to the beneficiary, not burned | Confirmed. |
| Blob txs rejected; `BLOBHASH` 0; `BLOBBASEFEE` 1; EIP-4788 empty | Confirmed. We touch none of them. |
| **Mainnet chainId 5042** | **UNSOURCED — MUST VERIFY.** From an unreliable secondary source. Circle documents **only testnet 5042002**. Do not put 5042 in the frontend, deploy config or anywhere else until confirmed. |

## Zero8 — Arc Testnet, 3 September 2026, 15:00 UTC

`BREAKING_CHANGES.md` confirms **no consensus-affecting behaviour changes**: it is
node-operator config and CLI. The contract is unaffected and R15 stands.

**One thing reaches us, and only as a string.** The reth 2.2 / revm 38 upgrade changes the
insufficient-balance error text — `insufficient funds for gas * price + value` becomes
revm 38's `OutOfFunds` variant.

~~**Audited: NOTHING in the suite asserts on RPC error text.**~~ **THAT AUDIT WAS WRONG,
and the thing it dismissed is exactly what later broke production — corrected 31 August
2026.**

The audit looked at `test/` and `scripts/` and concluded the count of places matching on
RPC error text was **zero**, so "no pattern note is warranted for message-matching". It was
not zero, and it missed the two that mattered:

1. **`indexer/src/index.js`, `withRetry`.** It classified rate limits as
   `err.code === -32011`. Arc actually returns **`-32005`**. It worked only because the
   regex `/rate limit/i` happened to match the *message*. Our own retry logic was
   depending on error text.
2. **ethers, underneath us, and this is the one that cost 29 hours.**
   `subscriber-filterid.js` has a downgrade-to-polling path for a backend without filters.
   It is gated on `UNSUPPORTED_OPERATION`, and `provider-jsonrpc.js` decides that by
   `message.match(/the method .* does not exist/i)`. Arc says `"internal error"`, so
   ethers classified it `UNKNOWN_ERROR`, never downgraded, and retried `eth_newFilter`
   forever. **Had Arc returned `-32601 method not found`, the fallback would have fired
   and nothing would have happened.**

**The standing rule was right and the audit was wrong.** The lesson is not "re-run the
audit more carefully" — it is that the audit's *scope* was wrong. It searched our source
for string comparisons. The dependency doing the message-matching was `node_modules`, and
the fragile string was one **we do not control and did not write**. See §11.11.

**A real weakness sat underneath it, and that was worth fixing.** The two R15 failure cases
passed on `catch (e) { check(..., true) }` — pass on ANY throw. Zero8 would not have broken
them; they would have kept passing **for the wrong reason**, which is test-shape error 3 in
§5. Both now assert STATE: no tokens received for the unaffordable buy, position still held
for the unaffordable sell, plus a predictive `balance < gasLimit * gasPrice` check made
BEFORE submitting. 14/14 against the live deployment.

⚠ **PENDING: re-run `scripts/smoke-r15.js` against testnet after 3 September.** Today is
29 August, so this has NOT been done. The suite passes pre-Zero8; the point of re-running is
to confirm the state-based assertions survive the upgrade, which is exactly what they were
rewritten for.

## What the token at `0x3600...0000` actually is

Probed, not assumed (`scripts/probe-arc-usdc.js`). **1,798 bytes of code** — a real
contract, not a bare precompile — presenting the full FiatToken admin surface: `paused()`,
`blacklister()`, `masterMinter()`, `owner()`, `pauser()`, `rescuer()`, `isBlacklisted()`,
`version() = 2`, `currency() = USD`, `DOMAIN_SEPARATOR()`. It is not a mock.

**It is NOT the Ethereum-mainnet USDC contract, and the difference is the whole of R15.**
Mainnet USDC has no native-balance duality; this token's ERC-20 view is a 6dp truncation of
an 18dp native balance, and both are the same money. Confirmed live: native
`108304838726808615422`, ERC-20 `108304838`, `native / 1e12` equal to the ERC-20 view
exactly, with 726,808,615,422 wei of sub-6dp dust being carried.

**What cannot be checked:** whether Arc *testnet* USDC is identical to Arc *mainnet* USDC.
Mainnet does not exist yet. The right claim is "the same KIND of token — native-backed and
truncating", not "the same token". Anything depending on exact parity has to be re-checked
at mainnet.

Circle holds the admin keys, so R1 and R2 stay out of reach here: `blacklister` is
`0x9338f53291715F1126291E28BBd3B9989e966572` and `pauser` is
`0xbc639a0A060E5831a7c437b491B8d3C1f58F554e`, neither of them ours.

**Arc states plainly that local EVM simulators "run a standard EVM, not Arc's."** Blocklist
enforcement, EIP-7708 and truncating `balanceOf` surface only on Arc RPC.

---

# 3. RESIDUAL RISK REGISTER

Kept deliberately non-empty. A register that closes everything is the same failure as a
test that cannot go red. Each entry: **structure** (closed by construction), **parameter**
(closed only by a value), or **open**.

| # | risk | class | notes |
|---|---|---|---|
| R1 | **Circle pauses USDC** → every buy, sell, claim and graduation reverts | **OPEN — permanent, unmitigable** | `paused()` verified live. USDC is both quote asset and gas, so there is no fallback path. Not a bug to fix — a dependency to disclose. Belongs in public risk copy, not only here. |
| R2 | Blocklisted **user-side** party (buyer, seller, creator) | **OPEN — untestable on testnet** | See §4. Covered locally by `MockBlocklistUSDC` only. |
| R3 | Creator-allocation denial: anyone graduating the curve inside the creator window takes the creator's entire 2.5% | **parameter** | Only the snipe tax makes it uneconomic. Soften the table and it gets cheap. |
| R4 | `MAX_TOTAL_FEE_BPS = 9900`, **zero headroom** — table t=0 (9800) + base fee (100) = exactly 9900 | **parameter** | The clamp's fee inversion divides by `(BPS_DENOMINATOR − buyFeeBps)`; a 100% total fee is a division-by-zero **panic**, not a revert. Raising the base fee at all requires publishing a lower t=0 table first. |
| R5 | `_performGraduation` writes `c.state` after the external call | **structure — by guard placement, not ordering** | Reachable only from `buy`/`creatorLaunchBuy` (via `_settleBuy`) and `graduate()`, all `nonReentrant`. The only state-changing external function that is neither guarded nor owner-only is `updateMetadataURI` (creator-gated, writes a string). **Add one unguarded state-changing function and this becomes live.** |
| R6 | Post-fix griefing race: an attacker re-skews the pair between correction and `graduate()` | **OPEN** | Costs them dust each time. Closed by the helper contract (unbuilt) bundling correct+graduate atomically. Severity depends on whether Arc has a public mempool — **unanswered**. |
| R7 | Curve stranded at `GRADUATION_READY` — both sides closed, holders frozen | **structure, accepted** | Recoverable via `graduate()` once a live router and sane pair exist. The 24h router timelock bounds worst-case exposure. |
| R8 | Owner is a **single EOA** | **OPEN — deliberate** | Deprioritised by the operator. Do not re-raise. |
| R9 | Fee-on-transfer creation fee over-credits `treasuryFeesAccrued` | **OPEN — priced and declined** | +339 bytes to close, in a scenario where buys already revert. |
| R10 | `SELFDESTRUCT` beneficiary push can put sub-6dp native dust in the factory | **OPEN — trivial** | Permanently stranded (no native-send path out). Does **not** corrupt the delta check — see 1.6. |
| R11 | `license_type: none` on the explorer | **CLOSED — `none` is the correct value** | Settled: the project is UNLICENSED, and `none` is the only entry on Blockscout's fixed list consistent with that. Nothing to change and nothing pending. **Do not "fix" this to `unlicense`** — see §8. |
| R12 | Router approval was **permanent, not single-use** — a compromised owner key could skip the 24h timelock by re-activating any previously-approved address, emitting only `RouterActivated` | **CLOSED — structure** | Fixed in two halves, both required and both red-proved (`regress-router-single-use`, `regress-router-bootstrap`). `activateRouter` now consumes `routerProposedAt`; the constructor no longer banks one for the bootstrap router. Clearing on activation alone was **not** enough — the constructor seeds the mapping without routing through `activateRouter`, so the bootstrap router stayed permanently approved under that partial fix. **+12 bytes** (24,018 → 24,030). Every route to a live router now passes a fresh `RouterProposed` and a full wait. |
| R13 | **`creationFeeUsdc` is absent from `currentEconomicsHash()`** — the one fee the creator pays directly is the one pinning does not cover | **OPEN** | Owner can raise it between the creator seeing terms and their transaction landing; the pinned hash is unchanged so the guard cannot fire. Proven: creator pinned the old terms and paid a 1000x fee. **Exposure is bounded by the creator's approval** — an exact-amount approval is safe, `MaxUint256` is not. The frontend must not approve max for the creation fee. |
| R14 | USDC or launched tokens sent directly to the factory are **permanently stranded** | **OPEN — unrecoverable** | Every payout path is bounded by accounting, never by balance, so nothing can pay a donation out. Also means §1.10's exact conservation is a **closed-system** property: a donation breaks the equality on-chain, though nothing in the handler performs one. Do not read it as "the factory can never hold unaccounted USDC". |
| R15 | The one-balance configuration: gas and settlement are the SAME balance | **LARGELY CLOSED — executed on Arc testnet, 13/13** | `scripts/smoke-r15.js`, run against the live deployment. What it proved, on chain rather than arithmetically: a wallet that can afford a trade cannot afford the trade PLUS its gas; a holder left with 0.0016 USDC holds 471 trillion tokens and **cannot afford to sell them**; §1.6's truncation lemma holds on the real token with genuine sub-6dp dust present (726,808,615,422 wei); and `_settleBuy`'s balance-delta check measures **exactly** `actualUsdcIn` against real Arc USDC, in both the 6dp and 18dp views. **Residual:** the delta check ran against a factory carrying NO dust — the factory has no `receive()`, so only a SELFDESTRUCT push (R10) can give it any, and the dusty-factory case is still arithmetic-only. Circle-side controls stay unreachable (R1 pause, R2 user-side blocklist), and Arc mainnet USDC does not exist yet, so testnet-equals-mainnet is unverifiable rather than verified. |
| R17 | `renounceOwnership()` was inherited from `Ownable` and live — one transaction would have permanently frozen every setter, including `revokeRouter()`, the only hard stop against a malicious router | **CLOSED for the labelled path — the CLASS remains open** | Overridden to revert, **+3 bytes** (24,030 → 24,033), no gas impact on any hot path. Six tests, red-proved via `redproof.py r17-unblock-renounce`. Confirmed reverting on the live deployment. **DO NOT READ THIS AS "the owner cannot brick the contract."** R17 closes the labelled path, not the class: `transferOwnership` to a dead or mistyped address is the same permanent freeze one step removed, and is **not** protected — `Ownable` rejects only `address(0)`, so any other address is accepted. Two of the six tests exist solely to pin that residual, showing `revokeRouter` and `pause` both reverting `OwnableUnauthorizedAccount` afterwards. The unlabelled path is also the more likely mistake: `renounceOwnership()` at least announces itself, while a wrong address in a routine transfer looks like an ordinary transaction and produces an identical outcome — and it is the path the multisig migration will actually use. |
| R16 | `setTreasury` emits no event | **OPEN — trivial** | Every other setter emits one. An owner redirecting the treasury is invisible to indexers and to monitoring. |

---

## Actor/phase pass — the four questions answered

⚠ §7 called these "the five specific questions" but lists **four**. Answered as listed;
if a fifth was intended it was lost before this file was written.

**1. Owner-key blast radius, severity order.**

1. **`activateRouter` to a hostile router.** Takes the whole LP allocation plus all
   accumulated USDC of every graduating token. **Now genuinely gated by 24h** — R12 is
   closed, approval is single-use, and there is no path to a live router that does not emit
   a fresh `RouterProposed` first. Still the top of the list, because the ceiling on the
   loss is unchanged; what changed is that the key alone no longer buys immediacy. The
   defence is now a 24h window someone has to actually be watching, which is a monitoring
   commitment rather than a code property — see §1.5.

   *Before the fix this entry read "nominally gated by 24h", which understated it: a
   compromised key skipped the timelock outright by re-using a previously-approved
   address, and the monitor this file told you to run would not have fired.*
2. **`setLpRecipient`.** No timelock at all. Bounded to launches *after* the change by the
   per-curve snapshot (§1.8), which is exactly what that snapshot buys, but it is instant
   and it silently invalidates the "LP Auto-Burned" claim for everything launched after.
3. **`setTreasury`.** Redirects all accrued protocol fees, and emits **no event** (R16).
   Bounded to protocol revenue, not user funds.
4. **`setCreationFee`.** Unbounded and unhashed (R13). Bounded in practice only by what
   creators have approved.
5. **`setDefaultFees` / `setDefaultCreatorFees` / `publishSnipeTaxTable` /
   `setDefaultGraduationThreshold`.** All snapshotted per curve and covered by the
   economics hash, so they reach new launches only and a pinned creator is protected.
6. **`pause()`.** Halts create/buy/sell. Cannot stop `graduate()` — deliberate (§1.5). No
   fund loss.
7. **`transferOwnership`.** Plain `Ownable`: immediate, irreversible (R8).

**2. The 24h timelock window's realistic exposure.**

The full 24h, on every activation, now that R12 is closed. The window used to apply only
to an address's **first** maturation — after that the approval stood for the life of the
contract, so the set of instantly-activatable routers only ever grew and a compromised key
could reach a live hostile router in one transaction. Both halves are fixed, so the
exposure is the documented one and nothing else: **24 hours during which a `RouterProposed`
event is public and someone has to notice it.**

That is a monitoring commitment, not a code guarantee. Unwatched it is still 24 hours of
decoration. `revokeRouter` remains immediate and is still the right lever on suspicion —
and revoking on *rotation* is still worth doing, not because approval lingers any more, but
because a revoked router cannot be activated even by an owner who later re-proposes it
without waiting.

**3. Donation and direct-transfer paths.**

Both directions land in R14: stranded, unrecoverable, harmless to accounting. Graduation
computes `tokenLiquidity` from `LP_TOKEN_RESERVE + c.tokenReserves`, never from
`balanceOf`, so donated tokens cannot inflate a pool or shift a ratio — proven. Donated
USDC likewise cannot be withdrawn by anyone, including the owner. The only real consequence
is on the *test* side: §1.10's exact equality holds for the closed system the handler
drives, and would not hold on a chain where anyone can transfer in.

There is no `receive()` or `fallback()`, so a plain native send reverts; the SELFDESTRUCT
push remains the one bypass (R10).

**4. Can a token be launched that can never graduate? No.**

The depletion arm (`tokenReserves == 0`) is reachable regardless of what the threshold was
snapshotted at, because buying out the curve costs a bounded ~$8.1k no matter how the
threshold is set. So even an absurd `setDefaultGraduationThreshold` cannot strand a token
permanently — it only removes the threshold arm. `createToken` also refuses while
`router == address(0)`, so nothing can be launched into a routerless state.

The failure modes that do exist are all **recoverable, not permanent**: an adversarial pair
parks the curve at `GRADUATION_READY` with reserves intact until the ratio is corrected
(§1.1, R6/R7); a revoked router blocks `graduate()` until one is live; USDC being paused
halts everything (R1). Each of those is a stall with a key, not a lock without one.

Two supporting facts checked rather than assumed: the graduation approval can never exceed
the factory's token balance, because `LP_TOKEN_RESERVE + tokenReserves` and the held balance
are the same quantity by construction; and threshold `0` does not divide by zero in
`graduationProgressBps`, because the `>=` early-return fires first.

---

# 4. TEST SURFACES ARE NOT INTERCHANGEABLE

**Do not read a mutation score as chain-level assurance.**

**Forge and Hardhat must compile the same bytecode, and that takes TWO pins.**
`foundry.toml` pins `optimizer` / `optimizer_runs` **and** `solc_version = "0.8.24"`.
Without the version pin forge resolves the `^0.8.24` pragma to whatever is newest (0.8.35
at the time of writing) while `hardhat.config.js` pins 0.8.24 — so the invariants fuzz
bytecode no deployment will ever have, and nothing says so. Same class of drift as the
optimizer settings above, one field over, and it survived longer.

| surface | covers | does NOT cover |
|---|---|---|
| **Hardhat local** | all contract logic; the mutation gate | anything Arc-specific — it is a standard EVM |
| **Pinned Ethereum fork** (block 25,846,000) | real Uniswap V2 router behaviour | **nothing about Arc** |
| **Arc testnet smoke** | blocklist enforcement, EIP-7708, truncating `balanceOf`, real block timing | only what we can actually trigger — see below |

**Why block 25,846,000 specifically:** the canonical **V2 factory**
`0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f`, **router02**
`0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D` and **USDC**
`0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48` were all verified present **at that height**.
Re-pinning to a newer block silently loses the validation the pin was chosen for — re-run
the presence checks if you change it. Pinned rather than `latest` so runs are reproducible
and Hardhat can cache state. Enabled by `FORK=1`; ordinary runs stay local.

## What the blocklist substitution actually reaches — narrower than it looks

We cannot ask Circle to blocklist an address. Real runtime reverts on the real token (zero
address, precompile addresses, self-destructed accounts) are a genuine stand-in — **but
they are destination properties, and a blocklist rejects a party, on either side.**

| USDC movement | counterparties | substitution reaches it? |
|---|---|---|
| `createToken` fee-in | creator (sender) → factory | **No** — sender-side |
| `_settleBuy` buy-in | buyer (sender) → factory | **No** — sender-side |
| `sell` payout | factory → seller (`msg.sender`) | **No** — a caller cannot be a precompile |
| `claimCreatorFees` | factory → creator (`msg.sender`) | **No** — same |
| `claimTreasuryFees` | factory → `treasury` | **Yes** — owner-settable; `setTreasury` rejects only `address(0)` |
| graduation | factory → router / `lpRecipient` | **Yes** — owner-settable |

**Answering directly:**
- **A blocklisted buyer whose inbound `transferFrom` fails — NOT REACHED.** Sender-side.
- **The factory itself blocklisted — NOT REACHED.** We cannot blocklist it, and it would break every path in both directions.
- **A blocklisted party where we are the recipient — NOT REACHED.** Sender-side again.

**Testnet blocklist coverage extends only to owner-chosen destinations.** Everything
user-side is R2: untestable, not covered. Do not let "simulated on testnet" read as
"closed".

## Mock-only sweep — what each stub does NOT reach

Every component whose only coverage is a stub, and the gap in each. `MockV2Router`'s own
header is the model: a stub that states its limits stays usable evidence; one that does not
gets read as the real thing.

### The V2 router — the largest gap, and it is NOT blocked

**Every graduation test in the repo runs against a mock.** `MockRouter` returns exactly the
amounts it was offered; `MockV2Router` transcribes `_addLiquidity`'s optimal-amount
branching. Neither is Uniswap. Not reached by either:

- **Token ordering.** V2 sorts `(tokenA, tokenB)` internally. `MockV2Router` keys its
  pretend reserves by *the order the caller passes them*, so a sorting bug is invisible to
  it — and roughly half of all launched tokens sort below USDC.
- Real pair contract, LP token minting, the k-invariant, the protocol fee-on mint.
- `quote()`'s rounding at real reserve magnitudes.
- Whether `assert(amountAOptimal <= amountADesired)` can trip against real reserves.
- `TransferHelper` semantics and deadline handling.

**§1.1's attack was executed against a transcription, not against Uniswap.** That is strong
evidence; it is not the same claim, and the section should not be read as if it were.

**The fork suite now exists** — `test/Fork.v2.test.js`, gated behind `FORK=1`, run with
`FORK=1 npx hardhat test test/Fork.v2.test.js`. It proves the three things no mock can, each
red-proved through `scripts/redproof.py`:

| proves | red-proof | mutation |
|---|---|---|
| Real token ordering, **both ways**, against real V2 sorting | test 1 goes red | `swap-graduation-args` |
| A **real LP token** minted, all of it at `0xdEaD`, none held by the factory | test 2 goes red | `lp-elsewhere` |
| **§1.1's attack against real Uniswap**, not a transcription | test 3 goes red | `zero-mins` |

`zero-mins` is the one that matters: it puts the literal zeros back as `amountAMin` /
`amountBMin`, and the skewed-pair attack then **succeeds against the real router**. §1.1's
claim is no longer "mock-verified against transcribed V2 logic" — it is fork-executed.

Ordering is not chosen by the test: token addresses come from `CREATE(factory, nonce)`, so
the suite launches until it holds one sorting below real USDC and one above, which is also
the point — roughly half of real launches land each way.

Measured on the fork: the token side of the pool is `LP_TOKEN_RESERVE + leftover curve
tokens` = **193,297,304e18**, matching §1.1's own figure, and asserted against the amounts
the `Graduated` event reports the router actually took rather than against the constant.

### USDC — now the largest remaining gap

`MockUSDC` is a plain 6dp ERC-20; `MockBlocklistUSDC` and `MockFeeOnTransferUSDC` cover the
blocklist and short-transfer paths. Not reached:

- **USDC as the gas token.** Every local test pays gas in ETH, so no test has ever executed
  a path where the settlement asset and the gas asset are the same balance. That is the
  configuration every real deployment runs in.
- The truncating 6dp `balanceOf` over an 18dp native balance. §1.6's proof is arithmetic;
  nothing executes it.
- EIP-7708 native `Transfer` logs, `paused()` (R1), and sender-side blocklisting (R2 — the
  substitution table above already scopes why).

### `lpRecipient` and the burn

`MockRouter` records `lastLpRecipient`, which proves the argument is **passed**. **No test
mints a real LP token**, so nothing has confirmed LP actually arrives at `BURN_ADDRESS` and
is irrecoverable there. "LP Auto-Burned" (§1.8) currently rests on argument passing, not on
an observed burn.

### Not even a stub

- **Indexer** — ⚠ *corrected: migrations 001 and 002 ARE applied and `SUPABASE_URL` resolves
  (verified with the anon key this session, §8). What this row was really pointing at
  remains true and is the part to keep:* the generated-ABI test covers generation, and
  **nothing covers ingestion.** No test drives the indexer against a chain and checks what
  lands in the database. That gap is unchanged.
- **Frontend** — ⚠ *corrected: it is BUILT (§11).* But "not even a stub" still describes the
  right thing about it, one level down: **143 checks cover the pure libraries, and NOTHING
  covers the rendered app.** There is no component test, no browser test, and no test that
  drives a wallet. The signature path has never executed. Read this row as "the UI itself is
  untested", which is exactly what it was warning about.

**There is no clamped-buy refund path.** The clamp never pulls the excess: `_quoteBuy`
computes `actualUsdcIn` for exactly the tokens available and `safeTransferFrom` pulls only
that. Closed by structure, not by a fix.

---

# 5. STANDING PROCESS RULES

## The mutation score is the freeze gate, not the test count

**228 passing tests coexisted with a real gap** — `quoteBuy`'s `UnknownToken` guard had no
test, and without it `quoteBuy` on a non-existent token returns `tokensOut = 0` with
`actualUsdcIn` set to the full amount and **does not revert**.

**Last clean run: 52/56 = 92.9%, re-run on the post-session state** (56 sites, full test
suite per site, ~2h). *(That "242-test suite" figure was the count at the time; the suite is
**255 passing + 10 pending** today. The sweep has NOT been re-run since — nothing on the
contract has changed, so it should not need to be, but the score belongs to the older
suite.)* **Re-read from `guard-coverage.jsonl` on 30 August 2026 rather than recalled: 56
lines, 52 `DETECTED`, 4 `UNDETECTED`.** Identical to the previous score, with the same four
survivors. That
was not the expectation — R12 and R13 landed after the last sweep, so movement looked likely
— and the absence of movement is the finding: R12's fix adds a storage write rather than a
guard, R13 was documented rather than fixed, and the new tests exercise behaviours whose
guards were already covered. The sweep's value here is confirming no regression, not
discovering anything.

The four survivors, re-verified rather than carried forward on the old classification:

| site | error | class |
|---|---|---|
| `_quoteBuy` L392 | `CurveMathError` | **proven** unreachable |
| `_quoteSell` L534 | `CurveMathError` | **proven** unreachable |
| `_quoteBuy` L416 | `ClampCostExceededOffer` | **evidenced**, 2,000,000 fuzz cases, zero firings |
| `_quoteSell` L555 | `ClampInputExceededOffer` | **evidenced**, same |

The two `CurveMathError` proofs, checked independently this session rather than accepted:
`newVirtualUsdc >= virtualUsdcReserves` gives `k/newVirtualUsdc <= virtualTokenReserves` as
reals, and since `virtualTokenReserves` is an integer, `ceilDiv` cannot exceed it — with
equality only when the input is zero. `_quoteSell` is the same argument with the operands
swapped. Both are defensive assertions against a condition the arithmetic forbids.

**Keep "proven equivalent" and "unfalsified over N cases" as separate claims.** The two
classes above are not interchangeable and the table should not be flattened into one number.

*Consequence worth weighing separately: the two proven-unreachable guards are dead
bytecode. Removing them would recover space against the 546 free, at the cost of a backstop
and a fresh mutation run plus redeploy. Not recommended without a reason to need the bytes.*

## Prove every test can go red

**Six test-shape errors in one session.** Classes seen, all of which passed while testing
nothing:

1. **Vacuous assertion** — an invariant ran 250,000 calls and still passed with the code it checked commented out, because no curve ever reached the state it asserted on.
2. **Baseline from the wrong reading** — comparing an event against a *pre-buy* `tokenReserves` figure larger than the amount actually offered, so a `lessThan` held either way.
3. **Passing for the wrong reason** — a same-block dump that reverted on *allowance*, not the guard under test.
4. **`launch()` returns an address, not a transaction** — chai-matchers cannot read it. Made twice.
5. **Wrong quantity** — asserting against gross payout where the contract compares net.
6. **Stored vs read** — asserting a field was written but never that it was read.

Assume the next one is yours until shown otherwise.

**Budget the cycle honestly — a red-proof is minutes, not seconds.** At the shipped
`[invariant]` settings (`runs = 1000, depth = 250`) the Foundry suite is **~4.4 minutes**
wall-clock, so one mutate -> compile -> run -> restore round trip is ~5 minutes and the
three proofs behind the cross-curve invariants cost ~15. While iterating, drop to
`FOUNDRY_INVARIANT_RUNS=50 FOUNDRY_INVARIANT_DEPTH=50` — that is ~25 seconds per proof. A
mutation that dies in 50 runs is proved dead; one that SURVIVES 50 has proved nothing and
must be re-run at full settings. Pinning solc 0.8.24 made the suite ~25% slower than the
0.8.35 figure an older note may quote.

## Mutations go through a mutation tool, never by hand

Two tools, because one cannot do both jobs:

- **`scripts/guard-coverage.py`** — the freeze gate. Disables every `if (!(...)) revert`
  guard site in turn and runs the **Hardhat** suite.
- **`scripts/redproof.py`** — one named mutation, one suite, restore. **The harness cannot
  red-proof a Foundry invariant:** it parses mocha's "N passing/failing", and an accounting
  bug is not a guard site, so `guard-coverage.py`'s mutation vocabulary cannot express one.
  Until this existed the only route was hand-editing a contract. `--list` shows the
  registered mutations; **add one there rather than editing a contract by hand.** Defaults
  to reduced fuzz settings — a mutation that dies in 50 runs is proved dead, one that
  survives 50 has proved nothing and needs `--full`.

Both restore from git after every site, on SIGINT/SIGTERM and via `atexit`. **No ad-hoc
mutation loops** — one timed out mid-run and left a mutated contract on disk.

**`redproof.py` REFUSES to run against a dirty target rather than restoring it.** The
restore it relies on can only recover what is COMMITTED, so auto-restoring destroys
uncommitted work — it ate an unstaged test fix the first time it ran. Commit, then mutate.
`guard-coverage.py` still auto-restores a dirty `contracts/LFX1.sol` at start: same hazard,
not yet changed.

### The pre-commit hook is a LEASE, not a marker grep

`.githooks/pre-commit` refuses **any** commit while `.mutation-lease` exists. Both tools
take the lease before touching a file and release it in the same path that restores, so a
killed run leaves the lease behind and fails closed.

**The marker grep it replaced was removed on purpose, not lost.** It matched `// MUTATED`
and `if (false) revert` in the staged diff — markers the tools themselves write — so it
only ever caught mutations that ANNOUNCE themselves. A hand-edited one carries no marker
and passes, and a green hook then gets read as a clean tree, which is worse than no hook.
It also could not see the class that motivated the guard at all: a cross-curve steal ADDS
lines and removes no guard, so no content rule matches it. The lease checks state, and
state cannot be evaded by writing different text.

Activated by `git config core.hooksPath .githooks` — **a fresh clone must run that
command** or the hook is inert. Verified to actually block: with a lease present
`git commit` refuses and HEAD does not move.

## Other standing rules

- Report findings before fixing. Some are acceptable risks; that is the operator's call.
- Flag anything safe only by a **parameter value** rather than by structure.
- Prefer restructuring over compiler flags (stack-too-deep → extract a function, never `viaIR`).
- **Never claim it is bulletproof.** State what was tested, what was found, and what would still worry you with real money on it.
- Arc's `eth_estimateGas` returns **no margin** — always send with headroom. This will hit the frontend.
- Arc RPC requires `batchMaxCount: 1` in every raw ethers.js provider config.
  **⚠ WAS TRUE, NOW UNVERIFIED — keep the setting, distrust the reason.** Measured
  29 August 2026: a hand-rolled 2-request JSON-RPC batch to `https://rpc.testnet.arc.io`
  returned **HTTP 200 with both results** (`eth_chainId` → `0x4cef52`, `eth_blockNumber`),
  so the blanket claim does not hold today at that size on that host.
  **This is not permission to turn batching on.** What was actually measured is one batch,
  of two, on one endpoint, while idle. Not tested: larger batches, ethers' own framing and
  batch sizing, the other RPC hosts, or **any of it under load** — and rate limiting on
  this endpoint is documented as real and severe (§8: the backfill stalled 150s at a time).
  The original rule was recorded without its evidence, which is why it cannot simply be
  deleted: **if it was added because batching failed under conditions nobody wrote down,
  those conditions still exist.** viem's `http()` transport defaults batching to **off**,
  so the safe posture is free — take it, and leave this entry standing until someone
  reproduces the original failure or proves it gone under load.
- USDC is 6 decimals in contract amounts.
- Fees are read per-token from `curves()`, never assumed global.
- Never put raw private keys in browser storage.

---

# 6. FORWARD DECISIONS ALREADY SETTLED — DO NOT REOPEN

- **Mainnet launches on the V2 router, LP burned to `BURN_ADDRESS`.** V4 is post-launch, via the router timelock. **A next session must not start building V4.**
- **The zero-fee-pool rationale is LP fee dilutability** — anyone can add liquidity to a permissionless v4 pool and take a pro-rata share of LP fees. It is **not** "Uniswap charges a fee on top of ours". That reasoning was wrong and must not reappear.
- **Under a zero-fee pool the position accrues nothing, so the hook is the fee accountant and the locker is a tombstone.** *(Corrected: an earlier version of this file said the locker "must be able to call `PositionManager` to collect fees and manage the position." That is wrong under a zero-fee pool and has been removed.)*
- **Burn vs locker for the v4 position is OPEN**, pending the operator's recommendation. `PositionManager` uses **`_mint`, not `_safeMint`** (L369, solmate base), so a position can go to a non-receiver address without reverting — graduation will **not** revert regardless of what the recipient implements.
- **No unvalidated calldata may ever be forwarded to `PositionManager` or `PoolManager`.** A reported launchpad exploit forwarded user-supplied calldata into `multicall()`; the attacker injected `setApprovalForAll` and swept every custodied position. All calldata must be constructed internally from validated parameters.
- Uniswap on Arc mainnet, from their own SDK: v2 router `0x1f7d7550b1b028f7571e69a784071f0205fd2efa`, v2 factory `0x89e5db8b5aa49aa85ac63f691524311aeb649eba`, v4 PoolManager `0x8366a39cc670b4001a1121b8f6a443a643e40951`, v4 PositionManager `0x6049c9a0e26405c0985f9e3685c87d0ae917f82b`. **The v2 router matches `IDEXRouter.addLiquidity` exactly.**

---

# 7. CURRENT STATE

| | |
|---|---|
| deployed commit | `38e3e9e` — **the commit the frozen bytecode was built from, NOT the repo HEAD.** Repo HEAD is `90813c5`; the gap is entirely frontend work and the contract has not moved. Keep these two labelled differently, because this file has carried three conflicting HEADs before. |
| bytecode | **24,033 / 24,576 — 543 free.** Verified on chain this session: `eth_getCode` on the factory returns 24,033 bytes. |
| tests | **255 Hardhat passing + 10 pending** (pending = the `FORK=1` suite, skipped without it), **13 Foundry** (`forge test`, 3 suites, 205s). Re-run this session. The **14 live R15** checks and the **10 fork** checks were **not** re-run — they need a funded key and a fork RPC respectively. |
| last mutation score | **52/56 = 92.9%**, re-read from `guard-coverage.jsonl` this session rather than recalled: 56 sites, 52 `DETECTED`, 4 `UNDETECTED`. Same four survivors, all classified (§5). |

## Current deployment — re-frozen

| | |
|---|---|
| **LFX1 (the factory)** | **`0xEDeed1F05D34421Add0F59b7340588ab2BbaC04b`** — block 59366694 |
| MockRouter (PLACEHOLDER) | `0xFa6CeBb5e50FaFFD1A3bF611392fE255f9ec0cD3` |
| GraduationHelper | `0x1197BB8324F0338104a00000B043CD9193D5Cd7f` — **inert on testnet, see below** |
| USDC | `0x3600000000000000000000000000000000000000` |
| treasury / owner | `0x64140EAa0a3B6E4682C98e440837bd3d5482B4cb` (EOA, deliberate — R8) |

Both fully verified on Blockscout (`is_fully_verified: true`,
`is_partially_verified: false`, `is_changed_bytecode: false`). Bytecode hash and a
local-vs-chain comparison are recorded in `deployments/arcTestnet.json`.

**On-chain code vs the local artifact: 12 differing bytes on `LFX1`, all benign.** Every one
is a `0x00` in the artifact against `0x36` on chain — the `usdc` immutable
(`0x3600...0000`) substituted at its 12 reference sites, where only the leading byte shows
because the other 19 are zeros that match the placeholder. `record-freeze.js` classifies
this rather than reporting a bare mismatch; a difference anywhere the artifact is NOT a
zero placeholder would be a real discrepancy and must not be waved past.

**SUPERSEDED, must not be published:** `0xDF714C3bA8Ab3578652E9D066D862fc63AD3F802`,
`0x2f7270Fd84871385FBe65531d50D946A8d84aaF9` and
`0x6d79D90F60B30d527e2DDcBb7fe4f64309bAA15A`. Four factory addresses have now existed;
this is the fifth and the reasons are worth keeping: the first predated the strict-mins
fix, the second died to the licence header change, the third to the R17 override. The second was live for about an hour before
the licence change altered the sources and therefore the bytecode. **Any source edit,
including a comment, moves the address** — the compiler embeds an IPFS metadata hash of the
sources. Decide licence and header text BEFORE deploying, not after.
Earlier superseded deployments are listed in git history.

### GraduationHelper is INERT on Arc testnet — do not publish it as working

It needs a real Uniswap V2 factory to find the pair it corrects. The Arc **mainnet** V2
factory has **no code on testnet** (confirmed by `scripts/refreeze-preflight.js`), and the
testnet router is `MockRouter`, which creates no pairs at all. The problem it solves —
§1.1's adversarial pair, R6 — **cannot occur on this chain**. It is deployed with the
mainnet factory address so the constructor args match production and the source is
verifiable now. Treat the address as a reserved, verified artifact, not a working contract.

**It holds no privilege in `LFX1`, and this was checked on chain, not asserted:** it is not
`owner`, not `router`, and calls only the public permissionless `graduate()`. A bug in it
cannot strand or damage a curve; the fallback is the same two-transaction sequence anyone
can perform by hand.

### Licence — settled: UNLICENSED, `license_type: none`

`SPDX-License-Identifier: UNLICENSED` on all 11 of our contracts. The BUSL-1.1 block, the
Change Date and the change-licence text are **removed**, and `LICENSE` at the repo root is
an all-rights-reserved notice. `[LICENSOR]` no longer appears anywhere.

**`license_type: none` is already correct and needs no call.** Blockscout's list has no
"UNLICENSED" entry. The nearest-sounding one is a trap:

| value | what it actually means |
|---|---|
| `none` | no licence stated — **correct for UNLICENSED**, and already set |
| `unlicense` | **The Unlicense: a PUBLIC DOMAIN DEDICATION.** The exact opposite. Setting this would publicly waive every right the project is trying to keep |

`scripts/set-license.js` exists from the BUSL decision and now defaults to `none`. There is
no reason to run it — the deployments already carry `none`. It is kept only so the next
person who wonders can see the mapping written down rather than re-deriving it.

OpenZeppelin's sources stay MIT and appear as separate files with their own SPDX headers.

---

# 7A. MECHANICS — restored after the rewrite dropped them

⚠ **These three sections were deleted by the CLAUDE.md rewrite and lived only in the
contract for weeks.** `### Fees`, `### Snipe tax` and `### Other mechanics` were present
before `2d92cfe` and absent after. The rewrite kept the hard-won *hazards* (§1.1–1.10, the
register) and dropped the *mechanics*. Restored below, corrected to current values.

## Fees

- **1% buy and 1% sell**, per-token snapshotted at creation. `defaultBuyFeeBps` /
  `defaultSellFeeBps` = 100.
- **Creator share: 90% of the buy-side fee, 50% of the sell-side**
  (`defaultCreatorBuyFeeBps` 90, `defaultCreatorSellFeeBps` 50). Blends to **70%** at a
  50:50 mix, ~78% buy-heavy. A lifetime mix below 50:50 buy is structurally impossible
  (everything sold was bought first), so **70% is a hard floor**.
- **Never market this as "90/10."** The blend is 70%, both splits are readable on a
  verified contract in thirty seconds, and the honest claims — "70%, matching the market
  leader" and "90% on every buy" — are already market-leading. Push back if it comes up.
- **Creation fee 0.5 USDC** (`creationFeeUsdc` = 5e5). Not 0.1: at 0.1 one wallet could
  push 8,640 launches/day for ~$1,063. Revenue from spam does not offset an unusable feed.
  **Not covered by the economics hash — see R13.**
- Curve-phase revenue is **capped per token** ($346–600 depending on mix). The engine is
  launch volume and curve trading, not graduations.
- Accrual and claiming are §1.7; the solvency identity is §1.10.

## Snipe tax

Table **`[9800, 9500, 9000, 8000, 6000, 4000, 2000, 0]`**, indexed by elapsed **seconds**
since creation. Retuned because the old `[9800, 2500, 300, 100, 0]` stopped deterring
against the thinner curve. Measured share of curve supply taken by a $1,000 sniper:

| t | tax | this table | old table |
|---|---|---|---|
| 0 | 9800 | 0.49% | 0.49% |
| 1 | 9500 | 1.96% | **28.93%** |
| 2 | 9000 | 4.34% | **35.25%** |
| 3 | 8000 | 8.85% | 35.79% |

Testnet racing found real snipers landing at **t=1–2**, exactly where the old table failed.

- Split **70% treasury / 30% back into the curve** (`defaultSnipeTaxTreasuryBps` = 7000),
  adjustable, snapshotted per token. **Never to the creator** — a creator sniping their own
  launch would recover part of their own tax.
- Tables are **immutable per version**. Each token snapshots
  `activeSnipeTaxTableVersion` at creation; there is no mutate path, only
  `publishSnipeTaxTable` creating a new version for future launches.
- **Describe it as "up to 98%," not "98%"** — the top tier is only reachable by co-located
  bots.
- Zero headroom: see R4.

## Other mechanics

- **Partial-fill clamp** on buy and sell — fills what is available rather than reverting,
  and never pulls the excess in the first place, so there is no refund step to fail. Stops
  a graduating buy being griefable by a small front-run.
- **Block-0 restriction:** trading opens the block AFTER creation
  (`block.number > creationBlock`, error `TradingNotOpenYet`). On 500ms blocks this delays
  a sniper by about half a second, which is why the snipe tax exists at all.
- **Creator launch buy:** creator-only, untaxed, capped at **2.5% of curve supply**
  (`maxCreatorLaunchBps` = 250), cumulative per token — a per-call cap is loopable inside
  one block. The cap limits the *privileged* path only and does **not** cap total creator
  holdings; nothing stops a second address. **Never describe it as "creators are capped at
  2.5%."** Disclosure is the protection — the frontend must show "creator bought X% at
  launch."
- **Creator launch window is TIME-based**, `creatorLaunchWindow` = 3 seconds, snapshotted
  and hashed. A block-number check was unreachable from an EOA. A zero window is
  same-SECOND, not same-BLOCK. The honest claim is "first CHEAP access", not "first
  access": a sniper can outbid on gas inside the window.
- **Economics pinning:** `createToken` takes `expectedEconomicsHash` and reverts
  `EconomicsChanged` if terms moved. Twelve values are hashed; **`creationFeeUsdc` and
  `launchCooldown` are NOT** (R13).
- **Mutable metadata URI** — creator-only `updateMetadataURI`, emits old and new so socials
  swapped after launch are auditable.
- **Pool boost** (opt-in at launch): the creator's fee share accrues to `poolBoost` instead
  of `creatorFeesAccrued`, and is added to the pool's USDC side at graduation. It must
  **never** count toward the graduation threshold. Effect is a ~1–4% deeper pool — a
  **trust signal, not an economic mechanism**. Do not let the UI imply otherwise, and do
  not call it "holder fee sharing": nobody receives anything.
- **Symbol lock — DISABLED.** `symbolLockDuration` was 5 minutes; it is now **0** on the
  live deployment. See §7B.
- **Launch cooldown — 5 seconds** per creator address (`launchCooldown`, keyed on
  `lastLaunchTimestamp[msg.sender]`). Bypassable with a second address or a factory
  contract, so it is **not** a spam control; the 0.5 USDC creation fee is.

---

# 7B. SETTLED THIS SESSION

## Symbol lock removed, launch cooldown 5s

`symbolLockDuration` **0**, `launchCooldown` **5**. Both by setter on the live deployment:
no redeploy, no bytecode change, reversible.

**A duration of 0 disables the check outright rather than shortening it** — proven in
`test/SymbolLock.test.js`, including the boundary where two launches of the same symbol
land in ONE block and `unlocksAt == now`, which `>=` passes and `>` would not. The write
still happens, so the guard is still evaluated and still costs gas; it simply can never
fire.

Priced before deciding, with the removal measured through the harness
(`redproof.py remove-symbol-lock`):

| | lock present | code removed |
|---|---|---|
| bytecode | 24,030 | 23,734 (**−296**) |
| `createToken` gas | 1,065,491 | 1,040,685 (**−24,806**, ~0.0005 USDC) |

Setting 0 recovers **none** of that — the SSTORE remains. Cutting the code out would, at
the cost of a fourth address, re-verification, and breaking five existing tests. Not worth
it on those numbers. `isSymbolAvailable()` stays honest at duration 0: it reports "not
currently locked", which is now permanently true.

**Consequence: symbols are fully duplicable with no delay.** Collision surfacing is a hard
frontend requirement, not a nice-to-have — `FRONTEND_BUILD_V2.md` rule 2.

⚠ `symbolLockDuration` is inside `currentEconomicsHash()`, so this change **moved the
hash**. Any `createToken` carrying a pre-change hash now reverts `EconomicsChanged`.
`launchCooldown` is not hashed, so that half invalidated nothing.

## Three test-calibration errors, kept with their reasons

All three were mine, in the R15 suite, and each looked like a contract finding first:

1. **Leaving 0.3 USDC to strand a holder** — ample. A transaction here costs ~0.004 USDC,
   so the sell went through and proved nothing.
2. **Spending down to a quarter of a transaction** — the BUY could then not afford its own
   gas and reverted, moving the trap to the wrong operation. Gas and settlement come out of
   one balance, so sizing one against the other fights you; sweep AFTER the buy instead.
3. **Snapshotting the factory before `createToken`** — measures the creation fee as well as
   the trade, and fails by exactly `creationFeeUsdc`. Snapshot immediately before the buy.

The general lesson: on Arc, any test that reasons about a balance must account for gas
coming out of that same balance, at every step.

---

# 7C. SCOPE: A LAUNCHPAD, NOT A TRADING TERMINAL

**We are building a launchpad.** Launch a token, trade it on its curve, watch it graduate.
Pons is the reference for shape and flow: a token list and a **token page as the unit of
navigation**.

**`frontend/terminal.html` is an ABANDONED Axiom-style trading terminal. Do not finish it.**
Salvage from it freely and delete the rest. No future session should treat it as the
product.

✅ **THE SALVAGE IS DONE.** The engine was lifted into `app/` (§11) and the JS curve math was
**not** — quotes come from `quoteBuy`/`quoteSell` on the contract. Two things changed shape
in the move and are worth knowing: `ensureArcNetwork` became the fail-closed guard in
`lib/arcGuard.ts` (§11.3), and `withRetry` — which existed in **two drifted copies** across
the two HTML files, only one of which handled rate limits — is now TanStack Query's retry
policy, in one place. The table below is kept as the record of what was taken.

| salvage | discard |
|---|---|
| wallet connect, `ensureArcNetwork` | the terminal shell itself |
| the `withRetry` wrapper (the RPC is genuinely flaky) | **the JS curve math, entirely** |
| USDC balance and allowance reads | |
| `serve.js`, and UI components that fit | |

The JS curve math is gone and must never come back. `calculateBuyOutput`,
`calculateSellOutput` and `ceilDiv` re-derived the curve without a snipe-tax term —
measured against the live deployment at **98.96x overstated at t=0**, 11x at t=1, 5.2x at
t=2. Overstating is the dangerous direction: `minTokensOut` is derived from the quote, so
the floor sat far above anything achievable and **every buy in the first seconds would have
reverted**. Quotes come from `quoteBuy`/`quoteSell` on the contract — §1.3.

---

# 8. NON-CONTRACT STATE

- **Frontend: BUILT, in React, in `app/`. NO LONGER THE CRITICAL PATH — §11 is the record.**
  *(This entry used to read "not started". It is corrected rather than deleted because the
  three requirements it carried are still binding and are the reason the pages look the way
  they do.)* Price impact **is** a headline number — a $500 buy at launch takes ~21% of
  curve supply and moves the price ~18.55%; the definition is pinned in §11.4 because three
  different numbers describe that one trade. `minTokensOut` never defaults to zero. "Creator
  bought X% at launch" renders on every token page — the 2.5% cap limits only the
  *privileged* path and does not cap total creator holdings, so disclosure is the actual
  protection. A quote taken during the snipe window is stale within **one second**, so the
  trade panel **re-quotes immediately before signing** rather than acting on a displayed
  number.
- **Indexer: ⚠ STALLED. The code works; the process is not running.** Migrations 000 + 001 +
  002 applied, backfilled from the deploy block. **Measured this session: checkpoint
  `59455052` against chain head `59663174` — 208,122 blocks behind, ~27.7 hours of chain
  time.** *(This entry previously said "WORKING … caught up to head, 12 blocks behind". That
  was true when written and is the exact failure mode this file warns about: a state
  recorded once and never re-measured. The 12-block figure is kept here as the reading it
  was, not as the reading it is.)* Restarting it is enough — **do not reset the checkpoint**,
  because the factory has not changed. Verified end to end when last live: 4 tokens indexed, all
  from the current factory, with both migrations' columns populated (`state=trading`,
  `creator_launch_bps`), and trade rows matching on-chain amounts exactly — a SELL recorded
  `usdc=188113`, the precise net `quoteSell` returned.
  - **The schema is now reproducible from the repo.** It was not: the base tables lived only
    in the hosted project, and 001/002 are `ALTER TABLE` against tables nothing here could
    create. `000_base_schema.sql` is generated by `indexer/scripts/gen-base-schema.js`.
    **It is introspected through PostgREST, not `pg_dump`** — it captures columns, types,
    NOT NULL and primary keys, and it does NOT capture indexes, CHECK constraints, defaults,
    triggers, RLS, or the body of the `tokens_with_volume` view. A floor, not a backup. The
    one default that matters is inferred and labelled: `trades.id` must default
    server-side, because the indexer inserts without supplying it.
  - Applying migrations needs the Supabase SQL editor or a DB password. **The service-role
    key cannot run DDL** — it is a PostgREST credential and PostgREST exposes no SQL
    endpoint (verified: zero RPC functions on the project). `migrations/APPLY-ALL.sql`
    bundles them for pasting.
  - **RLS verified with the ANON key, which is the only key that can.** The service-role
    key bypasses RLS, so it returns rows whether or not the policies work and cannot detect
    a broken one. 11/11 via `indexer/scripts/verify-anon-access.js`: anon reads
    `tokens_with_volume`, `tokens` and `trades`; cannot read `indexer_state`; cannot
    insert, update or delete.
  - **`tokens_with_volume` is SECURITY INVOKER**, not the Postgres default. Everything it
    exposes is chain-derived or public, and `trader_address` never leaves its subquery. The
    trap is that switching to INVOKER can **silently empty the view** — the caller then
    needs its own SELECT rights, and without them it returns zero rows and no error.
  - **Judge a destructive RLS check by ROW COUNT, never by HTTP status.** PostgREST returns
    `204` for a DELETE that matched nothing, which is exactly what RLS produces. A first
    version of the check read that as "DELETE ALLOWED" and reported a breach that had not
    happened. Nothing was deleted.
  - **anon USED to hold DELETE and UPDATE grants, with only the missing RLS policy stopping
    them. That is closed: the REVOKE is applied to the live database.** Supabase grants
    broadly to anon by default and `GRANT SELECT` adds rather than replaces, which is how
    the grants survived — DELETE and UPDATE returned 204 (grant held, RLS matched nothing)
    while INSERT returned 401. Re-measured 29 August: **all six write paths on both tables
    return `401` / `42501 permission denied`**, so the protection now rests on two
    independent barriers. See the table under RESUME HERE for the before/after and for why
    the status code — not the row count — is the signal that separates them.
  - Rate limiting on the public RPC is real and visible: the backfill stalled for 150s at a
    time under `withRetry`'s backoff. A dedicated provider would fix it.
  - Env vars: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `FACTORY_RPC_URL`,
    `FACTORY_ADDRESS`, `FACTORY_DEPLOY_BLOCK`. Only the first four are checked at startup —
    a missing `FACTORY_DEPLOY_BLOCK` falls through silently.
  - **The checkpoint is per-factory and is NOT reset by a redeploy.** It held 53995966 from
    July, against the original factory; left alone the indexer would have replayed 5.4M
    blocks of a dead contract. Reset it whenever the factory address changes.
- **Licence: UNLICENSED. Settled, not an open item.** All rights reserved, no rights granted, no entity name required and none used. BUSL-1.1 was considered and **dropped** rather than filling `[LICENSOR]`: it needed a named licensor the project did not want to publish, and verifying on a public explorer arguably starts its four-year clock — both problems disappear with UNLICENSED. Blockscout shows `license_type: none`, which is correct and already set; **`unlicense` on that list is The Unlicense, a public-domain dedication, and must never be selected.** OpenZeppelin's sources remain MIT.
  The trade-off accepted: with no `[LICENSOR]`, there is no named copyright holder in the headers. CLAUDE.md previously argued a clear copyright line matters more than the licence choice for DMCA against hosted frontends and GitHub mirrors. That lever is weaker now. `LICENSE` states all-rights-reserved explicitly to compensate, but a takedown would rest on the repo and deployment history rather than on a name in the source.
- **CCTP V2 bridging is REQUIRED non-contract scope — it is NOT descoped.** It is the
  day-one frontend onramp and sits at the **top of the entire funnel**: a user on
  Base / Ethereum / Solana must be able to buy an Arc-native token without manually
  bridging first. What was removed from this file was the claim that it is a *contract*
  feature — `LFX1` does not and will not implement bridging. The frontend does.
  **Do not read its absence from the contract sections as descoped.**
  Use Circle's **Forwarding Service** (Bridge Kit, or `depositForBurnWithHook`) rather
  than a custom relayer: no wallets to fund, no retries to manage, and fees are taken from
  the minted USDC so users need no destination gas. Arc testnet is CCTP **domain 26** and
  is a supported Forwarding Service destination; **Arc mainnet is still absent from
  Circle's published CCTP address list — verify before relying on it.**
- **Owner is a single EOA** by the operator's deliberate decision. Do not re-raise.
- **`ARCHITECTURE.md`** holds 140 comment blocks / 748 lines moved out of the deployed source. Published nowhere; it is the only copy of that reasoning.

---

# 9. ARC PLATFORM REFERENCE

**Arc's docs are ground truth. This section is a CACHE and it will go stale.** Every fact
below carries its source page. Before relying on any of it, re-read the page — doing exactly
that has caught errors every time this project has done it, and these values are explicitly
testnet-only in places.

**Verified 29 August 2026** against `docs.arc.io`, four pages read in full:
`/arc/references/evm-differences`, `/arc/references/gas-and-fees`,
`/integrate/defi/amm-and-pools`, `/integrate/infrastructure/indexing-events`. Anything not
from those four pages is not verified and is not recorded here.

## ⚠ QUERY THE MCP SERVER FIRST. This section is the fallback, not the source.

**`arc-docs` is connected** — `.mcp.json` at the repo root, project scope, HTTP transport
at `https://docs.arc.io/mcp`, no authentication. It exposes search and page-retrieval over
the live docs.

**Prefer it over anything written below.** This section is a snapshot taken on 29 August
2026; the server is the current text. Where they disagree, the server is right and this
section is stale by construction. Use it before recording any new Arc fact, and use it to
re-check an old one rather than trusting the table.

Connecting it paid for itself on the first query, which surfaced four things this file had
wrong or missing — see §9.5. That is the argument for reaching for it by default.

## 9.1 EVM differences — `/arc/references/evm-differences`

| behaviour | Arc |
|---|---|
| `PREVRANDAO` | *"Always returns `0`"*. *"No onchain randomness. Use an oracle or verifiable random function (VRF)."* |
| `SELFDESTRUCT` | EIP-6780 plus native value rules; **emits a `Transfer` log on success**. Account fully deleted only if created in the same transaction. Reverts when the beneficiary is the contract itself with a balance, the zero address with a balance, blocklisted, or already self-destructed. |
| `SELFDESTRUCT` and USDC | *"a contract's USDC is its native balance, held in the account, so `SELFDESTRUCT` transfers it to the beneficiary"* — unlike chains where ERC-20 USDC stays in the token contract. |
| Call to a self-destructed account | **The largest semantic departure.** A non-zero-value call **reverts**. On Ethereum, sending value to an address that self-destructed earlier in the same transaction succeeds; on Arc it is *"treated as a transfer to a destructed account, a forbidden burn, and reverts"*. |
| Transfers to `0x0` | *"A value-bearing transfer to `0x0` reverts with `"Zero address not allowed"`; a zero-value transfer to `0x0` succeeds."* |
| Native value to a contract | *"Sending native value to a contract is not guaranteed to succeed."* A call forwarding native value can revert, which *"breaks a common DeFi assumption."* |
| EIP-7702, `CREATE2`, EIP-2935 | *"all behave as on Ethereum."* |
| EIP-4788 | Beacon root set to the parent execution block hash; **the beacon-roots contract is omitted, so reads return empty (`0x`)**. |
| Blob transactions | *"Not supported; the mempool rejects type-3 transactions."* |

**Known limitation, fix planned:** *"A transfer that would leave an account with a zero
balance, a zero nonce, and no code currently reverts."* Reachable in practice only through a
USDC meta-transaction that fully drains a brand-new account. We have no meta-transaction
path, so it does not reach us — but a frontend that ever adds one must know.

## 9.2 AMM porting — `/integrate/defi/amm-and-pools`

**Step 4, the allowance warning:** *"ERC-20 allowances control transfers initiated through
`transferFrom`. They do not gate direct native transfers."* And: *"Any sweep mechanism or
authorization boundary that relies on ERC-20 allowance limits to protect the contract's
native USDC balance is ineffective."*

The docs prescribe two mitigations: mark functions `nonpayable`, or add an explicit
`receive()` that reverts or records the incoming balance. **We do the first**, and having no
`receive()` at all produces the same refusal as a reverting one — see §9.4.

**No WETH-style wrapping.** *"Any WETH-style wrap/unwrap code paths are unnecessary and
create double-accounting bugs by crediting balances twice."* We never wrap; USDC is used
directly at `0x3600...0000`.

## 9.3 Indexing — `/integrate/infrastructure/indexing-events`

- **Ordering:** *"Always use `blockNumber` (and `logIndex` in a block) as your canonical
  ordering key."* And explicitly: *"Do not use `block.timestamp` for ordering. Two
  consecutive blocks (for example, block 100 and block 101) may both have
  `timestamp = 1700000000`."*
- **Finality:** *"Arc provides deterministic finality. Once a block appears, it is
  permanent."* Remove *"reorg detection and rollback logic, confirmation-depth delays,
  uncle/ommer block handling, and chain reorganization event listeners."* *"You do not need
  to wait for N confirmations."*
- **Restart:** *"If your indexer restarts, resume from the last processed block number. You
  do not need to re-validate previously indexed blocks because they cannot be reverted."*
- **Blocklist events**, from the USDC contract at `0x3600000000000000000000000000000000000000`:
  `Blocklisted(address indexed account)` and `UnBlocklisted(address indexed account)`.
- **The dual emitter.** Every native USDC movement emits an EIP-7708 `Transfer` from the
  system address **`0xfffffffffffffffffffffffffffffffffffffffe`** at **18 decimals**; the
  ERC-20 contract emits its own at **6 decimals**. One ERC-20 transfer produces a log from
  **both**. Anything reading USDC transfers must **dedupe by emitter** or it double-counts
  every movement at two different scales.
- **Throughput:** *"Arc produces sub-second blocks. Your ingestion pipeline must handle
  bursts of many blocks per second without falling behind."*

## 9.4 What this means for OUR contracts — all confirmed, none changed

The contract is frozen and deployed. Every line below was **checked against the source**,
not assumed:

| claim | status |
|---|---|
| No block-derived entropy anywhere | **Confirmed.** No `PREVRANDAO`, `block.difficulty`, `blockhash` or block-modulo in `contracts/`, `scripts/`, `indexer/` or `frontend/`. |
| `LFX1` and `GraduationHelper` never call `SELFDESTRUCT` | **Confirmed.** No `selfdestruct` or `suicide` in any contract. |
| Nothing sends native value to `0x0` | **Confirmed.** Our contracts send **no native value at all** — no `{value:}`, no `.transfer()`, no `.send()`, no `payable()`. Every `address(0)` occurrence is a *validation guard*, never a destination. |
| `BURN_ADDRESS` is `0x...dEaD`, not `0x0` | **Confirmed**, `LFX1.sol:25`. Correct: a value-bearing transfer to `0x0` would revert. |
| No allowance-based protection of our own native balance | **Confirmed.** All six approve sites are `forceApprove(router, ...)` — outbound grants so the router can pull at graduation. Nothing relies on an allowance to *protect* our balance; §1.6's balance-delta measurement does that, and it reads the balance rather than an allowance. |

**The absence of `receive()` / `fallback()` is now a DELIBERATE property, not an accident.**
`/integrate/defi/amm-and-pools` prescribes either `nonpayable` functions or a reverting
`receive()`. We have no payable function, no `receive()` and no `fallback()`, so a plain
native send to the factory reverts — the same outcome as a reverting `receive()`, with no
code. **Do not add one.** The residual is unchanged and already recorded as R10: a
`SELFDESTRUCT` push can still deposit native dust, because that path does not call the
recipient.

## 9.5 Found by the MCP server on its first query, 29 August 2026

Recorded because each one contradicts or extends something this file already said. None is
acted on here; the contract is closed and the frontend is unwritten.

| finding | source page | why it matters |
|---|---|---|
| **Mainnet addresses do not exist yet.** *"All addresses on this page are for Arc Testnet. Mainnet addresses are not yet available."* | `/arc/references/contract-addresses` | Settles §10's first two rows. There is no mainnet USDC or CCTP address to look up, so nothing can be pre-wired. |
| **There is no published mainnet chain ID.** Deployment phases list Public Testnet as *Live* (`5042002`); **Private Mainnet and Public Mainnet are both "Upcoming"**. | `/arc/concepts/deployment-model` | **`5042` remains unsourced and must not be used.** The docs publish no mainnet ID at all, so the secondary source that produced `5042` had nothing to be right about. |
| **The documented RPC host is `rpc.testnet.arc.io`.** We use `rpc.testnet.arc.network` in `hardhat.config.js` and both frontend files. | `/integrate/infrastructure`, `/arc-chain` | Ours demonstrably works — every deployment this session went through it. But it is not the documented host, so it may be a legacy alias with no guarantee. **Do not change it blind**; test the documented host before switching, and prefer it for anything new. |
| **EVM target is the Osaka hard fork.** Block time *"~0.48 s (testnet)"*, finality *"Deterministic, sub-second"*, CCTP domain `26`. | `/arc-chain`, `/integrate/infrastructure` | We compile with `evm target: paris`, which is conservative and therefore safe — Osaka is a superset. Worth knowing that newer opcodes are available if a future contract wants them. The block time confirms the ~500ms assumption behind `allowBlocksWithSameTimestamp`. |

**One more, for the frontend rather than the contract:** *"Arc Testnet (chain ID 5042002) is
not registered in the WalletConnect chain registry. On first connection, WalletConnect
issues a `wallet_addEthereumChain` call per user."* (`/integrate/connect-to-arc`.) So a
WalletConnect user is prompted to add the chain before anything else happens — the existing
`ensureArcNetwork` helper in both frontend files already does this for injected wallets, and
the same handling is needed on the WalletConnect path.

---

---

# 10. MAINNET CHECKLIST — all currently unknown or testnet-only

Nothing here is verified. Each is a thing that must be re-checked when Arc mainnet exists,
and none of it should be hardcoded before then.

| item | current state |
|---|---|
| **Mainnet chain ID** | **UNSOURCED.** Testnet is `5042002`. A secondary source said `5042` and Circle documents only the testnet value — do not put `5042` anywhere until confirmed. |
| **Mainnet contract addresses** | USDC, CCTP `TokenMessengerV2`, `MessageTransmitterV2`, and anything else depended on. The docs say to always check the contract-addresses page rather than reusing a testnet value. |
| **Fee parameters** | Floor (20 Gwei), ceiling (20,000 Gwei) and throughput are **explicitly testnet configuration** and *"may change before mainnet launch."* Read from the chain. |
| **Uniswap V2 deployment** | The v2 router/factory addresses in §6 came from Uniswap's SDK **for a chain that did not exist yet**. Confirm code is actually deployed at those addresses on mainnet before graduation depends on them — `scripts/refreeze-preflight.js` already does this check. **Re-verified on testnet, 30 August 2026:** `eth_getCode` returns `0x` (NO CODE) for both router `0x1f7d7550…` and factory `0x89e5db8b…`, while the LFX1 factory returns 24,033 bytes and USDC returns 1,798 — so the probe itself is known-good and the absence is real, not a broken call. Expected on testnet; the same one-line check is the gate on mainnet. |
| **Everything resolves ON THE DAY** | Confirmed by the MCP server: *"Mainnet addresses are not yet available"*, and both mainnet phases are listed as **Upcoming** with no chain ID published. Nothing can be pre-wired. **So anything that can fetch-and-verify at runtime should be built that way NOW, not hardcoded and swapped later** — chain ID from the provider, contract addresses from config fetched at boot, fee parameters from `eth_gasPrice`/`eth_feeHistory`, and a startup assertion that what was fetched matches what was expected. A frontend that hardcodes testnet values needs a rebuild on 16 September; one that resolves them needs a config change. |
| **Testnet-vs-mainnet USDC parity** | Unverifiable until mainnet exists. §2 records testnet USDC as the same KIND of token, not the same token. |

---

# 11. THE FRONTEND — React, built, in `app/`

**The no-build-step constraint is revoked (see `## Stack`). This section is the record of
what replaced it.** `REACT_REBUILD.md` holds the spec and the twenty-one traps;
`FRONTEND_BUILD_V2.md` holds the nine hard rules, all of which survived the rebuild
unchanged because they are properties of the *contract*, not of the rendering technology.

## 11.1 Stack, versions as installed

Read from `app/node_modules`, not from the `^` ranges in `package.json`:

| package | range | installed |
|---|---|---|
| react / react-dom | `^19.0.0` | **19.2.8** |
| wagmi | `^3.7.7` | **3.7.7** |
| viem | `^2.56.0` | **2.56.0** |
| react-router-dom | `^7.18.3` | 7.18.3 |
| @tanstack/react-query | `^5.62.0` | 5.62.x |
| vite | `^6.0.0` | **6.4.3** |
| typescript | `^5.7.0` | 5.7.x |
| @walletconnect/ethereum-provider | `^2.24.0` | **2.24.0** — a PEER dep of `@wagmi/connectors` 8.2.0, not installed by it. `walletConnect({projectId})` import-fails at click time without it. |

**Bundle, measured before and after wiring WalletConnect:**

| | entry raw | entry gzip | total dist |
|---|---|---|---|
| before | 691.94 kB | **210.13 kB** | ~713 kB, 3 chunks |
| after | 708.30 kB | **216.08 kB** | 2.5 MB, 62 chunks |

**+5.95 kB gzip eagerly.** The WalletConnect machinery itself (`core` 606 kB, `w3m-modal`
169 kB) is code-split and loads only when someone clicks the button — confirmed in the dev
server's network log. Worth noting against §11.6: this is *cheaper on first load* than the
17.1 kB gzip i18n library that was rejected on size grounds, so the two decisions are
consistent rather than contradictory.

Routes: `/` (list), `/t/:address` (token page), `/about` (the ported landing page), `*` →
redirect to `/`. **`/create` is linked but NOT built** — Phase 4 is gated on the operator.

**143 frontend checks across seven suites**, all passing, all red-proved, run by
`npm run verify` in `app/`:

| suite | checks | covers |
|---|---|---|
| `verify:chain` | 11 | chain object, fee floor, derived hex id |
| `verify:guard` | 22 | the fail-closed chain guard |
| `verify:wallets` | 14 | EIP-6963 selection, and WalletConnect not suppressing the fallback |
| `verify:trade` | 36 | quotes, slippage, gas, curve gating |
| `verify:list` | 30 | sort, collisions, search, pagination |
| `verify:i18n` | OK | locale parity (pass/fail, not counted) |
| `verify:claims` | OK | public claims vs the deployed contract |

## 11.2 Phase commits

| commit | what |
|---|---|
| `3244698` | Phase 0/1 — scaffold, Arc chain, wallet connect, proven read |
| `adb649e` | two fail-open chain-guard bugs: poll the wallet, never trust a switch attempt |
| `1fd1233` | prompt the switch automatically on connect, once, never retry after rejection |
| `3afbc5d` | diagnostics page for the real wallet — no fix, a hypothesis with evidence |
| `67a1440` | **EIP-6963 binding; stop using the contested generic `injected()` connector** |
| `45d0fae` | settle whether green came from stale app state or the wallet itself |
| `b994f15` | explain per-site network scoping in the wrong-network banner |
| `3248410` | measure real gas — reserve 249,546 units sized on the EXIT |
| `751b3c6` | Phase 2 core — trade logic as pure, red-proved libs before any UI touched it |
| `cc462c3` | Phase 2 — the token page, live against the frozen factory |
| `5c33f89` | i18n — in-house layer on `Intl`, parity enforced at build |
| `1a6b422` | Phase 3 Part A — seven fixes |
| `59928fd` / `10be2bf` | Part B — app identity and `/about` |
| `90813c5` | Part C — the list page at `/` |

## 11.3 The chain guard took FOUR rounds, and why is the reusable part

⚠ **Three consecutive fixes passed against an injected fake and failed against real
MetaMask.** Anyone touching wallet or network code should read this before shipping.

1. **`useChainId()` reads the wagmi CONFIG, not the wallet.** The wrong-network branch was
   structurally unreachable — wagmi refuses to move config state to an unconfigured chain,
   so the value could never be wrong. Fixed with `useAccount().chainId` plus an
   independent `eth_chainId` probe.
2. **Read once, trusted forever.** A provider that changed chain without emitting
   `chainChanged` produced **zero** further reads. Fixed with 3s polling and a **12s
   freshness bound** — a stale answer is `unknown`, not `ok`.
3. **`switchChain` can hang forever** when the wallet resolves without switching, leaving
   the button permanently disabled. Bounded at 20s.
4. **The real cause of the last round was `window.ethereum` contention** — Phantom and
   MetaMask fighting over one property. The operator diagnosed it; my "stripped persistence
   shell" hypothesis was wrong. Fixed by **EIP-6963 discovery**, binding to a named
   wallet. `selectWallets` drops the generic injected connector whenever any 6963 wallet is
   discovered.

**And the last symptom was not a bug at all.** MetaMask's per-site network scoping meant
the site's permitted network was Arc while the wallet's global network was Ethereum. The
banner now explains that case rather than asserting a fault.

`lib/arcGuard.ts` is pure and fail-closed: `ok` requires **both** sources to agree **and**
the probe to be fresh. Anything else is `unknown` and `canTransact` is false.

### A fifth round, found by wiring WalletConnect — 30 August 2026

⚠ **`selectWallets` was keyed on the wrong signal, and all ten existing checks passed
either way.** It read `connectors.filter(c => c.id !== "injected")` and kept the generic
connector only when that came back empty — correct **only** while every connector is
either the generic one or an EIP-6963 discovery. WalletConnect is neither.

Under that rule, a user with **no extension installed** and WalletConnect configured got
`[generic, walletConnect]` → `[walletConnect]`: the last-resort fallback stripped by a
connector that says nothing whatsoever about whether `window.ethereum` is contested. An
old injected-only wallet would have had no way in.

The suppression is caused by **discovery**, so it is now conditioned on discovery —
`rdns` present, which is exactly when a wallet announced itself and therefore exactly when
`window.ethereum` might be contested. WalletConnect is orthogonal: always offered when
configured, never suppressing anything.

**The reusable part:** adding WalletConnect broke nothing and failed nothing. The suite
went 10/10 before the fix and 10/10 after, because no row described a connector that was
neither generic nor discovered. Four rows now do (W10–W13), and W10 is red-proved — with
the old rule restored it reports `offered: WalletConnect` and fails. **A suite that cannot
distinguish two rules is not evidence for either.**

## 11.4 Price impact — ONE trade, THREE numbers, and they are not interchangeable

The probe method (§1.3) yields one ratio; the formula chooses which side to report. For the
same $500 buy, measured live:

| figure | value | what it is |
|---|---|---|
| token shortfall | **15.65%** | `1 − (trade rate / probe rate)` |
| **PRICE MOVE** | **18.55%** | `(probe rate / trade rate) − 1` — **what the UI shows** |
| share of curve supply | **~20.9%** | §1.3's figure. **Not an impact number at all.** |

The first two are exact reciprocals, not two measurements. `impactPct` in `lib/quotes.ts`
divides by `effective`, **not** `marginal` — that single denominator is the whole
difference. PRICE MOVE was chosen because its misreading is the safe one: read as "I get
18.55% fewer tokens" it OVERSTATES the cost, and for a warning, erring high is correct.

⚠ **Do not "reconcile" 20.9% with either of the others.** It answers a different question.

## 11.5 Gas — the limit and the reserve are DIFFERENT NUMBERS, deliberately

Both from real receipts (`app/scripts/measure-gas.mts`), not chosen. The old frontend sent a
hardcoded 600,000 limit against a buy that consumed 194,372.

**Limit = `estimate × 3.0`** (`GAS_LIMIT_MULTIPLIER_X10 = 30n`). Raised from 1.5 because 1.5
was thinner than it reads: `estimateGas` returned **143,576** against **194,372** actually
consumed — the estimate came in **26% BELOW reality**, so the ratio to cover is already
1.354 and x1.5 leaves ~11% real headroom, not 50%. No measured buy triggered a
**graduation**, which does strictly more work than anything in the sample. The asymmetry is
total: unused gas is refunded, so an oversized limit costs a slightly higher balance bar;
an undersized one fails the most important transaction in the product.

**Reserve = 249,546 units**, sized on the **EXIT**, not on the limit. Worst observed sell
**119,254** + first-time approve **47,110** = 166,364, plus 50%. It is the exit because
that is R15's actual failure — a holder with 471 trillion tokens and 0.0016 USDC who could
not afford to sell. And the exit is **two** transactions for a first-time seller:
`sell()` takes tokens via `safeTransferFrom` (`LFX1.sol:577`), so an approve must land
first. A reserve covering only the sell strands exactly the user it exists to protect.

**Held in GAS UNITS, never in USDC**, so it tracks the fee. What it costs the user in
withheld trading balance:

| base fee | reserve (249,546 u) | one-trade limit (583,116 u) |
|---|---|---|
| 20 Gwei (Arc's floor) | **0.004991 USDC** | 0.011662 USDC |
| 200 Gwei | 0.049909 USDC | 0.116623 USDC |
| 20,000 Gwei (Arc's ceiling) | **4.990920 USDC** | 11.662320 USDC |

A figure fixed in USDC would be wrong by **1000x** exactly when the network is busy.

`GAS_LIMIT_UNITS_FOR_PRECHECK` uses the *same* x3.0 multiplier as the sent limit, so the
affordability check cannot pass a trade the wallet then refuses to sign.

## 11.6 i18n — in-house on `Intl`, and the locale decision

**Built in-house, ~1 kB.** Measured against the alternative before deciding: adding a
library cost **+51.5 kB raw / +17.1 kB gzip** (200.25 → 217.34 kB gzip). The two things
that price buys — ICU MessageFormat and namespace lazy-loading — are worth 17 kB on a large
app and are not worth it here.

**LOCALE DECISION: English and Simplified Chinese ship. Korean is CUT.**

⚠ **The code does not yet reflect that decision, and this is the honest state, not a claim
of completion.** `app/src/i18n/locales.ts` currently reads
`SHIPPED_LOCALES = ["en"]`, `PLANNED_LOCALES = ["zh-Hans", "ko"]`. And `en.ts` holds **239
keys** while `zh-Hans.ts` and `ko.ts` hold **7 each** — they are scaffolds proving the
plumbing, not translations. Shipping zh-Hans means translating 232 keys and moving it into
`SHIPPED_LOCALES`; cutting Korean means deleting `ko.ts` and its entry.

**Parity is enforced at build, not by review.** `scripts/gen-revert-copy.js` delegates to
`app/scripts/verify-i18n.mts` via `spawnSync` and **refuses to generate** if any configured
locale is missing copy for any revert error. A locale in `SHIPPED_LOCALES` with a missing
key fails the build.

**Layout is tested, not hoped for.** `?pseudo=long` renders the longest string actually
present across all locale files per key; `?pseudo=expand` pads English to ~1.4x with
visible filler, standing in for Korean's typical expansion. Chinese renders shorter and
Korean longer, so both directions have a mode.

**Number formatting is locale-aware and the divergence is real.** Plain grouping is
identical across en/zh/ko; **compact** notation is where they split — zh groups by 万/亿,
ko by 천/만/억/조. `i18n/format.ts` exposes exact and compact variants separately.
**No `Intl` currency style** — USDC is not an ISO currency and forcing it through one
produces a wrong symbol.

## 11.7 The claims checker — a build gate, because a careful read is not repeatable

The landing page claimed **"Uniswap v4" in five places**. Mainnet ships the **V2** router
with LP burned to `0x...dEaD` (§6, settled). On a project whose stated moat is
verifiability, a public specific claim the deployed contract contradicts is worse than a
bug: a competitor falsifies it in one page load, and fixing it does not undo having said
it. Five instances were found by reading carefully once; a sixth would be found the same
way, or not at all. `npm run verify:claims` finds it every build.

⚠ **The checker had two bugs of its own, and both are the instructive part.** `/Uniswap\s*v/i`
matched the string **"NO UNISWAP VERSION"** in its own explanatory copy; and a positive
check read the file's *source*, so a **comment** satisfied it after all the real copy had
been deleted — the red-proof passed when it should have failed. A checker that cannot go
red is the same failure as a test that cannot.

⚠ **"LP burned" vs "LP locked" is a claim that CHANGES on a settled future event.** Today
`lpRecipient` defaults to `BURN_ADDRESS` and "LP Auto-Burned" is true. If V4 lands with a
locker, §1.8 applies: tokens launched *before* the flip keep burning, tokens launched
*after* do not, and the two claims are **not interchangeable**. The checker must be updated
in the same change as the flip, not after it.

`components/token/TrustPanel.tsx` already reads `curve.lpRecipient` — the **per-curve
snapshot for the viewed token** — and renders "burned" or "sent to <address>" from it,
never from a global setting. That is A1, and it is the frontend honouring §1.8 rather than
restating it.

## 11.8 The list page — what the indexer can actually serve

Measured against the live view with the anon key before any of it was written. The view has
**no** `last_buy_at`, `volume_24h_usdc`, `volume_7d_usdc` or `total_supply` — re-confirmed
this session by reading its columns.

- **Default sort is `recentBuys`, set explicitly.** Not Newest: Newest ranks by creation, so
  the feed fills with tokens nobody has traded. Recent buys ranks by activity, so **spam is
  invisible rather than merely expensive to produce.** Served by a second query against
  `trades`, ordered by `block_number` — never by timestamp (Arc's sub-second blocks share
  timestamps, §9.3).
- **24h and 7d are DISABLED with a reason**, not silently served with 1h data. Serving 1h
  under a 24h label is the interface asserting what the data cannot support.
- **Graduated sits ABOVE Explore, and stays visible at zero.** Graduated tokens are evidence
  the mechanism completes. An empty "Graduated 0" with its explanation is launch-day state
  and must not look broken.
- **The address is on every card and is not optional.** `symbolLockDuration` is 0 and name
  uniqueness was never enforced, so two tokens can carry the same name and ticker in the
  same block.
- **Duplicate symbols are flagged case-INSENSITIVELY, across the whole live set, on BOTH
  tokens.** `caseSensitiveSymbols` is true on chain, so CAT and cat are different to the
  contract and identical to a reader — the impersonation is visual. A page-scoped scan
  cannot see a collision on page 4, which would *clear* tokens that are in fact
  impersonated: worse than not checking. Which of two identical tickers is "the real one"
  is not ours to assert.
- **Every figure on a card is `~` and named `approx*`** (trap 21: PostgREST serialises
  uint256 as a JSON **number**, truncated before JavaScript sees it). Nothing acted on comes
  from the indexer — clicking a card opens the token page, which reads the chain.

  ⚠ **TRAP 21 OBSERVED, NOT THEORISED — 30 August 2026.** Reading the live view with the
  anon key, `virtual_token_reserves` came back as:

  ```
  1.0749234267333488e+27
  ```

  A **float64 in scientific notation**. The true value is an exact 28-digit integer;
  `Number.MAX_SAFE_INTEGER` is ~9e15, so roughly **eleven digits were gone before any
  JavaScript ran**. Not a parsing choice we can override — PostgREST emitted a JSON number
  and the precision was already lost in the response body.

  **This instance is stronger than the `trades` one and worth keeping separately**, because
  it is a **reserve** — the exact field the `approx*` convention exists to guard. It is
  harmless where it currently sits: market cap and progress are display figures, and the
  relative error is ~1e-16, far below anything a card renders.

  **Which is precisely why it is easy to move somewhere it isn't.** The same column, copied
  into a quote, a slippage floor or a `minTokensOut`, is a number the contract will not
  honour. The rule is not "reserves are approximate" — it is that **anything sourced from
  the indexer is approximate, and the token page reads the chain because of this.** Do not
  let an `approx*` value cross into a path that signs.
- **The chain fallback is BOUNDED to 36,000 blocks (~4.8h)** and says so in the UI.
  Replaying from the deploy block would hang the page on exactly the day the indexer is
  down, because Arc's public RPC rejects wide `eth_getLogs` ranges and then rate-limits the
  chunked retry. In fallback the unavailable fields are **named**, never rendered as
  zeroes — a zero market cap is a claim; "unavailable" is the truth.

## 11.9 Visual identity

Tokens live in `app/src/styles.css` (578 lines) and are the whole palette:

```
--bg #f3f3f0   --text #111111  --muted #777777  --line #d6d6d1  --soft #e9e9e5
--warn #8a5a00 --pos #1f6b3a   --neg #a32b2b
--mono "DM Mono"   --sans "Inter"   --radius 10px   --pad 18px
```

Warning / positive / negative are the only hues and are used sparingly — **a page of
figures should be monochrome so the one coloured thing means something.**

## 11.10 Open, and honestly open

| item | state |
|---|---|
| **The signature path is UNEXERCISED** | No real wallet has signed a buy, sell or create through the React app. The single largest gap. |
| **Supabase 401s are bounded but UNIDENTIFIED** | The app degrades correctly on a 401 and the RLS posture is verified 11/11, but the *cause* of intermittent 401s was never root-caused. Bounded, not understood. |
| **zh-Hans is 7 of 239 keys; `locales.ts` still ships `en` only** | The decision (en + zh-Hans ship, ko cut) is made; the code has not been changed to match. §11.6. |
| **WalletConnect** | ✅ **WIRED, 30 August 2026.** `projectId` from `VITE_WALLETCONNECT_PROJECT_ID` (public by design, gitignored anyway so a fork does not spend the quota); the connector is built **only** when it is set. **Verified live in-browser:** the modal mounts, its chunks lazy-load, and a valid `wc:` pairing URI carrying `relay-protocol` is generated — which only happens after the relay ACCEPTS the projectId. ⚠ **Still unverified: no real mobile wallet has ever completed a session.** Trap 17 is NOT closed by wiring it — Arc 5042002 is absent from the WalletConnect registry, so first connect issues `wallet_addEthereumChain`; `chain.ts` carries the metadata that call needs, but what a real wallet does with it is untested. |
| **Arc mainnet chainId** | **Still unsourced.** `5042` came from a secondary source; Circle documents only `5042002`. §10. |
| **Uniswap V2 on Arc** | Verified this session: `eth_getCode` on **testnet** returns **NO CODE** for both the mainnet router `0x1f7d…efa` and factory `0x89e5…eba`. This is expected (they are mainnet addresses) and is exactly why `GraduationHelper` is inert. **Re-run the same check on mainnet before graduation depends on them.** |
| **No hosting, no runbook, no rollback, no user docs** | None of these exist. Not started, not scheduled. |
| **Migration 003** | Approved, not written. See "The exact next action". |

## 11.11 The indexer's live mode — filters, and how it went dark for 29 hours

⚠ **Live mode POLLS `eth_getLogs`. It is not a subscription, and it must not become one.**

### Arc does not support filters. Measured 31 August 2026, on BOTH hosts.

| method | `rpc.testnet.arc.io` | `rpc.testnet.arc.network` |
|---|---|---|
| `eth_newFilter` | **`-32603 internal error`** | **`-32603`** |
| `eth_newBlockFilter` | **`-32603`** | **`-32603`** |
| `eth_getLogs` | works | works |
| `eth_subscribe` over **WebSocket** (`wss://`) | **works** | **works** |
| `eth_subscribe` over **HTTP** | **returns an id — see the trap below** | same |

**WebSocket subscriptions genuinely work**, and that is worth knowing rather than
re-deriving: `wss://rpc.testnet.arc.io` connects and `eth_subscribe("logs", …)` returns a
usable id on both hosts.

**They are still not used.** A dropped or silently-dead subscription has *exactly* the
failure mode being fixed — process alive, nothing arriving, checkpoint frozen. Polling
from the checkpoint is **self-healing**: every tick re-reads from where it left off, so a
missed tick just means the next one covers more blocks. The subscription design would
reimport the bug in a new coat.

`eth_getLogs` rate-limits on request **frequency**, not span: a 1-block query succeeded and
a 10-block query 2.5s later returned `-32005`. Catch-up already paces at
`CHUNK_DELAY_MS = 750`; live polling reuses the same path.

### ⚠ `eth_subscribe` OVER HTTP IS A FAIL-OPEN TRAP

It returns a plausible subscription id. Then:

- `eth_getFilterChanges` on that id → **`-32603`**
- `eth_unsubscribe` on that id → **`false`**

So it accepts the call and hands back something worthless. **Anything checking "did
subscribe succeed?" gets yes.** A future session trying subscriptions over HTTP will see a
green result and index nothing. Use `wss://` or do not use subscriptions.

### Why it retried forever instead of failing

Not `withRetry` — that would have thrown on the first attempt, since `-32603` is neither a
rate limit nor node lag. The loop is inside ethers, and **ethers has a fallback for exactly
this case that never fires**:

```js
// subscriber-filterid.js
if (!isError(error, "UNSUPPORTED_OPERATION") || error.operation !== "eth_newFilter") throw error;
// The backend does not support Filter ID; downgrade to polling
```

`provider-jsonrpc.js` decides `UNSUPPORTED_OPERATION` by **regex-matching the error
message** — `message.match(/the method .* does not exist/i)`. Arc says `"internal error"`.
No match → `UNKNOWN_ERROR` → re-thrown into ethers' own catch → `console.log("@TODO", error)`
→ `provider.once("block", poller)` **re-arms it on the next block**.

Measured over 45 seconds:

```
eth_newFilter attempts        : 11   (~4s apart = pollingInterval)
distinct request ids used     : 1    -> id 2, every single time
backoff                       : none
provider "error" events fired : 0
process alive                 : yes
```

**Three layers each swallowed it**, which is why there was no signal anywhere:

1. **ethers' `console.log("@TODO", error)`** — not an event, not a rejection.
   Uninterceptable from our code.
2. **`provider.on("error", …)`** — measured **zero events**. The handler the code relied on
   to surface provider problems is dead for this failure class.
3. **`process.on("unhandledRejection")`** — never saw it either, and logged-and-continued
   even when it did fire.

And `degraded` was only set inside the log handler, which required a log to *arrive*. None
ever did, so it stayed `false` forever and the checkpoint never advanced.

### What replaced it

- **One code path.** `catchUp()` IS live mode, called on a 5s interval. The two-path
  version is what broke: catch-up polled and worked, live mode subscribed and did nothing.
- **Bounded failure.** 5 consecutive failed polls → log the failing method → `exit(1)`.
  A supervisor restarts it or a human sees it. Never an infinite quiet loop.
- **`unhandledRejection` is FATAL**, not a log line.
- **`withRetry` matches rate limits by CODE** (`-32005`, `-32011`), text only as fallback.

### ⚠ THE LIVENESS ASSERTION IS HEAD-RELATIVE. NEVER REWRITE IT AGAINST A CLOCK.

`livenessVerdict()` compares the checkpoint to the **chain head**, and that distinction is
the whole value:

| head | checkpoint | verdict |
|---|---|---|
| moving | moving | healthy |
| still | still | **quiet chain — perfectly fine** |
| **moving** | **still** | **silently dead. This is the signature.** |

**On a wall-clock timer, rows 2 and 3 are identical** — both look like "no new rows for N
minutes" — so a timer either fires constantly on a quiet chain or is set so loose it never
fires. Against the head they are opposites. It catches every silent-death variant including
ones nobody has thought of, because it does not care *why* the checkpoint stopped.

Limit: **1,000 blocks** (~8 min at Arc's 0.48s blocks), 3 consecutive strikes, then
`exit(1)`. Strikes clear **only on a poll that actually kept up** — clearing on any
successful poll lets a permanently-lagging indexer alternate strike/reset forever and never
die. A `null` checkpoint counts as infinitely behind: unreadable is not evidence of health.

`indexer/scripts/verify-liveness.js` is 14 checks, all red-proved. The one that matters most
is **V1**, which fails the moment the rule is rewritten against time.

### ⚠ The checkpoint is MONOTONIC — two indexers will fight over it

`saveCheckpoint` refuses to lower the checkpoint. Found by running two instances **by
accident** while testing this fix: each catches up from its own start block and blindly
writes its own cursor, so the **slower one overwrites the faster one** and the checkpoint
goes *backwards*. Observed: `59782875` written, then `59776875` written over it.

Nothing corrupts — every handler is idempotent, so the range is just re-read — but the
indexer appears to make no progress while working hard, and the liveness check above would
eventually (correctly) kill it with the cause invisible. Refusing to lower it makes
concurrent instances merely wasteful instead of pathological, and costs one read.

**Before starting the indexer, check nothing else is already running it.**

## 11.12 Settled — do not re-argue

Same standing as §6.

- **The build step stays.** See `## Stack` for why the buildless constraint was revoked.
- **Quotes come from `quoteBuy`/`quoteSell` on the contract.** The JS curve math is gone and
  must never return (§1.3, §7C).
- **The default sort is `recentBuys`.**
- **Price impact is PRICE MOVE (18.55%), not token shortfall.**
- **The gas limit and the gas reserve are separate numbers.** The reserve is sized on the
  exit and is never derived from the limit.
- **i18n stays in-house on `Intl`.** The 17 kB gzip a library costs is not worth it here.
- **Bind wallets via EIP-6963.** Never go back to the generic `injected()` connector.
- **The indexer polls `eth_getLogs`. Live mode is never a subscription** — filters are
  unsupported on Arc, and a dead subscription reproduces the outage (§11.11).
- **The liveness check is head-relative, never wall-clock.** A quiet chain and a dead
  indexer are identical on a timer and opposite against the head.
- **Classify RPC errors by CODE.** Text matching is a fallback, and it is what broke.

---

## Stack

Solidity 0.8.24 · Hardhat · Foundry · Slither · Node.js · Supabase (Postgres + RLS) ·
**React + Vite + wagmi + viem frontend** · Arc Testnet (chainId 5042002) · Blockscout ·
Circle CCTP V2 — **required non-contract scope, see §8**

### The "no build step" constraint is REVOKED — 29 August 2026. Do not reinstate it.

This file previously specified a *"plain HTML/CSS/JS frontend, no build step"*, and
`FRONTEND_BUILD.md` and its successor both treated that as a standing constraint. **It is
revoked by the operator's decision, and the decision is not to be re-argued** — the same
standing as §6's settled forward decisions.

**Why it is recorded rather than just deleted.** A constraint that vanishes without a
reason gets reinstated by the next session that notices the frontend "should" be
dependency-free, and reinstating this one now means throwing away the rebuild. The old
constraint was not arbitrary — buildless meant no toolchain to break, no lockfile drift, and
a frontend anyone could read in a browser's view-source, which suited a project whose moat
is verifiability. It was outgrown rather than found wrong:

- **The CCTP onramp forces a build regardless.** Bridge Kit and App Kit are npm packages.
  `FRONTEND_BUILD_V2.md` Part II framed this as an open question with three options; the
  answer is now the whole app rather than one bundled module, which removes the
  awkward split it was trying to preserve.
- **The buildless engine had already duplicated and drifted.** `withRetry` existed in two
  versions across `terminal.html` and `create-token.html`, and only one of them handled
  rate limits — on an RPC this file records as stalling 150 seconds at a time. Duplication
  was the only sharing mechanism available without a bundler, and it silently rotted.
- **ethers does not decode custom errors on Arc**, so five sites reported "Unknown error"
  for every revert and needed a generated selector map to compensate. viem is claimed to
  handle this natively — verified in `REACT_REBUILD.md` Phase 0, not assumed.

**What does NOT change.** The nine hard rules in `FRONTEND_BUILD_V2.md` are the
specification for the rebuild and every one of them still applies — they are properties of
the *contract*, not of the rendering technology. The contract stays frozen; nothing in the
rebuild may cause a contract change. `scripts/verify-frontend-txshapes.js` must still pass,
because it is the check that proves the rebuild lost nothing.

`REACT_REBUILD.md` holds the spec, the phase plan, and the twenty-one known traps.
