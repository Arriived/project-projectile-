# Ballista — project briefing

*Written 30 August 2026. For a fresh Claude conversation with no access to the repo.*

**You cannot verify anything in this document.** It was written by an assistant working
directly in the codebase, from commands run against the live chain, the live database and
the actual test suites — but you are reading a snapshot, not the source. If the person
you're talking to can run commands, prefer what the repo says over what this says. Where
they disagree, this document is the bug.

---

## 1. What is being built

**Ballista** — a memecoin launchpad native to **Arc**, Circle's stablecoin L1 where **USDC
is the native gas token**.

Users launch a token, it trades on a bonding curve, and when the curve fills it
**graduates**: the remaining tokens plus the accumulated USDC are deposited into a Uniswap
V2 pool and the LP tokens are burned to `0x...dEaD`.

**The positioning is trust and verifiability, not feature count.** Twelve competitors are
launching on Arc and several have already damaged their reputations. The differentiator is
a deployed, verified, adversarially-tested contract that anyone can read on the block
explorer. This shapes every decision below — it is why claims in the UI are checked at
build time against what the contract actually does, and why "we tested it" is never
allowed to stand in for "we tested it against the real thing".

**Hard external deadline: Arc mainnet launches 16 September 2026.** Confirmed, immovable.
Launch-ready target is ~9 September; that week is buffer, not spare capacity.

---

## 2. Where the project is, right now

### The contract is FINISHED and FROZEN

- **Address:** `0xEDeed1F05D34421Add0F59b7340588ab2BbaC04b` on Arc Testnet
- **Size:** 24,033 of 24,576 bytes — 543 free. Verified on-chain this session.
- **Fully verified on Blockscout.** Source is published and readable.
- **No contract work remains, and none should be started without a written reason.**

Any source edit — *including a comment* — changes the compiled bytecode, because the
compiler embeds a hash of the sources. Five factory addresses have existed for this
reason. Do not casually edit the contract.

### Test state (all re-run 30 August unless noted)

| suite | result |
|---|---|
| Hardhat (local) | **255 passing**, 10 pending |
| the 10 pending | the fork suite; needs `FORK=1` and a mainnet fork RPC. **Not re-run.** |
| Foundry invariants | **13 passing** (~205s) |
| Frontend | **143 passing** across 7 suites |
| Supabase RLS (anon key) | **11/11** |
| Live Arc-testnet R15 checks | 14, passed when last run. **Not re-run** — needs a funded key. |
| Mutation score | **52/56 = 92.9%**, 4 survivors, all classified |

### The frontend is BUILT

React 19 + Vite 6 + wagmi 3.7.7 + viem 2.56 + TanStack Query, in `app/`.

Three routes ship: `/` (token list), `/t/:address` (token page), `/about` (landing page).
**`/create` is linked but does not exist** — that is Phase 4, deliberately not started.

### ⚠ The indexer is STALLED

Not broken — **not running**. Its checkpoint sits ~217,000 blocks behind the chain head,
about **29 hours** of Arc time. The data it already holds is correct (4 tokens, 6 trades)
and all migrations are applied. It just needs restarting.

**Do not reset its checkpoint.** The checkpoint is per-factory. Resetting is only correct
after a *redeploy*; here the factory has not changed, so resetting would replay ~90,000
blocks for nothing.

### Source control

Branch `ballista-migration`, HEAD `6860f6b`, tree clean, **pushed to a private GitHub
remote**. Until today, 73 commits existed only on one disk; that is now fixed.

---

## 3. The single largest gap

**No real wallet has ever signed a transaction through this app.**

Everything underneath the signature is proven against the live contract — quotes, the gas
reserve, the blocklist check, error decoding, and the exact transaction shapes. What has
never happened is a human clicking "Buy" in MetaMask and the transaction landing.

This matters more than it sounds, because of a pattern that has already burned this
project: **the chain guard took four rounds to fix, and three of those fixes passed against
a simulated wallet and failed against real MetaMask.** The root cause turned out to be two
browser extensions fighting over `window.ethereum`. Nothing in a test double reproduced it.

Treat "verified against a fake" as *not verified*.

---

## 4. Things that are settled — do not reopen these

These were each decided after real work. Re-arguing them wastes the calendar.

- **Mainnet ships on the Uniswap V2 router, LP burned.** V4 is post-launch. Do not start
  building V4.
- **The contract is frozen.** No changes without a written reason.
- **Quotes always come from the contract's own `quoteBuy` / `quoteSell` view functions.**
  The curve maths was once re-derived in JavaScript and was wrong by **98.96x** at launch
  moment, in the direction that makes every buy revert. That code is deleted and must
  never return.
- **There is a build step.** A "no build step, plain HTML" constraint used to exist; it was
  revoked deliberately and the reasoning is recorded. Do not reinstate it.
- **The owner is a single EOA**, by the operator's explicit decision. Do not re-raise
  multisig.
- **Licence is UNLICENSED**, all rights reserved. On Blockscout the correct value is
  `none`. ⚠ The `unlicense` option on that list is *The Unlicense — a public-domain
  dedication*, the exact opposite. Never select it.
- **i18n is in-house on `Intl`** (~1 kB). A library was measured at +17.1 kB gzip and
  rejected.
- **Wallets bind via EIP-6963**, never the generic injected connector.

---

## 5. Roadmap to 16 September

### Now → next few days

