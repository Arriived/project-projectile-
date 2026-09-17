# HANDOFF — start here, then go to CLAUDE.md

**This file is an entry point, not a second copy of `CLAUDE.md`.** `CLAUDE.md` (repo root)
is canonical — the reasoning, the register, the mechanics, the history. This file's only
job is to get a stranger to the right section of it fast, and to carry the handful of facts
that live outside the repo (what's deployed where, right now) rather than in it. Where this
file and `CLAUDE.md` disagree, `CLAUDE.md` is right and this file is stale — it was written
2026-09-12 and will start drifting the moment anything changes.

⚠ **RUN `git branch --show-current` BEFORE READING FURTHER. Sections 1–9 below are about
the `ballista-migration` branch's mainnet-launch-day work (which DEX venue, the v4 hook,
the Wednesday sequence) and do NOT apply to the `bxr1` branch.** If you are on `bxr1`, skip
straight to **§10, at the foot of this file** — a self-contained entry point for the
provider-agnostic pivot, written 2026-09-17. Sections 1–9 remain accurate for
`ballista-migration` and are unchanged; they are simply about a different, parallel line of
work than whatever brought you to `bxr1`.

## 1. Orientation

Ballista is a memecoin launchpad native to Arc, Circle's stablecoin L1 (USDC is the native
gas token). Tokens launch on a bonding curve, trade against it, and graduate to a DEX pool
once a USDC threshold is crossed. The stated moat is trust and verifiability — a deployed,
verified, adversarially-tested contract anyone can read — not feature count; several
competitors launching on Arc around the same time have already damaged their own
reputations.

**Arc mainnet opens Wednesday 16 September 2026.** Confirmed, external, immovable. The
contract (`contracts/LFX1.sol`) is frozen and already deployed and verified on Arc Testnet.
What ships on the 16th is either that same contract graduating through a plain Uniswap V2
router (already fully specified, no new code needed), or through a new Uniswap v4 adapter
plus a fee-capturing hook built this month — see §6 and §7 below for which, and when that
gets decided.

**CLAUDE.md is canonical. This file is not.** Read this file to orient and to find the
right section fast; read §24.4–§24.6 before relying on older sections or the runbook, because
those sections record corrections and distinguish implemented fixes from live verification.
Verify everything you act on against the repo or live state; the documentation is a starting
point, not proof.

## 2. How to verify you are in the right place

```bash
git remote -v
git branch --show-current
git rev-parse --short HEAD
git status
git fetch origin && git status -sb
```

Expected, as of this handoff: remote `origin` → `https://github.com/Arriived/project-projectile-.git`,
branch `ballista-migration`, HEAD `5d3ed04`, working tree clean, level with `origin`.

**What a mismatch means:**
- **HEAD differs from `5d3ed04`** — expected; this file rots the moment anything is
  committed on top of it. Every figure in §4 below may now be stale. Re-derive rather than
  trust it — this is the project's own standing rule (`CLAUDE.md`, "HOW TO READ THIS FILE"),
  not a formality.
- **Remote or branch differ entirely** — stop and confirm with the operator before doing
  anything else. This repo was once moved off OneDrive after it silently corrupted a
  session's work (`CLAUDE.md` "HOW TO READ THIS FILE"); do not assume this clone or this
  remote is the canonical one just because it's what's open.
- **Working tree not clean, or not level with origin** — read `git status` in full before
  touching anything. Do not discard or overwrite what's there without understanding whose
  it is (a prior session's own uncommitted work has happened before — see `parked/bridge-kit`
  in §4).

## 3. Working rules

- **Moad decides.** Product and scope calls (which DEX venue ships, timing, what's in
  scope) are the operator's, not a session's to make or re-make. Report findings; don't
  implement a reversal of a settled call on your own judgment.
