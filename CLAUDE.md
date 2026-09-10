# Ballista

---

# RESUME HERE

| | |
|---|---|
| repo HEAD **when this was written** | `920acad`, on branch **`ballista-migration`**, tree clean, pushed. (Was `dc7e083`, and `f96f267` before that — the latter stood for six commits after it stopped being true, which is the drift the paragraph below warns about.) ⚠ **`git rev-parse --short HEAD` is ground truth; this line is a snapshot and rots the moment anything lands on top of it.** |
| deployed commit | `38e3e9e` — **not** the same thing, and it should not be. The contract is frozen; everything since is frontend. §7 carries this one. |
| contract | **FROZEN.** `0xEDeed1F05D34421Add0F59b7340588ab2BbaC04b`, verified, 24,033 / 24,576 — 543 free. Re-confirmed on chain this session: `eth_getCode` returns 24,033 bytes. |
| ✅ **ALL THREE WRITE PATHS PROVEN ON A REAL WALLET** | **Create, buy and sell, against real MetaMask, 2 September 2026. This closes the longest-open item in the project.** Round trip 246.89 → 246.778 USDC on a 5 USDC trade (~2.2% = two 1% fees plus gas). `wallet_watchAsset` prompted, imported, and MetaMask shows **1,991,519.04** — the correct figure, so decimals are right and trap 4 is clear. See §11.15. |
| tests | **255 Hardhat passing + 10 pending** (the pending ones are the `FORK=1` suite), **13 Foundry**, **187 frontend** across nine suites (11+22+14+44+39+13+**31 upload** counted, plus i18n/claims pass-fail), **11 anon-key RLS checks**. |
| tests NOT re-run | the **10 fork** checks (need a mainnet fork RPC) and the **14 live Arc-testnet R15** checks (need a funded key). Both passed when last run; neither was re-executed. |
| indexer | Code is fixed and correct (§11.11) but ⚠ **runs on a laptop and nothing supervises it.** Live mode now polls `eth_getLogs`; it must never go back to a subscription. |
| database | Migrations **000 + 001 + 002 + 003 + 004 all applied.** RLS re-verified with the **anon** key: **11/11**. View returns **34 columns**; the ROW counts are live data and are therefore not asserted here — they were 5/13/3 when first written and were 11 tokens / 28 trades / 15 candles on 5 September 2026. **Read them, do not quote them:** `node indexer/scripts/verify-anon-access.js` prints the token and trade counts as part of its 11/11. |
| frontend | **BUILT, and the create flow SHIPS — now with image upload.** React + Vite + wagmi + viem in `app/`. `/`, `/t/:address`, `/about`, `/create`. Price chart, toasts, focus states, Pinata uploads. ⚠ **No longer a purely static build**: `app/api/sign-upload.ts` is a serverless function (§11.17). Entry bundle **228.37 kB gzip**; the chart is a **55.20 kB lazy chunk** loaded only on a token page. |
| ✅ deployment | **LIVE IN PRODUCTION — this row said "nothing is deployed anywhere" until 4 September 2026.** Frontend at **`https://ballista.trading`** (Vercel project `ballista`, Root Directory `app`); indexer at **`https://ballista-indexer.fly.dev/health`** (Fly app `ballista-indexer`, one machine, `iad`). Both verified HTTP 200 this session. Full detail in `app/DEPLOY.md` and `indexer/RUNBOOK.md` — **read those before touching either**, they carry traps that cost real deploys. |

**That HEAD is stale the moment anything is committed on top of it.** It records where
this file was last updated, not where you are. `git rev-parse --short HEAD` is ground
truth; if the two differ, commits have landed since and anything below may have moved with
them. This file once carried **three different HEADs at once** — this table said `2d92cfe`,
§7 said `08be890`, and the repo was on `646e2ed`.

## The exact next action

⚠ **The previous version of this section is DONE and has been rewritten.** It said restart
the indexer, click through with a real wallet, and write migration 003. All three happened:
003 and 004 are applied, and **all three write paths are proven on real MetaMask (§11.15)**
— which closes the item every prior session had to record as unproven.

⚠ **SUPERSEDED AGAIN, 4 September 2026. IT IS NOW DEPLOYED.** This section said the project
was "feature-complete and operationally unstarted". Both the frontend and the indexer are
live in production and healthy — see the deployment row above.

**The ranked resume point is now §12 at the foot of this file. Read that, not the numbered
list below**, which is kept only because items 2-4 in it are still open.

**1. DEPLOY IT SOMEWHERE. STILL THE TOP ITEM — the deploy has NOT been run.**
Everything around it is now checked rather than merely written: `app/DEPLOY.md` carries
the settings and the full env-var table, the SPA rewrite excludes both the Google
verification file and `/api/` (asserted at build time, red-proved), the favicon set is
present and dimension-verified, source maps are off, and the safety grep was run on the
**real 74-file build output** — zero `service_role`, one JWT decoding to `role: anon`,
zero `.map` files. **Set `PINATA_JWT` (unprefixed) on Preview or image upload 503s.**
Mainnet is **16 September** and a launchpad nobody can reach is worse than a missing chart.

**2. GET THE INDEXER OFF A LAPTOP.** The code is correct and now fails loudly rather than
silently (§11.11), but nothing restarts it and nothing outside the process knows if it
stopped. A supervisor plus an external head-relative liveness ping is the whole job.

**3. TEST ON A REAL PHONE.** ⚠ *Partially done — an emulated 375×812 pass found zero
horizontal overflow on all four routes and caught one iOS zoom-on-focus regression.* What
an emulator cannot test is what remains: touch latency, the on-screen keyboard resizing the
viewport mid-form, and **a wallet's in-app webview**, which is where most memecoin trading
actually happens and which is a different browser from mobile Safari or Chrome. Six
pre-existing controls also sit under the 44px touch floor.

**4. Send the two Goldsky emails** (§11.17). No session can research them and the provider
recommendation rests on them.

**Do NOT start:** V4, holders (dropped from scope — per-token `Transfer` indexing is not
worth it now), or anything on the contract. The contract is closed.

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
npm run verify                       # every suite; prints SUITES=n CHECKS=n FAILED=n
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

**Circle's own `use-arc` skill is vendored at [`docs/CIRCLE_use-arc.md`](docs/CIRCLE_use-arc.md)** — a byte-for-byte snapshot (sha256 `c67e5e9dd4fe40fd`), NOT a live source, and it names the undocumented `rpc.testnet.arc.network` where we deliberately use `.io` (§9.5, §18.6).

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
| **Mainnet chainId 5042** | ✅ **PRIMARY-SOURCED — corrected 3 September 2026.** Previously recorded here as an unverified secondary-source claim. It is not: `MAINNET_CHAIN_ID = 5042` appears in `circlefin/arc-node`, `crates/shared/src/chain_ids.rs`, and v0.7.0's breaking-changes entry refers in prose to "mainnet (chain id `5042`)". Testnet remains `5042002`. Still do not hardcode it in the frontend — §10's fetch-and-verify-at-runtime rule is about deployment discipline, not about doubt over the number. |

## Zero8 — Arc Testnet, 3 September 2026, 15:00 UTC

⚠ **THIS SECTION PREVIOUSLY SAID ZERO8 HAD "no consensus-affecting behaviour changes".
THAT WAS WRONG, AND THE ERROR IS INSTRUCTIVE — corrected 3 September 2026.**

Circle's own description (Arc House blog, `arc-testnet-v080-hardfork-2026-08-28`) is a
**protocol-correctness upgrade that updates gas accounting and state-clearing semantics at
the execution layer, without introducing new developer-facing APIs.** The old wording read
"no new developer-facing APIs" as "nothing changes for us". **Gas accounting is not an API
surface.** Every gas figure in this repo was invalidated by it, and nothing said so.

⚠ **`BREAKING_CHANGES.md` IS NOT A LOCAL FILE AND CANNOT ANSWER THIS QUESTION.** It is
`https://github.com/circlefin/arc-node/blob/main/BREAKING_CHANGES.md`. It has **no v0.8.0
entry**, and by its own scope statement it never will have a useful one: every entry is
tagged `[CLI]`, `[Config]` or `[Format]` and split between "For Validators" and "For Node
Operators". It is a node-operator changelog. **There is no published description of what
Zero8 changed for dapps, so measurement is the only source of truth** — see the
re-measurement below and `scripts/measure-gas-post-zero8.js`.

**MEASURED AFTER ACTIVATION, 3 September 2026 15:50 UTC** (activation was 15:00 UTC), on
the live deployment:

| | pre-Zero8 (recorded) | post-Zero8 (measured) |
|---|---|---|
| buy `eth_estimateGas` | 143,576 | **178,560** |
| buy actual `gasUsed` | 194,372 | **167,436** |
| actual / estimate | **1.354** — estimate 26% BELOW actual | **0.938** — estimate 6.6% ABOVE actual |
| sell actual | 119,254 | 114,418 |
| first-time approve | 47,110 | 46,463 |
| exit (sell + approve) | 166,364 | **160,881** |

⚠ **THE 26% ESTIMATOR SHORTFALL IS GONE AND INVERTED.** Every operation now estimates at
or above actual (ratios 0.886–0.992). That shortfall was the ENTIRE stated justification
for `GAS_LIMIT_MULTIPLIER_X10 = 30n`, so **the reason recorded in §11.5 is now obsolete
even though the value is still defensible** — see §11.5.

`scripts/smoke-r15.js` re-run post-Zero8: **14/14 passing.** The state-based assertions
survived, which is exactly what they were rewritten for.

⚠ **The revert text did NOT change.** This section predicted revm 38's `OutOfFunds`
replacing `insufficient funds for gas * price + value`. Measured post-Zero8, the text is
**still `insufficient funds for gas * price + value`**. The codes-first rule (§11.18) is
unaffected and still correct — but the specific prediction was wrong, and nothing in the
repo depended on either string.

The contract is unaffected and R15 stands.

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
| `_quoteBuy` L391 | `CurveMathError` | **proven** unreachable |
| `_quoteSell` L533 | `CurveMathError` | **proven** unreachable |
| `_quoteBuy` L415 | `ClampCostExceededOffer` | **evidenced**, 2,000,000 fuzz cases, zero firings |
| `_quoteSell` L554 | `ClampInputExceededOffer` | **evidenced**, same |

The two `CurveMathError` proofs, checked independently this session rather than accepted:
`newVirtualUsdc >= virtualUsdcReserves` gives `k/newVirtualUsdc <= virtualTokenReserves` as
reals, and since `virtualTokenReserves` is an integer, `ceilDiv` cannot exceed it — with
equality only when the input is zero. `_quoteSell` is the same argument with the operands
swapped. Both are defensive assertions against a condition the arithmetic forbids.

⚠ **`guard-coverage.jsonl` IS NOW TRACKED, and committing it immediately caught a doc
error.** It was gitignored as "regenerated, never authored" — which is true of the file and
wrong about its role: it is the EVIDENCE for the freeze gate this section rests on, and a
claim whose evidence a fresh clone cannot see is a claim nobody can check without a ~2h
re-run.

The first thing tracking it exposed: the survivor line numbers in the table above read
392/416/534/555 and the log says **391/415/533/554**. The log is right — those are the
`if (!(...)) revert` statements; the doc's numbers pointed at a variable assignment and two
closing braces, which are not guard sites at all. Corrected above.

⚠ **THIS PREVIOUSLY CLAIMED R12 AND R17 LANDED AFTER THE SWEEP. IT IS BACKWARDS —
corrected 3 September 2026 by reconstruction, since the file records no commit.**

Reading those four line numbers at each contract-touching commit settles it:

| commit | L391 | L415 | L533 | L554 |
|---|---|---|---|---|
| `08be890` (pre-R12) | blank | assignment | blank | assignment |
| `7ffd720` (R12) | `_ceilDiv` assignment | blank | `_ceilDiv` assignment | blank |
| `dceebc0` (R17) | **guard** | **guard** | **guard** | **guard** |
| HEAD | **guard** | **guard** | **guard** | **guard** |

So **the sweep ran at or after `dceebc0` (R17), not before it.** `git diff dceebc0..HEAD --
contracts/LFX1.sol` is empty, so the recorded numbers are valid at HEAD — but by luck
rather than by record.

⚠ **The line numbers are only meaningful against the commit the sweep RAN on**, so a future
edit to `LFX1.sol` will silently invalidate them without
invalidating the score. Re-read the file rather than trusting the numbers if the contract
has moved.

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
- Arc RPC: keep `batchMaxCount: 1` in raw ethers.js provider config — but ⚠ **the stated
  reason was wrong and there is now a real number (corrected 3 September 2026).** Since
  arc-node **v0.7.2**, `--arc.rpc.max-batch-entries` defaults to **100**, and an oversized
  JSON-RPC batch is rejected with **`-32600`** before any per-entry handler runs. So Arc
  does not reject batching as such; it caps it, and the cap is 100, not 1. **Multicall3 is
  a different mechanism entirely** — one `eth_call` — and is unaffected by this limit.
  The conservative setting is kept because viem defaults batching off anyway and nothing
  has re-measured behaviour under load, not because batching fails.
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
  ⚠ **SUPERSEDED AS TO THE VENUE, 6 September 2026 — see §17.** v4 IS the graduation
  venue by operator decision. The prohibition on building **phase 2** (the hook, the
  escrow) still stands; the claim that mainnet ships v2 does not. v2 remains the
  fallback and is unmodified (§17.3).
  ⚠ **STILL BINDING, but the strategic direction has moved — see §14.6.** The intent is now a v4 graduation with a fee-capturing hook, phased. That spec is **unwritten and unapproved**, and this rule is not lifted. What §14.1 changes is the *reason*: v4 is a choice about fee capture, not a prerequisite, because the v2 router is published and the frozen `addLiquidity` interface works against it unmodified.
- **The zero-fee-pool rationale is LP fee dilutability** — anyone can add liquidity to a permissionless v4 pool and take a pro-rata share of LP fees. It is **not** "Uniswap charges a fee on top of ours". That reasoning was wrong and must not reappear.
- **Under a zero-fee pool the position accrues nothing, so the hook is the fee accountant and the locker is a tombstone.** *(Corrected: an earlier version of this file said the locker "must be able to call `PositionManager` to collect fees and manage the position." That is wrong under a zero-fee pool and has been removed.)*
- **Burn vs locker for the v4 position is OPEN**, pending the operator's recommendation. `PositionManager` uses **`_mint`, not `_safeMint`** (L369, solmate base), so a position can go to a non-receiver address without reverting — graduation will **not** revert regardless of what the recipient implements.
- **No unvalidated calldata may ever be forwarded to `PositionManager` or `PoolManager`.** A reported launchpad exploit forwarded user-supplied calldata into `multicall()`; the attacker injected `setApprovalForAll` and swept every custodied position. All calldata must be constructed internally from validated parameters.
## ⚠ UNISWAP V2 **IS** PUBLISHED FOR ARC. A previous conclusion said otherwise and was wrong.

**Corrected 5 September 2026.** A strategy session concluded there is no canonical Uniswap
V2 on Arc, and several sessions were built on that. **It is wrong, and the way it went
wrong is the reusable part:** the conclusion came from Uniswap's chain playbook, which
enumerates the `ChainAddresses` struct — v3 factory, SwapRouter02, v4 PoolManager, v4
Quoter. **V2 is not a member of that struct.** It lives in two separate top-level maps,
`V2_ROUTER_ADDRESSES` and `V2_FACTORY_ADDRESSES`, which the playbook does not surface.

**The answer was drawn from a list that structurally could not contain it.** Before
concluding "X is absent", establish that the source you are reading is one where X *could*
appear.

**Source for every value below:** `github.com/Uniswap/sdks`,
`sdks/sdk-core/src/addresses.ts`, branch `main`, **read 2026-09-05**.

| what | address | where in the SDK |
|---|---|---|
| **v2 router** | `0x1f7d7550b1b028f7571e69a784071f0205fd2efa` | `V2_ROUTER_ADDRESSES[ChainId.ARC]` |
| **v2 factory** | `0x89e5db8b5aa49aa85ac63f691524311aeb649eba` | `V2_FACTORY_ADDRESSES[ChainId.ARC]` |
| v3 core factory | `0xf0db7b58379503491d857db50ac9ece64c653918` | `ARC_ADDRESSES.v3CoreFactoryAddress` |
| multicall | `0x33e885ed0ec9bf04ecfb19341582aadcb4c8a9e7` | `ARC_ADDRESSES.multicallAddress` |
| quoter | `0x7dfd4f31be6814d2906bde155c3e1b146eac1468` | `ARC_ADDRESSES.quoterAddress` |
| NF position manager | `0x39654a85a4c05127f5fd6ed22caec077a0fb1377` | `ARC_ADDRESSES.nonfungiblePositionManagerAddress` |
| tick lens | `0x9eb8600665b55d10c1eb2316ca5127a9ca6e2e76` | `ARC_ADDRESSES.tickLensAddress` |
| SwapRouter02 | `0x53bf6b0684ec7ef91e1387da3d1a1769bc5a6f77` | `ARC_ADDRESSES.swapRouter02Address` |
| v4 PoolManager | `0x8366a39cc670b4001a1121b8f6a443a643e40951` | `ARC_ADDRESSES.v4PoolManagerAddress` |
| v4 PositionManager | `0x6049c9a0e26405c0985f9e3685c87d0ae917f82b` | `ARC_ADDRESSES.v4PositionManagerAddress` |
| v4 StateView | `0xf3334192d15450cdd385c8b70e03f9a6bd9e673b` | `ARC_ADDRESSES.v4StateView` |
| v4 Quoter | `0x8dc178efb8111bb0973dd9d722ebeff267c98f94` | `ARC_ADDRESSES.v4QuoterAddress` |

**⚠ CONSEQUENCE, AND IT IS THE LOAD-BEARING ONE: the frozen contract already works on Arc
mainnet with no new contract at all.** `IDEXRouter.addLiquidity` is a V2-signature call and
`0x1f7d7550…` is a V2 router, so graduation needs no adapter to function. **Any v4 work is
therefore a CHOICE about fee capture, never a prerequisite for graduating.** Do not let a
future session record "we need an adapter or graduation is broken" — that is false.

### ⚠ Provenance — these are not unattributed addresses

