# Ballista

A memecoin launchpad native to Arc (Circle's stablecoin L1, USDC as native gas).
Bonding-curve launches that graduate to a DEX pool, with cross-chain USDC buy-in
so a user on Base/Ethereum/Solana can buy an Arc-native token without manually
bridging first.

**Positioning:** what Pons V2 is to Robinhood Chain, but for Arc. Same shape of
product, different chain, plus cross-chain USDC on-ramping as the differentiator.

---

## Timeline — this is the constraint that governs everything

- **Arc mainnet: September 16, 2026.** Confirmed, external, immovable.
- **Ballista must be launch-ready by ~September 9** — a week early, deliberately.
  That week is buffer for problems found late, not spare time to add features.
- Build and test on **Arc Testnet**. Mainnet is a config flip on launch day
  (chain ID, RPC, contract addresses), not a rebuild.

## Scope for mainnet launch

**IN:**
- Launchpad: create token → bonding curve trading → graduation to DEX
- CCTP bridging so users can buy with USDC from other chains
- Automatic buys (bridge lands → buy executes with minimal user friction)
- Frontend for the above

**OUT — do not build these before mainnet:**
- The trading terminal. Explicitly cut from launch scope. Post-launch.
- Buybacks, fee escrow, vesting
- Anything not on the path to "a user can launch a token and another user can
  buy it, including from another chain"

If a proposed feature isn't required for that sentence to be true, it's post-launch.
Scope creep is the main risk to the date. Push back on it, including when the
push comes from me.

---

## Current state

### Contract — `Ballista.sol` (was `ArcLaunchFactory`)
Compiled, **95 Hardhat tests + 2 Foundry invariants passing**. **Not yet deployed anywhere.** The previous
version (`ArcLaunchFactory`) is live on Arc Testnet at
`0x63C4c5b7D7add4dbE9Bf8f155711dd00F566Ec57`, verified on Blockscout.

**Token supply constants:** 800M curve supply + **165M** LP reserve = **965M total**.
The LP reserve was 200M, sized for full curve depletion. We graduate at 67,000 USDC
(92.6% of the curve), so ~58.9M unsold tokens diluted a pool sized for zero leftovers:
the pool opened **11.45% below** the curve's closing price and the last curve buyer was
instantly down 11%. Measured against the contract, not modelled.

**Measured graduation gap at 165M**, by how far the triggering buy overshoots 67,000:
tight `+2.42%` / moderate `+6.60%` / heavy `+14.46%` / near-depletion `+23.36%`.
The gap is not a property of the constant alone — it scales with overshoot, and nothing
caps how far a single buy can cross the threshold. Tests enforce the SIGN (the pool must
never open below the curve close); the magnitude is reported, not asserted.

**Measured fee economics** (`npx hardhat run scripts/economics.js`, real trades through
a real deployment, so fee rounding is included):
- Blended creator share: **70.12%** at a 50:50 buy/sell mix, 74.11% at 60:40, 78.56% at
  70:30. The blend is the honest headline number.
- Protocol revenue needs **2.34x** the volume under the new model to match the old
  (0.5 USDC + 90/50 vs 5 USDC + symmetric 30%). Flat across $10k/$100k/$1M, because both
  models are linear in volume once the launch fee is amortised.
- A creator on a $100k-lifetime-volume token earns **$704** at 50:50, **$784** at 70:30.
- A lifetime mix below 50:50 buy is **structurally impossible** — every token sold must
  have been bought first, so cumulative sell volume can never exceed buy volume.
- Buy-heavy tokens **graduate before accumulating volume**: at 70:30 the curve hit its
  67,000 threshold at ~$161k lifetime volume and stopped earning.

Recent changes, all tested:
- Renamed to `Ballista`
- Graduation threshold 67,000 USDC (was 69,000)
- Symbol lock is time-limited (5 min default) rather than permanent
- `caseSensitiveSymbols` toggle — starts lenient (true), tighten later
- Block-0 trading restriction (`creationBlock`, trading opens next block)
- **Partial-fill + clamp** on `buy()` and `sell()` — no longer reverts when the
  request exceeds remaining supply; fills what's available, never pulls the excess
- **Decoupled graduation** — `ACTIVE → GRADUATION_READY → GRADUATED` state enum,
  one-way. A failing router can't unwind the trade that triggered it. `graduate()`
  is permissionless and retryable.
- **Economics pinning** — `createToken()` takes `expectedEconomicsHash`; reverts if
  fees/threshold/symbol policy changed since the creator saw the terms
- `quoteBuy()` / `quoteSell()` views sharing the exact same math as execution
- **Router gate + 24h timelock** — `createToken()` reverts unless a router is live.
  `setRouter()` is GONE, replaced by `proposeRouter()` → 24h → `activateRouter()`, with
  `revokeRouter()` immediate at any stage. The asymmetry is the point: granting trust is
  slow and public, removing it is one transaction. `ROUTER_TIMELOCK` is a constant, not
  owner-settable — an owner who can shorten it to zero has no timelock.
  Consequences, both accepted: **nothing can launch until a router is live** (and a
  fresh deployment is therefore unusable for 24h), and revoking the live router strands
  `GRADUATION_READY` tokens until a replacement clears the delay. Losing a day of
  graduation beats losing the pot.
  **Residual risk, unfixed by design:** an owner who holds the key for 24 hours
  unnoticed still takes the pot. No on-chain check can tell a hostile router from an
  honest one. Monitoring `RouterProposed` is what turns the delay into a defence.
- **Creator fee share, asymmetric** — `creatorBuyFeeBps` 90 and `creatorSellFeeBps` 50:
  90% of the fee on a buy, 50% on a sell, carved OUT OF the existing 1% fee, never added
  on top. Trader-facing cost is unchanged; the treasury's share is what shrinks.
  **Blends to 70% creator over a 50:50 mix** (measured 70.12%), 74% at 60:40, 78% at
  70:30. Accrue-and-claim via `claimCreatorFees()`, never pushed inside a trade: a
  creator address that cannot receive USDC (Circle blocklist) would otherwise brick
  every trade on that token permanently. Keyed by creator, not per-token; per-token
  attribution lives in `CreatorFeeAccrued`. Both rates snapshotted per token and in the
  economics hash, so the defaults can move without changing the deal for anyone already
  launched — which is the point, since 90/50 is a launch promotion.
- **Launch fee 0.5 USDC** (was 5). Every competitor is at or near free. Not 0.1:
  `createToken` costs ~0.02 USDC of gas, so at 0.1 the fee barely clears cost and one
  cooldown-limited wallet could push 8,640 launches/day for ~$1,027. At 0.5 that same
  wallet pays ~$4,483/day. Noxa earned $12M in fees and still had to stop accepting
  launches because the feed became unnavigable.
- **Decaying snipe tax** — buy-side only, decaying to zero over ~5s. Lookup table indexed
  by whole seconds, published as immutable **versions**; a token snapshots only its
  version number, so tables can be retuned without touching live tokens. The table's
  length IS the window length. Splits 70/30 treasury/curve; the curve's share raises
  `realUsdcReserves` without releasing tokens and counts toward graduation (intended).
  Never routed to the creator — a creator sniping their own launch would otherwise
  recover part of their own tax. Opening table: 98/25/3/1/0 percent.
- `curves()` returns the **`Curve` struct**, not a flat tuple — Solidity's auto-generated
  getter overflowed the ABI encoder's stack at 15 fields. Callers get named fields.

### Other components (built, never run against real infrastructure)
- `BridgeWithPermit.sol` — permit-based CCTP burn, one tx instead of approve+burn.
  5 tests passing. Deploy one per source chain.
- `bridge-relayer/` — Node service: watches Circle attestation, submits Arc-side claim.
  **Being replaced by Circle's Forwarding Service.** Verified against
  `developers.circle.com/cctp/concepts/supported-chains-and-domains`: Arc testnet is
  domain 26 AND is marked as a supported Forwarding Service destination, which removes
  the burden of running our own relayer. Note the Forwarding Service *launch blog* lists
  a shorter chain set without Arc — the docs table is current, the blog is stale. Do not
  invest further in the custom relayer.
- `verify-ownership.mjs` — checks multisig ownership transfer actually took effect.

---

## Open items, roughly in priority order

1. **Multisig migration.** Contract owner is still a single EOA. Safe is confirmed
   live on Arc Testnet. 2-of-3, keys must be *independently generated* — not one
   seed copied three ways. Contract uses plain `Ownable`, NOT `Ownable2Step`, so
   `transferOwnership()` is immediate and irreversible. Verify the address twice.
2. ~~Run the original 19-test suite against `Ballista.sol`~~ **Done.** It had never run
   against *any* current source: it loaded frozen bytecode from a gitignored
   `artifacts-manual/`, so it had been testing a July build of `ArcLaunchFactory`
   regardless of what `contracts/` said, and would have thrown `ENOENT` on a fresh
   clone. That path is deleted. All 19 now run against Ballista.
3. **Deploy `Ballista.sol` to Arc Testnet, verify on Blockscout.** Now blocked on
   configuring a router first — see the router gate above.
4. Apply the `ArcLaunchFactory` → `Ballista` rename across remaining files. Mostly done;
   `ArcLaunchToken.sol` NatSpec and the root `README.md` still carry the old name.
   `contracts/ArcLaunchFactory.sol` is deliberately kept as a reference until Ballista
   is deployed and verified.
5. End-to-end CCTP test: Base Sepolia → Arc Testnet, including failure paths. Retarget
   at the Forwarding Service rather than the custom relayer.
6. Frontend. Needs `tokens.state` (indexer migration 001) to distinguish "still trading"
   from "awaiting graduation" from "graduated" — the old boolean cannot.
7. ~~P1 (only if the date is safe): decaying snipe tax, creator fee share~~ **Both landed.**
8. **Redeploy to Arc Testnet.** The deployment at
   `0x874C80220d7d21ada3c5137335FBFF895F4b1858` predates the fee revision (it carries
   the 5 USDC launch fee and the symmetric 30% creator share). Superseded, not broken.
9. **Post-graduation fee capture** via a V3/V4 locker. Probably where the long-term
   revenue is: measured below, a buy-heavy token graduates at ~$161k of lifetime volume
   and the curve stops earning entirely after that. Blocked on confirming which Uniswap
   version Arc actually gets — reporting says v4, no primary source. Separate job.

---

## Hard-won constraints — these have already caused real bugs

- **Arc RPC requires `batchMaxCount: 1`** in every ethers.js provider config.
  Default batching silently breaks against Arc's public RPC.
- **Never re-derive the bonding curve math.** Use `_quoteBuy` / `_quoteSell`.
  External LLMs have re-derived it incorrectly more than once.
- **USDC is 6 decimals** in all contract amounts. Arc also exposes USDC as native
  gas with 18 decimals internally — these are not interchangeable. Confirm which
  one you're touching before assuming.
- **Graduation threshold cannot exceed ~87,912 USDC.** That's the computed maximum
  `realUsdcReserves` can ever reach at full curve depletion. Set it higher and a
  sold-out token can never graduate — it just sits there, permanently stuck. 67,000
  leaves deliberate margin.
- **Fees are read per-token from `curves()`**, snapshotted at creation. Never assume
  the global default applies to an existing token. This now covers `creatorFeeBps`,
  `snipeTaxTableVersion` and `snipeTaxTreasuryBps` as well.
- **Total effective fee must stay strictly below `BPS_DENOMINATOR`.** The clamp branch of
  `_quoteBuy` inverts the fee with `_ceilDiv(x * BPS, BPS - feeBps)`. At exactly 10000
  that divides by zero; above it, it underflows. Either way every *clamped* buy reverts
  — the buys that finish a launch, at the moment the tax is highest. This is why the
  snipe tax opens at 98% and not the 99% originally specified: 9900 plus a 100 bps base
  fee is 10000 on the nose. `MAX_TOTAL_FEE_BPS = 9900` enforces it at publish AND launch.
- **Arc targets 500ms blocks** (verified against Arc's own consensus write-up: Malachite
  BFT, sub-second deterministic finality). Two consecutive blocks can therefore share a
  whole-second `block.timestamp`, so Hardhat needs `allowBlocksWithSameTimestamp`. It
  also means the block-0 trading restriction only delays a sniper by half a second,
  which is the entire reason the snipe tax exists.
- **`forge` and `hardhat` must compile with the same optimizer settings.** `foundry.toml`
  configured none, so invariant fuzzing ran against unoptimized bytecode while everything
  that ships is optimized at 200 runs. Both now match at 200.
- **Never put raw private keys in browser storage.** Rejected permanently, any framing.
- **`pause()` does NOT stop graduation.** `buy()`/`sell()` are `whenNotPaused`, so the
  auto-graduation inside `buy()` is blocked transitively — but `graduate()` is only
  `nonReentrant`, so anyone can still push a `GRADUATION_READY` token through a live
  router while paused. `revokeRouter()` is the tool that actually stops graduation.
- **Monitoring `RouterProposed` is a launch requirement, not a nice-to-have.** The 24h
  router timelock only defends anything if somebody is watching the event during it.
- The relayer never custodies user funds — it only pays gas to trigger a mint whose
  recipient was fixed at burn time on the source chain. Keep it that way. No session
  keys, no relayer-signs-buy-on-behalf-of-user.

## Verification rules

- **Always verify Arc / Circle / CCTP / Bridge Kit claims against the official docs**
  (`developers.circle.com`, `docs.arc.io`) rather than from memory or training data.
  Contract addresses and domain IDs especially — a wrong address is unrecoverable
  fund loss, not a revert.
- Arc **mainnet** is not yet in Circle's published CCTP address list. Testnet is
  (domain 26), and is also a supported **Forwarding Service** destination. Re-check
  before any mainnet config.
- Uniswap is confirmed on Arc at launch. **Version is not confirmed** — reporting
  says v4, but not from a primary source. Don't build V4-specific code until
  confirmed; V3 and V4 aren't interchangeable.

## Working style

- One feature at a time: build it, then genuinely try to break it, then move on.
  Adversarial tests, not just happy-path confirmation.
- **Prove a test can fail.** Two separate suites here passed while testing nothing: the
  original 19 ran against frozen bytecode, and the Foundry invariants had every call
  swallowed by `try/catch` under `fail_on_revert = false`, so `reverts: 0` proved
  nothing. Both now carry guards that fail if no trade actually executed. When a test
  passes first try on something subtle, break it on purpose and confirm it goes red.
- Prefer restructuring code over enabling a compiler flag to work around a limit
  (e.g. stack-too-deep → extract a function, don't just turn on `viaIR`).
- I bring code back from Gemini/ChatGPT for auditing. Assume it may contain
  invented ABI params, wrong decimals, or fabricated functions. Verify against
  actual source before trusting it.
- Be direct. If an idea is bad, say so and say why. Don't soften it.
- **Never market the creator split as "90/10".** The blended rate is 70%. Both splits are
  readable on a verified contract in thirty seconds, and the honest claims — "70% to
  creators, matching the market leader" and "90% on every buy" — are both true and both
  market-leading, so there is nothing to gain from the false one. Our whole position is
  being the launchpad that doesn't misrepresent itself. Push back if I drift toward the
  90/10 framing later.

## Stack

Solidity 0.8.24 · Hardhat · Foundry (invariant fuzzing) · Slither · SolidityScan
Node.js · Supabase (Postgres + RLS) · plain HTML/CSS/JS frontend (no React, no build step)
Arc Testnet · Circle CCTP V2 (+ Forwarding Service) · Safe multisig · Blockscout