- **Verify, don't recall — quote `file:line`.** This repo's own history is full of stale
  claims that outlived the fact they described (`CLAUDE.md`'s own three-conflicting-HEADs
  incident, §14.1's reversed V2-availability conclusion). A claim without a citation you
  can re-check is worth nothing here.
- **Prove every test can go red.** A check that cannot fail is not evidence — six distinct
  ways this has gone wrong are catalogued in `CLAUDE.md` §5 ("Prove every test can go red"),
  and more since (§12.6, §15.6, §16.4, §19.6, §22.7). Red-prove under the mutation lease
  (`scripts/mutation_lease.py`; see §9 below for how that went wrong once).
- **Never re-derive the curve math.** Call `_quoteBuy`/`_quoteSell` (or the contract's own
  `quoteBuy`/`quoteSell`). A re-derivation in the frontend was off by up to 98.96x — full
  story in `CLAUDE.md` §1.3.
- **One shell command at a time; don't chain speculatively.** This is a Windows machine —
  PowerShell is primary, Bash is also available, and the two have different syntax. Run a
  command, read its actual output, then decide the next one — do not assume a multi-step
  script succeeded because it didn't error loudly (§9 below is a case where it didn't).
- **Never combine a change instruction and a report-only instruction in the same request
  without asking which governs.** This has happened once already and the operator confirmed
  stopping to ask was correct (`CLAUDE.md` §5, §23.1).
- **Do not re-argue settled product decisions.** `CLAUDE.md` §6 lists them explicitly. Some
  have been reversed before (§14.1, §17, §19→§20) — but by the operator, on new evidence
  presented, not by a session unilaterally deciding the old call was wrong.
- **Arc-platform facts come only from Circle sources or the `arc-docs` MCP server** (configured
  in `.mcp.json`, HTTP transport to `docs.arc.io`), never from memory. `CLAUDE.md` §9 is a
  cache of a specific date and says so; query the live server first. `docs/CIRCLE_use-arc.md`
  is a dated, verbatim snapshot of one Circle skill file — read it as a snapshot, not a feed.
- **Outputs from other models — or from this file — are unverified until checked against
  source.** That includes this handoff itself: every claim in it was checked against the
  repo or live state in the session that wrote it, but it is still a summary, not the thing
  it summarizes. Read `CLAUDE.md`'s own warning about itself ("It is a starting point to
  verify, not ground truth") and apply it here too.

## 4. Current state — verified live, 2026-09-12

**Frontend.** `https://ballista.trading` — HTTP 200.
- Vercel project `ballista`, scope/org `moadadas-projects`.
- Serving deployment `dpl_2zEYjPFGjDzDgSEpSZ6GDVNJewcQ`, built from this repo's `app/` at
  commit `1f3d4d7` (verified: `app/` is byte-identical between `1f3d4d7` and the commit that
  built it).
- ⚠ **This is a production ALIAS onto a Preview-target build, not a Vercel Production
  deployment.** `vercel ls` still tags this deployment `Preview`. It was aliased with
  `vercel alias set` rather than `vercel promote`, because promoting it would have triggered
  a full rebuild against Production environment values — which conflicted with an explicit
  "do not rebuild" instruction at the time. **Why it matters for env scope:** this Vercel
  project's Preview and Production environments currently hold the same five variable names
  (`PINATA_JWT`, `VITE_PINATA_GATEWAY`, `VITE_SUPABASE_URL`, `VITE_WALLETCONNECT_PROJECT_ID`,
  `VITE_SUPABASE_ANON_KEY` — confirmed via `vercel env ls`), but the live site was built
  against **Preview**-scope values. If those two scopes' values are ever changed
  independently (a different Supabase project, a rotated key), the site keeps serving
  whatever was baked in at Preview-build time, not what Production env vars currently say.
- ⚠ **`app/` has moved two commits past what's live.** `0069211` (a watch-asset failure UI
  fix) and `5d3ed04` (a `CLAUDE.md`-only doc commit) are on HEAD but not in the running
  bundle. The UI fix in `0069211` is not yet visible on `ballista.trading`.