`git log -S` (run 5 September 2026): **both `0x1f7d7550…` and `0x6049c9a0…` entered the
repo in `546a531`, "Timed creator window, custom errors, and the comment strip"**, sourced
from that same SDK file. `0x89e5db8b…` entered there too and was later touched by `6e7d16f`
and `13920eb`. The §11 concern about where they came from is **closed**.

A commit about creator windows is a poor home for two mainnet addresses, which is why the
record lives here now rather than only in a diff nobody will think to search.

### ⚠ CAVEAT — PUBLISHED IS NOT DEPLOYED. `eth_getCode` EVERY ONE BEFORE DEPENDING ON IT.

These are **SDK entries for a chain whose mainnet has not opened**. They may be
deterministic addresses published *ahead of* deployment rather than confirmations that code
exists at them. The SDK is a manifest, not a chain.

The strongest evidence that they are deterministic rather than observed: **`0x1f7d7550…`
appears elsewhere in the same file as Robinhood's v3 factory and as Ink's mixed-route
quoter** — the same address in three different roles on three different chains, which is
exactly what CREATE2-style cross-chain deployment produces and is impossible for
independently-deployed contracts. *(Reported by the strategy session from its own read of
`addresses.ts`; not re-verified here, because the SDK is not installed and this pass fetched
nothing.)*

So: **every address above requires `eth_getCode` on Arc mainnet before anything depends on
it** — and, per §10, **the probe must first be validated against three known-good addresses**,
because a probe that returns empty for everything proves nothing.
`scripts/refreeze-preflight.js` already does exactly this and returned `0x` (NO CODE) for
both v2 addresses on *testnet*, which is expected and is not evidence either way about
mainnet.

---

# 7. CURRENT STATE

| | |
|---|---|
| deployed commit | `38e3e9e` — **the commit the frozen bytecode was built from, NOT the repo HEAD.** Repo HEAD is `920acad` (it read `dc7e083` before that, and `f96f267` for six commits after THAT stopped being true); the gap is entirely frontend work and the contract has not moved. Keep these two labelled differently, because this file has carried three conflicting HEADs before. |
| bytecode | **24,033 / 24,576 — 543 free.** Verified on chain this session: `eth_getCode` on the factory returns 24,033 bytes. |
| tests | **255 Hardhat passing + 10 pending** (pending = the `FORK=1` suite, skipped without it), **13 Foundry** (`forge test`, 3 suites). ⚠ **Re-measured 5 September 2026: 664s wall / 1,472s CPU, not the 205s recorded here** — budget ~11 minutes, not ~3. Both counts re-run and green that day. The **14 live R15** checks and the **10 fork** checks were **not** re-run — they need a funded key and a fork RPC respectively. |
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
- **Indexer: code CORRECT, hosting UNSOLVED.** *(This entry has read "not started", then
  "WORKING", then "STALLED" across three sessions. The churn is the point: it is the one
  component whose state has to be MEASURED rather than recalled — compare
  `indexer_state.last_processed_block` against `eth_blockNumber` before believing any of
  it.)* Live mode was silently dead for 29 hours and is now fixed (§11.11): it polls
  `eth_getLogs`, fails loudly after 5 consecutive errors, treats unhandled rejections as
  fatal, and carries a head-relative liveness assertion. ⚠ **It still runs on a laptop with
  no supervisor and no external alerting**, which is now the risk rather than the code.
  - **⚠ MIGRATIONS 003 AND 004 ARE APPLIED, and 003 exists because of a live bug.**

    **`trades.created_at` is the INDEXER'S INSERT TIME, not the block time.** The insert
    never supplied it, so it defaulted to `now()`. Measured against every trade row and its
    block's real timestamp:

    | block | `created_at` | actual block time | drift |
    |---|---|---|---|
    | 59446076 | 2026-08-29 14:54:35Z | 2026-08-29 13:37:04Z | 1.3 h |
    | 59458963 | 2026-08-30 22:21:12Z | 2026-08-29 15:29:51Z | **30.9 h** |

    The 30-hour rows were ingested during a catch-up after downtime. So the **existing
    `volume_1h_usdc` column was reporting 31-hour-old trades as one-hour volume** on the
    live site, and any restart after downtime re-stamps history as "just now".

    **003** adds `trades.block_time` (from the chain), `tokens.curve_token_supply`, and to
    the view: `last_buy_block`, `last_buy_at`, `volume_24h/7d/all_usdc`, `market_cap_usdc`,
    `symbol_collision_count`, `name_collision_count`, `volume_windows_exact`. Every window
    filters on `COALESCE(block_time, created_at)`.

    ⚠ **`curve_token_supply` holds CURVE_TOKEN_SUPPLY (807M), not TOTAL (1,000M).** Market
    cap is price x CIRCULATING supply, and the 193M LP reserve cannot be sold into the
    curve. Using the total would overstate every market cap by 1.24x. **Graduated tokens
    are a different question this column does not answer** — after graduation the 193M IS
    tradeable, so MC and FDV genuinely diverge. Flagged, not solved.

    **The backfill ran: 10 trades, 4 tokens, worst drift 30.9 h corrected, zero remaining.**
    `volume_windows_exact` then **cleared itself to true on every token with no manual
    flag**, and `volume_24h_usdc` correctly dropped to 0 — those trades really are older
    than 24h once `block_time` is real. Before the backfill they counted as recent.

    **004** adds `trades.virtual_usdc_reserves` / `virtual_token_reserves` (the POST-trade
    curve state) and the `token_candles_1m` view. Written from the read the indexer
    ALREADY makes — `updateReservesFromChain` now returns what it read and `handleTrade`
    was reordered read-then-insert, so the chart costs **zero extra RPC calls**. See §11.13
    for why execution price cannot be charted.

    ⚠ **Rows written before 004 have no reserves and are invisible to the chart.** They are
    not backfillable: the curve state at that block is unrecoverable from the row, and
    re-deriving it would mean re-implementing the curve math (§1.3).

    **Both files were parsed with the real PostgreSQL grammar** (`pgsql-parser`,
    libpg-query WASM) before applying — 003 is 9 statements preserving all 24 pre-existing
    columns, 004 is 8. `rollbacks/003_list_page_columns.ROLLBACK.sql` (moved out of the numbered
    sequence 3 September 2026 — as `003_ROLLBACK.sql` it sorted BEFORE
    `003_list_page_columns.sql`, so "apply everything in order" ran the rollback first)
    restores the previous view and its grants, with
    the body extracted programmatically from `000_base_schema.sql` rather than retyped and
    proven column-for-column against the live view.
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

⚠ **THIS TABLE'S COUNTS ARE HISTORICAL AND ARE KEPT ONLY TO SHOW WHAT EACH SUITE COVERS.**
It read "143 frontend checks across seven suites", which was true when written and was wrong
for months afterwards. **Do not quote a number from here.** `npm run verify` in `app/` prints
the live figure as its last line — `SUITES=n CHECKS=n FAILED=n` — and that is the only
figure worth repeating (§13.7). The per-suite rows below have drifted too; run
`npm run verify:<name>` for any one of them.

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
| `1e3fdb7` | CLAUDE.md re-grounded against the repo |
| `6860f6b` | WalletConnect wired; the fallback bug it exposed |
| `b904009` | BRIEFING.md, for a chat with no repo access |
| `c3fdb0d` | item-2 display fixes, schema decisions, 003 rollback |
| `b38dcf2` | **indexer live mode: poll `eth_getLogs`, make silent death impossible** |
| `af781fd` | `useQuote`: 1s in the snipe window, 30s after |
| `9d15a97` | **migration 004: per-trade reserves and the candle view** |
| `b92f69b` | **Phase 4 — the create flow, R13 red-proved** |
| `72bd41e` | Vercel preview config and the SPA rewrite |
| `ed0f8a5` | create + trade fixes from the first real click-through |
| `753089f` | **the price chart, mid-price from reserves** |
| `72987cb` | sell-side price impact, which never computed |
| `f96f267` | **interaction pass: focus, pending, toasts** |

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

**Limit = `estimate × 3.0`** (`GAS_LIMIT_MULTIPLIER_X10 = 30n`).

⚠ **THE ORIGINAL JUSTIFICATION NO LONGER HOLDS — re-measured 3 September 2026, post-Zero8.**
It was raised from 1.5 because `estimateGas` returned **143,576** against **194,372**
consumed — the estimate came in **26% BELOW reality**, so the ratio to cover was 1.354 and
x1.5 left ~11% real headroom, not 50%.

**Zero8 changed gas accounting and that shortfall is gone and inverted.** Measured on the
live deployment: buy estimate **178,560**, actual **167,436** — ratio **0.938**, i.e. the
estimate now sits 6.6% ABOVE actual. Every operation measured the same way (0.886–0.992).

**The value is kept at ×3.0 anyway, on the reason that survives:** no measured buy has ever
triggered a **graduation**, which does strictly more work than anything in the sample — it
seeds a pool, moves the LP, and writes the one-way state transition. The asymmetry is also
unchanged: unused gas is refunded, so an oversized limit costs only a slightly higher
balance bar, while an undersized one fails the most important transaction in the product.

⚠ **Do not now "optimise" this down to ×1.5 citing the new ratios.** One sample per
operation, taken 50 minutes after a hard fork, is not a basis for shaving headroom off the
graduating buy. What changed is the ARGUMENT, not the conclusion — and the old argument
must not be quoted again, because it is no longer true.

**Reserve = 249,546 units**, sized on the **EXIT**, not on the limit. Worst observed sell
**119,254** + first-time approve **47,110** = 166,364, plus 50%.

✅ **Still correct post-Zero8, re-measured 3 September 2026.** The exit now costs
**160,881** (sell 114,418 + first approve 46,463), so 249,546 covers it with **1.55x**
margin — slightly more conservative than when it was set. No change needed.

It is sized on the exit because
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

⚠ **Re-read as of 2 September 2026.** The single largest item on this list — the unexercised
signature path — is CLOSED (§11.15). What remains is mostly operational, and the
operational gaps are now the project's real risk rather than the code.

| item | state |
|---|---|
| ~~NOTHING IS DEPLOYED ANYWHERE~~ → **DEPLOYED 4 September 2026** | Frontend on Vercel at `ballista.trading`, indexer on Fly at `ballista-indexer`. See `app/DEPLOY.md` and `indexer/RUNBOOK.md`. **The pre-deploy note is kept below because its CHECKS are still the ones that matter — read it as history, not as current state.** *(Historical, 2 September:)* the config is now checked rather than merely written — the safety grep was run on real build output (74 files, one JWT, `role: anon`, zero `service_role`, zero source maps), the favicon set is present and dimension-verified, and the SPA rewrite's two exclusions are asserted at build time and red-proved. The deploy itself remains un-run. |
| **No runbook, no rollback plan, no user docs** | None exist. Not started, not scheduled. Mainnet is 16 September. |
| **The indexer runs on a laptop** | No host, no supervisor, no external alerting. The code is correct and fails loudly now (§11.11), but a process that dies on a closed laptop is still dark. The liveness check is head-relative and exits(1); nothing restarts it. |
| **Mobile: FIRST PASS DONE, unproven on real hardware** | ⚠ *This row read "never tested — not once". Corrected 2 September 2026.* All four routes were driven at **375×812** and MEASURED rather than eyeballed: **zero horizontal overflow on `/`, `/about`, `/create` and `/t/:address`**. The card grid and trade panel — the two surfaces this row predicted would break — do not. `.input` was already 16px/44px, so iOS zoom-on-focus was largely handled before this session. **Exactly one regression found and fixed, my own**: the new `.upload-uri` at 12px was the single text field on `/create` that would have triggered Safari's zoom-and-stay-zoomed. **Still open:** six pre-existing controls sit under the 44px touch floor (nav links 22px, Connect 40px), and **nothing has been opened on a real handset** — an emulated viewport tests layout and nothing else: not touch latency, not the on-screen keyboard resizing the viewport, and not a wallet's in-app webview, which is where most memecoin trading actually happens. |
| **zh-Hans is 7 of 239 keys, and there is no translator** | The decision (en + zh-Hans ship, ko cut) is unchanged and the plumbing is enforced at build. `locales.ts` still ships `en` only. This needs a person, not a session. |
| **Arc mainnet chainId UNSOURCED** | `5042` came from a secondary source; Circle documents only `5042002`. Do not hardcode it. |
| **Uniswap V2 unverified on mainnet** | `eth_getCode` on **testnet** returns NO CODE for the mainnet router and factory, which is expected. The same one-line check is the gate on mainnet and has not been run there because mainnet does not exist. |
| **Goldsky Edge: two unanswered questions** | Mainnet coverage for Edge specifically, and the rps ceiling. Both need an email; see §11.17. The provider recommendation rests on them. |
| ~~Image upload designed, not built~~ → **BUILT** | Shape B shipped: `api/sign-upload.ts`, `src/lib/upload.ts`, `src/lib/ipfs.ts`, `components/create/ImageUpload.tsx`. **31 checks in `verify:upload`, 8 mutations red-proved.** ⚠ The project is **no longer a purely static build** — see §11.17. Unverified end-to-end: no upload has run against a real `PINATA_JWT`. |
| **Supabase 401s bounded but UNIDENTIFIED** | The app degrades correctly and RLS is 11/11, but the cause of intermittent 401s was never root-caused. |
| **Supabase under load never benchmarked** | The list query runs a grouped pass over `trades` per request. Free at 13 rows; unmeasured at launch volume. ⚠ `EXPLAIN ANALYZE` cannot run through PostgREST — it needs the SQL editor or a connection string. |


## 11.11 The indexer's live mode — filters, and how it went dark for 29 hours

⚠ **Live mode POLLS `eth_getLogs`. It is not a subscription, and it must not become one.**

### Arc does not support filters. Measured 31 August 2026, on BOTH hosts.

| method | `rpc.testnet.arc.io` | `rpc.testnet.arc.network` |
|---|---|---|
| `eth_newFilter` | ~~`-32603 internal error`~~ → **`-32601 method not supported`** | same |
| `eth_newBlockFilter` | ~~`-32603`~~ → **`-32601`** | same |

⚠ **THE ERROR CODE CHANGED, AND THE RATIONALE BELOW IS NOW STALE. Re-measured on BOTH
hosts, 5 September 2026: both filter methods return `-32601 method not supported`, not
`-32603 internal error`.** Circle appears to have fixed the bug this section was written
about — `-32601` is the standard "method not found" code, and §11.11 itself says that had
Arc returned it, ethers' downgrade-to-polling fallback would have fired and the 29-hour
outage would not have happened.

**The polling design still stands and must not change.** Its justification was never the
error code: a dropped or silently-dead subscription reproduces the outage regardless of
how the failure is reported, and polling from the checkpoint is self-healing. Only the
REASONING below is out of date, not the conclusion. Measured with viem 2.56 the same day:
`createContractEventFilter` throws, viem's bare `catch {}` engages the `getLogs` fallback
correctly, and `getContractEvents` returns our `Trade` events — so viem, unlike ethers,
handles this properly either way.
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

⚠ **These two were NOT re-measured when `eth_newFilter` was re-measured on 5 September 2026.**
That check covered `eth_newFilter` and `eth_newBlockFilter` only, both of which moved from
`-32603` to `-32601`. Do not assume these moved with them — a neighbouring value changing is
not evidence about this one.

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

## 11.13 The price chart — and why EXECUTION price is unchartable

⚠ **The chart plots CURVE MID-PRICE, derived from reserves. Never `usdc_amount / token_amount`.**

This is the finding that would otherwise be re-derived wrongly, so the evidence is here
rather than a conclusion. Derived from the trade rows that already existed:

| block | side | usdc | tokens | price |
|---|---|---|---|---|
| 59446076 | BUY | 2.0000 | 153,147 | **$1.306e-5** |
| 59446082 | SELL | 0.1881 | 76,573 | **$2.457e-6** |
| 59446156 | BUY | 2.0000 | 153,147 | $1.306e-5 |
| 59446162 | SELL | 0.1881 | 76,573 | $2.457e-6 |

**A 5.3x sawtooth between ADJACENT trades at the SAME reserve level.** That is not the
market — it is the snipe tax and the fees. `usdc_amount / token_amount` is the effective
EXECUTION price including tax, so charting it draws the fee schedule. And it is worst
exactly where it does the most damage: the tax opens at 9800 bps, so **every new token's
chart would have begun with an enormous spike that means nothing**, at the moment the
creator and their first buyers are looking hardest.

**The same two trades, priced from reserves, measured after 004 landed:**

```
buy   2.4901e-6
sell  2.4809e-6     0.4% apart
```

That 0.4% is the curve actually moving. **The pair is recorded here because it is the
proof.** Anyone who reaches for `usdc_amount / token_amount` should be able to see, in one
table, that it was tried and what it produced.

### Empty minutes are not gaps

On a bonding curve price is a pure function of reserves, and reserves change ONLY when
someone trades. Between trades the price is **exactly** constant, so carrying the last
close forward is arithmetic rather than interpolation and a flat candle is a true
statement. Confirmed against pump.fun, whose own API exposes the same virtual/real reserve
pair — **they are not doing anything clever, because there is nothing clever to do.**

### Decisions

- **A LINE, not candles.** Almost every bucket holds one trade or none, so candlesticks
  render as a column of identical doji — all the ink of OHLC conveying the information of a
  line. `token_candles_1m` already carries open/high/low, so candles can be adopted the day
  a bucket holds many trades.
- **A token with no trades gets a FLAT LINE FROM CREATION, not an empty panel.** The curve
  defines a price from its opening reserves whether or not anyone has traded. This is every
  brand-new token, which is when the chart matters most.
- ⚠ **"No trades yet" and "history unchartable" are DIFFERENT STATEMENTS.** The first
  version said "No trades yet" on a token that had traded five times — its rows predate 004
  and carry no reserves, so there is genuinely nothing to draw. Saying "no trades yet" there
  is checkably false. `isHistoryUnchartable` is a separate state.
- **Library: `lightweight-charts` 5.2.1.** Entry bundle 222.64 → **225.69 kB gzip, +3.05 kB
  on first paint**; the library is a **55.20 kB lazy chunk** loaded only on a token page.

## 11.14 Phase 4 — the create flow, shipped

`/create` exists and has launched a real token on a real wallet. The rules that cost money
live in `lib/create.ts`, red-proved in `verify:create` (13 checks).

