# Feature trim report — what BXR1 could shed, measured

**Written 2026-09-18, against `bxr1` at `de2eecb`.** Report only. No feature code is
committed alongside this file, and no other file in the repo was changed by this work.
Every number below was produced by removing the real code for that candidate from
`contracts/bxr1/BXR1.sol`, compiling with `npx hardhat compile`, reading the deployed
artifact's `deployedBytecode.length`, and then reverting with `git checkout --` before
moving to the next candidate — the same method `docs/BYTE_BUDGET_REPORT.md` used. Nothing
here is estimated. After every measurement the file was diffed byte-for-byte against a
saved copy of the pre-report baseline to confirm the revert was exact; the last one is
recorded at the end of this report.

## Starting point

BXR1 is at **24,205 / 24,576 deployed bytes — 371 bytes of headroom** (`CLAUDE.md` §25.6,
`docs/BYTE_BUDGET_REPORT.md`). `docs/BYTE_BUDGET_REPORT.md` measured LaunchType alone at
**+441 bytes** — 70 bytes over the entire remaining budget by itself, before a vault
binding or a fee split are even drafted. This report's job was to find out what could be
**removed** to make room, before treating a contract split as the only way forward.

## What was asked, and the two rules that bounded it

The instruction named eight explicit candidates (a–h) — pool boost, the snipe tax table
machinery, `creatorLaunchBuy`, `caseSensitiveSymbols`, the symbol lock, `updateMetadataURI`,
several view functions the frontend could compute itself, and an open invitation to find
more. It also named a list of properties that must **never** be proposed for removal: the
exact-balance-delta check, ceil-division against the trader, per-launch snapshotting, the
economics hash, the dual graduation trigger with its try/catch and approval clearing, fee
caps, pause-with-unpausable-`graduate()`, and fixed supply with no creator pre-allocation.
**None of those appears below.** Every candidate measured is fee-mechanics, launch-flow, or
display surface — nothing that the register in `CLAUDE.md` §1 or §3 treats as a safety
property.

## Measurements, one candidate at a time

Each row is the delta from the 24,205-byte baseline to the same baseline with only that
candidate's code removed, then reverted before the next row.

