# Two report-only measurements — the snipe tax split, and LaunchType against the trimmed contract

**Written 2026-09-18, against `bxr1` at `9dea7c5`** (the commit carrying the applied trim
in `docs/FEATURE_TRIM_REPORT.md` — pool boost, `creatorLaunchBuy`, `caseSensitiveSymbols`,
the symbol lock, `updateMetadataURI`, the four redundant view functions and
`launchCooldown` removed; the snipe tax kept in full). Report only — no feature code is
committed alongside this file, and `contracts/bxr1/BXR1.sol` is confirmed byte-identical
to the committed trim (`git diff --stat -- contracts/` empty) after each measurement.

**Method, same as `docs/FEATURE_TRIM_REPORT.md` and `docs/BYTE_BUDGET_REPORT.md`:** build
the real code, compile, read `deployedBytecode.length` from the artifact, revert. This
time each build was also run against a small functional smoke test — not the full suite,
but enough to confirm the measured bytecode is *working* code, not merely code that
compiles. Both smoke tests are described below and were deleted before reverting.

## 1. Can the snipe tax move to its own contract?

**Built:** `contracts/bxr1/SnipeTaxOracle.sol` — `_snipeTaxTables`,
`snipeTaxTableMaxBps`, `activeSnipeTaxTableVersion`, `_nextSnipeTaxTableVersion`,
`publishSnipeTaxTable`/`_publishSnipeTaxTable`, `snipeTaxTable(version)`, and
`currentBps(uint32 version, uint256 creationTimestamp)` replacing `_snipeTaxBps`'s role —
externalized as a pure function of the two values BXR1 already snapshots per curve,
rather than of a `Curve storage` reference an external contract cannot hold. BXR1 kept
exactly what the instruction specified: `Curve.snipeTaxTableVersion`/`snipeTaxTreasuryBps`,
`defaultSnipeTaxTreasuryBps`, `setDefaultSnipeTaxTreasuryBps`, `MAX_TOTAL_FEE_BPS`, and
`_splitBuyFee` (which writes no storage itself, but its caller `_settleBuy` does,
immediately after — keeping the fee-arithmetic path in one place avoided threading a
`FeeSplit` result back across a contract boundary into code that then writes state from
it). `buy()`/`quoteBuy()` call `snipeTaxOracle.currentBps(c.snipeTaxTableVersion,
c.creationTimestamp)` in place of `_snipeTaxBps(c)`; `createToken`'s
`BaseFeeCeilingExceeded` check and `_buildCurve`'s snapshot read the oracle's
`activeSnipeTaxTableVersion()`/`snipeTaxTableMaxBps()`. The constructor's opening-table
publish moved into the oracle's own constructor. `BXR1`'s constructor gained a fourth
parameter, `address snipeTaxOracle_`, stored as `immutable`.

### ⚠ The first version was NOT faithful, and it failed loudly rather than quietly