- ⚠ **R13. The creation fee is approved for an EXACT amount, never `MaxUint256`.**
  `creationFeeUsdc` is one of only two values NOT in `currentEconomicsHash()`, so the
  pinning guard cannot fire on a change to it and **the creator's approval is the only bound
  on the exposure**. Red-proved: returning `MAX_UINT256` fails three rows.
- ⚠ **The economics hash is fetched INSIDE the submit handler**, in the same action that
  sends the transaction. Never a hook, never cached. A hash read at page load is stale by
  definition; submitting it either reverts `EconomicsChanged` (the good case) or pins terms
  the creator never saw. The test reads the SOURCE so it cannot pass against a copy.
- **Symbols over 11 characters WARN, never block.** `wallet_watchAsset` caps at 11; the
  contract validates nothing. Blocking would make this UI stricter than the chain, and the
  same token would launch fine through the contract directly.
- ⚠ **AFFORDABILITY COVERS FEE PLUS GAS FROM ONE BALANCE.** A creator holding **exactly
  0.5 USDC cannot afford to send 0.5 USDC**, because USDC is also the gas token. This is
  R15 reappearing in a new place and it will keep reappearing; any new payment path must
  price the gas out of the same balance.

**Trading approvals are a DIFFERENT hazard and are deliberately not the same rule.** The
trade panel approves the exact trade amount, and that is bounded by terms which ARE hashed
and snapshotted per curve — so a standing trading approval cannot be moved underneath the
user. R13 is specifically about the creation fee.

**Metadata:** one "Image or metadata URL" box became Image / Description / X / Telegram,
assembled into the JSON the token page and indexer already read. A bare image URL with
nothing else stays **unwrapped**, so a creator with only a picture gets a URI any other
explorer can render.

## 11.15 ✅ Verified against a real wallet — the longest-open item, closed

**2 September 2026. Create, buy and sell, all three write paths, against real MetaMask.**

This was open from the beginning of the frontend work and is the item every previous
session had to record as unproven.

| | |
|---|---|
| round trip | **246.89 → 246.778 USDC** on a 5 USDC trade — ~2.2%, which is the two 1% fees plus gas |
| sell | 100% preset filled the full balance, estimated 4.90, **received 4.898** |
| the panel | quoted a number the contract honoured |
| approval | **1,991,519** — the exact amount, not `MaxUint256` |
| `wallet_watchAsset` | **prompted, imported, MetaMask shows 1,991,519.04** |

⚠ **Decimals are confirmed correct on a real wallet.** 18, not 6. Trap 4 is clear — a token
imported with the USDC number would have rendered a balance 1e12x too large.

**The original silent `watchAsset` failure did not reproduce** once the error path reported
properly. The bug the diagnostic was built to find may not exist; the diagnostic is kept,
because what it replaced was a `catch {}` that collapsed three different failures — user
declined, MetaMask refused the params, provider unreachable — into one quiet grey line.
**An error we swallow is a bug we cannot see.**

## 11.16 The interaction pass, and two button-state bugs

**Focus was at ZERO.** Not one `:focus-visible` rule existed, no button had any focus
style, and `.input:focus` actively REMOVED the outline in favour of a border-colour change
that fails contrast. The app was unnavigable by keyboard. One universal
`:where(a, button, input, textarea, select, summary, [tabindex]):focus-visible` rule now
covers everything, so a control added later inherits it. Verified in-browser: **20 of 20
focusable elements covered, zero uncovered.**

### ⚠ Two real bugs, both in the trade button's state

1. **`busy = writing || confirming || quoting`** disabled the trade button every time a
   QUOTE refreshed — **once per second during the snipe window**. A control that flickers
   unusable while someone is pressing it is worse than a stale number, and the two states
   are unrelated: one is "we are re-reading a price", the other is "a transaction is in
   flight". Refreshing now shows on the FIGURES; the button reflects only the transaction.

2. **`useWriteContract().isPending` only goes true once `writeContractAsync` is CALLED** —
   and `submit()` re-quotes, checks affordability and estimates gas first. That whole
   stretch was **a live, enabled Buy button doing invisible work**: the dead interval
   between clicking and MetaMask appearing, and the double-click window Phase 6 lists as an
   attack. An explicit `submitting` state covers the entire path, set on the first line and
   cleared in `finally` so a throw cannot strand the button disabled.

**Toasts.** Success carries the RECEIPT'S number — the same string decoded from the
transaction's own `Trade` event, never the quote (trap 6). Failure carries the decoded
reason. A user rejection is a decision, not a failure, and gets no error toast.
**Successes auto-dismiss; failures do NOT** — a reason that vanishes after six seconds is a
reason nobody reads.

**`prefers-reduced-motion`** was already handled by a global block that neutralises
animation duration with `!important`. Transforms are not animations, so the press nudge is
neutralised explicitly. Four blocks live; none added redundantly.

## 11.17 Infrastructure decisions — RPC provider and image upload

### RPC: Goldsky Edge as primary, Alchemy as failover

**Goldsky is the only provider with a confirmed Arc mainnet answer** (launch partner, all
products day one, confirmed by email). Alchemy, QuickNode, Blockdaemon and dRPC publish
**testnet endpoints only**, and Arc's docs state mainnet addresses are not yet available —
so "does provider X support mainnet" is currently unanswerable for all of them.

**Edge is a general-purpose JSON-RPC endpoint at a FLAT $5 per million requests, no compute
units.** That is a structural fit rather than merely a cheaper number: **flat pricing and
multicall compound.** Eight reads collapsed into one `eth_call` bills as ONE request; under
weighted CU the same call bills 26 regardless, so the batching work partly cancels itself.

⚠ **TWO QUESTIONS ARE OPEN AND THE RECOMMENDATION RESTS ON THEM.** Both need an email, and
no session can research them:

1. Does the day-one mainnet guarantee cover **Edge specifically**, or only Turbo and
   Subgraphs?
2. **What is Edge's rps ceiling?** Goldsky publishes that limits exist but not the numbers.
   The rate limit is the binding constraint, not monthly quota — Alchemy free caps at 25
   rps and QuickNode's $49 tier at 50, and graduation-day traffic spikes.

⚠ **CU is NOT comparable across providers.** Blockdaemon's $0.0000425/CU is $42.50 per
million against Alchemy's $0.45 — ~94x. That is a unit-definition difference, not a price
difference, and it could not be resolved: their CU table is not published where it could be
found. Do not compare those columns directly.

### Multicall3 was ALREADY active, and nobody knew

`chain.ts` spreads viem's built-in `arcTestnet`, which ships
`contracts.multicall3 = 0xcA11bde05977b3631167028862bE2a173976CA11`. wagmi's
`useReadContracts` picks it up automatically. Measured on a live token-page load: **three
requests total**, one `eth_call` going to Multicall3 carrying `useCurve`'s eight reads.

⚠ **JSON-RPC ARRAY BATCHING AND MULTICALL ARE DIFFERENT MECHANISMS AND BOTH WORK ON ARC.**
Batches of 2, 5 and 10 all returned proper arrays. So CLAUDE.md's `batchMaxCount: 1` rule is
**not** because Arc rejects batching — keep the setting until someone reproduces the
original failure under load, but the stated reason is not the real one.

### Image upload: Pinata presigned URLs, Shape B

**A URL field is not acceptable for a launchpad** — that is settled. The upload design is:

- Browser asks a **Vercel serverless function** for a presigned URL (a few hundred bytes)
- Function calls Pinata `POST /v3/files/sign` with `expires`, `max_file_size`,
  `allow_mime_types` — **the key never leaves the server**
- Browser uploads **directly to Pinata**

⚠ **Why NOT proxying the file through the function: Vercel's request body limit is 4.5 MB**
(`413 FUNCTION_PAYLOAD_TOO_LARGE`). A 2 MB image fits, but base64 makes it ~2.67 MB and the
cap becomes a platform constraint rather than a product decision. Shape B never touches the
limit, and cold start lands on a tiny JSON request instead of a 2 MB transfer.

**The size cap and mime allowlist are enforced BY PINATA, server-side** — not by our
function trusting the client. A scoped key in the bundle was rejected because Pinata's own
documentation says an upload-only key still lets an attacker "upload tons of files, costing
you significant money or locking out your account".

**Decisions: no KV rate limiting** (it would add a vendor for a speed bump; the real bound
is `max_file_size` x `expires`), and **no wallet gate** — a connected address costs nothing
to acquire, real gating means a signature prompt for a non-transaction, and it moves the
connect step earlier for no security gain.

⚠ **THE PROJECT IS NO LONGER A PURELY STATIC BUILD. THIS IS NOW FACT, NOT A PLAN.**
The deploy is "a folder plus a function". The trust boundary is worth stating precisely:
**that function can mint an upload URL and nothing else.** It holds no key that touches
funds, cannot sign a transaction, reads no database, and cannot affect anything already
launched. If it disappears, existing tokens are unaffected and only new uploads stop.

### ✅ BUILT — 2 September 2026

| file | role |
|---|---|
| `app/api/sign-upload.ts` | the only place `PINATA_JWT` is read. Unprefixed, server-only. |
| `app/src/lib/upload.ts` | pure client logic: limits, validation, the two-hop upload |
| `app/src/lib/ipfs.ts` | gateway resolution + the scheme allowlist, shared with `TokenImage` |
| `app/src/components/create/ImageUpload.tsx` | the UI, wired into `/create` |
| `app/scripts/verify-upload.mts` | **31 checks, 8 mutations red-proved** |

⚠ **THE HANDLER SIGNATURE IS `export default { async fetch(request) {} }`, NOT named
`GET`/`POST` EXPORTS.** The named-export form is Next.js-specific; Vercel documents the
default-export-with-`fetch` object for a non-framework (`framework=other`) project with an
`api/` directory, which is what this is. Checked against Vercel's docs rather than
assumed — the named form was the intuitive guess and it is wrong here.

⚠ **The signing host is `uploads.pinata.cloud/v3/files/sign`, NOT `api.pinata.cloud`.**
Also checked rather than recalled.

⚠ **`/api/sign-upload` IS EXTENSIONLESS, SO THE SPA CATCH-ALL ATE IT.** The rewrite was
`/((?!.*\.).*)` — dot-free paths go to the shell — and the API path has no dot. Vercel
checks the filesystem before top-level rewrites so it would *probably* have worked anyway,
but that is exactly the "probably" this project already refused to accept for the Google
verification file. Now `/((?!api/)(?!.*\.).*)`, with both exclusions asserted against the
real `vercel.json` (U26–U29) and red-proved by restoring the old catch-all.

**The constants are duplicated in `api/` rather than imported from `src/`.** A
cross-directory `.ts` import is compiled by Vercel's builder, not ours, so it fails at
DEPLOY time — the one place a failure costs a redeploy cycle to find. `verify:upload`
U8–U10 fail if the two copies drift, which makes the copy safe rather than merely tolerated.

⚠ **SVG IS EXCLUDED FROM THE MIME ALLOWLIST AND MUST STAY EXCLUDED.** It is XML and can
carry script; a token image is attacker-supplied content rendered next to other people's
money. Every design tool exports PNG, so excluding it costs a creator nothing. U11 is
red-proved.

⚠ **UPLOADS WRITE `ipfs://<cid>` TO THE CHAIN, NEVER A GATEWAY URL.** A gateway hostname
in on-chain metadata is a permanent dependency on one company's domain: if it lapses, every
token pointing at it breaks and only each individual creator can fix their own. The gateway
belongs at RENDER time, where `VITE_PINATA_GATEWAY` changes it for every token at once.
Unset, the fallback is `ipfs.io` — which must FIND content on the network and so may not
serve a just-pinned CID promptly, which is the moment a creator is watching. Set the
dedicated gateway.

**Not yet verified end to end: no upload has run against a real `PINATA_JWT`.** Everything
above is checked by construction and by the local failure path (a missing function produces
the correct "this is a problem with this site" message, not a crash). The success path has
never executed.

## 11.18 Settled — do not re-argue

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
- **The chart plots CURVE MID-PRICE from reserves.** Never `usdc_amount / token_amount` --
  that is execution price including the snipe tax and produces a 5.3x sawtooth (§11.13).
- **A sell is sized in PERCENT, a buy in dollars.** Nobody holds a position in units.
- **The creation fee is approved for an EXACT amount (R13); trading approvals are a
  different hazard** and are bounded by the economics hash instead.
- **The economics hash is fetched in the same action that sends the transaction.**
- **Affordability always covers the trade PLUS gas from one balance.** USDC is the gas
  token; this keeps reappearing and any new payment path must price it.
- **`quoting` never disables a submit button.** Refreshing is shown on the figures.
- **Holders are OUT OF SCOPE.** Per-token `Transfer` indexing is not worth solving now.
- **Image upload is Shape B: a presigned URL, the file never transits our function.**
  Proxying it collides with Vercel's 4.5 MB body limit and makes a platform cap the
  product's size cap.
- **No KV rate limiting and no wallet gate on upload.** The real bound is
  `max_file_size` × `expires`. A signature prompt to pick an image is the pattern users
  are correctly taught to treat as phishing, and a connected address gates no attacker.
- **SVG is never in the image allowlist.** XML, script-capable, attacker-supplied,
  rendered next to other people's money.
- **Uploads write `ipfs://<cid>` on chain; the gateway is applied at render time.**
- **`PINATA_JWT` is server-only and never `VITE_`-prefixed.**
- **The SPA rewrite excludes both `api/` and any path containing a dot**, structurally
  rather than by relying on Vercel's filesystem precedence.
- **Production source maps stay off**, set explicitly so enabling them shows in a diff.

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


---

# 12. THE RESUME POINT — written 4 September 2026, HEAD `866e08d`

⚠ **APPENDED, NOT A REWRITE.** Everything above this line is untouched. This file has lost
three sections to a rewrite before (commit `2d92cfe` dropped the fee structure, the snipe
tax table and "Other mechanics"; they were restored later). **Append and amend. Never
rewrite.**

Everything in this section was **verified against the repo, the chain, the live database or
a live HTTP request** at the time of writing, except where marked UNVERIFIED. The section
ends with an explicit list of what could not be checked.

## 12.1 It is deployed. That is new.

| | |
|---|---|
| frontend | `https://ballista.trading` — HTTP 200, verified |
| alias | `https://ballista.vercel.app` — HTTP 200, verified |
| indexer | `https://ballista-indexer.fly.dev/health` — `healthy: true`, lag **1 block**, verified |

**`app/DEPLOY.md` and `indexer/RUNBOOK.md` carry the operational detail and the traps.
Read them before touching a deploy.** The three that cost the most time:

* The Fly deploy command in the runbook **was wrong** and is now corrected. The build
  context is a **positional argument** (`flyctl deploy indexer …`), and **`--ha=false` is
  required** — it defaults to true and overrides `fly.toml`, which is how Fly created two
  indexers on the first deploy despite one being pinned in three places.
* A Vercel project's **first** deployment always goes to production, whatever flags say.
* `PINATA_JWT` is a Vercel **Secret**, so `vercel env pull` returns `[SENSITIVE]`. **The
  only copy is outside Vercel.**

## 12.2 The quote goes stale after a trade — ⚠ OPEN BUG, REPRODUCED ON PRODUCTION

**This is the most serious open defect in the product and it is not fixed.**

Reproduced on `ballista.trading`. After a sell that nearly emptied a curve, a second sell
**34 seconds later** displayed:

```
In the curve:       0.000001 USDC
Estimated receive:  0.000001 USDC
Minimum received:   0.000001 USDC
```

It **settled at 6.08 USDC** — wrong by roughly six orders of magnitude.

Re-tested against a settled curve: estimate 4.90, settled 4.90, exact. **The quote math is
correct. This is staleness.** Verified in source: `app/src/hooks/useQuote.ts` sets
`QUOTE_POLL_HOT_MS = 1_000` while the curve is inside the snipe window and
`QUOTE_POLL_COLD_MS = 30_000` after it — so **for up to 30 seconds after any trade the panel
quotes against reserves that have moved.**

⚠ **The slippage floor protected the user** — the trade could not execute below what was
shown. The harm is a confident wrong number that a person would act on, not a loss.

A fix probably means invalidating the quote on an observed `Trade` event rather than waiting
for the next poll. **Not attempted.**

## 12.3 Arc facts confirmed from primary sources this session

* **`--rpc.gascap` default dropped 50M → 30M in arc-node v0.7.2.** Not previously recorded.
* ⚠ **arc-node v0.7.0 switched address rendering to `0x`-prefixed lowercase hex and states
  EIP-55 checksums are not used.** The app normalises case on both sides everywhere it
  compares (verified). The **indexer** uses raw PostgREST `.eq()` against checksummed
  strings and the database holds checksummed values — **self-consistent today**, so nothing
  is broken. It is a latent mismatch the day any write comes from a raw log topic.

## 12.4 The creator launch buy is unreachable in practice — measured, not assumed

The EIP-5792 batch **does** reach the launch window; the mechanism is sound and the code is
correct. Two facts make it work, and the second is easy to miss:

* One atomic transaction has one `block.timestamp`, so `createToken` sets
  `creationTimestamp = t` and `creatorLaunchBuy` tests `t <= t + window`.
* ⚠ **`creatorLaunchBuy` has NO `creationBlock` restriction** where `buy()` and `sell()`
  both do — re-verified this session, **zero** `creationBlock` references in its body. That
  exemption is deliberate and without it a same-block batch would revert.

The token address is predicted from `keccak(rlp([factory, nonce]))` because the factory
uses plain `CREATE`. **Verified exact against two live tokens.** The nonce race is bounded
by atomicity: another launch shifts the nonce, `creatorLaunchBuy` reverts `NotCreator`, and
the whole batch reverts including `createToken` — the creator pays gas and retries.

⚠ **But no wallet offers it on Arc.** Measured against a real wallet on Arc Testnet,
`wallet_getCapabilities` returned Ethereum, Base, Monad, BNB and Polygon. **Arc
(`0x4CEF52`) was absent.** So the control is correctly hidden and the allocation cannot be
taken today. ⚠ **It could not be established which wallet answered** — Phantom wins
`window.ethereum` in a two-extension environment. **Unresolved.**

The blocker is **not** the chain: Arc supports EIP-7702. It is per-wallet, per-chain
delegation deployment, which no frontend change can affect.

## 12.5 Graduation gas has NEVER been measured

⚠ **This is the largest unmeasured number in the product, and it is the transaction that
moves the entire pot.** Not before Zero8, not after. Measuring it needs 8,000 USDC of buys
to cross the threshold and the test wallet holds ~200.