**Indexer.** `https://ballista-indexer.fly.dev/health` → `healthy: true`, checkpoint 3
blocks (~1s) behind the chain head. Fly app `ballista-indexer`, current release **v6**
(`flyctl releases`), deployed ~6h before this check. v6 is a `scripts/`-only redeploy with
no runtime change from v5 (`CLAUDE.md` §23.7); v5 added retry for transport-level failures
(bare HTTP 5xx, timeouts, dead sockets) that the prior JSON-RPC-code classifier couldn't see.

**Branches on `origin`** (`git ls-remote origin`): only two refs exist —
`ballista-migration` (`5d3ed04`, current HEAD, clean, level with origin) and
`parked/bridge-kit` (`412b7de`). Local branches `main`, `cctp-spike`, `v4-adapter` exist
only in this clone; their tip commits are confirmed ancestors already reachable from
`origin/ballista-migration` (`git merge-base --is-ancestor`, `git branch -r --contains`) —
they are stale bookmarks from earlier in the project's history, not unpushed work. No
stash entries.

**`parked/bridge-kit`** (`412b7de`, pushed, does not depend on this clone): the operator's
own uncommitted `app/package.json` / `app/package-lock.json` edits, moved off
`ballista-migration` rather than discarded or committed there. Adds exactly three
dependencies not present on `ballista-migration`: `@circle-fin/adapter-solana@^1.7.2`,
`@circle-fin/adapter-viem-v2@^1.17.1`, `@circle-fin/bridge-kit@^1.14.1` (verified by diff —
nothing else differs). Nothing in `app/src`, `app/scripts` or `app/api` imports any of them
yet. CCTP bridging is required non-contract scope (`CLAUDE.md` §8), not descoped — this is
a parked dependency set, not abandoned work. Resume with `git switch parked/bridge-kit` or
by cherry-picking `412b7de`.

**Test counts, run this session — treat every other count in `CLAUDE.md` as historical
unless re-run:**
- Hardhat, unforked (`npx hardhat test`): **288 passing, 0 failing, 48 pending** (~1 min).
- Foundry (`forge test`): **13 passed, 0 failed** across 3 suites (~4.8 min, mostly
  invariant fuzzing).
- The 48 pending are 5 fork-gated files — `Fork.v2.test.js` / `ForkHelper.v2.test.js`
  (`FORK=1`, Ethereum mainnet fork) and `Fork.v4.test.js` / `Fork.v4.attack.test.js` /
  `Fork.v4.corrector.test.js` / `Fork.v4.hook.test.js` (`FORK_BASE=1`, Base mainnet fork) —
  **not run this session**; they need a funded/dedicated fork RPC and, per `CLAUDE.md`
  §16.2, may hang rather than fail if run against a shared public endpoint under load.
- Frontend (`npm run verify` in `app/`): **SUITES=18, CHECKS=541, FAILED=0**.

**Contracts.** The frozen v2 factory remains
`0xEDeed1F05D34421Add0F59b7340588ab2BbaC04b` on Arc Testnet — `eth_getCode` against
`https://rpc.testnet.arc.io` returned **24,033 bytes**, matching
`deployments/arcTestnet.json`. The first v4 stack is now live on Arc private mainnet:
hook `0xAd1286D1c8Cb5359334B084ACB4dbB6879462044`, adapter
`0xA2C27DbC84b602d9496799096a133043B81d5799`, and LFX1
`0x1629a7449f5F799eE0Ac04313a1A61D9FF43eA7f`. All seven bindings read back exactly;
receipts, gas and constructor arguments are recorded in `deployments/arcMainnet.json` and
`CLAUDE.md` §23.9. This is a rehearsal stack. Its treasury and immutable hook protocol
recipient are the testnet key `0x64140EAa0a3B6E4682C98e440837bd3d5482B4cb` and must not
carry into production.

## 5. What is frozen and cannot change

- `contracts/LFX1.sol`, deployed at the Testnet address above, is **closed**. Do not propose
  changing it without a reason written down first (`CLAUDE.md` §"The contract is CLOSED",
  §7).
