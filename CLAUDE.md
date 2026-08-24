# Ballista

A memecoin launchpad native to Arc (Circle's stablecoin L1, USDC as native gas).
Bonding-curve launches that graduate to a DEX pool, with cross-chain USDC buy-in
planned so a user on Base/Ethereum/Solana can buy an Arc-native token without
manually bridging first.

**Positioning:** what Pons V2 is to Robinhood Chain, but for Arc. Trust and
verifiability are the moat, not feature count — twelve competitors are launching
on Arc and several have already damaged their reputations (a phishing "bridge"
site took real funds before mainnet even opened). Ours is the one with a
deployed, verified, adversarially-tested contract anyone can read.

**⚠ THE REPO IS "Ballista"; `contracts/` IS DELIBERATELY NOT.** Everything outside
`contracts/` — docs, tests, scripts, the indexer — says Ballista. Everything inside
`contracts/` keeps the neutral `LFX1` / `LFX1Token` naming, **filenames included**, and
so do the `getContractFactory('LFX1')` strings that tests and scripts use to reach
them. This is not an oversight and it is not half-finished work.

The reason: Blockscout publishes the SOURCE PATH, not just the contract name. The live
verified deployment currently serves `contracts/LFX1.sol` and `contracts/LFX1Token.sol`
to anyone browsing the explorer. Renaming those files would publish the brand to every
competitor scanning ArcScan, which is the entire thing the neutral naming exists to
prevent. Renaming only the *contract* and not the file achieves nothing for the same
reason. **Do not "finish" this rename.** The switch happens at mainnet, on instruction.

**Repo location: `C:\dev\arc-launch`, pushed to a private GitHub remote.** It was moved
off OneDrive on 24 Aug after OneDrive corrupted 29 of 54 mutation-test results into
phantom compile failures and failed a git ref write outright in one session — it
falsified audit data and nearly ate a commit. Do not move it back.

**How to read this file: it is a starting point to verify, not ground truth.**
It is written by the same assistant that writes the code, from sessions that have
since ended, and it goes stale the moment a constant, address or table changes.
Before relying on any number, address, table or claim here, check it against the
repo — `contracts/Ballista.sol` for constants and modifiers, `git log` for
deployments, an actual test run for test counts. Doing exactly that has already
caught real drift in this document more than once. Where this file and the source
disagree, **the source is right and this file is the bug** — fix the file.

---

## Timeline — the constraint that governs everything

- **Arc mainnet: September 16, 2026.** Confirmed, external, immovable.
- Launch-ready target ~September 9. That week is buffer for late problems, not
  spare capacity.
- Build and test on Arc Testnet. Mainnet is a config change on launch day.
- Today is August 21.

## Scope for mainnet

**IN:** launchpad (create → curve trading → graduation), frontend.
**OUT until after mainnet:** trading terminal, CCTP bridging, holder fee
distribution, buy-and-burn, creator allocation lock.

If a feature isn't required for "a user can launch a token and another user can
buy it," it's post-launch. Scope creep is the main risk to the date — push back
on it, including when the push comes from me.

---

## Standing policies — apply from now on, not just once

### 1. Never deploy under the name "Ballista" until explicitly told

Competitors find each other by searching contract names on the explorer. Every
testnet deployment uses a neutral, non-descriptive name (`LFX1`-style — not
"Launchpad", not "Factory", nothing keyword-searchable). The real name goes live
at mainnet, on instruction only.

**The source FILENAME leaks too — renaming only the contract is not enough.**
Verified on the live deployment: Blockscout's API publishes
`file_path: contracts/Ballista.sol`, plus `contracts/BallistaToken.sol` and
`contracts/interfaces/IDEXRouter.sol` in `additional_sources`. Hardhat is happy
to compile contract `LFX1` inside `Ballista.sol`, so the two *can* diverge — it
just achieves nothing, because the path is published verbatim on the explorer.
Renaming for real means renaming the files as well.

### 2. Licence: explicit permission-required notice, not bare `UNLICENSED`

`SPDX-License-Identifier: UNLICENSED` already grants no rights, so copying is
already infringement — but say it explicitly. OpenZeppelin's 14 sources stay MIT
and are unaffected: they carry their own `// SPDX-License-Identifier: MIT` and
appear as separate files on the explorer.

**Blockscout has no custom/proprietary option.** Its verification API accepts
exactly 14 values: `none`, `unlicense`, `mit`, `gnu_gpl_v2`, `gnu_gpl_v3`,
`gnu_lgpl_v2_1`, `gnu_lgpl_v3`, `bsd_2_clause`, `bsd_3_clause`, `mpl_2_0`,
`osl_3_0`, `apache_2_0`, `gnu_agpl_v3`, `bsl_1_1`. A bespoke notice can only be
filed as **`none`** — which is what the current deployment already shows, and
which communicates nothing to anyone browsing. **`bsl_1_1` (BUSL-1.1) is the only
supported value that actually means "source-available, commercial use
restricted."** Note also that `hardhat verify` does not send a licence type at
all, so whichever is chosen must be set through Blockscout's own UI or a direct
API call.

**Chosen 22 Aug: BUSL-1.1, change licence GPL-2.0-or-later, Change Date 2030-09-16,
Licensor left as `[LICENSOR]` until the entity name is supplied.** GPL rather than
MIT because BUSL exists to stop commercial forks during the restricted window, and
converting to MIT at the Change Date would hand a fork the right to close the source
again — GPL-2.0-or-later keeps derivatives open. Confirmed as Uniswap v3-core's own
choice by reading their LICENSE, not from memory. `LICENSE` at the repo root is the
canonical MariaDB text with only the Parameters block replaced; the Terms section was
verified byte-identical rather than retyped.

**⚠ Verifying on an explorer arguably STARTS the four-year clock.** BUSL converts on
the Change Date *or the fourth anniversary of the first publicly available
distribution of that version, whichever comes first*. A verified contract on a public
explorer is plausibly such a distribution, so a long-lived verified testnet deployment
should not carry a Change Date anyone is relying on — the real date may be earlier
than the one written in the file. Immaterial at current timescales; it matters if a
version is ever left published for years.

Realistic expectation: enforcement against an anonymous deployer on a new chain
is not practical. This raises cost and removes ambiguity. It does not make
copying impossible. The one lever that does work in practice is DMCA against
hosted frontends and GitHub mirrors, which needs a clear copyright line more than
it needs any particular licence.

### 3. No security reasoning in deployed source

The contract should say almost nothing. **Removed entirely:** anything of the form
"safe only because of X", anything describing an attack, mitigation or weakness,
anything explaining why a value was chosen or what breaks if it changes, trust
notes, admin-power commentary, and long explanatory prose (a strong tell that code
was AI-assisted, which itself costs trust).

**May stay:** a short mechanism-only line on genuinely complex code — the curve
math inversions and the clamp paths. Never rationale, never risk. If in doubt, cut.

Applied 21 Aug: `Ballista.sol` went 1420 → 799 lines, 5 comment lines left in
total. 777 comment blocks were moved verbatim into **`ARCHITECTURE.md`**, which is
private and published nowhere. **Move reasoning, never delete it** — that file is
now the only copy. New findings go in the report or in these docs, never into the
source.

**Stripping comments frees ZERO bytecode** — comments are not compiled. Revert
strings are, and they leak the same kind of detail while being readable straight
off the chain without any verification at all. See the bytecode note below.

---

## Current deployment (Arc Testnet)

Deployed as **`LFX1`** per the naming policy — the name "Ballista" appears nowhere
on chain, in the contract name or in any published source path.

| | address |
|---|---|
| **LFX1** (the launchpad) | `0x7072b0f726526B616101473aB6579A8F58fee1fb` (block 58301503) |
| MockRouter (placeholder) | `0xe3287055068C662a4f03eA3Ae6ceF032C3A32F37` |
| USDC | `0x3600000000000000000000000000000000000000` |
| treasury / owner | `0x64140EAa0a3B6E4682C98e440837bd3d5482B4cb` (EOA — multisig pending) |

Both exact matches on Blockscout (`is_fully_verified: true`,
`is_partially_verified: false`, `is_changed_bytecode: false`). Explorer:
`https://testnet.arcscan.app/address/0x7072b0f726526B616101473aB6579A8F58fee1fb`

Published source paths are now `contracts/LFX1.sol`, `contracts/LFX1Token.sol` and
`contracts/interfaces/IDEXRouter.sol` — confirmed via Blockscout's API, no brand
string anywhere in the closure. `license_type` is still `none`; the licence
decision is open.

Superseded deployments: `0x63C4...Ec57` (original Ballista),
`0x874C...1858`, `0x14faEc...0759`, `0x8a6175...44f7`, `0x19ba1F...01e3`
(last one under the old name).

The authoritative record is `deployments/arcTestnet.json`, written by
`scripts/deploy.js` on every deploy. The table above is a convenience copy; if the
two ever disagree, trust the JSON and the deploy transaction on Blockscout. Never
let a live address exist only in a commit message or a scratch script.

Branch: `ballista-migration`. **186 Hardhat tests + 5 Foundry invariants.**

---

## Contract design — decisions and why

### Curve (redesigned 21 Aug)

```
INITIAL_VIRTUAL_USDC_RESERVES  =  2_667e6
INITIAL_VIRTUAL_TOKEN_RESERVES =  1_075_000_000e18
CURVE_TOKEN_SUPPLY             =  807_000_000e18
LP_TOKEN_RESERVE               =  193_000_000e18
TOTAL_TOKEN_SUPPLY             =  1_000_000_000e18
graduation threshold           =  8_000e6
```

Measured: depletion ceiling **$8,030.85**, graduation gap **+4.16%** (up to
+4.83% on overshoot), launch→graduation multiple **16.05x**, graduation market
cap ~$39,687.

**Why $8,000:** competitors graduate far lower — pump.fun ~$6,100-7,400
(~70-85 SOL), Pons 4.2 ETH (~$9,700). We were at $67,000, i.e. 7-11x everyone.
Real pump.fun graduation rate is 0.198%, so a high bar is a serious problem.
$8,000 sits between the two and gives a better post-graduation pool than $6,700
(a $1,000 trade moves it 12.5% vs 14.9%).

**The flat-handoff derivation** (verified — it reproduces the old constants
exactly):

```
x            = T / (vUSDC0 + T)
CURVE        = vTOKEN0 * x           tokens sold at threshold
pool price   = T / LP_TOKEN_RESERVE
curve price  = T / (x * vTOKEN0 * (1-x))
gap          = x * vTOKEN0 * (1-x) / LP - 1
multiple     = 1 / (1-x)^2           depends ONLY on x
```

`LP_TOKEN_RESERVE` is the direct gap dial. **Do not increase the gap** — a
positive gap is free money for arbitrageurs; large gaps get arbed down within
minutes and give the first DEX buyer a bad fill. +4% is deliberate.

**807M/193M chosen over 806M/194M** so the ceiling ($8,030.85) sits *above* the
threshold. At 806M the ceiling was $7,991 — below the threshold, making it
unreachable, `graduationProgressBps` unable to hit 100%, and "$8,000 to
graduate" subtly false.

### Dual graduation trigger — load-bearing, not a safety net

```
realUsdcReserves >= threshold   OR   tokenReserves == 0
```

Without it, any rounding that puts the ceiling below the threshold strands
**every** token permanently. Even unrounded, 806M landed 19 cents short.

Consequence: a clamped buy always graduates (the clamp takes every remaining
token, tripping the depletion arm in the same transaction), so "depleted but
still ACTIVE" is unreachable. The threshold→ceiling window is only ~$31 wide.

### Graduation state machine

`ACTIVE → GRADUATION_READY → GRADUATED`, one-way. Decoupled from the triggering
trade: a router failure cannot unwind a buy that already succeeded. `graduate()`
is permissionless and retryable, so Ballista's own frontend/backend being down
never blocks a token reaching the DEX.

### Router controls (F1 fix)

`proposeRouter` → 24h → `activateRouter`. `revokeRouter` is **immediate** and
clears `router` itself. Granting trust is slow and visible; removing it is
instant.

**Constructor bootstrap:** a router passed at deployment is live from block
zero, bypassing the timelock once. Without this, mainnet launch day would be
dead — Arc mainnet doesn't exist until the 16th, `createToken` is gated on a
live router, and a 24h wait would mean tokens couldn't launch until the 17th.
This doesn't weaken F1: the attack is an owner *swapping* the router later, and
a constructor-set router is visible in the deployment's constructor args with no
window to attack.

Verified: `router` is assigned in exactly three places (constructor,
`activateRouter`, `revokeRouter`), `setRouter` no longer exists, and a test
enumerates the whole compiled ABI to assert no other setter.

**Why it matters:** graduation approves the full LP allocation plus all
accumulated USDC to the router. A malicious router takes ~the whole pot. This is
the highest-value lever in the contract.

**`pause()` does NOT stop graduation — and that is deliberate.** `createToken`,
`buy` and `sell` are `whenNotPaused`; `graduate()` is `nonReentrant` only. Pausing
stops trading and transitively halts the auto-graduation inside `buy()`, but
anyone can still push an already-`GRADUATION_READY` token through a live router
while the contract is paused.

**The lever for a malicious router is `revokeRouter()`, not `pause()`.** It clears
`router` in the same transaction, and `graduate()` requires `router != address(0)`
— so revocation is a hard stop, not a mitigation. Know this before you need it;
it is not something you want to derive at speed.

Decided, not left by omission. `graduate()` stays un-pausable because:

1. `revokeRouter()` is strictly stronger for the only case that matters. Pause
   merely postpones handing the pot to a router that is still approved the instant
   anyone unpauses.
2. A pausable `graduate()` would be a lever that *looks* sufficient and isn't.
   Under pressure someone pauses, sees everything stop, and believes it is
   contained. Two levers where one is subtly wrong is worse than one correct lever.
3. Decisive: a pausable `graduate()` is a censorship lever. Today the owner cannot
   stop tokens reaching the DEX while custodying their USDC — that is what
   "permissionless and retryable" buys, and it is readable on the verified
   contract. Trading that away for operational convenience is the wrong trade for
   a project whose whole position is verifiability.

The counter-argument — that stopping graduation strands tokens at
`GRADUATION_READY` — is real, but applies to **both** levers equally, so it does
not discriminate between them. The only asymmetry is undo speed (unpause is one
transaction; replacing a revoked router is 24h), and a fast-undo graduation stop
is precisely the power you would not want an owner to have.

**Monitoring `RouterProposed` is a launch requirement, not a nice-to-have.** The
24h timelock only defends anything if a human is watching the event during it.
Unwatched, it is 24 hours of decoration.

### Fees

- 1% buy and sell, per-token snapshotted at creation.
- Creator share: **90% of the buy-side fee, 50% of the sell-side.** Blends to
  **70%** at a 50:50 mix, ~78% buy-heavy. A lifetime mix below 50:50 buy is
  structurally impossible (everything sold was bought first), so 70% is a hard
  floor.
- **Never market this as "90/10."** The blend is 70%, both splits are readable
  on a verified contract in thirty seconds, and the honest claims — "70%,
  matching the market leader" and "90% on every buy" — are already
  market-leading. Push back if this comes up again.
- **ALL fees accrue and are claimed — creator AND treasury.** Nothing is pushed to a
  payee inside a trade. A payee that reverts must never be able to break trading.
  - The treasury was brought under this rule on 24 Aug. Before that, every buy, every
    sell **and every `createToken`** pushed to the treasury inline, so a blocklisted
    treasury address bricked trading *and* launching. Circle can blocklist an address;
    that made a third party able to halt the launchpad. Cost: **+260 bytes**.
  - **`claimTreasuryFees()` is deliberately PERMISSIONLESS.** It can only ever move
    protocol funds to `treasury`, so there is nothing to gain by calling it and nothing
    to grief. This matters for the multisig migration: sweeping treasury fees does
    **not** become a 2-of-3 Safe transaction — anyone, including a keeper or a hot
    wallet, can trigger the sweep, and the USDC still lands at `treasury`. Only
    `setTreasury` needs the Safe.
  - **The solvency identity changed.** The contract now legitimately holds unclaimed
    treasury fees, so every check of the form "balance covers reserves + creator fees"
    is now WRONG — it reads the accrued balance as surplus and would stay green while a
    real shortfall of up to that amount existed. Both Foundry invariants and two Hardhat
    checks were extended to add `treasuryFeesAccrued()`. Proven red by paying the
    treasury inline *and* accruing it.
- Creation fee: **0.5 USDC.** Not 0.1 — at 0.1 one wallet could push 8,640
  launches/day for ~$1,063. Noxa earned $12M in fees and still had to stop
  accepting launches because the feed became unusable; revenue from spam doesn't
  offset that.
- Revenue reality: curve-phase revenue is **capped per token** ($346-600
  depending on mix). Pump.fun made $1B+ with a sub-1% graduation rate — the
  engine is launch volume and curve trading, not graduations. Graduations are
  marketing and, later, the V4 fee-capture path.

### Snipe tax

Table `[9800, 9500, 9000, 8000, 6000, 4000, 2000, 0]`, indexed by elapsed
seconds. Retuned 21 Aug because the old `[9800, 2500, 300, 100, 0]` no longer
deterred against the thinner curve.

Measured share of curve supply taken by a $1,000 sniper:

| t | tax | new table | old table |
|---|---|---|---|
| 0 | 9800 | 0.49% | 0.49% |
| 1 | 9500 | 1.96% | **28.93%** |
| 2 | 9000 | 4.34% | **35.25%** |
| 3 | 8000 | 8.85% | 35.79% |

Testnet racing found real snipers landing at **t=1-2**, exactly where the old
table failed. Split 70% treasury / 30% into the curve, adjustable, snapshotted
per token. Never to the creator — a creator sniping their own launch would
recover part of their own tax.

Tables are **immutable per version**; each token snapshots the version it
launched under. There is no mutate path.

**Describe it as "up to 98%," not "98%"** — the top tier is only reachable by
co-located bots.

**⚠ Zero headroom:** table t=0 (9800) + base fee (100) = 9900 =
`MAX_TOTAL_FEE_BPS` exactly. Raising the base fee at all requires publishing a
table with a lower t=0 first. Fails loudly at `createToken`.

### Other mechanics

- **Partial-fill clamp** on buy and sell — fills what's available rather than
  reverting, and never pulls the excess in the first place (no refund step to
  fail). Stops the graduating buy being griefable by a small front-run.
- **Block-0 restriction:** trading opens the block after creation.
- **Creator launch window is TIME-based, not block-based.** `block.timestamp <=
  creationTimestamp + creatorLaunchWindow` (default 3s, settable, snapshotted,
  in the economics hash). A block-number check was unreachable from an EOA.
  - **A zero window is same-SECOND, not same-BLOCK.** Arc's 500ms blocks mean two
    consecutive blocks routinely share a whole-second timestamp, so window 0 still
    spans more than one block. Anyone reading "0" as "one block" is wrong.
  - **The honest claim is "first CHEAP access," not "first access."** A sniper can
    pay more gas and land ahead of the creator inside the window. Measured, $1,000
    sniper front-running at each second of the window:

    | t | tax | sniper take | creator still gets |
    |---|---|---|---|
    | 0 | 9800 | 0.498% | full 2.500% |
    | 1 | 9500 | 1.968% | full 2.500% |
    | 2 | 9000 | 4.348% | full 2.500% |
    | 3 | 8000 | 8.859% | full 2.500% |

    Two things follow. The window does **not** make sniping worse — those figures
    match the pre-existing t=0-3 numbers to the third decimal, because the snipe
    tax is untouched. And being front-run does **not** cost the creator their
    allocation: the cap is a share of curve supply and the curve is nowhere near
    exhausted, so the creator still takes the full 2.5% in every case. Ordering
    costs the sniper ~4% relative (0.498% -> 0.479% if the creator goes first).
  - Window length is close to abuse-free because the cap, not the clock, bounds
    the take — and buying later costs the creator MORE USDC for the same tokens.
    Past t=7 the snipe tax is zero, so a window beyond that confers nothing.
- **Creator launch buy:** creator-only, untaxed, capped at **2.5% of curve
  supply** (`maxCreatorLaunchBps`, settable, snapshotted). Cap is **cumulative
  per token** — a per-call cap is loopable inside one block for ~37% of supply.
  Proven defeated at exactly 2.500%.
  - The cap limits the **privileged** allocation only. It does **not** cap total
    creator holdings — nothing stops a second address. **Never describe it as
    "creators are capped at 2.5%."** Disclosure is the protection: the frontend
    must show "creator bought X% at launch."
- **Symbol lock:** 5-minute time-limited hold, not permanent.
  `caseSensitiveSymbols` starts `true` (lenient — "Cat" and "cat" both launch).
  Tightening it later increases symbol-squatting exposure.
- **Launch cooldown:** 10 seconds. Not a real spam control — bypassable via a
  factory contract. The creation fee is the real control.
- **Economics pinning:** `createToken` takes `expectedEconomicsHash`; reverts if
  fees, threshold, or symbol policy changed since the creator saw the terms.
  Pool boost is deliberately **not** hashed — the creator supplies it in the
  same transaction, so hashing protects against nothing; immutability is
  structural (no setter exists).
- **Mutable metadata URI** — creator-only, emits old and new values so socials
  swapped after launch are auditable.
- **Pool boost** (opt-in at launch): creator's fee share accumulates separately
  and is added to the pool's USDC side at graduation. Must **never** count
  toward the threshold. Measured: gap 4.159% → 5.649%. Effect is ~1-4% deeper
  pool — a **trust signal, not an economic mechanism**. Don't let UI imply
  otherwise, and don't call it "holder fee sharing" (nobody receives anything).
- **Licence: UNLICENSED** on our 9 contracts; OpenZeppelin's 14 sources remain
  MIT. **Keep verifying on Blockscout** — public readability is the whole
  positioning.

---

## Open items

1. ~~**Creator block-0 buy is unreachable from a normal wallet.**~~ **RESOLVED and
   PROVEN ON TESTNET 22 Aug.** Live smoke test, 43/43 checks:

   | flow | blocks apart | seconds apart | result |
   |---|---|---|---|
   | sequential (wait for receipt, then buy) | +3 | **+1s** | buy succeeded |
   | back-to-back (predicted address) | +1 | **+1s** | buy succeeded |

   The sequential flow is the one that was impossible before, and the numbers show
   exactly why: three blocks apart but only ONE second apart. A block-number check
   had no chance; a 3-second window has 3x margin at observed timing. The check is now
   The check is `block.timestamp <= creationTimestamp + creatorLaunchWindow`,
   replacing `block.number == creationBlock`. `creatorLaunchWindow` is a settable
   uint32, snapshotted per token, default **3 seconds**, pinned by the economics
   hash.
2. **Multisig migration.** Owner is still a single EOA. Safe is confirmed live
   on Arc Testnet. 2-of-3, keys **independently generated** — not one seed
   copied three ways. Contract uses plain `Ownable`, so `transferOwnership()` is
   immediate and irreversible; verify the address twice. Use
   `verify-ownership.mjs` before and after.
3. **`SUPABASE_URL` doesn't resolve** — project deleted, renamed, or stale.
   Migration `indexer/migrations/001_add_token_state.sql` still unapplied.
4. **Indexing must survive the laptop being closed.** Goldsky supports Arc, has
   a free tier, and explicitly supports **factory contracts** — which matches
   this architecture exactly. Mirror sinks into Postgres (keeps Supabase);
   Subgraphs replaces the indexer with a GraphQL endpoint. Note Goldsky Edge RPC
   is a *different* product — that's RPC reads, not indexing.
5. **Frontend.** Nothing usable. Biggest remaining risk.
6. **V4 graduation + fee-capture locker.** See below.
7. **Move the repo out of OneDrive** — it fights build tooling and can corrupt
   `.git` mid-operation.

---

## Uniswap on Arc — confirmed from their own SDK

`sdks/sdk-core/src/addresses.ts`, `ChainId.ARC` (Arc **mainnet**; no Arc testnet
entry exists, which is why V4 can't be integration-tested on our own testnet):

| | address |
|---|---|
| v4 PoolManager | `0x8366a39cc670b4001a1121b8f6a443a643e40951` |
| v4 PositionManager | `0x6049c9a0e26405c0985f9e3685c87d0ae917f82b` |
| v4 StateView | `0xf3334192d15450cdd385c8b70e03f9a6bd9e673b` |
| v4 Quoter | `0x8dc178efb8111bb0973dd9d722ebeff267c98f94` |
| v3 core factory | `0xf0db7b58379503491d857db50ac9ece64c653918` |
| v3 SwapRouter02 | `0x53bf6b0684ec7ef91e1387da3d1a1769bc5a6f77` |
| **v2 router** | **`0x1f7d7550b1b028f7571e69a784071f0205fd2efa`** |
| v2 factory | `0x89e5db8b5aa49aa85ac63f691524311aeb649eba` |

**The v2 router matches `IDEXRouter.addLiquidity` exactly** — V2 graduation
needs zero new code. That's the fallback if V4 isn't ready.

**V4 plan:** an adapter implementing `IDEXRouter` internally doing V4
operations, plus a locker holding positions permanently while allowing fee
collection. Don't modify `Ballista`'s graduation logic. Fee capture
post-graduation is what makes an aggressive creator split sustainable.

**Critical constraint for the locker** (learned from Adam's IMD launchpad,
`@surfcoderepeat`): **never transfer value to an externally-controlled address
inside a PoolManager unlock.** A contract recipient can return success while
leaving an unsettled delta, reverting the whole unlock — bricking fee collection
permanently. A gas stipend does not prevent it. Collect to the locker's own
balance; claim in a separate transaction.

**Testing:** fork-test against Base Sepolia's V4 deployment
(`0x05E73354cFDd6745C338b50BcFDfA3Aa6fA03408`). Mocks test our understanding of
V4, not V4. **Currency ordering must be tested both ways** — roughly half of all
token addresses will sort below USDC and half above; getting it backwards
inverts the pool price.

---

## Hard-won constraints — these have caused real bugs

- **Bytecode: 22,628 / 24,576 — 1,948 bytes free.** Was 5 bytes. Recovered by
  converting all 54 `require(cond, "string")` in `Ballista.sol` to 27 custom
  errors (`if (!cond) revert X();` — `require(cond, Err())` needs solc 0.8.26 and
  we are on 0.8.24). **Measured saving 2,164 bytes**, of which the strings
  themselves are only part: the rest is the per-site `Error(string)` ABI-encoding
  machinery that disappears with them. Diagnostic parameters were then added back
  at 13 sites (`SlippageExceeded(received, minRequested)`, `CurveNotActive(state)`,
  `LaunchWindowClosed(closedAt)`, …) for **221 bytes** — cheap, and they make a
  failure legible without a lookup table.
  - **Comments are not compiled; stripping them frees zero.** Revert strings are,
    and they are readable straight off the chain with no verification at all.
  - **`BallistaToken` counts against Ballista's limit.** `new BallistaToken(...)`
    embeds its **4,077-byte creation bytecode** into Ballista — ~18% of the
    contract, and the single largest block in it. It is not "a separate small
    contract"; if headroom ever gets tight again this is where the leverage is,
    though most of those 4KB are OpenZeppelin ERC20 rather than anything ours.
  - Still unconverted, deliberately: `BallistaToken` (1 string, ~100 bytes) and
    the mocks (not deployed). Churn is risk and the margin no longer needs them.
- **Arc RPC requires `batchMaxCount: 1`** in every **raw ethers.js** provider
  config (the indexer, the frontend). Hardhat's own provider doesn't route
  through ethers' batching, so it doesn't apply there.
- **Arc's `eth_estimateGas` returns no margin.** A buy sent at the bare estimate
  (198,794) ran out of gas; the same call with a 400,000 limit succeeded using
  192,616. hardhat-ethers sends at exactly the estimate. **Always send with
  headroom — this will hit the frontend too.**
- **Arc targets 500ms blocks** (Malachite BFT, sub-second deterministic finality,
  per Arc's own consensus write-up). Two consecutive blocks can therefore share a
  whole-second `block.timestamp`, which is why `hardhat.config.js` sets
  `allowBlocksWithSameTimestamp: true`. `hardhat.config.js` carries the same
  reasoning in a comment — keep the two in sync and do not "clean up" either,
  since the tests need several blocks inside one second to exercise t=0 at all.
  It is also why the block-0 trading restriction only delays a sniper by half a second,
  which is the entire reason the snipe tax exists.
- **Never re-derive the bonding curve math.** Use `_quoteBuy` / `_quoteSell`.
  External LLMs have re-derived it incorrectly more than once.
- **USDC is 6 decimals** in contract amounts. Arc also exposes USDC as native
  gas with 18 decimals internally — the same pot, two views. Not interchangeable.
- **Fees are read per-token from `curves()`**, never assumed global.
- **Never put raw private keys in browser storage.** Rejected permanently.
- **The two CCTP bullets below are deferred, not current work.** Bridging is out
  of launch scope (see Scope). They are kept because they were expensive to
  establish and will be right when you return to them after mainnet — not because
  anything on the critical path depends on them.
- **Verify Arc/Circle/CCTP claims against official docs** (`developers.circle.com`,
  `docs.arc.io`), never from memory. Arc mainnet is still not in Circle's
  published CCTP address list; Arc testnet is domain 26 and *is* a supported
  Forwarding Service destination.
- **The custom bridge relayer should be scrapped** — Circle's Forwarding Service
  does the job (no wallets to fund, no retries to manage, fees taken from the
  minted USDC so users need no destination gas). Bridge Kit or
  `depositForBurnWithHook`, not our own relayer.

## Frontend requirements that fall out of the above

- **Price impact must be a headline number.** The curve is ~11x thinner than
  before: a $500 buy at launch takes ~21% of supply with ~19% slippage. Someone
  receiving 19% less than quoted will assume they were scammed.
- **A quote taken during the snipe window is stale within ONE second.** Measured: a
  quote at t=0 against an execution 2.5s later returned 35,092,491 tokens where the
  quote said 4,015,689 — an 8.7x difference, because the tax decayed two tiers in
  between. The direction is always favourable to the buyer (tax only decays, so
  execution beats a stale quote and `minTokensOut` never trips), so this is a
  presentation problem rather than a loss. But a UI showing a frozen quote during the
  first seven seconds is showing a number that is simply wrong. Re-quote continuously
  and show the current tax tier and the seconds remaining, or do not show a quote at
  all until the window closes.
- **`minTokensOut` must never default to zero.** On an exhausted curve a zero
  default silently does nothing; on a thin curve it means arbitrary sandwiching.
- **Show "creator bought X% at launch"** on every token page.
- Surface metadata-update events ("socials updated N hours ago").
- Nudge hard on social links at launch: pump.fun launches advertising Telegram
  graduate at 1.485% vs 0.166% (8.94x); all three channels 1.919% vs 0.110%
  (17.4x). Creator self-buy gives a 4.51 hazard ratio.

---

## Foundry — depth, and a vacuous invariant caught by inversion

**1000 runs x 250 depth = 250,000 calls per invariant**, up from 256 x 50 = 12,800.
Handler gained `claimTreasury()`, since treasury fees now accrue and the claim path is
part of the state machine — it is exercised ~62k times per run.

**A new invariant was written, proved vacuous, and replaced.**
`invariant_graduatedCurvesAreFullyDrained` asserted that a GRADUATED curve holds no
reserves. It passed 250,000 calls — and it still passed with
`c.realUsdcReserves = 0` commented out of `_performGraduation`, because **the handler
caps buys at ~250 USDC to keep curves alive, so no curve ever reaches the 8,000
threshold and the assertion never ran.** Raising the cap would graduate every curve on
the fuzzer's first call and hollow out the solvency invariants instead — the trade the
handler comment already warns about. It is now a deterministic test that forces the
state, `test_graduatedCurveIsFullyDrained`.

**That test needed three arms before every assertion was load-bearing**, and each was
found the same way — by mutating and watching it stay green:
- a **depleting** buy leaves `tokenReserves` already zero, so `c.tokenReserves = 0` is
  redundant on that path; the **threshold** arm is needed to make it bite
- every fuzz token is created with pool boost OFF, so `c.poolBoost = 0` is redundant
  unless a **boost-enabled** token is launched and graduated

All three drain assignments now fail the test when removed. **The lesson generalises: an
assertion is only load-bearing on the paths that actually reach it, and "the invariant
passed" says nothing until the mutation says otherwise.**

## Static analysis — Slither 0.11.6, 24 Aug

17 findings. What was acted on, and what was dismissed and why — the dismissals matter
more than the acceptances, because a tool's output is a starting point.

**Medium — `reentrancy-no-eth`, `c.state` written after `addLiquidity`. REAL as
structure, safe by guard placement rather than by ordering.** `_performGraduation` sets
`c.state = GRADUATED` *after* the router call, which does violate CEI. It is reachable
from exactly two places, both `nonReentrant`: `_settleBuy` (from `buy`/`creatorLaunchBuy`)
and `graduate()`. The cross-function targets Slither names — `currentPrice`,
`currentSnipeTaxBps` — are `view`. Verified by enumeration: **the only state-changing
external function that is neither `nonReentrant` nor `onlyOwner` is `updateMetadataURI`**,
which is creator-gated and only writes a string. A hostile router driving all eight
external functions from inside graduation is blocked on every one, and that test goes red
if any single guard is removed.
⚠ This is safe because of WHERE THE GUARDS ARE, not because the ordering is correct. Add
one unguarded state-changing external function and it becomes live.

**Medium — `incorrect-equality`, `liquidity == 0`. Dismissed.** The detector targets
equality on balances and timestamps, where an exact match is fragile. Here zero is a
distinguished value — "the router returned no LP tokens at all" — not an approximate one.

**Medium — `unused-return`, `amountA`/`amountB` from `addLiquidity` ignored. Valid, not a
bug, worth doing later.** Only `liquidity` is read. Consuming the amounts would let
graduation detect a partially-consuming router and zero the residual approval on the
success path. Today that residual is bounded by orphaned funds nobody is owed and is
already regression-tested, so this is a tightening, not a fix.

**Low — `events-maths` ×5. VALID and unaddressed.** `setLaunchCooldown`,
`setSymbolLockDuration`, `setCreationFee`, `setDefaultGraduationThreshold` and
`setDefaultFees` all change owner-controlled economics **with no event**. This project
already treats "monitoring `RouterProposed` is a launch requirement" as doctrine; by the
same logic these are unmonitorable admin actions. The economics hash protects anyone
mid-launch from a surprise, but nothing makes the change *observable*. Decide before
mainnet.

**Low — `timestamp` ×6. Inherent, bounded, dismissed.** The snipe tax, creator window,
router timelock, symbol lock and launch cooldown are all deliberately time-based. A
validator nudging `block.timestamp` a second or two could drop a sniper into a cheaper
tax tier; the tier decays in seconds anyway, so the gain is small and bounded.

**Low — `missing-zero-check` on `LFX1Token`'s `creator_`. Dismissed.** `LFX1` always
passes `msg.sender`, and the token is only ever deployed by the factory.

**Low — `reentrancy-events` on `updateMetadataURI`. Dismissed.** Event after an external
call to our own non-hooking token.

## Working style

- One feature at a time: build it, then genuinely try to break it, then move on.
  Adversarial tests, not happy-path confirmation. Report what was tried **and
  failed** — coverage matters as much as results.
- **Hardhat stamps blocks from the WALL CLOCK, so timing tests are machine-speed
  dependent.** A test that pins a timestamp, asserts a view, then sends a transaction
  gets a transaction block stamped from real time — on a slow run the trade executes
  in a different snipe-tax tier than the one just asserted, and a correct contract
  fails. Fixed in `SnipeTax.test.js` by having `atElapsed` pin the CALLER'S next
  transaction as well as mining a filler block for the views. Reproduced deliberately
  with a 2.5s sleep before fixing, and re-verified under the same sleep and under six
  concurrent CPU burners. **If you add a timing-sensitive test, pin every block it
  depends on, not just the first.**
- **Prove a test can fail before trusting it.** The single most valuable habit
  this project has developed, and not a footnote. Two separate suites here passed
  while testing nothing: the original 19 loaded frozen bytecode from a gitignored
  `artifacts-manual/`, so they tested a July build regardless of what `contracts/`
  said; and the Foundry invariants had every call swallowed by `try/catch`, so
  `reverts: 0` proved nothing. **`fail_on_revert = false` is still set in
  `foundry.toml` — the hazard is live, not historical.** When a test passes first
  try on something subtle, break it on purpose and confirm it goes red. A green
  suite is evidence only once you have watched it go red.
- **Report findings before fixing them.** Some are acceptable risks; that's my
  call.
- Prefer restructuring over compiler flags (stack-too-deep → extract a function,
  don't reach for `viaIR`).
- **Trust the contract over my models.** My numbers come from JS derivations;
  where they disagree with measured behaviour, the contract is right — and
  saying so has caught real errors more than once.
- Flag anything that's only safe because of a parameter value rather than the
  code's structure. Parameters change.
- **Never claim it's bulletproof.** State what was tested, what was found, and
  what would still worry you with real money on it.
- I work across multiple LLMs and bring code back for auditing. Assume invented
  ABI params, wrong decimals, fabricated functions.
- Be direct. If an idea is bad, say so and say why.

**Standing caveat:** Claude Code has written both the contract changes and the
tests that check them, which is structurally the wrong shape for finding its own
blind spots. A paid audit is deferred until revenue — Code4rena/Sherlock
contests, Cantina, or an Immunefi bounty are cheaper shapes than a $15k
engagement and worth considering before mainnet.

## Stack

Solidity 0.8.24 · Hardhat · Foundry (invariant fuzzing) · Slither · SolidityScan
Node.js · Supabase (Postgres + RLS) · plain HTML/CSS/JS frontend, no build step
Arc Testnet (chainId 5042002) · Blockscout · Safe multisig · Circle CCTP V2