It is also the whole remaining justification for `GAS_LIMIT_MULTIPLIER_X10 = 30n` (verified
still `30n` in `app/src/lib/gas.ts:31`): the 26% estimator shortfall that originally
justified ×3.0 is gone post-Zero8, and what survives is that no measured buy has ever
triggered a graduation, which does strictly more work.

**How to measure it:** deploy a throwaway factory with a tiny graduation threshold, buy
across it, record the receipt.

## 12.6 ⚠ Three patterns promoted to rules — each has now bitten more than once

**RULE: fixtures use real-shaped values, never placeholder strings.**
Three fixtures have been found carrying properties the real object lacks — the wagmi `rdns`
connector doubles (real wagmi never sets `rdns`; discovered connectors carry `id =
"io.metamask"`), the chain-guard injected provider, and `bafyTEST` as a CID (8 characters;
no CID can be). Each passed while the real thing failed. **A fixture that cannot occur in
production is not a test of production.**

**RULE: mutate the thing the check asserts about, not something upstream of it.**
Two checks have been found asserting the bug. `S8` read *"exactly 5% does NOT warn"* and
passed, pinning an off-by-one in place. `M13` **could not go red at all** — the input never
reached the code under test, so mutating the resolver left it green. **A check that cannot
fail is not evidence.** Prove the red, do not assume it.

**RULE: strip comments before a checker reads source.**
The self-matching-comment trap has fired **three times** — `verify:claims` matching
`/Uniswap\s*v/i` against its own explanatory prose, and twice since. Each checker
rediscovered the fix independently. ⚠ **Proposed, not built: a shared `stripComments()`
helper** in a common module rather than a fourth private copy.

## 12.7 Confirmed-open items — all verified this session

| item | state |
|---|---|
| Stale quote after a trade | **OPEN**, §12.2, reproduced on production |
| Graduation gas unmeasured | **OPEN**, §12.5 |
| `.env.example` omits `MAINNET_RPC_URL` | confirmed — `.env` defines it and `hardhat.config.js` reads it |
| `frontend/` still tracked | **4 files**, holds a committed ten-year `role: anon` Supabase JWT at `terminal.html:418`. Public by design, but §7C says delete the directory and it never happened |
| `ballista project.zip` | confirmed **tracked**, 43 KB binary at the repo root |
| `app/api/` outside the TS project | `app/tsconfig.json` has `"include": ["src"]`, so `tsc -b` **never type-checks the serverless function** |
| No `engines` / `.nvmrc` at the repo root | confirmed absent. `verify:*` needs Node ≥22. ⚠ The **indexer's** floor is Supabase's own `engines: >=22.0.0`, not `--experimental-strip-types` |
| Explore sort ranks graduated tokens by a stale market cap | reported, **deliberately not changed** |
| ~~Reown project ID not allowlisted~~ → ⚠ **MISDIAGNOSED. The 403 was a TRUNCATED PROJECT ID, not the allowlist** | Measured 5 September 2026 with both values against three origins: the correct id returns **200** from `ballista.trading`, `ballista.vercel.app` and `localhost:5173` — and **200 from an unlisted origin too**, so that endpoint was never origin-gated. The truncated id returns **403 everywhere**. Production had `6c706f1c…`, missing the leading `8`, lost to a dashboard paste. `pulse.walletconnect.org/batch` returns **400 with BOTH ids**, so that one is a payload-shape response and not an auth failure at all — do not chase it. |
| ⚠ Wallet extension flagged the `*.vercel.app` preview as phishing | **not yet tested on `ballista.trading`.** Blockaid / MetaMask / Phantom review takes days and could not start until the domain served the app — which it now does |
| zh-Hans translation | ⚠ **7 of 330 keys** (counted this session — the figure "239" in circulation is stale). `SHIPPED_LOCALES = ["en"]`, so it is reported, not enforced; moving it to shipped turns on a hard gate |
| ~~`.gitignore` gap~~ → ⚠ **THE PROSE WAS WRONG WHEN IT WAS WRITTEN** | `.env*.tmp.txt` was added **in commit `dc7e083` — the SAME commit whose prose says the gap is "real and unfixed"**. It was written from an earlier measurement and never re-measured, which is exactly the failure the "Pending, small" section warns about, occurring inside the act of writing the warning. ⚠ The list was also still incomplete: `.env.production.tmp.bak`, `.env.prod.backup`, `.env.production.txt` and `.env.local.tmp.json` were all verified UNIGNORED. **Now closed properly** — the four `.env` lines are replaced by `.env*` plus `!.env.example`, and all eight variants are confirmed ignored with `git check-ignore` while `.env.example` stays tracked. |

## 12.8 What to do next, ranked

1. **Terms of Use and Privacy Policy.** Moad is sourcing the documents. **Do not write legal
   text.** The gate mechanism is buildable once they exist.
2. **The contract deployment runbook. It does not exist.** Needs: constructor arguments with
   values, router address, treasury address, who signs, in what order, what is verified
   between steps, and rollback. ⚠ Pre-flight must `eth_getCode` **every** address and abort
   on empty — **and the probe must first be validated against three known-good addresses**,
   because a probe that returns empty for everything proves nothing.
3. **Measure graduation gas** (§12.5).
4. ⚠ **Multicall3 on Arc mainnet — cannot be checked before the 16th.** If viem's `arc`
   entry declares the canonical address and mainnet has no code there, **every read on every
   page fails** and it looks like an RPC outage. Belongs in the pre-flight, with an
   env-driven kill switch for batching.
5. **The stale-quote bug** (§12.2).
6. **Registrar hardening:** lock, WHOIS privacy, 2FA at Porkbun, and a second domain at a
   different registrar.
7. **Regenerate the Healthchecks.io ping URL before mainnet** — it is a credential and has
   been pasted into a terminal.
8. **A second Goldsky Edge key** for launch-day bursts; per-IP tiers are per key.
9. **zh-Hans** needs a translator, not a session.

**Provider decision is MADE — do not reopen it.** Goldsky Edge at launch, our own indexer,
Turbo in October as a resilience layer. ⚠ **Edge passes filter methods through to the node**,
so `eth_newFilter` will return `-32601` (see §11.11 — it was `-32603` until Arc fixed it,
re-measured 5 September 2026) on mainnet exactly as on testnet and **the polling
design stays correct**. The `getLogs` range cap on Arc mainnet is **still unanswered** —
default 20K, heavier chains 1K; Goldsky has the question with engineering.

## 12.9 ⚠ What this section could NOT verify

Recorded as gaps rather than guesses, because this file has carried three conflicting commit
hashes at once and an unmarked guess is worse than an admitted hole.

* **Which wallet answered `wallet_getCapabilities`.** Phantom wins `window.ethereum`. The
  measurement stands; the attribution does not. Disambiguate with
  `window.ethereum.isMetaMask` / `.isPhantom` / `.providers?.length`.
* **The Vercel dashboard state** — environment-variable scopes, Secret-vs-Config kinds, and
  Deployment Protection being off. Taken from the operator's report; there is no CLI
  read-back for a Secret, by design. **Not independently verified from this machine.**
* **The Fly secret list and the Healthchecks.io configuration.** Same reason — reported, not
  read back.
* **`schema_migrations` contents.** `anon` is correctly denied (verified: HTTP 401), and
  there is no Postgres connection string anywhere in the repo, so the table could not be
  read from here. ⚠ **Reported and NOT verified: it holds 000–007, and 000–005 were
  backfilled by hand in one statement — so `applied_at` for those is when they were
  STAMPED, not when they were applied. Do not read that column as a timeline.**
* **That migrations 006 and 007 were actually applied.** Their *effects* were verified — both
  views return rows to `anon` and refuse `INSERT` — but the stamp rows themselves were not
  read.
* **The 828 MB upload figure and the flyctl trap details.** Reported by the operator from
  the deploy session. `flyctl v0.4.97` **was** confirmed on this machine.

---

# 13. SESSION OF 5 SEPTEMBER 2026 — quote fix, identity pass, checker repair

⚠ **APPENDED, NOT A REWRITE.** §12's warning applies unchanged: this file has lost three
sections to a rewrite before. Everything above is amended in place where it was wrong, and
each amendment says what it used to say.

## 13.1 ⚠ §12.2's DIAGNOSIS OF THE STALE QUOTE WAS WRONG. It was not staleness.

§12.2 records "the panel quotes moved reserves for up to 30 seconds" and reads the
displayed `0.000001 USDC` against a settled `6.08` as a stale quote. **Measured against
archive state at the incident's own blocks, a stale quote could not have produced that
figure.** `quoteSell` for the exact amount submitted (2,471,092,226,246,865,422,123,154):

| block | | net out |
|---|---|---|
| 60466878 | before the preceding sell | 6.168161 |
| **60466934** | **immediately BEFORE the bug trade** | **6.083285** |
| **60466935** | **the trade's OWN block, after it** | **0.000001** |

`0.000001` exists at exactly one block: **after** the trade. A stale quote shows **6.08** —
which is what it settled at.

**What actually happened: an ORPHANED quote, not a stale one.** `input` was never cleared
on settle, so after the sell confirmed `data.refetch()` moved "In the curve" to 0.000001
and the quote query — still keyed to an amount the user no longer held — was re-read
against the drained curve and rendered directly beneath "Settled … 6.08 USDC". Both numbers
were correct; only their juxtaposition lied.

The trade sequence, from the `Trade` events: buy, sell **75%**, sell the remaining **100%**
(7,413,276,678,740,596,266,369,462 then 2,471,092,226,246,865,422,123,154 — exactly 3:1).

**A real stale window ALSO existed, and is also fixed.** Same amount, same token:
**18.419215** at block 60466878 vs **6.083286** at 60466934 — a quote taken before an
intervening trade and shown after it **OVERSTATES by 3.03x**, for up to 30s, across
anyone's trade. Overstating is the direction that matters.

⚠ **Underneath both: three figures on three clocks.** The curve polled at **6s**, balances
at **8s**, the quote at **30s** — so "In the curve" and "Estimated receive" routinely
described the same curve at different moments.

### The fix, and why it is NOT a `Trade` event watcher

The quote is keyed on a **curve fingerprint** (`curveQuoteFingerprint`, `lib/quotes.ts`)
built from data `useCurve` already fetches: virtual reserves, `realUsdcReserves`,
`tokenReserves`, `state`, `snipeTaxBps`.

* **Zero extra RPC.** A `watchContractEvent` costs ~2 calls per poll per open page.
* Own trade → invalidated **immediately** (the receipt already calls `data.refetch()`).
  Someone else's → **≤6s**, against 30s before.
* Catches a move the `Trade` event would miss, such as a graduation closing both sides.

⚠ **DO NOT reduce the fingerprint to a block number.** A block in which nothing touched
this curve does not stale a quote, and invalidating per block would refetch every ~0.48s
forever. It changes when the ANSWER would change — that is what makes it correct and cheap.

**In-flight treatment — the distinction the old code could not make.** `placeholderData`
carries a figure forward only while it is merely OLD (amount changed, poll ticked); it
DROPS it the moment the fingerprint changes, because then the number is not old but wrong.
Implemented structurally: the fingerprint is in the query key, so a superseded figure sits
in a different cache entry and is unreachable.

**`verify:quotefresh`, 28 checks, 7/7 mutations killed.** Q23 is the control — on an
unchanged curve the figure survives all three polls, so the mechanism discriminates rather
than blanket-refusing.

## 13.2 ⚠ `eth_newFilter` NOW RETURNS `-32601`, NOT `-32603`

See §11.11, amended in place. Both hosts, both filter methods, measured 5 September 2026.
Circle appears to have fixed the bug §11.11 was written about. **The polling design is
unchanged and must stay** — its justification was never the error code.

## 13.3 ⚠ THE REOWN 403 WAS A TRUNCATED PROJECT ID, NOT THE ALLOWLIST

§12.7 recorded "Reown project ID not allowlisted". **Wrong cause.** Production carried
`6c706f1caa5d9a114f7e206898ea947` — 31 characters, the leading `8` lost to a dashboard
paste. Measured with both values against three origins:

| | correct id `86c706f1c…` | truncated id `6c706f1ca…` |
|---|---|---|
| `ballista.trading` | **200** | 403 |
| `localhost:5173` | **200** | 403 |
| an **unlisted** origin | **200** | 403 |
| `getWallets` registry | **200, 609 wallets** | 403 |

⚠ **The config endpoint returns 200 even from an unlisted origin**, so it was never
origin-gated and the allowlist was never the cause. ⚠ `pulse.walletconnect.org/batch`
returns **400 with BOTH ids** — a payload-shape response, not auth. Do not chase it.

⚠ **The console displays the id with its first character truncated**, which is how the
wrong value looked plausible. **The full value is 32 hex characters beginning `86c706f1c`.**

## 13.4 ⚠ AppKit CANNOT BE INSTALLED. It is a hard dependency conflict, not a preference.

The full Reown AppKit modal was approved and **was not built**, on the escape hatch the
task itself provided. `@reown/appkit-adapter-wagmi` (1.8.19 and 1.8.23 both tried) fails to
resolve:

```
Conflicting peer dependency: ox@0.8.9
  @wagmi/core@3.6.5 -> accounts@0.18.4 -> @privy-io/react-auth@3.40.0
    -> permissionless@0.2.57 -> peerOptional ox@^0.8.0
```

⚠ **`ox` is a DIRECT DEPENDENCY OF viem** — the library that encodes and signs every
transaction. The installed version is **0.14.34**; AppKit's resolution wants **0.8.9**. The
only ways past are `--force` or `--legacy-peer-deps`, which npm itself calls "an incorrect
(and potentially broken) dependency resolution". **Downgrading `ox` under viem, eleven days
before mainnet, to improve a wallet picker, is not a trade worth making.** Nothing was
installed; `package-lock.json` is untouched.

**Shipped instead: the EIP-6963 in-place upgrade.** Icons (with an initials fallback) and
INSTALLED / QR / Unidentified badges, **zero new dependencies**. ⚠ The badge is derived from
DISCOVERY, never from the name — Phantom wins `window.ethereum` on a two-extension machine,
so a name-based rule would confidently mislabel the generic entry. The 540+ wallet search
genuinely needs the registry and is therefore **not shipped**.

⚠ **W14–W18 all still pass** (21/21 before the addition, 34/34 after). The connector dedupe
is untouched.

## 13.5 The checker repair, and a bug it caught in itself

`stripComments()` is now one shared helper (`scripts/lib/strip-comments.mts`) replacing
three private copies, as §12.6 proposed.

⚠ **`REJECTS_CLAIM` IS DELETED, AND THE RESIDUAL EXEMPTION IS NONE.** Measured: stripping
comments and running all five patterns over all 60 scanned files with **no exemption at
all** yields **zero hits**. Every one of the 8 matches the word list used to suppress was a
comment. The exemption was buying nothing and disabling four of five patterns.

⚠ **THE FIRST SHARED STRIPPER HAD A BUG THAT DELETED REAL CODE.** A lazy JSX pattern
backtracked past the first `*/` to a later one followed by `}`, matching from a media
query's opening brace to its closing brace and **deleting 1,013 characters of styles.css**,
including the `.addr-full` rule. Caught only because `verify:address` A13/A14 went red.
**Those went red — the safe direction. The same over-deletion inside `verify:claims` would
be SILENT**, because text the stripper eats is text that can never be flagged: a stripper
that removes too much turns every negative check into a pass. Hence `verify:strip`
(15 checks), and the tempered pattern that cannot span a comment boundary.

## 13.6 Identity: the mark, the colours, the ground

* **The wordmark is now the bow-and-arrow**, as one inline SVG with
  `stroke="currentColor"` — one asset, both themes, no theme-switch bug. Header measures
  **59.70px at 390px** (under the 61px bar); `ARC TESTNET` untouched and still derived from
  `arc.name`.
* ⚠ **The supplied raster assets were NOT broken.** The brief said `android-chrome-192x192.png`
  was "dark grey on a solid white background". Measured: **94.9% fully transparent, ZERO
  opaque white pixels** (favicon-32 90.9%, ballista-logo 96.0%, all zero). They render on
  white in a previewer because previewers composite alpha onto white. **The favicons and
  `site.webmanifest` needed no change** and carry this same drawing.
* ⚠ **The header stroke is HEAVIER than the source drawing, deliberately.** Matching the
  original's line weight needs ~0.35 in a 24 viewBox, which at 22px renders as a third of a
  pixel and disappears. Judge it at 22px, not at 340px.
* **Buy is `--pos`, sell is `--neg`.** ⚠ `color: var(--bg)` is what makes ONE declaration
  correct in both themes — the tokens already encode the inversion. Picking white or
  near-black outright fails half the cases: white on dark `--pos` is **2.67:1**, near-black
  on light `--neg` is **2.64:1**. All four shipped pairs are **5.85–7.08:1**.
* ⚠ **Colour is never the only signal.** The active tab keeps font-weight 600, a `--soft`
  background and a 2px underline bar, plus `aria-selected` on a real `role="tablist"`. All
  three survive desaturation.
* **The dark ground is NEUTRAL: `#111111`.** It was `#14140f` — R20 G20 B15, a 5-point
  red-over-blue bias that read brown-black. Every dark token now has R = G = B exactly, and
  `--bg` equals the light theme's `--text`. Contrast improved on every pair.
* ⚠ **`PriceChart`'s `PALETTE` is a COPY** and moved in the same change. `verify:theme`
  asserts the correspondence. ⚠ It also found that `grid` is **not the same token in both
  themes** — light uses `--soft`, dark uses `--line` — which is **pre-existing** and is
  pinned as-is rather than silently normalised, because changing the light chart is a
  visual decision nobody has taken.
* **None of the 13 hardcoded `#fff` backgrounds returned.** The only `#ffffff` left is the
  light theme's own `--card` token.

## 13.7 Counts are now DERIVED, not asserted

`npm run verify` is a runner (`scripts/verify-all.mts`) that discovers every `verify:*`
script from `package.json`, runs **all** of them (the old `&&` chain stopped at the first
failure and hid the rest), and prints:

```
SUITES=17 CHECKS=481 FAILED=0        <- illustrative: this was the value on 6 Sep 2026
```

