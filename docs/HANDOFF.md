# HANDOFF — start here, then go to CLAUDE.md

**This file is an entry point, not a second copy of `CLAUDE.md`.** `CLAUDE.md` (repo root)
is canonical — the reasoning, the register, the mechanics, the history. This file's only
job is to get a stranger to the right section of it fast, and to carry the handful of facts
that live outside the repo (what's deployed where, right now) rather than in it. Where this
file and `CLAUDE.md` disagree, `CLAUDE.md` is right and this file is stale — it was written
2026-09-12 and will start drifting the moment anything changes.

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

**Contract.** `0xEDeed1F05D34421Add0F59b7340588ab2BbaC04b` on Arc Testnet — `eth_getCode`
against `https://rpc.testnet.arc.io` this session returned **24,033 bytes**, matching
`deployments/arcTestnet.json`. No mainnet deployment exists yet; `deployments/` holds only
`arcTestnet.json`.

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
  - Neither contract is deployed anywhere — no v4-stack entry exists in `deployments/`.
    Built, tested locally and against a real Base fork; unpublished.
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
7. **Other work explicitly required before launch by §24.6:** a written frontend/indexer/
   database cutover procedure; the missing deploy nonce and chain-ID guards; the §24.4
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
