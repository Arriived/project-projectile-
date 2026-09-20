# PAUSE RECORD — 20 September 2026

Report only. No contract, test, config, or live infrastructure was changed to produce
this record. HEAD at the time of writing: `d9166507ecec2e15a81dd5991f9c19cb7decd07d`
(branch `bxr1`, `git log -1 --format="%H"`), tree clean (`git status --porcelain`, empty).

## 1. Why paused

20 September 2026: Arc memecoin volume stayed roughly flat after the day-one spike
(~$340M on DefiLlama, per the operator), several Arc projects exit-scammed, and
sentiment turned. Resuming depends on the triggers in section 7 below.

## 2. Status per workstream

**LFX1 — frozen control.** `contracts/LFX1.sol` / `contracts/LFX1Token.sol` are
byte-identical throughout the entire BXR1 pivot: `git diff --stat -- contracts/LFX1.sol
contracts/LFX1Token.sol` between the pivot's branch point (`dbb4d91`) and current HEAD
(`d916650`) is empty, re-confirmed after every commit in that range (CLAUDE.md §25.1,
§26, §29.4). Test control: **303 passing + 48 pending, 0 failing** (`test/*.test.js`),
last re-confirmed in the commit that added §29 (CLAUDE.md §29.4).

**BXR1 — hardening done.** Every commit since the feature trim
(`9dea7c5` "feat: trim BXR1 to seven removed features, keep the snipe tax"), oldest
first, from `git log --oneline 9dea7c5..d916650`:

| commit | what |
|---|---|
| `ceb926b` | docs: measure the snipe-tax-to-oracle split and LaunchType against the trim |
| `02e0d1a` | remove unmeasured figures from CLAUDE.md |
| `4b97fe9` | test: graduate() must work while paused |
| `9ce7375` | pin initialVirtualReserve in the economics hash |
| `34b2203` | creation fee per asset |
| `676fc02` | pin creationFee in the economics hash |
| `09731e7` | fix: failed graduation cannot strand pulled funds for a retry to spend |
| `d351996` | deploy-bxr1: pass creationFee to registerAsset |
| `4ad613c` | CLAUDE.md: correct §26.6 record, add §26.7 |
| `2e95760` | CLAUDE.md §27: LEVERAGED design decisions |
| `3495590` | LEVERAGED launches: asset kind, USD-denominated terms converted at launch |
| `3383ea0` | record LEVERAGED implementation numbers |
| `e1613d9` | docs: frontend/indexer decimal survey — LFX1-only, 6dp is correct, no BXR1 port yet |
| `8e19a37` | TokenCreated carries quoteAsset |
| `a84b546` | registry rejects decimals that don't match the token |
| `03db337` | deploy-bxr1: opt-in router bootstrap, hard-refused on Arc mainnet |
| `4d380f0` | deploy guard: allowlist testnet/hardhat only |
| `d916650` | BXR1 testnet deployment |

BXR1 is deployed and verified on Arc testnet (section 3). `test/bxr1/*.test.js`:
220 passing, 0 failing as of the last recorded run (CLAUDE.md §29.4).

**LEVERAGED registry side — done.** `AssetRegistry`'s `AssetKind.LEVERAGED` path
(USD-denominated launch terms converted at `createToken` time via a live
`exchangeRate()` read, never cached — CLAUDE.md §27, commit `3495590`) is built,
tested, and included in the same BXR1 deployment above. `AssetRegistry` deployed
bytes: 3,724 (CLAUDE.md §29.3/§29.4).

**Vault, router, keeper — NOT STARTED.** The Bounce-derived leveraged-token vault, the
router that would settle LT proceeds to USDC, and the off-chain keeper that posts
equity, are all unbuilt. The vault design report (Phase 1: read Bounce's source,
propose a design, list required test properties, list open questions) was produced as
a chat-only report in this session and was never written to the repo, never compiled,
and no hardhat command was run for it — nothing exists on disk for this workstream
beyond `contracts/bxr1/interfaces/ILeveragedToken.sol` (the one-function interface
`AssetRegistry` already calls against) and `contracts/bxr1/mocks/MockLeveragedToken.sol`
(a test double), both added in commit `3495590` (`git log --oneline --diff-filter=A --
contracts/bxr1/interfaces/ILeveragedToken.sol contracts/bxr1/mocks/MockLeveragedToken.sol`),
already listed in the commit table above — no vault, router, or keeper contract exists
anywhere in the repo.