⚠ **Quote that command, never a number — including the line above.** This file has asserted
"143 across seven suites" and "187 across nine" while the truth was 337 across 13, and the
figure printed here has already moved twice since (460 across 16, then 481 across 17).

⚠ **It judges a suite by its EXIT CODE, not by counted FAIL lines.** A crashed suite prints
no FAIL lines at all; a counter alone would report it green. Proved by crashing one
deliberately: `RED verify:chain (exit 1, no FAIL lines — crashed?)`, exit 1 with `FAILED=0`.

## 13.8 Still open after this session

* **`VITE_WALLETCONNECT_PROJECT_ID` in Vercel Production is still truncated** at the time
  of writing — Moad is correcting it in the dashboard. Until then WalletConnect fails auth
  on `ballista.trading` regardless of the allowlist. **The correct value is 32 hex
  characters beginning `86c706f1c`.**
* **The 540+ wallet search** needs AppKit, which needs the `ox` conflict resolved upstream.
* **The light chart's grid token** differs from the dark one (§13.6). Pinned, not fixed.
* Everything in §12.8 that this session did not touch.

---

# 14. SESSION OF 5–6 SEPTEMBER 2026 — mobile wallet work, and the V2 correction

⚠ **APPENDED, NOT A REWRITE.** Same rule as §12 and §13: this file has lost three sections
to a rewrite before. Everything above is amended in place where it was wrong, and each
amendment says what it used to say.

## 14.1 ⚠ THE BIGGEST ITEM IS A REVERSAL: Uniswap V2 **is** published for Arc

**See §6, which now carries the full address table, the provenance and the caveat.** It is
recorded there rather than here because §6 is where a session looks for settled forward
decisions, and this correction changes one.

The short version, because it invalidates reasoning several sessions were built on:

* A strategy session concluded there is no canonical Uniswap V2 on Arc. **Wrong.**
* It read Uniswap's chain playbook, which enumerates the `ChainAddresses` struct. **V2 is
  not a member of that struct** — it lives in two separate top-level maps,
  `V2_ROUTER_ADDRESSES` and `V2_FACTORY_ADDRESSES`, in the same `addresses.ts`.
* **The answer was drawn from a list that structurally could not contain it.** Before
  concluding "X is absent", establish that the source could have shown X at all.
* ⚠ **Consequence: the frozen contract already works on Arc mainnet with no new contract.**
  `IDEXRouter.addLiquidity` is a V2-signature call and `0x1f7d7550…` is a V2 router. **Any
  v4 work is a choice about fee capture, never a prerequisite for graduating.**
* ⚠ **Published is not deployed.** Every address needs `eth_getCode` on mainnet first, with
  the probe validated against three known-good addresses (§10).

**Nothing in this repo ever claimed V2 was absent** — swept 6 September, zero hits. The
wrong conclusion lived only in chat, which is precisely why it now lives in §6 instead.

## 14.2 What shipped — four commits

All four are on `origin/ballista-migration`.

| commit | what |
|---|---|
| `1fcd932` | **theme-color** used `#14140f`, the dark ground superseded when the palette went neutral. Confirmed live on a phone: the iOS status bar and the Android task switcher painted the old brown-black against a neutral `#111111` page. |
| `0f7b7f0` | **Build fails on a malformed WalletConnect project id.** |
| `4caea95` | **A namespace rejection is now legible** instead of being reported as the user declining. |
| `920acad` | **Picker badge** `QR / mobile` → `QR / 70+ wallets`. |

`SUITES=17 CHECKS=481 FAILED=0`, `tsc -b` clean. Red-proofs: theme 3/3, project id 6/6
(six full production builds), switch-failure 6/6.

### 14.2.1 ⚠ The theme fix's real lesson is about the CHECK, not the colour

`verify:theme` already checked **one** copy of the palette — `PriceChart.PALETTE` — and
asserted it matched. **It never asked whether there were others.** There was a third copy in
`ThemeProvider`, and enumerating copies is what failed.

So the new check asserts the **property**: `RETIRED_TOKEN_VALUES` lists every value that
*was* a token and is not any more, and no `.ts`/`.tsx` under `src/` may contain one. A copy
added tomorrow is covered without anyone remembering to extend the check.

⚠ **The maintenance contract: when you change a token value, add the OLD one to that list.**
Comments are stripped first, so a file explaining a change is not mistaken for one shipping
the old value.

### 14.2.2 The project-id check fails the BUILD, not the site

Production had carried `6c706f1caa5d9a114f7e206898ea947` — 31 characters, the leading `8`
lost to a dashboard paste. WalletConnect then initialised and failed at auth with a 403 that
reads exactly like an origin-allowlist problem.

⚠ **The existing guard in `wagmi.ts` is a truthiness check, and that is why the truncation
was invisible.** Unset and empty are falsy and correctly skip the connector; a 31-character
id is **truthy**, so the connector was built and then failed. Truthiness cannot separate
valid from malformed.

Checked at build time because **Vite inlines `VITE_` variables** — the id is a literal in the
shipped JS and cannot change afterwards, so a build check catches everything a boot check
would while failing the *deployment* instead of the site. Vercel keeps serving the last good
build and no user meets a blank page.

## 14.3 Findings that outlive the tasks

* ⚠ **The WalletConnect registry is 609 unfiltered, 79 filtered to `eip155:5042002`, 544 for
  `eip155:1`.** Only **~13%** of WalletConnect wallets advertise Arc. That is a **funnel
  constraint, not a bug**, and it is worth knowing before launch-day support questions.
* ⚠ **The WalletConnect modal differs by width.** At 390px it opens on **"All Wallets"** with
  a search box and a grid (Trust, MetaMask, Binance, SafePal, TokenPocket, imToken, Safe…).
  On **desktop it opens on a bare QR pairing screen with no wallet list at all.** Anyone
  checking the `70+ wallets` badge from a desktop browser will see no list and reasonably
  conclude the copy is false. It is not — the QR is a generic WalletConnect URI any of those
  wallets can scan.
* ⚠ **`loadEnv` returns `""` rather than omitting the key** for a bare `VITE_X=` line. Caught
  by the project-id red-proof: an `!== undefined` guard failed the build on a file that meant
  "no id". Anything reading env this way must treat empty as unset, as `wagmi.ts` already does.
* **`verify-switch-failure.mts` is red-proved as a pure function, but no component test drives
  the rendered UI.** Consistent with §4's standing note that the UI itself is untested.
* **The session namespace is read once per `(connector, address)`.** A mid-session
  `session_update` would classify against a stale list until reconnect. It degrades to
  `unknown`/`declined`, i.e. the pre-existing behaviour, so it fails safe.

## 14.4 ⚠ STILL OPEN: mobile WalletConnect lands on the wrong chain

**Not fixed, and inference is exhausted. The next step is measurement, not more reasoning.**

`84156418 = 0x5042002` — Arc's **decimal** digits `5042002` parsed as **hex**. Arc Testnet is
5042002 decimal, whose correct hex is `0x4cef52`. Our own derivation is right
(`chain.ts:100`, asserted by `verify:chain`) and `84156418` appears **nowhere** in the repo.

⚠ **The obvious explanation has been ruled out.** The wallet's network entry was deleted and
re-added reading `0x4cef52`, the session was killed on both sides, **and it still
reproduces.** So it is not simply a mistyped network.

**The diagnostic was written and reverted WITHOUT EVER BEING RUN.** It is recorded here in
full so the next session re-applies it rather than rewriting it.

Insert into `app/src/hooks/useArcGuard.ts`, immediately after the
`if (!aliveRef.current) return;` that follows `connector.getProvider()` (~line 94), before
`await readChain();`:

```ts
      // ── TEMPORARY WALLETCONNECT SESSION DIAGNOSTIC — REMOVE BEFORE COMMIT ──────
      try {
        const p = providerRef.current as unknown as {
          chainId?: number | string;
          session?: { namespaces?: Record<string, unknown>; peer?: { metadata?: unknown } };
        };
        if (p?.session) {
          const ns = p.session.namespaces?.eip155 as
            | { chains?: string[]; accounts?: string[]; methods?: string[]; events?: string[] }
            | undefined;
          console.log("[WC-DIAG] provider.chainId =", p.chainId);
          console.log("[WC-DIAG] eip155.chains    =", ns?.chains);
          console.log("[WC-DIAG] eip155.accounts  =", ns?.accounts);
          console.log("[WC-DIAG] eip155.methods   =", ns?.methods);
          console.log("[WC-DIAG] eip155.events    =", ns?.events);
          console.log("[WC-DIAG] peer.metadata    =", p.session.peer?.metadata);
          console.log("[WC-DIAG] full namespaces  =", JSON.stringify(p.session.namespaces));
        } else {
          console.log("[WC-DIAG] not a WalletConnect provider (no .session) —", connector?.name);
        }
      } catch (e) {
        console.log("[WC-DIAG] diagnostic threw (ignored):", e);
      }
      // ── END TEMPORARY DIAGNOSTIC ──────────────────────────────────────────────
```

**Reading it from an iPhone (Safari remote inspect):**

1. iPhone: **Settings → Apps → Safari → Advanced → Web Inspector: ON**.
2. Laptop Safari: **Settings → Advanced → "Show features for web developers"**.
3. `npm run dev -- --host` in `app/`, note the `Network:` URL it prints.
4. Phone on the **same Wi-Fi**, open that URL in **mobile Safari** — ⚠ *not* the MetaMask
   in-app browser, which uses the injected provider and has no WalletConnect session.
5. Plug in, trust the computer, then laptop Safari → **Develop → [iPhone] → [the page]**.
6. Connect via WalletConnect, approve, return to Safari; `[WC-DIAG]` appears in the console.

*(Android: `chrome://inspect/#devices` with USB debugging.)*

⚠ **Attach the inspector BEFORE connecting** — the log fires once when the provider resolves,
and a session restored from storage prints before you can attach otherwise.

**What to look for:** whether `eip155.chains` contains `eip155:5042002`. If it does not, the
switch cannot work whatever the wallet's network list says — and the app now says so on
screen (`4caea95`).

## 14.5 Not deployed

**Production still serves the pre-`3cd27c1` bundle.** A **preview** was deployed on
5 September and nothing has been promoted since:

`https://ballista-9oqqeu21p-moadadas-projects.vercel.app`

⚠ None of the four commits in §14.2 are in that preview either — it predates them. **A fresh
preview is needed before any mobile testing of the wallet changes.**

**Connected-wallet flows remain untested** as a direct consequence, on desktop and mobile.
`WalletBar`, `lib/wallets.ts`, `ChainProvider` and the connector list have all changed.

## 14.6 The direction change — graduation to v4 with a fee-capturing hook

**Recorded, NOT approved, and no work has started.** The spec is unwritten and §6's standing
⚠ **APPROVED, 6 September 2026 — see §17.** Phase 1 is built (§15) and attacked (§16).
Phases 2 and 3 remain unstarted. The line below was true when written and is not now.
rule against starting V4 has not been lifted.

The intent is a Uniswap **v4** graduation with a **fee-capturing singleton hook**, modelled
on Pons v2, phased:

1. **adapter with `hooks: address(0)`** — v4 pool, no hook
2. **the hook** — fee capture
3. **escrow**

⚠ **PHASE 1 IS A CHOICE, NOT A NECESSITY.** §14.1 is the reason: the v2 path is published,
⚠ **THE CHOICE HAS BEEN MADE — see §17.** The arithmetic below is unchanged and still
correct: v2 works unmodified and no new contract is REQUIRED. But v4 is now the plan,
so "phase 1 is optional" is no longer a reason to defer work on it.
LFX1's frozen `addLiquidity` interface works against `0x1f7d7550…` unmodified, and **no new
contract is required for graduation to function.** Do not let a future session record that an
adapter is needed to make graduation work.

### The four measured facts any adapter design rests on

Established 6 September by reading the frozen source, not inferred:

1. ⚠ **The launched token is 18 decimals; USDC's ERC-20 view is 6.** `LFX1Token` extends OZ
   `ERC20` and never overrides `decimals()` (`contracts/LFX1Token.sol:6`, OZ default 18).
   **The `sqrtPriceX96` derivation therefore carries a 1e12 scale factor**, and that is the
   likeliest place for this to go silently wrong.
2. ⚠ **Both liquidity amounts are VARIABLE, never constants.**
   `tokenLiquidity = LP_TOKEN_RESERVE + c.tokenReserves ≥ 193,000,000e18` and
   `usdcLiquidity = c.realUsdcReserves + c.poolBoost > 8,000e6`. `c.tokenReserves` is
   **non-zero on the normal (threshold) arm** — it is only zero on the depletion arm
   (`LFX1.sol:442-443`). One measured graduation: **193,297,304e18 / ~8,019e6**, with
   `poolBoost = 0`. `poolBoost` is opt-in per token and adds ~1–4%.
3. **LFX1 ignores the returned `amountA`/`amountB`.** They appear only in the `Graduated`
   event (`LFX1.sol:681`); only `liquidity == 0` is rejected (`:672`). Nothing downstream
   reads them — `indexer/src/index.js:361` uses `log.args.token` alone. **So an adapter may
   consume less than offered.**
4. ⚠ **Unpulled dust is permanently stranded in the FACTORY.** `LFX1.sol:677-679` zeroes
   `tokenReserves`, `realUsdcReserves` and `poolBoost` **unconditionally on the amounts**, so
   anything left unpulled sits in the factory's balance with no accounting entry and no
   payout path can ever reach it (R14). **An adapter must `transferFrom` the full approved
   amounts** and sweep dust on its own side, where it can still move it.

⚠ **Also unestablished: whether v4 `PositionManager` has code on Arc mainnet.**
`@uniswap/sdk-core` is not installed in this repo, so `ARC_ADDRESSES` could not be read
directly; the address in §6 comes from the strategy session's read of the SDK. If it turns
out to be absent, an adapter must go straight to `PoolManager.unlock` → `modifyLiquidity` and
hold the position itself with no withdraw function — a materially different contract.

## 14.7 Corrections made to this file in this pass

* **HEAD** in the RESUME HERE table and §7: `dc7e083` → `920acad`, with a note that
  `git rev-parse --short HEAD` is ground truth and the line is a snapshot.
* **§11.1's suite table** no longer states a total. It read "143 frontend checks across seven
  suites", which was true when written and wrong for months. The counts are now obtained from
  `npm run verify`'s own last line.
* **§13.7's example output** updated and labelled illustrative — it has already moved twice
  (460/16 → 481/17).
* **§11.11**: a note that `eth_getFilterChanges` and `eth_unsubscribe` were **not** re-measured
  when `eth_newFilter` was. A neighbouring value changing is not evidence about this one.
* Swept and clean: **no "V2 absent from Arc" claim**, **no "adapter required"** claim, **no
  remaining Reown-403-as-allowlist** claim, and `eth_newFilter` reads `-32601` throughout.

---

# 15. SESSION OF 6 SEPTEMBER 2026 — v4 phase 1, the adapter and its fork test

⚠ **APPENDED, NOT A REWRITE.** Same rule as §12, §13 and §14: this file has lost three
sections to a rewrite before. Nothing above this line was deleted.

Branch **`v4-adapter`**, off `ballista-migration`. Two commits: `43077d0` (the adapter and
its fork test) and `4fd0230` (the red-proofs, and two checks they caught). **Not merged,
not deployed.** `contracts/LFX1.sol`, `LFX1Token.sol`, `GraduationHelper.sol` and
`IDEXRouter.sol` are byte-identical to `ballista-migration` — `git diff ballista-migration
-- contracts/LFX1.sol` is empty and LFX1 still compiles to exactly **24,033 bytes**.

`contracts/BallistaV4Adapter.sol` implements the one method LFX1 calls, `addLiquidity`, by
seeding a Uniswap v4 pool. It is ownerless: no owner, no withdraw, no upgrade, no pause.
**§6's standing rule against starting V4 is NOT lifted** — this is phase 1 of §14.6's
⚠ **SUPERSEDED FRAMING — see §17.** v4 is the graduation venue and the adapter is on
the intended path, not spike work. Phase 2 is still not started. The two sentences
below describe the position as of §15 and are kept for the record.
phased intent, `hooks: address(0)`, and §14.1 still stands: the v2 path is published and
works unmodified, so any v4 work is a choice about fee capture, never a prerequisite.

## 15.1 ⚠ GRADUATION GAS, MEASURED — §12.5 said it never had been

§12.5 records graduation gas as "the largest unmeasured number in the product" and
"never measured on any path, not before Zero8, not after". **That is now false, and this
is the measurement.** §12.8 item 3 asks for exactly this.

| | gas |
|---|---|
| buy alone, no graduation | **187,350** |
| buy that triggers graduation | **696,332** |
| **delta — what graduation costs** | **508,982** |
| standalone `graduate()` retry | **602,853** |

**Conditions, because the number means nothing without them:**

* Real Uniswap v4 on a **Base mainnet fork, pinned at block 50,900,000**. Not Arc — Arc
  mainnet does not exist yet, and v4 is live on Base today.
* **Default 8,000 USDC graduation threshold**, deliberately not a scaled-down one. The
  test funds USDC by writing the balance slot, so there is no reason to shrink the curve,
  and the amounts are the ones production actually produces.
* Token side **193,297,304.88e18** against **8,019 USDC** — §1.1's own figure, reached
  independently.
* The graduating transaction is a `buy()` that crosses the threshold (`LFX1.sol:462-466`),
  so its receipt covers both; the delta is the attribution.

⚠ **ARC'S BLOCK GAS LIMIT HAS NOT BEEN MEASURED, AND 508,982 MEANS NOTHING UNTIL IT SITS
NEXT TO THAT NUMBER.** It appears nowhere in this file and nowhere in `scripts/` — checked,
not assumed. The fork test asserts only that the transaction fits in a 30,000,000 block,
which is Hardhat's default and says nothing whatsoever about Arc. **Read Arc's limit off
the chain (`eth_getBlockByNumber` → `gasLimit`) and record it beside this table before
treating the figure as safe.** A graduation that cannot be mined is a token that can never
reach the DEX, and that is the failure this measurement exists to rule out.

Two further caveats. This is v4; the **v2 path's graduation gas is still unmeasured**, and
⚠ **§17 SUPERSEDES "v2 is what mainnet ships on" BELOW.** v4 is the venue. The v2
path's graduation gas is still genuinely unmeasured either way, so that half stands.
v2 is what mainnet ships on (§6). And Base is not Arc: Zero8 changed Arc's gas accounting
once already (§2), so an Arc figure has to be measured on Arc.