| # | candidate | removed | bytes after | **saved** |
|---|---|---:|---:|---:|
| a | Pool boost | `poolBoostEnabled`/`poolBoost` fields, `PoolBoostAccrued`, the `_routeCreatorCut` branch, `createToken`'s `poolBoostEnabled` parameter, `_buildCurve`'s handling of it, and the two `_performGraduation` sites that add/zero `poolBoost` | 23,923 | **282** |
| b | Snipe tax table machinery | `_snipeTaxTables`, `snipeTaxTableMaxBps`, `activeSnipeTaxTableVersion`, `_nextSnipeTaxTableVersion`, `defaultSnipeTaxTreasuryBps`, `MAX_TOTAL_FEE_BPS`, `Curve.snipeTaxTableVersion`/`snipeTaxTreasuryBps`, `FeeSplit.snipeToTreasury`/`curveCut`, `publishSnipeTaxTable`/`_publishSnipeTaxTable`/`snipeTaxTable`/`currentSnipeTaxBps`/`_snipeTaxBps`, `setDefaultSnipeTaxTreasuryBps`, the constructor's opening-table publish, `buy()`'s tax lookup, and `_splitBuyFee`'s snipe branch | 21,628 | **2,577** |
| c | `creatorLaunchBuy` and its cap | the function itself, `Curve.creatorLaunchPurchased`/`maxCreatorLaunchBps`/`creatorLaunchWindow`, the global `maxCreatorLaunchBps`/`creatorLaunchWindow`, `setMaxCreatorLaunchBps`/`setCreatorLaunchWindow`, `CreatorLaunchBuy`/`MaxCreatorLaunchBpsSet`/`CreatorLaunchWindowSet`, `CreatorAllocationUsed`/`LaunchWindowClosed` | 22,767 | **1,438** |
| d | `caseSensitiveSymbols` | the bool, `setCaseSensitiveSymbols`, `CaseSensitiveSymbolsSet`, `_toUpperAscii`, and the ternary in both `createToken` and `isSymbolAvailable` (collapsed to plain `keccak256(bytes(symbol))`) | 23,596 | **609** |
| e | The symbol lock entirely | `symbolLockDuration`, `symbolUnlocksAt`, `setSymbolLockDuration`, `SymbolLockDurationSet`, `SymbolLocked`, the lock check + write in `createToken` — **and, forced by the same removal, `isSymbolAvailable`**, which reads `symbolUnlocksAt` directly and cannot compile once that storage is gone | 23,209 | **996** |
| f | `updateMetadataURI` | the function, `MetadataURIUpdated`. (`BXR1Token.setMetadataURI`/`metadataURI()` are untouched — they live in a separate deployed contract with its own byte budget, not BXR1's) | 23,375 | **830** |
| g | Redundant view functions | `graduationProgressBps`, `isSymbolAvailable`, `currentPrice`, and `currentSnipeTaxBps` — all four are pure derivations of fields already on `curves()` plus already-public state (`snipeTaxTable(version)`, `symbolUnlocksAt(hash)`); nothing here is a write path or a safety check | 23,357 | **848** |
| h | `launchCooldown` (found, not asked for) | `launchCooldown`, `lastLaunchTimestamp`, `setLaunchCooldown`, `LaunchCooldownSet`, `LaunchCooldownActive`, the check + write in `createToken` | 23,908 | **297** |

**Sum of the eight rows: 7,877 bytes.**

## What (h) is, and why it's here

The instruction's item (h) asked for "anything else you find that is product surface
rather than a safety property." `launchCooldown` is a per-creator-address 10-second
cooldown between launches. It is described in `CLAUDE.md` §7A itself as **not a spam
control** — "bypassable with a second address or a factory contract" — with the 0.5-unit
creation fee named as the actual deterrent. A mechanism the project's own documentation
already says does not do its stated job, on a protocol whose creation path is about to be
gated by a vault binding anyway, reads as exactly the kind of leftover memecoin-launchpad
surface item (h) was asking to surface. It is measured, not removed.

Nothing else surfaced that both (1) is not on the do-not-touch list and (2) is not already
implied by the eight items above. `router` timelock/revocation (§1.5), the treasury/creator
fee accrual-and-claim split (§1.7), `lpRecipient` snapshotting (§1.8), `renounceOwnership`
being blocked (R17), and the block-0 trading restriction are all either named safety
properties in `CLAUDE.md` §1/§3 or load-bearing for the vault-binding and fee-split
features this budget exercise exists to make room for — removing any of them would be
removing exactly the kind of property the instruction said not to touch, not "product
surface."

## Cumulative total — measured together, not just summed

**The eight removals were then applied together, in one file, compiled once.** Byte
savings from independent single-feature measurements are not strictly additive — some
candidates touch the same lines (the `caseSensitiveSymbols` ternary appears in both
`createToken` and `isSymbolAvailable`, and `isSymbolAvailable` itself is removed by both
(e) and (g)) — so the combined figure is the one to trust, not the arithmetic sum.

| | bytes |
|---|---:|
| baseline | 24,205 |
| all eight removed together | **16,809** |
| **combined saving** | **7,396** |
| sum of the eight independent measurements | 7,877 |
| **overlap between candidates** | 481 |

**Reverted and verified byte-identical to the pre-report baseline** (`diff` against a
saved copy of `contracts/bxr1/BXR1.sol` before any edit in this report, zero output), and
the working tree was confirmed clean (`git status --short`, no output) before this file
was written. `contracts/bxr1/BXR1.sol` compiles back to exactly **24,205** bytes.
`test/bxr1/Ballista.test.js` (29 tests, including the router-timelock and block-0-trading
suites this report's edits touched most directly) was re-run against the restored file and
passes, 29/29, as a control that the revert left nothing broken.

## Headroom after the trim

**16,809 / 24,576 bytes used — 7,767 bytes of headroom**, against 371 before. That is a
**21x increase** in the room available for the pivot's own features.

## Does this carry LaunchType, a vault binding and per-launch-type fee splits?

**Yes, with high confidence for LaunchType specifically, and very likely for the other
two — but the other two have not been re-measured against this trimmed baseline, and
should be before anyone treats the number as final.**

- `docs/BYTE_BUDGET_REPORT.md` measured LaunchType (an enum field, included in the
  economics hash, threaded through `createToken` and `_buildCurve`) at a real, built cost
  of **441 bytes**. 7,767 bytes covers that **17 times over**.
- A vault-binding field is, at minimum, one `address` on `Curve` plus its own struct-ABI
  encoding tax at every function boundary the struct already crosses — the same shape of
  cost LaunchType demonstrated, likely similar in size (an `address` and an `enum` field
  cost the same class of tax; LaunchType's 441 bytes is the closest real data point
  available). Even doubled to account for a binding that needs its own validation guard,
  that is still comfortably inside 7,767.
- A four-way, per-launch-type fee split needs new packed fields plus a sum-to-denominator
  setter plus, per the original spec, a fourth accrual/claim destination alongside the
  existing treasury/creator split. That is the most expensive of the three, closer in
  shape to this report's own candidate (b) (a whole parallel fee-accrual path cost 2,577
  bytes to **remove**) than to a single field — so a **generous** estimate, not a measured
  one, is somewhere in the 1,000–2,500 byte range for a minimal accrual-only version
  matching the hook's `sweep`/`claim` shape in `CLAUDE.md` §21.2, and higher for anything
  closer to a full per-destination claim path.

Summed even at the high end of that unmeasured range — 441 (LaunchType, measured) + ~800
(vault binding, estimated) + ~2,500 (fee split, estimated high) = **~3,741** — the three
features together fit inside the 7,767-byte headroom with **room to spare**, and by a wide
enough margin that the estimate's own uncertainty is unlikely to close the gap. This
removes the immediate pressure toward the `GraduationManager`/trading-split options
`CLAUDE.md` §25.6 measured as net-negative or structurally blocked, and toward the harder
approval-scoping redesign `docs/BYTE_BUDGET_REPORT.md` raised as the fallback if nothing
fit.

**What this report does not do:** build LaunchType, the vault binding, or the fee split
against the trimmed contract to get a real combined figure. That is the obvious next
measurement — repeat `docs/BYTE_BUDGET_REPORT.md`'s method on top of whichever subset of
(a)–(h) actually gets removed, rather than trusting the estimate above once real feature
code exists to measure instead.

## What this report does not decide

Trimming (a)–(h) means BXR1 stops doing several things the current `CLAUDE.md` §7A
documents as intentional launchpad mechanics: no snipe-tax deterrent against same-block
bots, no privileged creator-launch allocation, no pool-boost trust signal, no per-token
symbol collision window, no case-insensitive impersonation guard, no post-launch metadata
correction path, and a thinner public read surface (callers would compute
`graduationProgressBps`-equivalent, current price, and symbol availability off `curves()`
and already-public mappings themselves rather than getting them from a dedicated view).
Whether any of that is still wanted for a vault-backed leveraged-position launch, versus
being memecoin-specific surface that should go, is a product decision this report does not
make — it only prices each option.