**`app/` and `indexer/` — still LFX1-only.** Confirmed this session (CLAUDE.md §28.1):
zero references to `BXR1`/`bxr1` anywhere in either tree (`grep -ri bxr1 app/src
app/api app/scripts indexer/` — no matches). `app/src/config.ts:11` hardcodes
`FACTORY_ADDRESS` typed as the LFX1 factory; `indexer/src/index.js:6` loads only
`./generated/lfx1Abi.json`. The BXR1 port (reading `quoteAsset` per curve, reading
decimals from the registry instead of assuming 6, and fixing the three hardcoded
6-decimal-shaped scale factors documented at CLAUDE.md §28.2 —
`app/src/routes/TokenPage.tsx:68-71`, `app/src/hooks/useCurve.ts:164-166`
(`marketCapUsdc6`), and `indexer/migrations/003_list_page_columns.sql:214` — plus the
five further recurrences of the same `/1000000.0` pattern listed at §28.2) is **not
started**.

## 3. Deployments

All addresses below are read directly from the deployment record files, not retyped
from memory.

**BXR1 stack — Arc testnet** (`deployments/arc-testnet-bxr1.json`):

| contract | address | explorer |
|---|---|---|
| CurveMath (library) | `0x375b0F9E6Fd3e31F1e76c07bD9234F96f32c5dAc` | https://explorer.testnet.arc.io/address/0x375b0F9E6Fd3e31F1e76c07bD9234F96f32c5dAc#code |
| AssetRegistry | `0xA2C27DbC84b602d9496799096a133043B81d5799` | https://explorer.testnet.arc.io/address/0xA2C27DbC84b602d9496799096a133043B81d5799#code |
| BXR1 | `0x7D041748083A88452AF4eE943E16b6c5Bf07e6C6` | https://explorer.testnet.arc.io/address/0x7D041748083A88452AF4eE943E16b6c5Bf07e6C6#code |

⚠ **The testnet router is `0xFa6CeBb5e50FaFFD1A3bF611392fE255f9ec0cD3` — LFX1's placeholder
`MockRouter`, not a real DEX.** It was bootstrapped directly into BXR1's constructor,
spending the factory's one untimelocked router activation, live at block zero with no
`proposeRouter`/24h wait/`activateRouter` (`arc-testnet-bxr1.json`'s own `router.note`
field, and CLAUDE.md §30.6). Any graduation on this deployment proves nothing about a
real router.

**LFX1 — Arc testnet** (`deployments/arcTestnet.json`), deployed from commit `38e3e9e`:

| contract | address | note |
|---|---|---|
| LFX1 factory | `0xEDeed1F05D34421Add0F59b7340588ab2BbaC04b` | `deployBlock` 59366694; explorer field in the file reads `https://testnet.arcscan.app/address/...`, which now 301-redirects to `https://explorer.testnet.arc.io/address/0xEDeed1F05D34421Add0F59b7340588ab2BbaC04b#code` — found and fixed in `hardhat.config.js` during the BXR1 deployment session (CLAUDE.md §30.2) |
| GraduationHelper | `0x1197BB8324F0338104a00000B043CD9193D5Cd7f` | `graduationHelperNote` in the file: "INERT ON TESTNET: needs a real Uniswap V2 factory... holds no privilege in LFX1" |
| router (same MockRouter) | `0xFa6CeBb5e50FaFFD1A3bF611392fE255f9ec0cD3` | `routerSource`: "MockRouter deployed by this script (PLACEHOLDER — not a real DEX)" |
| USDC (quote asset) | `0x3600000000000000000000000000000000000000` | Arc testnet USDC — the same address both LFX1 and BXR1's first registered asset use |