## 15.2 ⚠ PositionManager REQUIRES Permit2 — and the interface will not import

**The settle path.** `PositionManager._settlePair` (`PositionManager.sol:442`) sets the
payer to `msgSender()`, which is the locker — our adapter. `_pay` (`:515`) then routes any
payer that is **not PositionManager itself** through `permit2.transferFrom`. There is no
way to hand v4 tokens directly on that path.

**No signature is involved.** `approve(address,address,uint160,uint48)` is a plain call, so
a contract can reach Permit2 without any EIP-712 machinery. The adapter does three things
per currency, in order:

1. ERC-20 `forceApprove(PERMIT2, amount)`
2. `permit2.approve(token, POSITION_MANAGER, uint160(amount), uint48(block.timestamp))`
3. after the mint, **both zeroed** — mirroring `LFX1.sol:668-670`, which clears whatever the
   router did not consume. A mint that settles less than it was approved for otherwise
   leaves a live allowance standing over the adapter's balance.

### ⚠ `IPositionManager` is NOT Hardhat-importable, and it never will be

`v4-periphery/src/interfaces/IPositionManager.sol` reaches
`permit2/src/interfaces/IAllowanceTransfer.sol` through `IPermit2Forwarder.sol:4`. **The
`permit2` npm package was unpublished on 2026-08-11 and no scoped Uniswap equivalent has
ever existed** (`@uniswap/permit2` 404s; only the JS `permit2-sdk` is published). The
periphery package declares **zero npm dependencies** and its `remappings.txt` points at
Foundry `lib/` paths absent from the tarball. So the import is not inconvenient, it is
**unresolvable**, and no amount of remapping configuration fixes it.

The adapter therefore declares minimal interfaces by hand in
`contracts/interfaces/IV4Minimal.sol`. Hand-transcribed signatures are exactly the risk
§1.3 warns about, so each was **verified against DEPLOYED bytecode on Base at block
50,900,000** rather than recalled:

| selector | signature | contract |
|---|---|---|
| `0x87517c45` | `approve(address,address,uint160,uint48)` | Permit2 |
| `0x36c78516` | `transferFrom(address,address,uint160,address)` | Permit2 |
| `0xdd46508f` | `modifyLiquidities(bytes,uint256)` | PositionManager |
| `0xf7020405` | `initializePool((address,address,uint24,int24,address),uint160)` | PositionManager |

### ⚠ STANDING CONSEQUENCE: those selectors are verified on BASE, not on ARC

Base's PositionManager and Permit2 are not Arc's. A different deployed version, or a
different address entirely, and the hand-written interface silently calls the wrong thing —
or calls into an address with no code, where a low-level call to a non-existent contract
**succeeds and returns empty** rather than reverting.

**Add to the pre-flight, alongside §10's and §12.8 item 2's `eth_getCode` checks:**

* `eth_getCode` on Arc's PositionManager, PoolManager and Permit2 — non-empty, with the
  probe first validated against three known-good addresses, because a probe that returns
  empty for everything proves nothing (§10, §12.8).
* **Then probe each of the four selectors above against the Arc deployments** — presence in
  the deployed bytecode, or a staticcall that returns a sane answer. Code existing at an
  address is not evidence that it exposes the function we are about to call.

Nothing may depend on the adapter on Arc until both have passed.

## 15.3 ⚠ `amountAMin` / `amountBMin` are ACCEPTED AND NOT ENFORCED LITERALLY

**A knowing departure from V2 semantics inside the graduation path. It must not be
discovered by surprise later, which is why it has its own entry.**

LFX1 passes the desired amounts as the mins (`LFX1.sol:656-664`) — §1.1's strict mins, and
the single most load-bearing line in the graduation path. **The adapter cannot honour them
literally.** A full-range v4 mint consumes an integer `liquidity`, so one side is always a
few wei short of the offer, and `consumed >= desired` would revert on **every honest
graduation**, not just an adversarial one.

The protection is kept, by a different and exact mechanism: an **exact `sqrtPriceX96`
check** against the price derived from the amounts the adapter was handed. If the adapter
initialised the pool, `slot0` holds precisely the value just written and the comparison is
free — structurally the same "free in the normal case" property §1.1 depends on. If someone
else initialised first at a different price, it reverts.

⚠ **There is still NO tolerance constant**, which §1.1 is emphatic about. The check is
equality, not proximity.

**Reverting is the correct outcome and is not a denial of service.** LFX1 wraps the call in
`try/catch`, zeroes its approvals, emits `GraduationAttemptFailed` and leaves the curve at
`GRADUATION_READY` with reserves intact, where the permissionless `graduate(address)` can
retry (`LFX1.sol:656-687`). That is v2's recovery shape exactly, and a v4 pool can be
swapped to an exact target price via `sqrtPriceLimitX96`. The residual is **R6**, the
griefing race, unchanged in character. Proven end to end: a pool pre-seeded at a hostile
price parks the curve and an unrelated token graduates normally; a reverting router parks
the curve and the adapter graduates it afterwards through the full 24h timelock.

## 15.4 ⚠ The `2**64` ratio bound was REACHABLE — and `setDefaultGraduationThreshold` now has an effective floor

The price derivation computes `sqrt(amount1 * 2**192 / amount0)`, which needs
`amount1/amount0` to stay under `2**64` or the intermediate overflows a `uint256`.

**That bound is reachable, and the failure was permanent.** `tokenLiquidity` tops out near
`1e27` (`LP_TOKEN_RESERVE` + an almost-unsold curve), so:

```
usdc floor = 1e27 / 2**64 = 5.42e7 raw = 54.2 USDC
```

**Any graduation threshold below roughly 54 USDC broke it.** A default graduation runs at
`1e27 / 8_000e6` = `1.25e17`, some **148x inside the bound** — but the threshold is an owner
setter, it is **snapshotted per curve at creation**, and there is **no path to change it
afterwards**. So a single mis-set value would have left every token launched under it
reverting at graduation forever, parked at `GRADUATION_READY` with both sides closed and no
recovery: **R7 with the key thrown away.** Found by a test written to exercise an extreme
amount ratio, not by reasoning.

**Fixed by a second branch.** Past `2**63` the derivation uses
`sqrt(amount1 * 2**64 / amount0) << 64` — the identity `sqrt(x * 2**128) == sqrt(x) * 2**64`
— trading 32 bits of precision (still ~1e-19 relative, far below anything a pool price
expresses) for a ceiling of `2**192`. That is beyond what v4 itself can represent:
`MIN/MAX_SQRT_PRICE` bound the ratio near `2**128` either side. `AmountRatioOutOfRange` is
now a backstop rather than a limit. Both branches are pinned as agreeing across the switch
(`verify` M7 in `test/V4AdapterMath.test.js`).

⚠ **OPERATIONAL CONSEQUENCE, and it belongs in the deployment runbook's parameter
checklist (§12.8 item 2, which does not exist yet):** `setDefaultGraduationThreshold` has an
effective floor. The arithmetic no longer breaks above ~54 USDC, but the value is still
snapshotted per curve and still unfixable after a launch, so **every threshold change is
irreversible for everything launched under it.** Treat it like `setLpRecipient` (§1.8): a
value you cannot correct for tokens already created.

## 15.5 ⚠ 4.148e-5 and 4.148e-17 are the SAME price. Conflating them is the 1e12 hazard

The launch token is **18 decimals** — `LFX1Token` extends OZ `ERC20` and never overrides
`decimals()` — and USDC's ERC-20 view is **6**. So 193.3M tokens against 8,019 USDC is:

| figure | what it is |
|---|---|
| **4.148e-5** | USDC per **TOKEN** — the human-decimal price, what a UI shows |
| **4.148e-17** | raw unit per raw unit — **what v4 actually stores**, 1e12 smaller |

**Only the second is what `sqrtPriceX96` encodes.** The raw amounts already differ by 1e12,
so a price derived from them is a raw-unit price and needs no decimal adjustment;
normalising one side to 18 decimals applies the factor twice.

⚠ **The strategy brief for this work stated the human figure and labelled it "in raw
units", and the first band assertion copied the label — and failed by precisely 1e12.** The
hazard reproduced itself inside the description of the hazard. That is why this has its own
entry rather than a footnote: the two numbers look like a units question and are actually
the whole failure mode.

**Why nothing on chain catches it.** An adapter wrong by 1e12 in either direction still
initialises the pool, still mints, still returns a non-zero `liquidity`, and still leaves
LFX1 marking the token `GRADUATED` with the LP already burned. No revert, no event, no
signal — the same shape as §1.1's original attack. The only thing that catches it is
asserting the pool's resulting **price**, which is why the fork test does that rather than
checking a pool exists.

## 15.6 ⚠ RULE: a check that derives its expected value from the thing under test is asserting the bug

**A fourth pattern for §12.6's list, and it bit on the most important assertion in the new
suite.**

The fork test's price assertion originally compared the pool's `sqrtPriceX96` against the
ratio of the amounts the mint **consumed**. Red-proved with a deliberate 1e12 decimal
normalisation, it **passed, at `rel=-7.5e-13`, on a pool priced 1e12 wrong.**

**The reason is structural, not a slip.** For a full-range position the amounts a mint
absorbs are *derived from* the pool price: `consumed1/consumed0` equals that price
identically, whatever the price is. The comparison was circular and **could not fail on the
error it existed to catch**, in any scenario.

**The fix is a reference the pool cannot influence:** what the adapter was *handed*.
`pulled = consumed + whatever the adapter kept`, measured by bracketing its balances across
the transaction. Under the same mutation every price case now reports `999999999999` — a
clean 1e12 — where one previously escaped entirely.

This sits beside §12.6's existing three, and it is the same family as §11.7's
self-matching-comment trap and §5's vacuous-invariant: **the check has to be able to
disagree with the code.** Two corollaries worth keeping:

* ⚠ **A check must also be REACHED.** A second red-proof fired on a range assertion that ran
  *before* the stranded-balance assertion it was meant to prove, so the check actually under
  proof never executed. §12.6 says "mutate the thing the check asserts about"; the mirror of
  it is that ordering can hide the check from its own proof. The factory-balance assertions
  now run first.
* ⚠ **Mutate so the code stays SELF-CONSISTENT.** Scaling only the `transferFrom` made the
  mint settle more than the adapter held and revert — which proves the adapter is internally
  consistent and says **nothing** about whether the test would notice funds stranded in the
  factory. The mutation now scales the desired amounts themselves, so the adapter pulls 99%,
  prices 99% and mints 99% with every one of its own guards passing, and the assertion under
  proof is the one that fires.

Four mutations are registered in `scripts/redproof.py` (`v4-decimal-normalise`,
`v4-pull-99pct`, `v4-lp-to-sender`, `v4-fake-liquidity`); the fifth, a reverting router, is
a permanent test rather than a mutation because the half that matters is what happens
*after* — swapping in a working router and completing the graduation.

⚠ **Each carries its own `env` and `grep` in the registry, deliberately.** The Base fork is
opt-in, and a fork suite that SKIPS prints "0 passing" with nothing failing — which the
harness would report as **the mutation surviving**. A false negative on the most important
red-proof in the file. The environment travels with the mutation rather than being something
the operator has to remember.

## 15.7 Two smaller records

**`BASE_RPC_URL` is unconfigured, and the default works.** The Alchemy app behind
`MAINNET_RPC_URL` has **Base disabled** (`BASE_MAINNET is not enabled for this app`), and an
Alchemy key for eth-mainnet does not cover Base automatically — the network has to be
enabled on the app. `hardhat.config.js` therefore defaults to **`https://mainnet.base.org`**,
which was measured to serve archive state at the pinned block. It rate-limits, so the first
run is slow while Hardhat fills its cache. Of the public endpoints tried, only that one
worked: `publicnode` demands a token for archive requests, `llamarpc` returned HTML,
`drpc` timed out on the free plan, and `1rpc` reported the state pruned.

⚠ **`CONTRACT_INVENTORY.md` moved 84 → 80 as PRE-EXISTING DRIFT, not from this work.**
§14's additions mention `CURVE_TOKEN_SUPPLY`, `currentPrice` and `caseSensitiveSymbols`, and
`npm run build` was never re-run afterwards, so the generated coverage list still described
the older CLAUDE.md. **Generated docs are not regenerated on commit and nothing checks
them**, so this will keep drifting: the inventory is generated from the ABI and the source
and then diffed against *this file*, which means every edit here silently ages it. §"HOW TO
READ THIS FILE" says to read the coverage list after any contract change; it is worth
reading after any CLAUDE.md change too. Running `npm run build` before committing a
CLAUDE.md edit is the whole fix.

## 15.8 ⚠ ARC TESTNET HAS NO UNISWAP v4. The adapter cannot be exercised on Arc at all yet

**Measured 6 September 2026, read-only, by `scripts/arc-v4-preflight.js`. This is a
go/no-go gate and it is currently NO-GO.** A session planning to deploy the adapter to
Arc Testnet and attack it there should read this first and stop.

| address | source | result on Arc Testnet |
|---|---|---|
| `0x8366a39c…` v4 PoolManager | sdk-core, `ChainId.ARC` = **5042 (mainnet)** | **0 bytes** |
| `0x6049c9a0…` v4 PositionManager | same | **0 bytes** |
| `0xf3334192…` v4 StateView | same | **0 bytes** |
| `0x8dc178ef…` v4 Quoter | same | **0 bytes** |
| `0x00000000…78BA3` Permit2 | Circle's own contract-addresses page | **9,152 bytes — PRESENT** |

**The absence is real, not a broken probe.** Three known-good Arc Testnet addresses were
read first and all returned code (USDC 1,798 · LFX1 24,033 · Multicall3 3,808), and Base's
own v4 addresses were read as controls and correctly returned nothing. §10 and §12.8 both
require this: a probe that returns empty for everything proves nothing.

### ⚠ And the absence was checked against a source where a testnet entry COULD appear

§14.1's lesson is that "V2 is absent from Arc" was concluded from a list structurally
incapable of containing it. So the same mistake was explicitly guarded against here:

* **`@uniswap/sdk-core` (latest) carries `ChainId.ARC = 5042` and the Arc v4 addresses**,
  so it is a file where an Arc *testnet* entry could appear. **`5042002` occurs zero
  times in the whole bundle**, as do `ARC_TESTNET` and `ARC_SEPOLIA`. Uniswap publishes
  no Arc Testnet chain at all, so there is no testnet address this probe could have
  missed.
* **Arc's own contract-addresses page lists no Uniswap deployment** — but that page is a
  Circle/tooling directory (USDC, CCTP, Gateway, CREATE2, Multicall3, Permit2), **not a
  DEX registry**, so on its own its silence would have proved nothing. It is cited only
  for Permit2, which it does list.
* The single Uniswap mention anywhere in Arc's docs is in the **porting guide** — *"if
  you are porting a DEX, AMM, or router (for example, Uniswap V2, Uniswap V3, or a
  fork)"* — advice for bringing your own, not a record of a deployment, and it does not
  mention v4.

**Consequence: a Base fork remains the ONLY surface on which the adapter can be
exercised.** There is nothing on Arc for it to talk to, and §4's rule stands — do not
substitute a mock and call the result chain-level assurance. Re-run
`scripts/arc-v4-preflight.js` before assuming this has changed; it is one command and it
answers the question outright.

⚠ **This says nothing about Arc MAINNET**, which does not exist yet (16 September).
§6's address table is for 5042 and remains unverified against a chain, and §15.2's
pre-flight applies there unchanged.

### ✅ ARC TESTNET'S BLOCK GAS LIMIT IS 30,000,000 — §15.1's missing number

§15.1 records graduation gas at 508,982 and says plainly the figure means nothing until
it sits beside this. Read from three consecutive blocks, all **30,000,000**, with observed
`gasUsed` of 1.0M–3.1M.

**So §15.1's 508,982 is about 1.7% of one Arc Testnet block.** Graduation fits with an
enormous margin, and the concern that a graduation might not be mineable is closed for
testnet. Two caveats that keep it from closing outright: the 508,982 is a **Base** figure
and Zero8 already moved Arc's gas accounting once (§2), and **testnet is not mainnet** —
§9's fee parameters are explicitly testnet-only and "may change before mainnet launch".

### ✅ Permit2 IS on Arc Testnet, and §15.2's selectors are verified ON ARC

Half of §15.2's standing pre-flight can be closed for testnet. All three Permit2
selectors are present in Arc's own deployed bytecode and a **live staticcall to
`allowance()` answers** — `[0, 0, 0]`, not a revert, not empty:

| selector | signature | Arc Testnet |
|---|---|---|
| `0x87517c45` | `approve(address,address,uint160,uint48)` | PRESENT |
| `0x36c78516` | `transferFrom(address,address,uint160,address)` | PRESENT |
| `0x927da105` | `allowance(address,address,address)` | PRESENT |

⚠ **Its code hash DIFFERS from Base's and that is CORRECT — do not read it as a
different Permit2.** Measured byte by byte: the two deployments are the same **9,152
bytes** and differ in exactly **35 of them, in two contiguous runs**:

| offset | length | Arc | Base | what it is |
|---|---|---|---|---|
| 6974 | 3 | `4cef52` | `002105` | the chain id — 5042002 against 8453 |
| 6983 | 32 | `e59c8d3f…` | `3b6f35e4…` | the `DOMAIN_SEPARATOR` derived from it |

Both are `immutable`s in Permit2's EIP-712 base, and Solidity bakes immutables into
runtime code at deploy time, so CREATE2 of identical init code produces exactly this.
**9,117 of 9,152 bytes are identical**, each chain embeds its own id and not the other's.
This is the same shape as §7's "12 differing bytes, all benign — the `usdc` immutable
substituted at its reference sites", and it is why the identity check in the script is
*same length plus differences confined to the chain-dependent immutables*, never hash
equality.

**Still open, and unprobeable until v4 lands:** `0xdd46508f` `modifyLiquidities` and
`0xf7020405` `initializePool`. There is no PositionManager on Arc to probe them against,
so §15.2's pre-flight item stays open for those two on both testnet and mainnet.

---

# 16. SESSION OF 6 SEPTEMBER 2026 — the adapter attacked against real v4

⚠ **APPENDED, NOT A REWRITE.** Same rule as §12, §13, §14 and §15. Nothing above this line
was deleted.

