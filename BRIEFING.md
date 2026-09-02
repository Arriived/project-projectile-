# Ballista — project briefing

*Written 2 September 2026. For a fresh Claude conversation with no access to the repo.*

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
- **Size:** 24,033 of 24,576 bytes. Verified on-chain.
- **No contract work remains.** Any source edit -- including a comment -- changes the
  bytecode, because the compiler embeds a hash of the sources. Five factory addresses have
  existed for this reason.

### ✅ All three write paths are proven on a real wallet

**This was the longest-open item in the project and it closed on 2 September 2026.**
Create, buy and sell, against real MetaMask. Round trip 246.89 → 246.778 USDC on a 5 USDC
trade (~2.2%, being two 1% fees plus gas). `wallet_watchAsset` prompted, imported, and the
wallet shows the correct balance -- so token decimals are confirmed right on real hardware.

Every earlier version of this briefing had to say the signature path was unverified. It is
not any more.

### Test state

| suite | result |
|---|---|
| Hardhat (local) | **255 passing**, 10 pending (the fork suite) |
| Foundry invariants | **13 passing** |
| Frontend | **156 checks** across eight suites |
| Supabase RLS (anon key) | **11/11** |
| Mutation score | **52/56 = 92.9%**, 4 survivors, all classified |

Not re-run recently: the 10 fork checks (need a mainnet fork RPC) and the 14 live
Arc-testnet R15 checks (need a funded key).

### The frontend is feature-complete

React 19 + Vite 6 + wagmi + viem. Four routes ship: token list, token page, `/about`, and
**`/create` -- the launch flow now works and has created a real token.** There is a price
chart, toasts, keyboard focus states, and percentage-based sell sizing.

Entry bundle 225.69 kB gzip; the chart is a 55.20 kB lazy chunk loaded only on a token
page.

### The database

Migrations 000 through 004 all applied. The view carries 34 columns including volume
windows, market cap, collision counts and a per-token flag saying whether its volume
windows are exact.

## 3. The largest gap is now operational, not technical

**Nothing is deployed anywhere.** No hosting, no domain, no preview URL. Config exists and
has never been run.

**The indexer runs on a laptop** with no supervisor and no external alerting.

**Mobile has never been tested once.** No viewport below 1280px has been opened, on a
product whose users are overwhelmingly on phones.

Mainnet is 16 September. The code is in better shape than the operations.

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

1. **DEPLOY IT.** Nothing is hosted. Vercel config exists (`app/DEPLOY.md`) and has never
   been run. A launchpad nobody can reach is worse than a missing feature.
2. **Get the indexer off a laptop** — a host, a supervisor, and external alerting. The code
   now fails loudly rather than silently, but nothing restarts it.
3. **Test on a phone.** No viewport below 1280px has ever been opened.
4. **Send two questions to Goldsky** (the chosen RPC provider): does their day-one Arc
   mainnet guarantee cover their Edge RPC product specifically, and what is its
   requests-per-second ceiling? The rate limit is the binding constraint, and no research
   can answer these — they need an email.

### Done since the last briefing — do not redo

Migrations 003 and 004 applied. The create flow shipped. A price chart built. All three
write paths verified on real MetaMask. The indexer's live-mode outage diagnosed and fixed.
An interaction and accessibility pass.

⚠ One correction to carry forward: the price chart plots **curve mid-price derived from
reserves**, never `usdc_amount / token_amount`. The latter is execution price including
the snipe tax and produces a 5.3x sawtooth between adjacent buys and sells at the same
reserve level. Anyone rebuilding the chart will reach for the wrong one first.

### Before mainnet — none of this exists yet

- **Hosting.** The app has never been deployed anywhere. This is now the top item.
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

The most useful things right now, in order: **deployment**, **getting the indexer onto a
supervised host**, and **testing on a phone**. All three are operational. The code is in
better shape than the operations, and mainnet is two weeks away.

The least useful: touching the contract, building Uniswap V4 support, re-arguing any
decision in section 4, or writing code that re-derives the bonding curve.