**LFX1 v4 stack — Arc PRIVATE mainnet rehearsal** (`deployments/arcMainnet.json`,
`deploymentKind: "private-mainnet rehearsal"`, chain 5042), **not a production
deployment**:

| contract | address |
|---|---|
| BallistaFeeHook | `0xAd1286D1c8Cb5359334B084ACB4dbB6879462044` |
| BallistaV4Adapter | `0xA2C27DbC84b602d9496799096a133043B81d5799` |
| LFX1 (rehearsal instance) | `0x1629a7449f5F799eE0Ac04313a1A61D9FF43eA7f` |

⚠ Note the hook/adapter addresses on this **mainnet rehearsal** are the same digits as
`AssetRegistry`'s address on **testnet** by coincidence of independent deployments —
different chains (5042 vs 5042002), not the same contract. The file's own
`treasuryNote` says this deployment's treasury/hook-recipient value
(`0x64140EAa0a3B6E4682C98e440837bd3d5482B4cb`) is "a rehearsal value and existing
testnet key" that "must not carry into production."

## 4. Repository

`https://github.com/Arriived/project-projectile-` — **private**, corroborated this
session by an unauthenticated `curl` against the repo page returning HTTP 404 (GitHub's
standard response for a private repo to an unauthorized viewer), `gh` was not installed
to confirm authoritatively. Branches (`git branch -vv`, verified pushed and matching
origin in the immediately preceding session):

| branch | tip | holds |
|---|---|---|
| `ballista-migration` | `dbb4d91` | the LFX1 launchpad: contract, frozen; React frontend in `app/`; indexer in `indexer/`; deployed to production (`ballista.trading`, `ballista-indexer.fly.dev`). Main branch for this project. |
| `bxr1` | `d916650` (current) | the BXR1 pivot — generic quote-asset launchpad, AssetRegistry, LEVERAGED asset kind, deployed and verified on Arc testnet. This pause record. |
| `cctp-spike` | `e5d6fbf` | an exploratory branch on CCTP bridging / the 5–6 September session record; its tip commit is already reachable from `ballista-migration`'s history |
| `main` | `9c3ee6f` | the repo's very first commit ("Initial commit: contracts, tests, indexer") |
| `parked/bridge-kit` | `412b7de` | `app/package.json`/lockfile changes adding `@circle-fin/adapter-solana`, `@circle-fin/adapter-viem-v2`, `@circle-fin/bridge-kit` — parked pending Arc mainnet CCTP v2 Forwarding Service support (CLAUDE.md §8) |
| `v4-adapter` | `d3fdc97` | the Uniswap v4 adapter + fee hook work for LFX1 (`BallistaV4Adapter.sol`, `BallistaFeeHook.sol`), attacked on a Base fork, later deployed for real as the private-mainnet rehearsal in section 3 |

## 5. Running or paid infrastructure referenced in the repo

Listed only — nothing shut down.