17 attacks against **real PoolManager, real PositionManager, real Permit2** on a Base fork
pinned at block 50,900,000, plus 2 price sweeps locally. `test/Fork.v4.attack.test.js` and
the `ATTACK 6` block in `test/V4AdapterMath.test.js`. **One finding**, recorded below.
`contracts/BallistaV4Adapter.sol` is unmodified — only test fixtures were added.

⚠ **WHAT THIS DOES NOT COVER, AND IT IS THE SAME CAVEAT §4 MAKES.** A Base fork exercises
real v4 and **nothing about Arc** — not the USDC blocklist, not EIP-7708 transfer logs, not
the truncating 6dp `balanceOf`. Arc's own docs say local simulators "run a standard EVM, not
Arc's". Base was used because **Arc Testnet has no v4 deployment at all (§15.8)**, so this
is the only surface that exists. **An adapter attacked on Base is not an adapter cleared for
Arc.** It is one whose logic has been tested somewhere real rather than nowhere.

## 16.1 ⚠ F1 — a pool can be poisoned BEFORE the token exists, for 51,508 gas and no capital

**`PoolManager.initialize` checks tickSpacing, currency ordering and hook validity and
NOTHING ELSE.** `@uniswap/v4-core/src/PoolManager.sol:117`, with the complete guard set at
**lines 119-126**: `TickSpacingTooLarge`, `TickSpacingTooSmall`, `CurrenciesOutOfOrderOrEqual`
and `isValidHookAddress`. **There is no check that either currency is a contract**, so a pool
can be initialised for an address that holds no code and never has.

**And LFX1 token addresses are predictable.** The factory uses plain `CREATE`, so a token is
at `keccak(rlp([factory, nonce]))` — §12.4 verified that derivation exact against two live
tokens. So an attacker can enumerate the next N tokens a factory will ever create and
**pre-initialise every one of their pools at a hostile price before any of them exist**.