- Each deployed adapter and hook has immutable bindings to one factory and to each other.
  This does not prevent deploying a replacement pair bound to the same factory (§24.5):
  - `contracts/BallistaV4Adapter.sol`: `lfx1` and `hook` immutables (lines 49, 54).
    Constructor rejects a zero hook (`ZeroHook`, line 145), wrong permission flags
    (`HookFlagsWrong`, line 157), and a hook not bound back to this exact adapter
    (`HookNotBoundToThis`, line 175). Runtime gate: `addLiquidity` requires
    `msg.sender == lfx1` (line 223, `NotLfx1`).
  - `contracts/BallistaFeeHook.sol`: `lfx1`, `usdc`, `protocolRecipient`, `adapter`
    immutables (lines 71–74). Runtime gate: `beforeInitialize` requires
    `sender == adapter` (line 215, `NotAdapter`).
  - The first pair is deployed on Arc private mainnet at the addresses above and bound to
    the rehearsal LFX1. `--bootstrap-router` spent that factory's one untimelocked router
    activation; later router changes require the full 24-hour timelock. No token had been
    created when the deployment record was written.
- **Recovery depends on whether graduation has happened** (`CLAUDE.md` §24.5).
  Already-graduated pools retain their immutable hook in the `PoolKey`; a replacement hook
  makes a different pool and cannot migrate the old pool's burned liquidity.
  Tokens parked at `GRADUATION_READY` can instead be rerouted to v2 or to a new adapter/hook
  pair bound to the **same LFX1**, because `graduate()` reads the router at call time.
  Either route needs the owner key and the 24-hour router timelock; holders cannot trade
  while parked. **The end-to-end recovery outcome is inferred, not executed.**

## 6. The Wednesday sequence

**`CONTRACT_DEPLOY_RUNBOOK.md` (repo root) has the procedure, but its outstanding corrections
are recorded in `CLAUDE.md` §24.4 and must be resolved before execution.** This is an outline,
not a substitute for the runbook or those corrections. §24.6 lists the pre-launch work.

1. **Preflight** (runbook §4): `eth_getCode` every dependency the deploy needs (PoolManager,
   PositionManager, Permit2, and — for the v2 fallback — the V2 router/factory), with the
   probe validated against known-good controls first. A probe that returns empty for
   everything proves nothing (`CLAUDE.md` §10).
2. **Deploy in a fixed three-nonce order, with two address predictions** (runbook §3, §5):
   the hook first, via CREATE2, with its initcode embedding the *predicted* adapter address
   and the *predicted* LFX1 address; then the adapter (real hook now, LFX1 still predicted);
   then LFX1 last, with `initialRouter_` set to the now-real adapter address. `CLAUDE.md`
   §20.18/§21.9 explains why the order is LFX1-last rather than LFX1-first.
3. **Fresh-key discipline until read-back passes.** Use a dedicated deployer key and send
   no unrelated transaction before the step-5 read-back below (runbook §6). A stray
   transaction changes the adapter/LFX1 nonce predictions; CREATE2 does not use the EOA
   nonce, so it does not itself change the hook's flags. Nonce assertions and the adapter's
   constructor binding check detect mismatches (`CLAUDE.md` §24.4).
   After read-back, the deployer is also LFX1's owner and remains needed for router changes
   (including the v2 fallback), revoke/pause actions, and intended configuration changes.
   A fresh LFX1 defaults to a 5-minute symbol lock and 10-second cooldown; matching testnet's
   0/5 settings requires two owner transactions (§24.5). Do not apply those implicitly.
4. The nonce is **re-read and asserted immediately before each of the two later deploys**
   (the adapter, then LFX1). **Still open:** the script lacks a nonce re-check immediately
   before the hook's CREATE2 send and prints, but does not assert, the chain ID. §24.4 records
   both missing guards; §24.6 requires them before launch.
5. **Read-back gate before any token is created or the stack is used**, including when
   `initialRouter_` bootstraps the adapter immediately. Read all runbook §6 bindings back,
   including `hook.adapter()` and `adapter.hook()`, and stop on any mismatch. Bootstrap does
   not call `proposeRouter`; subsequent router changes do require proposal and the 24-hour
   timelock (`CLAUDE.md` §24.5).