| what | where configured |
|---|---|
| Fly app `ballista-indexer` (region `iad`, `shared-cpu-1x`/512MB, exactly one machine, `strategy = "immediate"`) | `indexer/fly.toml`; operational detail in `indexer/RUNBOOK.md:265-267` |
| Vercel project `ballista` under team `moadadas-projects`, Root Directory `app` | `app/DEPLOY.md:158-159` |
| Domain `ballista.trading` (alias `ballista.vercel.app`) | pointed at the Vercel project above; registrar hardening (lock, WHOIS privacy, 2FA) at **Porkbun** is still an open item per CLAUDE.md:2751 |
| Supabase project (Postgres + RLS, indexer's database) | `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY` in `indexer/.env` (gitignored — real project URL not in the repo; `indexer/.env.example:4` shows only the placeholder shape) |
| Arc testnet RPC — `https://rpc.testnet.arc.io` (documented host) / `https://rpc.testnet.arc.network` (working undocumented alias) | `hardhat.config.js:11-12`; production indexer confirmed on the `.io` host via `flyctl ssh console` in an earlier session (CLAUDE.md §23.3, "Production's `FACTORY_RPC_URL` is `https://rpc.testnet.arc.io`") |
| Arc private-mainnet RPC `https://rpc.arc-scan.org` (Circle-contact endpoint, used for the rehearsal in section 3) | `docs/threshold-budget-report.md:11`, `deployments/arcMainnet.json:10` |
| `thirdweb` RPC (`https://5042002.rpc.thirdweb.com`) | listed as the suggested default in `indexer/.env.example:10`; whether the live `indexer/.env` actually uses this or the `.io` host above was not re-checked this session (see the `rpc.testnet.arc.io` row, which is what was last confirmed live) |
| Healthchecks.io, check named `ballista indexer` (5-minute period, 5-minute grace) | `indexer/RUNBOOK.md:295`; CLAUDE.md §12.8 item 7 flags the ping URL as a credential that should be regenerated before mainnet, not yet done |
| Pinata (IPFS pinning + presigned uploads) | `PINATA_JWT` (server-only Vercel secret, read only by `app/api/sign-upload.ts`), `VITE_PINATA_GATEWAY` (public gateway hostname) — `app/.env.example:19-35`, `app/DEPLOY.md:47-81` |
| WalletConnect / Reown (`VITE_WALLETCONNECT_PROJECT_ID`) | `app/.env.example:10-17`; the production value was previously truncated (CLAUDE.md §13.3) and has since been corrected per §14.2 |
| Goldsky Edge | **decided as the mainnet RPC provider, not yet live** — CLAUDE.md:2758 "Provider decision is MADE... Goldsky Edge at launch"; two questions to Goldsky remain unanswered (CLAUDE.md:2390-2398, §23.3) |
| Alchemy | dev/test-only — `MAINNET_RPC_URL` for the `FORK=1` Ethereum-mainnet fork test suite (`.env.example:33`), not part of the production stack |

## 6. Open outreach threads

- **Hibachi**: support forwarded to the team; no reply yet.
- **Aster**: contacted.
- **Backpack**: contacted.
- **Extended**: Discord ticket T-3187; support answered questions 1 and 3, the rest
  deferred to announcements.
- **edgeX**: no contact route found.

(This section is the operator's own account, given directly in the instruction that
produced this record — no file in the repo documents these outreach threads, so there
is no file:line citation for it beyond this record itself.)

## 7. TRIGGERS

*(placeholders — fill in before resuming)*

-
-
-

## 8. On resume — first three things

Taken from CLAUDE.md's most recent explicit numbered "resume point" list, **§24.6
"Resume point — do these in order"** (written 11 September 2026, before the 17
September BXR1 pivot):

1. Read §24.1 before any git command — the tree at that time held uncommitted work
   belonging to two owners.
2. Get the operator's answers to §24.2's open decisions before committing, pushing, or
   deploying anything.
3. Work the queue in §24.3 (the chart-fix steps, then the fee-row changes, then the UI
   audit report), one item at a time, reporting and stopping after each.

⚠ **This list predates the BXR1 pivot and is stale as a literal to-do list** — item 1's
"two owners" conflict and item 4 (the WalletConnect fix) are already resolved
(CLAUDE.md §23.6, §14.4), and items 2/3/5 are about the old LFX1/mainnet-by-16-September
track, not the current BXR1/vault work. It is quoted here because it is genuinely the
most recent section in CLAUDE.md that takes the shape of a numbered resume list — no
later section (§25–§30, the BXR1 pivot itself) replaces it with an updated one. Given
the actual current state recorded in section 2 above, the operator may prefer to start
instead from: the vault build itself (Phase 1's design report, produced only as a chat
report this session, needs to actually be written and built), or the `app`/`indexer`
BXR1 port described in CLAUDE.md §28.5 and §25.7. That judgment is left to whoever
resumes this, not decided here.
