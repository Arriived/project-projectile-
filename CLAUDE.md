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

**CURVE CONSTANTS — redesigned for an $8,000 graduation.** These six values are ONE
derivation, not six knobs; changing any in isolation breaks the gap and multiple.

```
INITIAL_VIRTUAL_USDC_RESERVES  =  2_667e6            (was 30_000e6)
INITIAL_VIRTUAL_TOKEN_RESERVES =  1_075_000_000e18   (was 1_073_000_000e18)
CURVE_TOKEN_SUPPLY             =  807_000_000e18     (was 800_000_000e18)
LP_TOKEN_RESERVE               =  193_000_000e18     (was 165_000_000e18)
TOTAL_TOKEN_SUPPLY             =  1_000_000_000e18   (was 965M)
defaultGraduationThresholdUsdc =  8_000e6            (was 67_000e6)
```

Why $8,000: we were asking 7-11x more than anyone else (pump.fun ~$6,100-7,400,
Pons ~$9,700) while the measured pump.fun graduation rate is **0.198%**.

**807M, not the 806M the derivation gives.** At 806M the DEPLETION CEILING — the most
`realUsdcReserves` can ever reach — is **$7,991**, BELOW the $8,000 threshold, so the
threshold is structurally unreachable. Even the unrounded values land at $7,999.81,
19 cents short. 807M lifts the ceiling to **$8,030.85** so the threshold is the primary
path with $30.85 of headroom.

**DUAL GRADUATION TRIGGER, mandatory:** `realUsdcReserves >= threshold OR tokenReserves == 0`.
Load-bearing, not a safety net — with a ceiling below the threshold a single-arm check
leaves every token permanently stuck. `sell()` needs no equivalent: `tokenReserves` only
reaches zero via a buy, and that buy graduates in the same transaction.

**Measured on the new curve** (`npx hardhat test test/GraduationGap.test.js`):
- depletion ceiling **$8,030.85**, gap **+4.16%** tight, +4.16% to +4.83% across overshoot
- launch-to-graduation multiple **16.05x**, graduation market cap ~$39,687
- the curve is ~11x thinner than before: a $1,000 buy takes ~36% of supply, not 4.3%.
  **Price impact must be a headline number in any UI, and `minTokensOut` must never
  default to zero.**

Recent changes, all tested:Recent changes, all tested:
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
  getter overflowed the ABI encoder's stack. Callers get named fields.
- **Creator launch buy** — `creatorLaunchBuy()` opens block 0 to `curve.creator` only,
  capped at `maxCreatorLaunchBps` (250 = 2.5% of curve supply) and EXEMPT from the snipe
  tax. The cap is **cumulative per token**, tracked as tokens PURCHASED: a per-transaction
  cap is defeated by several transactions in one block (~37% of supply), and a balance
  check is defeated by transferring out and buying again. Snapshotted and in the
  economics hash. **This does NOT cap total creator holdings** — nothing stops a creator
  buying more from another address. Never describe it as "creators are capped at 2.5%";
  disclosure via the `CreatorLaunchBuy` event is the protection.
- **Mutable metadata URI** — `updateMetadataURI()`, creator-only, going through the
  factory so the audit event lives on one address. `MetadataURIUpdated` carries old AND
  new; launch-clean-then-swap is not preventable on-chain, so it is made visible.
- **Pool boost (opt-in at launch)** — `createToken(..., poolBoostEnabled)`. Diverts the
  creator's fee share into a SEPARATE `poolBoost` accumulator added to the pool's USDC
  side at graduation. It must never touch `realUsdcReserves` or it would advance
  graduation and leave leftover tokens diluting the pool. Measured worth: gap 4.16% ->
  5.65%, i.e. a low-single-digit-percent deeper pool. **A trust signal, not an economic
  mechanism** — do not let the UI imply otherwise.
- **Licence: UNLICENSED** on everything we wrote. OpenZeppelin stays MIT (verified
  against the compiler input: 9 ours UNLICENSED, 14 OZ still MIT). Blockscout
  verification continues — a readable contract is the whole advantage.

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
8. **Activate the router on the new testnet deployment.** Ballista is live at
   `0x8a6175797BBd32aA306f39a25B215CA0d9Be44f7` (block 58150801), verified exact.
   MockRouter `0x07D7D1C2D31FFa19Ca24b7Fe116Db1Ada67e191a` is PROPOSED but not active:
   the 24h `ROUTER_TIMELOCK` must elapse, then `activateRouter()`. **Nothing can launch
   until then** -- the F1 fix working as designed, not a fault. The live smoke test,
   including a real creator block-0 buy, is blocked on this.
10. **Retune the snipe tax table** for the thinner curve -- see the constraint above.
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
- **The depletion ceiling is $8,030.85** — the most `realUsdcReserves` can ever reach,
  fixed by the virtual reserves. The $8,000 threshold sits only **$30.85** below it. Any
  threshold above the ceiling would be unreachable; the DUAL TRIGGER is what makes that
  survivable rather than fatal, and it is why the trigger is not optional.
- **The threshold-to-ceiling window is only ~$31 wide.** A final buy larger than that
  clamps straight to depletion instead of crossing the threshold cleanly, so in practice
  many graduations take the depletion arm. Both produce a ~+4% gap, so this is a
  behavioural note rather than a problem.
- **A clamped buy ALWAYS graduates.** The clamp takes every remaining token, so it trips
  the depletion arm in the same transaction. There is no longer a "depleted but still
  ACTIVE" state, and the old zero-fill-on-empty-curve case is unreachable.
- **The contract is 24,306 bytes against EIP-170's 24,576** — 270 bytes of headroom.
  Adding anything requires restructuring or a library first. `_settleBuy` was extracted
  precisely because `buy()`/`creatorLaunchBuy()` duplication pushed it over the limit.
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
- **The snipe tax table no longer deters on the new curve.** Measured: a $1,000 sniper
  takes 0.49% of supply at t=0 (9800 bps) but **28.93% at t=1** (2500 bps) and 35% by
  t=2. The table was tuned against a $30,000 virtual reserve; at $2,667 the same dollar
  buys 11x more. Real testnet racing lands snipers at t=1-2. Retuning the table is
  outstanding — do not describe the tax as effective until it is.
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