6. **Explorer verification** — target is genuinely unsettled (Blockscout vs an
   Etherscan-compatible API); runbook §7 flags this as open, not assumed.
7. **Post-deploy checks before any token is created** — runbook §8.
8. **Private-mainnet / throwaway phase** — runbook §9, subject to §24.4's corrections.
   The throwaway threshold is **10 USDC**, not the older ~54.2 figure. The real graduation
   evidence is `test/Fork.v4.test.js` test 4; `V4AdapterMath` M8 is only a math-harness test.
   The runbook still lacks the throwaway steps. Its selector preflight also needs updating:
   the adapter no longer calls `initializePool`; include the actual `initialize`, `extsload`
   and `getPositionLiquidity` calls identified in §24.4. These are open procedure corrections,
   not evidence that Arc testing has passed.

## 7. The decision point

**If the hook and its attack tests are not green *and* tested against real Arc — not only a
Base fork — by end of Monday 14 September 2026, ship v2 and switch to v4 later through the
router timelock** (`proposeRouter` → 24h wait → `activateRouter`).

This is not a fallback to improvise under pressure: the v2 path is fully specified,
unmodified, and is already how `LFX1.addLiquidity` works against a real Uniswap V2 router —
no new contract required (`CLAUDE.md` §14.1, §17.3). "Tested against real Arc" is the actual
bar, not "tests pass" in general — a Base fork exercises real Uniswap v4 mechanics but
**nothing** about Arc itself (the USDC blocklist, EIP-7708 transfer logs, the truncating
6dp `balanceOf`): "an adapter attacked on Base is not an adapter cleared for Arc"
(`CLAUDE.md` §16 preamble). The one gate specific to activating v2 in production is still
open — see item 1 in §8.

## 8. Open items, ordered by what blocks what

1. **[Blocks the v2 fallback] The router-side V2 init-code-hash probe.** Only the
   **factory** side of Arc mainnet's V2 deployment has been measured and matches canonical
   Uniswap; the **router**'s embedded hash — what `pairFor` actually uses — is unconfirmed,
   and Arc's router is a different byte length from canonical mainnet's. Must resolve before
   §7's fallback is ever activated in production. `CLAUDE.md` §20.19; runbook §10.
2. **[Blocks the v4 path] Private-mainnet deploy of the v4 stack.** Blocked on
   `ARC_MAINNET_RPC_URL` (must come from Circle directly or a Circle-named provider, never a
   search result) and on funding the dedicated deployer key. `CLAUDE.md` §20.5 states the
   five conditions this phase must prove or the launch reverts to v2; apply §24.4's selector
   and throwaway-procedure corrections before treating that older list as executable.
3. **[Is the literal subject of §7] Hook + adapter tested against real Arc, not only a Base
   fork.** No decision about which venue ships can be made responsibly until this exists.
