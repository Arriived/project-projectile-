# Ballista

A memecoin launchpad native to Arc (Circle's stablecoin L1, USDC as native gas).
Bonding-curve launches that graduate to a DEX pool.

**Positioning:** trust and verifiability are the moat, not feature count. Twelve
competitors are launching on Arc and several have already damaged their reputations. Ours
is the one with a deployed, verified, adversarially-tested contract anyone can read.

**Arc mainnet: 16 September 2026.** Confirmed, external, immovable. Launch-ready target
~9 September; that week is buffer, not spare capacity.

---

## HOW TO READ THIS FILE

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
| R11 | `license_type: none` on the explorer | **OPEN — blocked** | Needs `[LICENSOR]`. |

---

# 4. TEST SURFACES ARE NOT INTERCHANGEABLE

**Do not read a mutation score as chain-level assurance.**

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

**There is no clamped-buy refund path.** The clamp never pulls the excess: `_quoteBuy`
computes `actualUsdcIn` for exactly the tokens available and `safeTransferFrom` pulls only
that. Closed by structure, not by a fix.

---

# 5. STANDING PROCESS RULES

## The mutation score is the freeze gate, not the test count

**228 passing tests coexisted with a real gap** — `quoteBuy`'s `UnknownToken` guard had no
test, and without it `quoteBuy` on a non-existent token returns `tokensOut = 0` with
`actualUsdcIn` set to the full amount and **does not revert**. Last clean run: **52/56 =
92.9%**, four survivors classified — two **proven** equivalent by `ceilDiv` monotonicity,
two **evidenced** over 2,000,000 fuzz cases with zero firings.

Keep "proven equivalent" and "unfalsified over N cases" as **separate** claims.

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

## Mutations go through the harness only

`scripts/guard-coverage.py` restores from git after **every** site, on SIGINT/SIGTERM and
via `atexit`, and refuses to start against a dirty file. **No ad-hoc mutation loops** — one
timed out mid-run and left a mutated contract on disk. The bad outcome is not a lost hour;
it is a mutation surviving into a commit unnoticed.

**A pre-commit hook refuses commits containing mutation markers** (`// MUTATED`,
`if (false) revert`). Lives in `.githooks/pre-commit`, activated by
`git config core.hooksPath .githooks` — **a fresh clone must run that command** or the hook
is inert. Verified to actually block.

## Other standing rules

- Report findings before fixing. Some are acceptable risks; that is the operator's call.
- Flag anything safe only by a **parameter value** rather than by structure.
- Prefer restructuring over compiler flags (stack-too-deep → extract a function, never `viaIR`).
- **Never claim it is bulletproof.** State what was tested, what was found, and what would still worry you with real money on it.
- Arc's `eth_estimateGas` returns **no margin** — always send with headroom. This will hit the frontend.
- Arc RPC requires `batchMaxCount: 1` in every raw ethers.js provider config.
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
| HEAD | `08be890` |
| bytecode | **24,018 / 24,576 — 558 free** |
| tests | **233 Hardhat, 7 Foundry** |
| last mutation score | 52/56 = 92.9% — **pre-dates this session's changes; must be re-run before re-freeze** |

## ⚠ `0xDF714C3bA8Ab3578652E9D066D862fc63AD3F802` IS STALE

That deployment predates the strict-mins fix. **It must not be sent to Zerion or anyone
else.** A new deployment and address come out of the re-freeze.

The authoritative record is `deployments/arcTestnet.json`, written by `scripts/deploy.js`
on every deploy, including the commit hash it was built from and a `commitDirty` flag
(which uses `git status --porcelain -uno`, ignoring untracked files — plain `--porcelain`
flagged every deploy irreproducible because of an unrelated archive in the repo root).

## Done this session

Strict mins merged and the adversarial-pair attack closed; mainnet fork wired, pinned and
verified; residual risk register created; pre-commit mutation guard added and proven to
block; blocklist substitution scoped honestly; Arc EVM differences verified against the
real docs.

## Remaining, in order

1. **Cross-curve contamination invariant** — Foundry, asserting the sum of all curves' `realUsdcReserves` + `treasuryFeesAccrued` + creator accruals never exceeds the contract's USDC balance. Prove it can go red.
2. **Mock-only sweep** — list every component whose only coverage is a stub.
3. **Actor/phase adversarial pass** — by actor (creator, sniper, whale, MEV/sequencer, malicious router, arbitrary contract, compromised owner, malicious frontend/indexer) and by phase (creation, creator window, curve trading, near-graduation, graduation execution, post-graduation, admin ops). Plus: owner-key blast radius in severity order; the 24h timelock window's realistic exposure; donation and direct-transfer paths; whether any token can be launched that can never graduate.
4. **Graduation helper** — external contract, no `LFX1` bytecode, permissionless, bounded correction spend, a failed call must leave the curve retryable rather than worse off.
5. **Fork suite proper** against real V2 — clean graduation, both skews, address ordering both ways, stranded remainder, retry, and whether `assert(amountAOptimal <= amountADesired)` can ever trip.
6. **Re-freeze** — clean mutation run with every survivor classified, redeploy, verify, record commit + bytecode hash, publish the new address.

---

# 8. NON-CONTRACT STATE

- **Frontend: not started. This is the critical path.** Price impact must be a headline number — a $500 buy at launch takes ~21% of supply with ~19% slippage. `minTokensOut` must never default to zero. Show "creator bought X% at launch" on every token page — the 2.5% cap limits only the *privileged* path and does not cap total creator holdings, so disclosure is the actual protection. A quote taken during the snipe window is stale within **one second** and can understate the received amount by ~9x (favourable to the buyer, so `minTokensOut` never trips — but a frozen quote is simply wrong).
- **Indexer:** migrations 001 and 002 **both unapplied**; `SUPABASE_URL` does not resolve. Goldsky vs Envio undecided pending their answers on Arc mainnet support; Supabase is the default if neither lands. The ABI is **generated** from build artifacts (`npm run build`) — the hand-maintained one silently truncated the `Curve` struct from 22 fields to 16 and hid `creatorLaunchPurchased`, the disclosure that protects buyers. **Never hand-edit it.**
- **Licence:** BUSL-1.1, change licence GPL-2.0-or-later, Change Date 2030-09-16, `[LICENSOR]` **still unfilled** and blocking Blockscout's `license_type` (value `bsl_1_1`; `hardhat verify` does not send one, so it needs the UI or a direct API call). ⚠ Verifying on a public explorer arguably **starts** the four-year BUSL clock.
- **Owner is a single EOA** by the operator's deliberate decision. Do not re-raise.
- **`ARCHITECTURE.md`** holds 140 comment blocks / 748 lines moved out of the deployed source. Published nowhere; it is the only copy of that reasoning.

---

## Stack

Solidity 0.8.24 · Hardhat · Foundry · Slither · Node.js · Supabase (Postgres + RLS) ·
plain HTML/CSS/JS frontend, no build step · Arc Testnet (chainId 5042002) · Blockscout ·
Circle CCTP V2 (deferred, out of launch scope)