**51,508 gas each. No capital, no race, no front-run.** Poisoning the next hundred launches
costs ~5.15M gas, well under one Arc block (§15.8 measured Arc Testnet's limit at 30,000,000).
Reproduced by `A4b`, which predicts the address, initialises at `Q96`, then launches and
confirms the prediction and the park.

⚠ **THIS IS A PROPERTY OF v4 AND OF CREATE ADDRESSING, NOT OF THE ADAPTER.** It remains true
whatever the adapter does, and it remains true if the fix in the report ships. What a fix can
change is the *consequence*, not the attacker's ability to do it.

### Recoverability, measured in both directions

The adapter refuses a mispriced pool (§15.3's strict-min substitute), so the curve parks at
`GRADUATION_READY` with reserves intact rather than seeding at the attacker's price. What
that costs depends entirely on whether the price can be put back, so it was measured rather
than argued:

| pool state | correction | measured |
|---|---|---|
| **empty** (initialise only) | moves to an EXACT target price for **gas alone** | full retry **579,824 gas** (`A1a`) |
| **poisoned LOW, with liquidity** | corrector buys the underpriced token | pays **3,365 USDC** for 353M tokens worth ~**14,600** — profits ~**11,000** at the attacker's expense (`A2b`) |
| **poisoned HIGH, with liquidity** | corrector sells into the overpriced pool | gains **4,985.58** of the attacker's **5,000 USDC** stake (`A2d`) |

An empty pool corrects for free because there is no liquidity to trade against: v4's swap
consumes nothing and walks the price straight to `sqrtPriceLimitX96`, settling no currency.
Confirmed on chain, not reasoned about — `V4PriceMover` performs the swap and returns
without settling anything, and `unlock` would have reverted `CurrencyNotSettled` if any
delta were non-zero.

⚠ **BACKING THE POISON WITH CAPITAL IS SELF-DEFEATING ARBITRAGE.** A mispriced pool with
liquidity in it is a gift: correcting it is profitable in both directions, and the profit
comes out of the attacker's own position. An attacker who wants to raise the cost of
recovery can only do so by handing that cost to whoever recovers it.

### ⚠ The cost that REMAINS, and it is not zero

While the curve is parked at `GRADUATION_READY`, **both buy and sell are closed** (§1.4 — we
are stricter than Pons here, deliberately). So:

* **holders are frozen** for the whole window, with no exit;
* **nobody can buy the token to fund a correction.** `A2d` asserts this directly: an
  ordinary holder attempting to restock from the curve gets `CurveNotActive`. The only
  supply of tokens is people who already bought before the park.
* **someone external must notice and act.** Recovery is permissionless and profitable, but
  it is not automatic. Nothing in the system performs it.

That is the residual: not a loss, but a dependency on an outside party noticing. It is **R6,
the griefing race, in a new place** — and unlike R6 it can be triggered pre-emptively, in
bulk, before the target exists.

## 16.2 ⚠ Run the two fork suites SEPARATELY — together they present as a hang

```bash
FORK_BASE=1 npx hardhat test test/Fork.v4.test.js
FORK_BASE=1 npx hardhat test test/Fork.v4.attack.test.js
```

Running **both files in one mocha process times out**. `mainnet.base.org` — the default when
`BASE_RPC_URL` is unset (§15.7) — rate-limits once the two suites' archive fetches
interleave, and the run dies on mocha's timeout after 30 minutes.

⚠ **Recorded because of how it PRESENTS.** A rate-limited fork suite does not fail, it
**hangs**: no error, no failing assertion, just a process that stops making progress and is
eventually killed by a timeout naming a test file. That reads as a bug in the test rather
than a property of the endpoint, and it costs a long time to work out. Set `BASE_RPC_URL` to
a dedicated provider and the constraint disappears.

## 16.3 Two findings that came out of the attacks that FAILED

**⚠ A7's guard is Uniswap's, not ours.** The one genuinely dangerous window is the settle
inside `PoolManager.unlock`, where both of the adapter's Permit2 approvals are live and the
PoolManager is unlocked. A token callback there was fired deliberately (`A7`) and stopped by
**`ContractLocked` (`0x6f5ffb7e`) — PositionManager's own `ReentrancyLock`**
(`v4-periphery/src/base/ReentrancyLock.sol:10-15`), reached via the `isNotLocked` modifier on
both `modifyLiquidities` and `modifyLiquiditiesWithoutUnlock`. Re-entering `PoolManager.unlock`
is separately refused with `AlreadyUnlocked` (`0x5090d6c6`).

**So the adapter's safety in that window is an UPSTREAM DEPENDENCY.** It is not a property of
our code and would not survive a v4-periphery version that relaxed it. Worth knowing before
anyone reads "no reentrancy found" as "we handle reentrancy there".

**The accepted price band is exactly one value.** The check is equality on `sqrtPriceX96`, so
the set of prices it accepts has one member. Expressed as a price that is **1.6e-37 relative
— 1.3e-33 USDC on an 8,019 USDC pool** (`A1b`). **There is no exploitable band inside the
check**; an attacker who lands on the accepted value has moved the pool by less than one raw
unit of either side.

## 16.4 ⚠ RULE: a mutation that survives means the test was never testing the thing it names

**Two of the four new mutations passed unchanged on the first attempt**, and in both cases
the test was green for a reason that had nothing to do with the guard in its own title.

| mutation | why it survived |
|---|---|
| `v4-accept-any-price` | deleting the price check did not let a hostile pool through, because the mint's own `amount0Max`/`amount1Max` caps also reject the lopsided amounts a wrong price demands. The test asserted "refused" and could not tell WHICH guard refused it. |
| `v4-no-guard` | the reenterer held no tokens and no approval, so the nested `addLiquidity` died on the transfer. Removing the `ReentrancyGuard` changed nothing the check could observe. |

This belongs beside §15.6 and is the same family. §15.6 says a check that derives its
expected value from the thing under test is asserting the bug. The rule here is its
companion:

> **A mutation that SURVIVES is not a contract that is safe. It is a test that was never
> testing the thing it names.** Read a survivor as a defect in the check first and in the
> code second — and fix it by making the check name its guard, not by widening the mutation.

Both were fixed by making the assertion specific rather than circumstantial. `A1c` now
asserts the revert is **`PoolPriceMismatch` by name**, on a direct call, because LFX1's
try/catch swallows the reason. `A3a` now **funds and approves the reenterer** so the only
thing that can stop it is the guard, and asserts the returndata selector is
`ReentrancyGuardReentrantCall`.

⚠ **AND FIXING THE SECOND PROVED THE GUARD IS LOAD-BEARING.** Under `v4-no-guard` with a
funded reenterer, the nested call **succeeds** — the failure message is "REENTRANCY
SUCCEEDED into addLiquidity". Before the fix there was no evidence the adapter's own
`nonReentrant` did anything at all; there is now.

⚠ **A third check was wrong in the same session and was NOT caught by a mutation** — attack
6's magnitude bound took three attempts, because the error is quantised in raw units at
small amounts and relatively at large ones and no single bound covers both. The invariant
that does hold everywhere is directional: `floor(sqrt(x))^2 <= x`, so the pool can only ever
open AT or BELOW the ratio the deposit justifies. §15.5's own M5 already recorded the
raw-unit half of that and this session repeated the mistake anyway.

---

# 17. ⚠ DECIDED, 6 September 2026: v4 IS THE GRADUATION VENUE

⚠ **APPENDED, NOT A REWRITE**, same discipline as §12–§16. Nothing above this line was
deleted. Forward pointers were ADDED at the sites that assert the superseded premise; no
existing sentence was altered, and every original line survives.

**This is an operator decision, not an inference.** It supersedes a premise several
sections still state, and it is recorded because the file and the decision had already
diverged — which is the drift class this project has hit repeatedly (§7's three conflicting
HEADs, §14.1's V2-is-absent reversal, §12.5's "never measured" standing after it had been).

## 17.1 The decision

**Uniswap v4 is the intended graduation venue.** Phased, and the phases are unchanged from
§14.6 — what changed is that this is now the plan rather than a recorded intent:

1. **the adapter**, `hooks: address(0)` — `contracts/BallistaV4Adapter.sol`, built (§15),
   attacked (§16), not deployed
2. **the fee-capturing hook** — phase 2, **NOT STARTED and still out of scope**
3. **escrow** — phase 3

⚠ **What this changes is the STATUS of phase 1, not its content.** §15 framed the adapter as
spike work whose justification was "a choice about fee capture, never a prerequisite". That
framing is superseded: the adapter is now on the intended path. Nothing about the contract
itself changes, and §16's findings stand exactly as written.

⚠ **PHASE 2 IS STILL NOT STARTED.** Deciding the venue does not authorise building the hook.
No hook, no escrow, no fee capture, until a spec exists.

## 17.2 The hook design, recorded as intent — unbuilt, unspecified, unapproved

Modelled on **Pons v2's meme hook**. Recorded here so phase 2 starts from a described shape
rather than a blank page, and explicitly NOT a specification:

* **`beforeInitialize` gates the pool** — only pools the factory registered may be
  initialised. Everything else reverts.
* **`afterSwap` takes the fee on the UNSPECIFIED currency** — the side the swap did not fix
  (the output of an exact-input swap, the input of an exact-output one), returned as a hook
  delta.
* **Every other callback disabled.** The permission bits live in the hook's own address
  (`v4-core/src/libraries/Hooks.sol`), so the address has to be mined for exactly the flags
  used and no others — an unused flag that is set is a live callback nobody wrote.
* ⚠ **The pool's own `fee` stays 0.** A burned position has no LP to pay, so an LP fee would
  accrue to nobody — and §6 already records the real reason it must be zero: **LP fees are
  dilutable**, because anyone can add liquidity to a permissionless pool and take a pro-rata
  share. The hook is the fee accountant; the pool fee is not.

⚠ **`beforeInitialize` GATING WOULD CLOSE §16.1's POISONING, AND ONLY FOR HOOKED POOLS.**
A hook that refuses to initialise unregistered pools makes the pre-emptive attack impossible
on the pools it governs — the attacker cannot create them at all. That is a genuine
second reason to want the hook, beyond fee capture, and it should be weighed when phase 2 is
specified. It does **not** help phase 1: `hooks: address(0)` pools have no hook to gate them.

⚠ **A HOOK CHANGES THE PoolKey, SO PHASE 2 POOLS ARE DIFFERENT POOLS.** `hooks` is a member
of `PoolKey` (`v4-core/src/types/PoolKey.sol:21`), so tokens graduated under phase 1 and
phase 2 land in **different pools that cannot be merged**. Liquidity does not migrate. That
is a product decision to take deliberately at phase 2, not a detail to discover then.

## 17.3 The v2 path remains available, and unmodified

**It is the fallback, not the plan.** §14.1 stands unchanged: Uniswap V2 **is** published for
Arc, LFX1's frozen `addLiquidity` is a V2-signature call, and the router at
`0x1f7d7550b1b028f7571e69a784071f0205fd2efa` works against it **with no new contract at all**.
Switching back is a `proposeRouter` / 24h / `activateRouter` sequence and nothing more.

⚠ **So graduation is not blocked on v4 shipping, and no session may record that it is.**
§14.1 is emphatic about this in the other direction and remains correct: an adapter is a
choice, never a prerequisite. What §17.1 settles is which choice was made.

⚠ **And the v2 path has a live blocker of its own that v4 does not remove:** §15.8 measured
**no Uniswap v4 on Arc Testnet**, and §10 records that the v2 addresses have never been
`eth_getCode`-verified on Arc *mainnet*, which does not exist yet. **Both venues are
unverified on the chain that matters.** Whichever ships, the pre-flight in §15.2 and §12.8
runs first.

## 17.4 What this supersedes

| where | what it says | status |
|---|---|---|
| §6 | "Mainnet launches on the V2 router… A next session must not start building V4" | ⚠ **superseded as to the VENUE.** v4 is the plan. The prohibition on building **phase 2** stands |
| §14.6 | "Recorded, NOT approved, and no work has started" | ⚠ **approved now.** Phase 1 is built; phases 2–3 are not started |
| §14.6 | "PHASE 1 IS A CHOICE, NOT A NECESSITY" | still true as ARITHMETIC — v2 works — but the choice has been made |
| §15 preamble | "§6's standing rule against starting V4 is NOT lifted… any v4 work is a choice about fee capture" | ⚠ **superseded framing.** The adapter is on the intended path, not spike work |
| §15.1 | "v2 is what mainnet ships on (§6)" | ⚠ **superseded.** The v2 graduation gas remains genuinely unmeasured either way |
| the F1 fix recommendation | deferred the in-adapter correction on the grounds that "v4 is not on the mainnet path" | ⚠ **THAT REASON IS GONE.** See §17.5 |

## 17.5 ⚠ The F1 deferral rested on this premise, and the premise was wrong

§16.1 records F1: a pool can be poisoned for **51,508 gas, with no capital, before the token
exists**, because `PoolManager.initialize` never checks the currencies have code and LFX1
addresses are predictable. The design report that followed recommended **deferring** the
in-adapter fix, and gave as its first reason that v4 was not on the mainnet path and the
work could wait for phase 2.

**That reason no longer holds.** The rest of that analysis is unaffected and still stands —
the fixed-point problem with correcting a liquidity-backed pool, the sandwich surface, and
`CurrencyNotSettled` as the enforcement mechanism are all properties of v4 rather than of the
schedule. **What changes is the priority, not the design.**

The independently-shippable half was built instead: **`contracts/BallistaPoolCorrector.sol`**
(§17.6), which makes recovery one permissionless transaction without touching the adapter or
the graduation path. The in-adapter correction remains unbuilt and remains a decision.

## 17.6 `BallistaPoolCorrector` — the recovery tool, shipped separately

Standalone, ownerless, **not in the graduation path**. The adapter still reverts on a
mispriced pool exactly as before; this only makes putting the pool back a single call anyone
can send, rather than a manual arbitrage someone has to construct.

The safety argument is **structural and worth stating in one line: it holds no funds, has no
settle path, and therefore cannot pay for a correction that costs anything.** An empty pool
has no liquidity to trade against, so the swap settles nothing and succeeds; a pool with
liquidity produces a non-zero delta and `PoolManager.unlock` reverts it with
`CurrencyNotSettled` (`v4-core/src/PoolManager.sol:112`) without the corrector needing to
check anything.

⚠ **DO NOT "FIX" IT BY ADDING A SETTLE PATH.** The absence is the enforcement. A settle path
would let it pay for a correction out of whatever it was holding, which is exactly the
unbounded, attacker-sized, sandwichable trade §16's design report argued against.

Detail, the design question about who supplies the target price, and the test results are in
the contract's own header and in `test/Fork.v4.corrector.test.js`.

---

# 18. SESSION OF 9-10 SEPTEMBER 2026 — read-only audit, the gas-floor fix, and the phase-2 design

⚠ **APPENDED, NOT A REWRITE**, same discipline as §12–§17. Nothing above this line was
deleted.

⚠ **THE HOOK IS NOT BUILT.** §18.4 records design decisions and one blocking consequence.
No Solidity was written for phase 2. `contracts/` gained nothing this session;
`BallistaV4Adapter.sol` and `LFX1.sol` are untouched.

One commit of code: `8114f32`, entirely in `app/`.

## 18.1 The audit — seven questions, read-only, with the evidence

### 1. The USDC side of the PoolKey is the ERC-20 address, and the native sentinel cannot reach it

The adapter never chooses a USDC address; it wraps what it is handed
(`BallistaV4Adapter.sol:159-160`), sorted from the caller's arguments (`:142-146`). LFX1
supplies `address(usdc)` (`LFX1.sol:658`), an immutable (`:114`, assigned `:213`) whose
deployed value is `0x3600000000000000000000000000000000000000`
(`deployments/arcTestnet.json`). **So Uniswap's Arc policy — reject `address(0)`, require
0x3600 — is satisfied, and the second 1e12 never arises.**

⚠ There is **no explicit zero-address guard** (`:115-117` checks deadline, identical
tokens, non-zero amounts). It does not matter: `safeTransferFrom` runs at `:130-131`, two
lines before the key is built, and OZ's `_safeTransferFrom` ends
`success := and(success, and(iszero(returndatasize()), gt(extcodesize(token), 0)))`
(`SafeERC20.sol:239`). A call to `address(0)` returns empty with zero code size, so it
reverts `SafeERC20FailedOperation`.

### 2. tickSpacing 60, aligned to ±887220 by TRUNCATION TOWARD ZERO

`TICK_SPACING = 60` (`BallistaV4Adapter.sol:58`, used `:162`). The ticks are **not passed
raw** — both sites go through TickMath (`:268-269` for the liquidity computation, `:311-312`
for the mint):

```
TickMath.sol:20   MIN_TICK = -887272        TickMath.sol:41   (MAX_TICK / tickSpacing) * tickSpacing
TickMath.sol:23   MAX_TICK =  887272        TickMath.sol:48   (MIN_TICK / tickSpacing) * tickSpacing
```

⚠ **Solidity divides toward zero, not toward negative infinity, and that is load-bearing.**
Both ends move *inward* to **±887220**. A true floor on the negative side would give
−887280, which is **below MIN_TICK and invalid**. Do not "fix" the asymmetry.

⚠ **The misalignment guard is in v4-core's TickBitmap, not in PositionManager.**
`Pool.checkTicks` (`Pool.sol:94-98`) only bounds-checks. Alignment reverts
`TickMisaligned` from `TickBitmap.sol:57-59` (error declared `:13`), reached via
`Pool.sol:176` and `:179` on the mint path.

### 3. ⚠ A `hooks: address(0)` pool can NEVER become a hooked pool

`fee: 0` (`BallistaV4Adapter.sol:51`, `:161`) and `hooks: IHooks(address(0))` (`:163`).

* **`hooks` is a member of PoolKey** — `PoolKey.sol:21`, the fifth and last field.
* **PoolId is keccak over all five slots** — `PoolId.sol:14`, `keccak256(poolKey, 0xa0)`,
  with `:13` naming `0xa0` as "5 slots of 32 bytes" and `:10` stating it equals
  `keccak256(abi.encode(poolKey))`.

**So changing `hooks` changes the preimage, hence the id. It is a different pool, always.**
There is no re-key path: `_pools` is keyed by PoolId (`PoolManager.sol:93`) and the entire
external surface (`:104-339`) contains nothing that alters a key — `updateDynamicLPFee`
writes only the fee inside an existing pool (`:345`).

⚠ **AND OUR LIQUIDITY CANNOT FOLLOW IT.** Phase 1 mints full-range to `0x…dEaD`, so it can
never be withdrawn and therefore never migrated. **This is recorded as §18.4's blocking
consequence, not as a curiosity.**

### 4. The chain-level fee override never reached a wallet write — fixed

See §18.3. Finding, evidence and fix are recorded there rather than split.

### 5. No native balance is read anywhere, so the 18/6 mixing hazard is structurally absent

`rg "getBalance|useBalance|eth_getBalance" app/src` finds **no native read**. The only hits
are our own `useBalances` hook and a comment explaining the avoidance
(`useBalances.ts:4`). Everything is ERC-20 via `useReadContracts` (`:42-70`).
**There is no site where an 18dp native figure meets a 6dp ERC-20 one, because the native
view is never fetched.**

The gas reserve is **units × live price, never a fixed USDC figure**: `GAS_RESERVE_UNITS =
249_546n` (`gas.ts:53`), `reserveCostWei = units * maxFeePerGas` (`:69-71`), priced from
`useFees()` on a 10s refetch. The 1000x hazard §11.5 warns about is avoided. The 18→6
conversions round **up** (`gas.ts:84`, `:116`, `:132`) so rounding withholds more.

### 6. LFX1 has no sweep, rescue or recover function — nothing to disclose

`rg "function .*(sweep|rescue|recover|withdraw|skim|drain|salvage)"` → **none**, checked
against the full external/public list (`LFX1.sol:111-841`). Every USDC outflow is bounded
by accounting: `:580` (sell quote), `:633` (`treasuryFeesAccrued`), `:641`
(`creatorFeesAccrued[msg.sender]`).

⚠ **This matters more on Arc than elsewhere and the absence is the answer.** A contract's
ERC-20 USDC balance and its native balance are ONE balance, so a generic
`rescueToken(address)` would also drain native USDC. There is no address-parameterised
token mover here to point at USDC — which is also why R14 (donations permanently stranded)
is true.

### 7. ⚠ `beforeInitialize` sees PositionManager, NOT the adapter

Followed through the source rather than inferred from the interface:

1. `BallistaV4Adapter.sol:239` — `positionManager.initializePool(key, sqrtPriceX96)`
2. `PoolInitializer_v4.sol:13-19` — an `external` function **on PositionManager**, whose
   body calls `poolManager.initialize(...)`. A plain external call, so `msg.sender` inside
   `PoolManager.initialize` is **PositionManager**.
3. `PoolManager.sol:130` — `key.hooks.beforeInitialize(key, sqrtPriceX96)`
4. `Hooks.sol:178-181` — an **internal library function**, inheriting PoolManager's frame,
   which encodes `msg.sender` into the hook call at `:180`.

**So a hook's `sender` is the PositionManager address.**

⚠ **`sender == adapter` CANNOT WORK**, and gating on PositionManager is worthless because
`initializePool` is permissionless — it identifies the router, not the caller.

⚠ **`IHooks.sol:17` documents `sender` as "The initial msg.sender for the initialize call",
which is misleading.** It is the *immediate* caller of `PoolManager.initialize`, not the
originating account. A phase-2 designer reading only the interface would get this wrong.

Making `sender == adapter` true would require the adapter to call `poolManager.initialize`
directly — which conflicts with why it uses the wrapper: `PoolInitializer_v4.sol:14-18`
swallows `PoolAlreadyInitialized`, and `BallistaV4Adapter.sol:203-205` depends on that.

## 18.2 ⚠ The gate that replaces it, and the window it leaves

`beforeInitialize` reads the PoolKey's currencies, identifies the non-USDC one, calls
`LFX1.curves(token)`, and requires the curve exists **and** is `GRADUATION_READY`.

**The state is available and correctly ordered.** `enum CurveState { ACTIVE,
GRADUATION_READY, GRADUATED }` (`LFX1.sol:74`), so **`GRADUATION_READY == 1`**; the field is
`CurveState state` (`:83`), field 7 of 22 in the struct returned by `curves()` (`:111-112`).

Set **before** the router call on both paths, and only cleared after:

```
LFX1.sol:464   c.state = CurveState.GRADUATION_READY;     <- threshold path
LFX1.sol:466   if (!_performGraduation(token)) ...         <- the router call, same frame
LFX1.sol:693   if (!(c.state == CurveState.GRADUATION_READY)) revert NotReadyToGraduate  <- retry path
LFX1.sol:695   if (!(_performGraduation(token))) revert GraduationFailed();
LFX1.sol:676   c.state = CurveState.GRADUATED;            <- only after the router returns
```

Those are the **only two** `c.state = ` writes in the file.

⚠ **`curves()` does not revert for an unknown token** (`:112` is a bare mapping read) — it
returns a zero-filled struct, so `token == address(0)` and `state == 0 == ACTIVE`. Test
existence with `c.token == token`, which is LFX1's own idiom (`:268`, `:420`, `:476`, `:508`).

**What the gate closes:** §16.1's pre-emptive attack, completely. Under phase 2 the
poisonable key carries the hook, and initialising it before the token exists now fails —
no curve record, `state == ACTIVE`. The 51,508-gas × N bulk attack has no entry point.

⚠ **The window that remains is the parked curve.** Between a *failed* graduation and a
successful retry the state sits at `GRADUATION_READY` for arbitrary duration, and the gate
**passes for an attacker** during it. But the window only opens if graduation already
failed, and with the gate in place poisoning cannot cause that failure — so there is **no
attacker-controlled trigger that this session could find.** That is not the same as closed:
an unrelated revert, gas exhaustion, or something swallowed by LFX1's `try/catch` would
open it.

⚠ **Two things the gate does not cover and the hook must:**
1. **Pin `fee` and `tickSpacing`** to the adapter's constants. Otherwise an attacker
   initialises the same currencies with `tickSpacing: 1`, passes the gate, and registers a
   junk pool in the hook's cache. Different PoolId so it cannot block graduation, but it
   pollutes the accrual accounting.
2. **Identify USDC by comparing against the hardcoded address**, never "whichever is not
   currency0". Both orderings occur.

⚠ **A HOOK REJECTION AND A POISONED POOL PRODUCE THE IDENTICAL REVERT.**
`PoolInitializer_v4.sol:14-18` swallows the hook's error and returns `type(int24).max`, so
the pool stays uninitialised and the adapter fails its own equality check with
**`PoolPriceMismatch(expected, 0)`** — the hook's reason never propagates. The two cases are
distinguishable only by `actual == 0`. **Tests must assert on that distinction or they are
not testing the gate** (§16.4).

## 18.3 ⚠ The 20 Gwei floor never reached a wallet transaction — `8114f32`

`chain.ts` declares a `fees.estimateFeesPerGas` override with the floor, and its comment
claimed pinning it there "applies it ONCE, to every write in the app, rather than at each
call site where one omission is silent."

**That was false for every user-facing transaction, and it was false the whole time.**
Followed through viem 2.56.0: `sendTransaction` branches at
`actions/wallet/sendTransaction.js:92` on `account?.type === 'json-rpc'`, builds the request
from the **passed parameters only** (`maxFeePerGas`/`maxPriorityFeePerGas` at `:116-117`)
and calls `eth_sendTransaction` at `:126-131`. `prepareTransactionRequest` — the only thing
that applies the override — is reached inside `if (account?.type === 'local')` at `:165`, at
`:190`. **Every injected and WalletConnect account is json-rpc.**

⚠ **Arc is where this bites:** below 20 Gwei a transaction "may remain pending indefinitely
or fail outright", and pending indefinitely is the bad outcome — no error, no receipt, never
mined.

**What the override DID still cover is any public-client fee read**, which is where the
affordability and gas-reserve math get their price (`useFees` → wagmi's
`useEstimateFeesPerGas`). So the floor protected the arithmetic and not the transaction —
the half that cannot strand anyone.

**Fixed:** `writeFees(maxFeePerGas)` in `chain.ts` is now the single place that decides the
sent fee, passed at all five write call sites (Create approve + createToken, TradePanel
approve-USDC + approve-token + buy/sell).

⚠ **The undefined fallback is the substance, not a nicety.** `useFees()` returns `undefined`
until it resolves, and `maxFeePerGas: undefined` is **indistinguishable to viem from not
passing the field** — a naive spread would reintroduce the bug on precisely the first click
after a page load. `writeFees()` falls back to the floor.

Both false comments are corrected in place and each says what it used to say.

**`verify:chain` 11 → 17 checks**, asserting what is *sent* rather than what the estimator
returns — the old check read `estimateFeesPerGas`, which is exactly the function viem never
calls. Includes a source scan requiring every `writeContract` site to pass `writeFees`, and
a companion check requiring the scan to have **found** sites, because a scan matching
nothing makes "none are missing" trivially true. Comments are stripped first (§11.7).

Red-proofs, all three: dropping `writeFees` from one site → RED naming the file; removing
the flooring → RED; breaking the scan regex → RED **on both**, the guard reporting "NO CALL
SITES FOUND -- the scan is broken, not the code".

⚠ **Not changed: the EIP-5792 `sendCalls` batch path in `Create.tsx`.** Different mechanism,
wallet-priced, and §12.4 measured it unreachable on Arc because no wallet lists the chain.

## 18.4 Phase-2 decisions — recorded, NOT built

`BallistaMemeHook`, singleton, ownerless: no owner, no admin, no pause, no upgrade, no
withdraw. Permissions **`beforeInitialize` and `afterSwap` only**, plus whatever delta-return
flag `afterSwap` needs; every other callback disabled and reverting.

| decision | value |
|---|---|
| fee | **100 bps**, taken on the **unspecified** currency in `afterSwap` |
| split | **50/50** protocol / creator, **immutable**, protocol recipient set at construction |
| accrual | **accrual-only** — per-poolId, per-currency mapping. No conversion, no swap, no external call on the swap path |
| sweep | `sweep(poolId)`, **permissionless**, no slippage parameter, credits the escrow, zeroes the accrual |
| escrow | **pull-based**, per-recipient balances in USDC and each launch token, `claim()` / `claimToken(address)`, no push payouts, ownerless |
| recipient transfer | `transferFeeRecipient(poolId, newRecipient)`, current recipient only, **immediate, no timelock** |

**Why `transferFeeRecipient` exists and why it has no timelock:** LFX1's `creator` is written
once in a struct literal (`LFX1.sol:342`) with **no setter anywhere** — zero matches for
`.creator =` — so a lost key would otherwise strand half of every graduated pool's fees
forever. A timelock on a recovery lever protects nobody and delays the only remedy.

⚠ **THE EVENT SURFACE IS A FIRST-CLASS DELIVERABLE AND CANNOT BE ADDED LATER.** A hook that
returns a delta in `afterSwap` makes PoolManager's own `Swap` event **not reflect what the
trader paid** — Uniswap Foundation flags this class in their v4 analytics disclosure. The
hook is immutable, so events not designed in are gone for good. Cover: pool registered
(with token, creator, USDC index — the acceptance path is where the diagnostic value is,
since a rejection reverts), fee accrued per swap, fees swept with the split, recipient
transferred.

**Deployment needs a mined CREATE2 salt**, because the permission flags live in the low bits
of the hook's own address (`v4-core/src/libraries/Hooks.sol`). ⚠ **Mine for exactly the flags
used and no others** — an unused flag that is set is a live callback nobody wrote.

### ⚠ BLOCKING CONSEQUENCE: the adapter must NOT go live as the router before the hook exists

This follows from §18.1 item 3 and it is the most important line in this section.

`hooks` is part of the PoolKey, so a phase-1 pool and a phase-2 pool are **different pools,
permanently**. Phase-1 liquidity is burned to `0x…dEaD` and can never be withdrawn, so it
can never migrate. **Every token that graduates through the hookless adapter is stranded in
a hookless pool for good, earns the protocol nothing, and cannot be moved.**

So `activateRouter(adapter)` before the hook ships is not a reversible sequencing choice —
it permanently forfeits fee capture on every token graduated in the interval. Either ship
the hook first, or accept that interval knowingly. **Merging this branch does not create the
exposure; `proposeRouter` / `activateRouter` does.**

## 18.5 Arc facts a phase-2 implementer needs, with honest provenance

⚠ **Most of these were established in earlier sessions and are cited here for convenience,
not re-measured this session.** The provenance column says which is which, because "verified
this session" applied to a carried-forward fact is exactly the drift §12.5 and §14.1 record.

| fact | provenance |
|---|---|
| **20 Gwei mempool floor, silent drop** — below it a transaction "may remain pending indefinitely or fail outright" | Circle docs `/arc/references/gas-and-fees`, quoted at `app/src/chain.ts:16-18`. **Acted on this session** (§18.3) |
| **Base fee sitting at 20 Gwei** | **Measured this session**: `verify:chain` reports `maxFeePerGas 25 Gwei` — 20 × viem's 1.2 multiplier + 1 Gwei tip |
| **Dual-interface USDC: 18dp native, 6dp ERC-20, ONE balance** | §2, §9; cited `chain.ts:124-127`. **Confirmed structurally this session** by finding no native read anywhere (§18.1 item 5) |
| **30,000,000 gas per block** | §15.8, measured on Arc Testnet across three consecutive blocks. Not re-measured |
| **Timestamps non-decreasing, not strictly increasing** — order by block number | §2, §9.3. Not re-measured |
| **`PREVRANDAO` returns 0** | §2, §9.1. Not re-measured. We use no randomness |
| **Local EVM simulation cannot reproduce Arc** — blocklist, EIP-7708, truncating `balanceOf` | §4, §9; Arc's own docs. **This is why §16's attack pass ran on a Base fork and is explicitly not Arc assurance** |

## 18.6 Circle publishes Claude Code skills — but the install did NOT happen here

⚠ **RECORDED AS MEASURED, NOT AS INTENDED.** `/plugin marketplace add circlefin/skills`
returned **"/plugin isn't available in this environment"**. Nothing was installed by that
command, and **nothing in the repo records an install** — `.claude/` holds only
`launch.json` and `settings.local.json`, and `.mcp.json` carries only the `arc-docs` server.

What *is* true: a set of `circle:*` skills was available to the assistant in this session
(`use-arc`, `use-usdc`, `use-circle-cli`, `use-gateway`, `bridge-stablecoin`,
`use-smart-contract-platform` and others), so they reach the tool by some mechanism other
than a repo-level plugin config.

**A future session should not read this as "the skill is installed in this repo".** If the
skills matter to a workflow, establish how they are actually provided before depending on
them — and note `arc-docs` (§9's MCP server) is a *different* thing and is configured in
`.mcp.json`.

### ⚠ CORRECTED, 10 September 2026 — the skill CONTENT is now in the repo

The paragraph above stands exactly as written: nothing was installed by `/plugin`, and
that is still true. What changed is a different thing, and the difference is the point.

**`docs/CIRCLE_use-arc.md` is Circle's `use-arc` SKILL.md, fetched byte-for-byte and
committed** — 8,081 bytes, sha256 `c67e5e9dd4fe40fd`, from
`raw.githubusercontent.com/circlefin/skills/master/plugins/circle/skills/use-arc/SKILL.md`
(HTTP 200). **It survives a fresh clone.** The ambient `circle:*` availability recorded
above does not.

⚠ **TWO DIFFERENT THINGS, AND CONFLATING THEM IS THE ERROR THIS SECTION EXISTS TO
PREVENT.** A file in `docs/` is content anyone can read, diff and cite. Ambient skill
availability is a property of whoever is running the assistant, is invisible to the repo,
and cannot be relied on by a session that does not happen to have it. Having either one
tells you nothing about the other.

⚠ **THE COPY IS A SNAPSHOT, NOT A SUBSCRIPTION.** Nothing updates it and nothing checks
it against upstream. The sha256 above is what makes drift detectable; re-fetch before
trusting it on anything time-sensitive.

⚠ **AND IT DISAGREES WITH US ON THE RPC HOST — DELIBERATELY NOT RECONCILED.** The skill
gives `rpc.testnet.arc.network` (its lines 19, 31, 32). We use `rpc.testnet.arc.io`
(`app/src/chain.ts:58`) because §9.5 found `.io` is the DOCUMENTED host and `.network` an
undocumented alias carrying no compatibility promise. Both answer `eth_chainId` with
`0x4cef52`. The file is committed VERBATIM rather than corrected, so a future session must
not read it as licence to "fix" `chain.ts` back to the alias.