4. **[Doesn't block Wednesday; blocks trust in the interim] `ballista.trading` is missing
   the watch-asset UI fix.** `0069211` is on HEAD but not in the live build (§4). A rebuild
   or a fresh alias from current HEAD closes this; no other gate.
5. **[Doesn't block Wednesday] Two open Goldsky Edge questions** (mainnet coverage
   specifically for Edge, and its per-IP rps ceiling) and two more about archive depth and
   catch-up request caps — `CLAUDE.md` §11.17 items 1–4, §18.6's dedicated-RPC context.
6. **[Required before launch by §24.6] No claims UI exists.** The recorded audit found
   `claimCreatorFees` only in the ABI and no UI for the hook's `sweep` / `claim` / `claimToken`.
   Creators cannot collect fees through the product yet (`CLAUDE.md` §24.4).
7. **Other work explicitly required before launch by §24.6:** the frontend/indexer/
   database cutover ([MAINNET_CUTOVER.md](MAINNET_CUTOVER.md), written, not executed); the missing deploy nonce and chain-ID guards; the §24.4
   documentation/runbook corrections; and `verify:reserves:live` after a real trade.
   The cutover finding includes hardcoded testnet configuration and absent frontend chain
   filtering, which would mix testnet/mainnet tokens if the database were reused (§24.4).
8. **Live WalletConnect verification remains open.** The chain-ID parsing fix is implemented
   and red-proved, but §24.4/§24.6 record no real phone WalletConnect session confirming create
   and trade are enabled. Passing the pure-function checks does not close that verification.
9. Everything else still open in `CLAUDE.md` §12.8 / §21.10 / §24.4–§24.6. Read the later
   corrections before carrying an older item forward; this entry point is not a second audit.

## 9. Known traps, one line each

- **The salt asymmetry.** A hook source/initcode change requires re-mining and revalidating
  its CREATE2 address. If the address no longer matches the declared permissions,
  `BaseHook`'s constructor reverts `HookAddressNotValid`; it does not deploy silently with
  missing callbacks. Adapter-only edits do not change the hook salt, because the adapter's
  CREATE address depends on `(deployer, nonce)`, not its bytecode. → `CLAUDE.md` §24.4,
  correcting §20.9.
- **Constructor argument ordering.** Keep each caller's argument encoding aligned with the
  constructor: `adapter_` is last on the hook and `hook_` last on the adapter. Changing the
  hook's encoded arguments changes its initcode and requires re-mining; reordering the
  adapter's constructor alone does **not** change the hook salt. A hook permission/address
  mismatch reverts, and an adapter binding mismatch reverts `HookNotBoundToThis`.
  → `CLAUDE.md` §24.4; the two constructors.
- **`Hooks.isValidHookAddress(IHooks(address(0)), fee)` returns `true` for a static fee** —
  confirmed this session against the pinned
  `node_modules/@uniswap/v4-core/src/libraries/Hooks.sol:124-126`. A hookless v4 pool is
  legal, so a hook wired to `address(0)` would deploy and graduate tokens silently forever,
  taking no fee — which is why the adapter's constructor has an explicit, otherwise
  logically-redundant `ZeroHook()` check (`contracts/BallistaV4Adapter.sol:145`). →
  `CLAUDE.md` §21.3 item 1.
- **The write-mode truncation rule.** A mutation script that opens its target file for
  writing before confirming its intended match will succeed can destroy an uncommitted
  file — `open(path, "w")` truncates to zero bytes the instant it's called, before whatever
  write comes next can fail. Take a byte-exact backup and confirm an exactly-one match
  *before* opening the target in write mode, ever. → `CLAUDE.md` §5 (recorded in commit
  `5d3ed04`); it happened this month to `app/src/components/token/YourPosition.tsx` and was
  recovered from `git show HEAD:<path>` plus a replayed diff, not from a backup that existed
  in advance.

---

## 10. THE `bxr1` BRANCH — the provider-agnostic pivot. Written 2026-09-17, self-contained.

**Read this section on its own if you are on the `bxr1` branch.** It does not assume you
have read §1–§9 above, which are about `ballista-migration`'s mainnet-launch-day work and a
different contract entirely. This section rots the same way the rest of this file does —
verify against the repo, not against this prose — but it is written to get you oriented and
working without needing anything else first.

### 10.1 The pivot, in one paragraph

Ballista is moving from a USDC-only bonding-curve launchpad to a **provider-agnostic launch
protocol**: the quote asset a curve trades against becomes a registry entry, not an
assumption baked into the contract. `contracts/LFX1.sol` (frozen, deployed, adversarially
tested on Arc Testnet — see §5 above) is the **reference implementation**, proof the
mechanics work, not a constraint on how the pivot is built. Contracts are rewritten as
needed to make genericity real; where a change would conflict with something LFX1 does, the
decision is made explicitly and the reason recorded, not silently preserved out of caution.
Full detail: `CLAUDE.md` §25.

### 10.2 Verify you are in the right place

```bash
git branch --show-current      # bxr1
git rev-parse --short HEAD     # cbf69b6, if nothing has landed since this was written
git status                     # clean
git log origin/bxr1..HEAD --oneline   # empty -- level with origin
```

`bxr1` was branched off `ballista-migration` at `dbb4d91`. Everything on
`ballista-migration` up to that point (the frozen LFX1, the deployed v2 factory, the v4
hook work, the whole frontend) is reachable from `bxr1` too — this branch adds new work on
top, it does not remove anything.

### 10.3 What exists on this branch, and where

| path | what |
|---|---|
| `contracts/bxr1/BXR1.sol` | the generic-asset rewrite of `LFX1.sol` — same mechanics, quote asset is now a parameter, not an immutable |
| `contracts/bxr1/BXR1Token.sol` | renamed copy of `LFX1Token.sol`, no functional change |
| `contracts/bxr1/AssetRegistry.sol` | new — per-asset config: decimals, `enabled`, the three misbehaviour flags, `initialVirtualReserve`, `defaultGraduationThreshold`, both in the asset's own native decimals |
| `contracts/bxr1/CurveMath.sol` | new — external library holding `_quoteBuy`/`_quoteSell`/`_ceilDiv`, extracted out of BXR1 to free bytecode space (§10.4) |
| `contracts/bxr1/mocks/` | `BXR1`-prefixed copies of the two mock contracts whose interface calls into BXR1 (`CreatorLauncher.sol`, `Attackers.sol`) |
| `test/bxr1/*.test.js` | 22 files, parallel to the original `test/*.test.js` suite, pointed at `BXR1` |
| `test/bxr1/assetRegistryHelper.js` | shared test helper — `deployRegistryWithAsset`, `setGraduationThreshold` (the re-registration helper that stands in for the setter AssetRegistry deliberately does not have), `getBXR1Factory` (deploys and caches the linked BXR1 factory — see §10.4) |
| `scripts/deploy-bxr1.js` | new deploy script: CurveMath → AssetRegistry → BXR1, linked. Run end-to-end against the local Hardhat network before being committed |
| `contracts/LFX1.sol`, `contracts/LFX1Token.sol` | **untouched.** `git diff --stat -- contracts/LFX1.sol contracts/LFX1Token.sol` must be empty. If it is not, something has gone wrong — this file is the control, not a place to make changes |

**Three commits so far, in order:**

| commit | what |
|---|---|
| `7026a5b` | BXR1/BXR1Token copied and renamed; AssetRegistry built; BXR1's quote asset made generic (§10.1) |
| `f0da62b` | CurveMath extraction — 345 bytes freed, measured |
| `cbf69b6` | graduation threshold moved into AssetRegistry, per asset — fixes a real bug, costs 66 bytes, measured |

Read each commit message in full (`git show --stat <sha>` then `git log -1 <sha>`) before
assuming you know what it did — they were written to be the record, not just a label.

### 10.4 The byte budget — read this before touching BXR1.sol at all

**BXR1 is at 24,205 of 24,576 deployed bytes. 371 bytes of headroom, measured, as of
`cbf69b6`.** This is not a soft constraint — it is the EIP-170 contract-size limit, and a
compile that exceeds it simply fails to deploy. Every feature added to BXR1 from here has
to be sized against this number before it is built, not after.

**What has already been measured, so it does not need re-measuring:**

- Extracting `_quoteBuy`/`_quoteSell`/`_ceilDiv` into an external library: **−345 bytes**,
  at a cost of **+3,935 gas per trade** (174,396 → 178,331, measured) and a hard
  requirement that the library be deployed and linked before BXR1 (`{ libraries: {
  CurveMath: address } }` — `ethers.getContractFactory('BXR1')` fails without it).
- Extracting the small fee-split helpers into the same library on top of that: **measured
  NEGATIVE** — costs more than it saves, because ABI encode/decode overhead exceeds the
  inlined cost for functions that small. Library extraction has a break-even size; do not
  assume "extract it to a library" is free money without measuring the specific function.
- Deleting dead code (an unused internal function): **measured ZERO savings.** The
  optimizer already strips unreachable internal functions from deployed bytecode.
- Moving graduation orchestration into its own contract: **measured NEGATIVE**, BXR1 grew
  53 bytes even in the leanest form. `forceApprove` has to stay wherever the balance is
  held (BXR1), and preserving "a reverting router does not unwind the triggering trade"
  means BXR1 needs its own try/catch around the cross-contract call too — there was
  nothing large enough to relocate for a net win.
- Splitting trading into its own contract: **not built** — ruled out on the same
  approval-scoping argument (whichever contract holds the balance is the only one that can
  approve the router) before any code was written. Doing it anyway means either moving
  graduation into the trading contract too, or an extra transfer hop that reopens the
  parked-curve recovery and permissionless-retry guarantees `CLAUDE.md` §1.1/§1.4 treat as
  load-bearing.

**Full detail and the exact numbers: `CLAUDE.md` §25.6.** If `docs/BYTE_BUDGET_REPORT.md`
exists in the repo, read it too — it measures the concrete cost of the next pivot features
(a launch-type distinction, a leveraged-vault binding, per-launch-type fee splits) against
this same 371-byte budget, the same way: build the smallest real version, compile, measure,
don't estimate.

**The rule going forward, stated plainly: measure before you build, and measure by
compiling, not by reasoning about what "should" be smaller.** Every one of the negative
results above looked plausible on paper before it was built. None of them held up compiled.

### 10.5 What is measured versus estimated — do not blur this distinction

Everything in §10.4's table is **measured**: built, compiled, the artifact's
`deployedBytecode.length` read directly, in most cases with a `git checkout --` revert
immediately after so nothing speculative stayed in the tree. Nothing in this section is a
guess dressed up as a number.

What is **not yet measured, only reasoned about**: the actual gas cost of a graduation that
crosses a per-asset threshold set far from LFX1's historic 8,000 USDC-equivalent figure (no
reason to expect it differs, but it has not been run); the gas cost of `createToken` itself
after the threshold move beyond the two figures already printed by
`test/bxr1/SymbolLock.test.js`'s own size-and-gas probe (1,102,357 / 1,048,257 at `cbf69b6`
— read those live rather than trusting this line, they move with the file). If a future
session needs either figure, measure it the same way §10.4's table was built: run the
relevant test, read the real number out of its output, do not estimate from the shape of
the diff.