The first build dropped BXR1's own publish-time leniency clause —
`_publishSnipeTaxTable` originally accepts a table if EITHER
`maxBps + MAX_FEE_BPS <= MAX_TOTAL_FEE_BPS` OR `maxBps + defaultBuyFeeBps <=
MAX_TOTAL_FEE_BPS`, and only the first disjunct was kept in the oracle on the reasoning
that it looked like the "worst case" branch. **That reasoning was wrong; the second
disjunct is what lets BXR1's own opening table publish at all.** `9800 + MAX_FEE_BPS
(1000) = 10800 > 9900` fails the first disjunct; only `9800 + defaultBuyFeeBps (100) =
9900 <= 9900` passes. The oracle's own constructor, publishing that exact opening table,
reverted `SnipeTaxCeilingExceeded` — caught immediately by the smoke test below, not by
inspection. **Restored** by giving the oracle's constructor and `publishSnipeTaxTable`
an explicit `uint16 currentBaseFeeBps` parameter, supplied by the caller: the oracle
cannot read `BXR1.defaultBuyFeeBps` itself, because BXR1 does not exist yet when the
oracle deploys (BXR1's constructor needs the oracle's address, so the oracle must come
first), and a cross-contract call back into BXR1 would be circular. This is a real,
measured cost of the split, not a rounding error — see "what BXR1 has to trust the oracle
for" below.

### Smoke test, not just a compile

`test/bxr1/_smoke_oracle_split.test.js` (deleted before reverting): deployed the full
stack (`AssetRegistry`, `CurveMath`, `SnipeTaxOracle` with the real opening table, `BXR1`
wired to it, a `MockRouter`), created a token, and asserted the decaying tax at t=0
(`actualFee` equal to the full 99% — 98% tax + 1% base) and again after the table's
window closes (`actualFee` equal to just the 1% base). Both passed. The mechanism works
end to end through the oracle, not merely compiles against it.

### Measured

| | bytes |
|---|---:|
| BXR1, committed trim (baseline for this report) | 19,484 |
| BXR1 with the oracle split | **18,713** |
| **BXR1's own saving** | **771** |
| `SnipeTaxOracle.sol`, deployed separately | **2,301** |

**It is NOT negative the way the earlier `GraduationManager` split was** (`CLAUDE.md`
§25.6) — BXR1 itself gets smaller, it does not grow. But **it is also nowhere near a
wash**: BXR1 saves 771 bytes while the oracle costs 2,301 to deploy on its own — nearly
**three times** what BXR1 saved, and total system bytecode across both contracts goes
**up** by 1,530 bytes, not down. The right way to read this pair of numbers is per
constraint: **the 24,576-byte EIP-170 ceiling applies per contract**, so BXR1 alone
carrying 18,713 bytes against that limit is what "headroom" means, and on that measure the
split buys **771 bytes of real, additional room** in BXR1's own budget — smaller than
either of this session's two removed-feature candidates in `docs/FEATURE_TRIM_REPORT.md`
(worth less than removing `creatorLaunchBuy` alone, for reference), and it comes at the
cost of a second contract to deploy, verify, and trust.

### What BXR1 has to trust the oracle for

Stated precisely, because this is the actual price of the split, not a hand-wave:

1. **Never to mutate a published table.** `publishSnipeTaxTable` must always allocate a
   *new* version, never overwrite `_snipeTaxTables[existingVersion]`. The oracle enforces
   this by construction (no setter takes a version number to overwrite), but that
   enforcement now lives in bytecode BXR1 does not control.
2. **To compute the same lookup BXR1 used to compute itself** —
   `elapsed = block.timestamp - creationTimestamp; elapsed >= table.length ? 0 :
   table[elapsed]` — with no off-by-one, no reordering, nothing else (a pause, an
   allowlist) that could make the same inputs answer differently across two calls in the
   same block.
3. **To stay live and never revert on a valid `(version, creationTimestamp)` pair.**
   Every `buy()` and every `quoteBuy()` now makes an external call that did not exist
   before. A reverting oracle — paused if it ever gained a pause, or simply broken —
   would revert every buy on every curve that has ever launched, not just new ones. This
   is a **new, unconditional dependency in the hottest path in the contract**, where none
   existed before.
4. **To be given the right `currentBaseFeeBps` at every publish**, per the leniency-clause
   fix above. Supplying the wrong value does not corrupt anything — it only makes the
   ceiling check stricter or looser than BXR1's own state would have made it — but it is
   one more manual value an owner (or a deploy script) must get right that used to be read
   automatically from BXR1's own storage.

### Is a curve snapshotting only a version number still safe if the oracle can be swapped?

**No — not for a swappable oracle, in the sense of a mutable address BXR1 could
repoint.** This build does **not** give BXR1 a `setSnipeTaxOracle`; `snipeTaxOracle` is
`immutable`, set once in the constructor, for the same reason `CLAUDE.md` §1.8 and §18.4
already established for `lpRecipient` and the v4 hook binding: a per-curve snapshot that
can be redefined by changing what it *points to* is not a snapshot, it is an indirection
with an owner-controlled trapdoor. A live, owner-swappable `address public
snipeTaxOracle` would mean every existing curve's pinned `snipeTaxTableVersion` silently
starts reading a *different* oracle's table 0, table 1, and so on the instant the address
changed — the version number was never the guarantee, the oracle's *identity* was. That
is a strictly worse shape than R13 (an unhashed, owner-movable value pulled against state
a user already committed to), and this measurement does not recommend building it that
way. An immutable oracle avoids it entirely, at the cost of the oracle needing the same
"never remove, only append" discipline BXR1's own `_publishSnipeTaxTable` already has
today — a relocated trust requirement, not a new one, so long as the address stays
immutable.

**Reverted.** `contracts/bxr1/SnipeTaxOracle.sol` and the smoke test were deleted,
`contracts/bxr1/BXR1.sol` restored from git, and `git diff --stat -- contracts/`
confirmed empty (also re-compiled back to exactly 19,484 bytes) before moving to the next
measurement.

## 2. LaunchType, built fresh against the trimmed contract

`docs/BYTE_BUDGET_REPORT.md`'s **441-byte** figure was **not reused**, per instruction —
it was measured against the pre-trim `createToken`, which needed a stack-too-deep
extraction (`_deployToken`) this session's trim may have made unnecessary, since
`createToken` lost a parameter (`poolBoostEnabled`) and several guard lines.

**Built:** the identical feature the original report specified — `enum LaunchType {
STANDARD, LEVERAGED }` as the second member of the `Curve` struct; `createToken`
extended to take `LaunchType launchType` as its sixth parameter; `currentEconomicsHash`
extended to `currentEconomicsHash(address quoteAsset, LaunchType launchType)` with
`launchType` in the hashed tuple; `_buildCurve` extended to accept and snapshot it.
STANDARD carries no mechanics of its own, matching the "just stores" version of the
original spec exactly.

**The stack-too-deep extraction was NOT needed.** Adding the sixth parameter to the
trimmed `createToken` compiled directly on the first attempt, with no `_deployToken`
extraction and no other restructuring — confirming the original report's own hypothesis
that the extraction was a consequence of the pre-trim function's stack depth, not of
`LaunchType` itself.

### Smoke test, not just a compile

`test/bxr1/_smoke_launchtype.test.js` (deleted before reverting): created one STANDARD
and one LEVERAGED token, confirmed each curve's stored `launchType` matches what was
passed, confirmed the two economics hashes differ (so `launchType` is genuinely inside
the pinned tuple, not decorative), and confirmed a hash computed for STANDARD is refused
with `EconomicsChanged` when used to create a LEVERAGED token. All three passed.

### Measured

| | bytes |
|---|---:|
| BXR1, committed trim (this report's baseline) | 19,484 |
| BXR1 with `LaunchType` added, no extraction needed | **19,850** |
| **cost** | **366** |

**366 bytes, against 441 pre-trim.** The 75-byte difference is smaller than the full cost
of the avoided `_deployToken` extraction alone would suggest — the trimmed `createToken`
and `_buildCurve` are also simply smaller functions than they were (fewer parameters,
fewer struct fields, fewer guard lines), so the marginal cost of adding one more field and
one more parameter is not identical to what it was against the pre-trim function, beyond
just the extraction. This report does not further decompose the 75 bytes; the number that
matters is the fresh, real one (366), not an explanation of why it differs from the old
one by exactly that amount.

**Against this session's 5,092-byte headroom** (`docs/FEATURE_TRIM_REPORT.md`'s applied
trim), 366 bytes leaves **4,726** — comfortably more room than the pre-trim report had for
LaunchType alone (371 minus 441 was already negative before the trim existed). The vault
binding and per-launch-type fee split remain unbuilt and unmeasured against this baseline;
build and measure them the same way before treating the combined feature set as
confirmed to fit.

**Reverted.** The `LaunchType` enum, the `Curve` field, `createToken`'s sixth parameter,
`currentEconomicsHash`'s extra parameter, and the smoke test were all removed;
`contracts/bxr1/BXR1.sol` restored from git, `git diff --stat -- contracts/` confirmed
empty, and the contract re-compiled back to exactly 19,484 bytes before this report was
finished.

## Summary

| | bytes | net effect on BXR1's own budget |
|---|---:|---|
| Snipe tax → `SnipeTaxOracle.sol` | BXR1 −771, oracle +2,301 | **+771 headroom**, at the cost of a second immutable contract and the trust properties above |
| `LaunchType`, fresh build | +366 | **not negative** — fits easily inside the 5,092-byte headroom the applied trim already has |

Neither measurement changes what shipped in the committed trim. The oracle split is
available as a second lever if the vault binding and fee split turn out to need more room
than 4,726 bytes leaves once they are built and measured for real; it was not applied
because the applied trim's own headroom already comfortably covers `LaunchType`, and
introducing a second contract is a real design cost (a fourth trust boundary, an
immutable cross-contract dependency in the hottest path) that should be paid for with a
real need, not pre-emptively.