1. **Restart the indexer.** It is the only thing currently degraded. The list page reads
   from it; every hour it is down is an hour of launches the product cannot see.

2. **Click through buy and sell with a real wallet.** The signature path. This is the
   highest-value hour available anywhere in the project.

3. **Migration 003** — approved, not yet written. The list page currently derives "recent
   buys" from a second database query and *disables* its 24h/7d filters because the data
   genuinely does not exist. Both are honest workarounds. The migration adds:
   `last_buy_block`, `last_buy_at`, `volume_24h_usdc`, `volume_7d_usdc`,
   `volume_all_usdc`, `total_supply`, `symbol_collision_count`.

4. **Re-run the R15 smoke tests after 3 September.** Arc Testnet gets an upgrade ("Zero8")
   on 3 September at 15:00 UTC. It contains no consensus changes, so the contract is
   unaffected — but the suite should be re-run to confirm.

### Phase 4 — the create flow

**Not started, and gated on the operator's explicit go-ahead.** Do not begin it unasked.

One hard requirement when it does begin: the token-creation fee must be approved for an
**exact amount, never `MaxUint256`**. There is a known open issue (R13) where the creation
fee is not covered by the contract's economics-pinning hash, so an unlimited approval is
genuinely exploitable and an exact one is not.

### Before mainnet — none of this exists yet

- **Hosting.** The app has never been deployed anywhere.
- **A runbook and a rollback plan.**
- **User-facing documentation.**
- **CCTP V2 bridging.** This is *required* scope, not optional: it sits at the top of the
  funnel so a user on Base, Ethereum or Solana can buy an Arc token without bridging
  manually first. Use Circle's Forwarding Service rather than a custom relayer.
- **Simplified Chinese translation.** The decision is English + Simplified Chinese ship,
  Korean cut. The plumbing works and is enforced at build time, but the Chinese file
  currently holds **7 of 239 keys** — it is a scaffold, not a translation.
- **Monitoring for `RouterProposed` events.** There is a 24-hour timelock protecting
  against a malicious router swap. Unwatched, it is 24 hours of decoration.

### Everything that resolves only on the day

Arc mainnet does not exist yet, so **none of these can be pre-wired**: the mainnet chain
ID (a secondary source claims `5042`; Circle publishes only testnet `5042002` — treat
`5042` as unsourced and do not hardcode it), mainnet USDC and CCTP addresses, and whether
Uniswap V2 is actually deployed at the expected addresses. Anything that can fetch and
verify at runtime should be built that way rather than hardcoded and swapped later.

---

## 6. How this project works — the ground rules

These are not stylistic. Each was paid for with a real failure.

**Verify, don't recall.** Documentation in this project has been wrong repeatedly — it
once carried three conflicting commit hashes simultaneously. Check claims against the repo
before relying on them.

**Every test must be proven capable of failing.** Six tests in one session passed while
testing nothing. Mutate the code, confirm the test goes red, restore. A test that has
never been seen to fail is not evidence. This caught two real problems this week — most
recently, adding WalletConnect broke a wallet-selection rule and **all ten existing checks
passed under both the correct and the broken version**, because no test described that
case.

**Distinguish "proven" from "not yet falsified".** Two of the four surviving mutations are
mathematically proven unreachable; two have merely survived 2,000,000 fuzz cases. Those
are different claims and must not be flattened into one number.

**Report findings before fixing them.** Some are acceptable risks, and that is the
operator's call, not the assistant's.

**Never claim it is bulletproof.** State what was tested, what was found, and what would
still worry you with real money on it.

**The risk register is deliberately non-empty.** A register that closes everything is the
same failure as a test that cannot go red. Known-open items include: Circle can pause USDC
and everything stops (unmitigable, must be disclosed publicly); a blocklisted user cannot
be tested on testnet; USDC sent directly to the factory is permanently stranded.

---

## 7. Arc-specific facts that trip people up

- **USDC is both the gas token and the settlement asset — one balance.** A wallet that can
  afford a trade cannot afford the trade *plus* its gas. This was proven on-chain: a holder
  left with 0.0016 USDC held 471 trillion tokens and **could not afford to sell them**. The
  frontend therefore withholds a gas reserve sized on the *exit*, not the entry.
- **USDC has two views of one balance:** 18 decimals natively, 6 decimals through the
  ERC-20 interface, and the ERC-20 view *truncates*.
- **Blocks are sub-second and consecutive blocks can share a timestamp.** Order by block
  number, never by timestamp.
- **Finality is deterministic.** No reorgs, no confirmation-depth waiting.
- **`eth_estimateGas` returns no margin** — and was measured returning **26% below** actual
  consumption. Always send with real headroom.
- **Every native USDC movement emits two `Transfer` logs** from different emitters at
  different decimal scales. Anything reading transfers must dedupe or it double-counts.
- **Local EVM simulators do not reproduce Arc's behaviour.** Arc says this explicitly.
  Blocklist enforcement and the truncating balance only appear on real Arc RPC.
- **Arc's docs are the ground truth** and there is a documentation server connected to the
  project. Query it rather than relying on memory; doing so has caught errors every time.

---

## 8. If you're being asked to help

The most useful things right now, in order: **restarting the indexer**, **the real-wallet
click-through**, **migration 003**, and then **deployment and hosting**, which does not
exist at all and is three weeks from a hard deadline.

The least useful: touching the contract, building Uniswap V4 support, re-arguing any
decision in section 4, or writing code that re-derives the bonding curve.