### 10.6 What is blocked on an external answer, and what is simply not started yet

**Nothing about the `bxr1` contract work itself is blocked on an external answer.** It is
pure local Hardhat work — no RPC, no funded key, no third-party API — unlike the
`ballista-migration` v4 hook work in §1–§9 above, which genuinely is blocked on Circle RPC
access and Goldsky's unanswered questions (`CLAUDE.md` §11.17, §20.5). Do not import that
urgency or those blockers into `bxr1` work; they belong to a different branch and a
different deadline.

**What is simply unstarted, not blocked:**

- The frontend and indexer have never been touched by this pivot. Both are still built
  entirely around LFX1's single fixed 6-decimal USDC integration, and both contain
  hardcoded 6dp-shaped scale factors that would silently misprice anything quoted in a
  different-decimals asset by 1e12 — `CLAUDE.md` §25.7 has the exact three sites
  (`app/src/routes/TokenPage.tsx:68`, `app/src/hooks/useCurve.ts:166`,
  `indexer/migrations/003_list_page_columns.sql:214`). None of this is broken *today*
  because nothing has pointed either system at a non-USDC BXR1 deployment yet; all three
  need a genuine decimals-aware rewrite before that can happen safely.
- The harder structural choice §10.4 ends on — split trading from graduation despite the
  reopened recovery/retry properties, or build and prove safe the extra-transfer-hop
  redesign that keeps those properties intact — has not been decided. That decision needs
  the operator's judgment, not an external answer; do not make it unilaterally on a
  session's own initiative (`CLAUDE.md`'s standing rule, restated in §3 above for the other
  branch and equally true here).
- Whatever `docs/BYTE_BUDGET_REPORT.md` measured for the next concrete pivot features
  (launch types, the vault binding, per-launch-type fee splits) is report-only by design —
  read it for the numbers, but building any of it is a separate, deliberate next step, not
  something this section authorizes.
