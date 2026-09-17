# Byte budget report — the three pivot features against 371 bytes

**Written 2026-09-17, against `bxr1` at `d4f470c`.** Report only — no feature code is
committed alongside this file. Every number below was produced by building the smallest
real version of the feature, compiling it, reading the deployed artifact's
`deployedBytecode.length`, and then reverting with `git checkout --` before moving to the
next one. Nothing here is estimated.

## Starting point

BXR1 is at **24,205 / 24,576 deployed bytes — 371 bytes of headroom** (`CLAUDE.md` §25.6).
This is the number every measurement below is checked against.

## (a) LaunchType enum — measured, and it alone exceeds the budget

**Built:** `enum LaunchType { STANDARD, LEVERAGED }`; a `LaunchType launchType` field added
to the `Curve` struct as its second member; `createToken` extended to take `LaunchType
launchType` as a seventh parameter; `currentEconomicsHash` extended to
`currentEconomicsHash(address quoteAsset, LaunchType launchType)` with `launchType` included
in the hashed tuple; `_buildCurve` extended to accept and snapshot it. STANDARD carries no
mechanics of its own here — this is exactly the "just stores" version the spec asked for.

**Adding the seventh `createToken` parameter reintroduced stack-too-deep** (0.8.24, 200
runs) — the same class of error the asset-genericity work already hit twice. Fixed the same
way both those times were: extracted a function, never `viaIR` (`CLAUDE.md` §5). The
BXR1Token construction block — three lines that were previously inline in `createToken` —
moved into a new internal function, `_deployToken(name, symbol, metadataURI)`. This is not
optional overhead added to inflate the number; it is the minimum change that makes the
seventh parameter compile at all under the project's standing rule.

**Measured:**

| | bytes |
|---|---|
| baseline (`d4f470c` / `cbf69b6`) | 24,205 |
| with LaunchType | **24,646** |
| **cost** | **+441** |

24,646 is itself already 70 bytes past the 24,576 EIP-170 limit — `hardhat compile` emits
Spurious Dragon's size warning and the contract could not deploy on mainnet as built. The
441-byte cost is **70 bytes more than the entire remaining 371-byte budget**, before either
of the other two features is considered.

**Why it costs this much for what looks like one field and one parameter:** `Curve` is
returned whole by the public `curves(address)` getter and copied by value through
`_buildCurve`, `_settleBuy`, `buy`, `sell`, `creatorLaunchBuy` and `_performGraduation` —
adding a field to it touches the ABI-encoding routine everywhere the struct crosses a
function boundary, not just the one place it's set. `createToken` gaining a parameter cost
a whole extra internal function (`_deployToken`) to keep compiling without `viaIR`. And
`currentEconomicsHash` picked up both a new parameter and one more `abi.encode` field,
multiplied across its two call sites (the public view and the guard inside `createToken`).
None of this is gratuitous; it is the real shape of what touching the central `Curve`
struct costs.

## (b), (c) — not measured

**Stopped here, per instruction: "If any single one exceeds the remaining headroom on its
own, stop there and report rather than continuing."** (a) alone costs more than the entire
371-byte budget, so there is no remaining headroom to measure (b) or (c) against, and
building either on top of an already-over-budget (a) would not answer a real question. The
vault-binding field (b) and the per-launch-type fee split (c) were **not built**.

## Do the three fit in 371 bytes?

**No. The first one alone does not.** LaunchType costs 441 bytes against a 371-byte budget
— a shortfall of 70 bytes before (b) or (c) are even drafted, both of which would add
further fields to the same `Curve` struct and are very unlikely to cost less than (a) did
(a vault-address field is a full `address` — 20 bytes of storage plus the same
struct-ABI-encoding tax `LaunchType` just demonstrated; a four-way fee split adds four
`uint16` fields plus a new setter with a sum-to-`BPS_DENOMINATOR` check plus, per the spec,
an entirely new accrual/claim path for the fourth destination).

## What has to happen first

**371 bytes cannot absorb even the first of these three features as built.** Before any of
them can ship, one of the following has to happen — in rough order of how much they
recover, cheapest first:

1. **Re-measure a leaner LaunchType encoding.** This report built the straightforward
   version (a full `enum` field on `Curve`, included in the hash, `createToken` taking it
   directly). A tighter version — e.g., folding `launchType` into an existing packed field
   rather than adding a new struct member, or deferring its inclusion in
   `currentEconomicsHash` until it actually gates an admin-controlled value (today nothing
   about `launchType` is admin-state the hash needs to protect against drift, since the
   creator supplies it themselves in the same call) — was not attempted here and might
   recover some of the 441 bytes. Worth trying before reaching for anything structural.
2. **Revisit `CLAUDE.md` §25.6's ruled-out options with a real budget number in hand.**
   Splitting trading from `createToken`/graduation was ruled out on the approval-scoping
   argument before a byte figure was needed to justify it; now that even the first pivot
   feature does not fit, the size of the problem this would solve is no longer
   hypothetical. That still means reopening the parked-curve-recovery and
   permissionless-retry properties `CLAUDE.md` §1.1/§1.4 treat as load-bearing, and does
   not become a smaller decision just because the alternative (fitting nothing) is worse.
3. **Accept that BXR1 cannot carry all three pivot features as a single contract and
   design for that from the start**, rather than discovering it one feature at a time.
   Given (a) alone already overshoots, this is likely the honest read of where things
   stand — not a decision this report makes, but the one it hands back.

None of this is a call this report makes. It measures; it does not decide.
