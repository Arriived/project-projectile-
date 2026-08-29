# Frontend build — hard rules and build brief

This is the single frontend document. It supersedes `FRONTEND_BUILD.md` and absorbs the
"frictionless build" brief that used to live separately; see the merge note at the end for
what came from where and what was dropped.

It has two parts, and they are different in kind:

- **Part I — hard rules.** Requirements the frontend must satisfy because of something in
  the contract, not because of taste. Each one has a reason attached. **If you are about to
  remove one as a needless restriction, read the reason first** — every entry exists
  because removing it costs a user money.
- **Part II — the build brief.** The goal, the CCTP onramp, the signature-count work, and
  the open questions to report on before building. This part contains decisions still to be
  made; Part I does not.

The broader frontend requirements (price impact as a headline number, `minTokensOut` never
defaulting to zero, "creator bought X% at launch", stale quotes inside the snipe window)
live in `CLAUDE.md` §8. They are not duplicated here, because two copies of a number go
stale at different rates. The same restraint applies between the two parts below: Part II
cross-references the rules rather than restating them.

---

# PART I — HARD RULES
---

## 1. The create flow must approve EXACTLY the creation fee. Never `MaxUint256`.

**Rule.** Before `createToken`, approve the launchpad for exactly the `creationFeeUsdc`
read in the same page load, and no more. Never an unlimited approval, never a rounded-up
buffer, never a standing approval reused across launches.

**Reason — register entry R13.** `creationFeeUsdc` is **not** covered by
`currentEconomicsHash()`. The economics hash pins the buy fee, sell fee, graduation
threshold, creator fee split, creator launch cap and window, LP recipient, snipe tax
version and split, and symbol policy — but not the creation fee. So `createToken` checks
the hash the creator signed up to, passes, and *then* pulls whatever `creationFeeUsdc`
happens to be at execution time:

```solidity
if (!(expectedEconomicsHash == currentEconomicsHash())) revert EconomicsChanged();  // passes
...
usdc.safeTransferFrom(msg.sender, address(this), creationFeeUsdc);                   // current value
```

Proven in `test/ActorPhase.adversarial.test.js`: a creator pinned the terms at 0.5 USDC,
the owner raised the fee 1000x, the pinned hash was unchanged so the guard could not fire,
and the creator paid 500 USDC. The economics-pinning guarantee does not extend to this
fee.

**The approval is the only thing bounding it.** With an exact approval the worst case is a
reverted transaction — annoying, safe. With `MaxUint256` the worst case is the entire USDC
balance of the creator's wallet, taken by a single owner transaction front-running the
launch. This is the difference between a failed launch and a drained wallet, and it is
decided entirely in the frontend.

**This is not defence against a hypothetical.** The owner is a single EOA by deliberate
decision (R8, and not to be re-raised). A compromised owner key is the threat model this
approval bound is sized for.

**If the contract later pins `creationFeeUsdc` in the economics hash, this rule can be
relaxed — and not before.** Check `currentEconomicsHash()` in `contracts/LFX1.sol` before
concluding that it has been.

---

## 2. There is NO name uniqueness, and symbols are now FULLY DUPLICABLE

**Rule.** Never present a token's name or symbol as identifying. Show the contract address
alongside them everywhere a user could act on the distinction, and warn on collision with
an existing token rather than relying on the contract to prevent one.

**Reason — this is what `LFX1.sol` actually does.** Grepped, not assumed:

| | what exists |
|---|---|
| **name** | **Nothing at all.** Not stored, not hashed, not compared. It is passed to the `LFX1Token` constructor and emitted in `TokenCreated`, and that is the end of it. The `Curve` struct has no name field. **Unlimited duplicate names, always, with no delay.** |
| **symbol** | The mechanism exists but is **switched off**. `symbolUnlocksAt[symbolHash]` is checked at [LFX1.sol:320](contracts/LFX1.sol:320) and written at [:329](contracts/LFX1.sol:329) as `block.timestamp + symbolLockDuration` — with the duration at **0** the stored value is always a past-or-present timestamp, and the `>=` comparison can never fire. It was a 5-minute reservation, never uniqueness. |

**`symbolLockDuration` is now 0 on the live deployment, so the lock never fires at all.**
It was 5 minutes; it was removed as friction without protection — bypassable by case, and
unable to back a "ticker is taken" UI. Two tokens with the same symbol in the same block is
now normal, expected behaviour, proven in `test/SymbolLock.test.js`.

**Surfacing collisions is therefore a HARD REQUIREMENT, not a nice-to-have.** Nothing in
the contract stops a launch impersonating an existing token's symbol, and nothing delays
it. The only defence a user gets is what the UI shows them.

**And within those five minutes it is bypassable by case.** `caseSensitiveSymbols` defaults
to `true` ([LFX1.sol:74](contracts/LFX1.sol:74)), so the hash is over the raw bytes: `CAT`
and `cat` are different symbols and both launch immediately. Flipping it to `false` routes
through `_toUpperAscii` and closes that, at the cost of more squatting surface — CLAUDE.md
records why it starts lenient.

`isSymbolAvailable(string)` ([LFX1.sol:735](contracts/LFX1.sol:735)) answers the question
the contract actually asks, and is the only thing worth calling for a live check. It returns
"not currently locked", **not** "nobody has ever used this".

**Do not build a "this ticker is taken" UX on top of it.** It cannot support one. The
honest UI is: show the address, surface collisions with already-launched tokens from the
indexer, and treat the 5-minute lock as anti-frontrunning for a single launch flow, which
is all it is.

Separately, `launchCooldown` is **10 seconds per creator address**
([LFX1.sol:67](contracts/LFX1.sol:67), keyed on `lastLaunchTimestamp[msg.sender]`) and is
bypassable with a second address or a factory contract. It is not a spam control; the
creation fee is.


---

## 3. Every quote and every trade needs a gas reserve. Gas IS the settlement asset.

**Rule.** Never let a user spend their whole balance. Reserve gas explicitly, show the
reserve, and cap "max" buttons at balance minus reserve. Refuse to submit a trade that
would leave less than the cost of one transaction.

**Reason — measured on Arc testnet, not reasoned about.** Arc pays gas in USDC, so the
settlement asset and the gas asset are one balance. A wallet was left holding
**471 trillion tokens and 0.0016 USDC**, and **could not sell them**. The position was not
illiquid; the holder simply could not afford to move it.

*(The node reported `insufficient funds for gas * price + value` at the time. Quoted as
evidence of what happened, not as something to match on — Zero8 changes that exact text,
which is rule 4's whole point.)*

This is not an edge case, it is what a "max" button does by default. On a chain where gas
is a different asset, spending the entire balance is normal and harmless. Here it strands
the user in a position they can see and cannot exit.

Two consequences beyond the max button:

- **A buy that spends the entire balance cannot succeed at all** — the gas for that very
  buy comes out of the amount being spent. The failure is confusing without a reserve.
- **Selling needs gas too.** A user who spent down to nearly nothing on the way in has no
  way out. The reserve must cover the exit, not just the entry.

Recorded as R15 in `CLAUDE.md`, executed by `scripts/smoke-r15.js` against the live
deployment.


---

## 4. Detect insufficient gas by ARITHMETIC, never by parsing a revert string

**Rule.** Before submitting any trade, estimate the gas, multiply by the gas price, add the
trade amount, and compare against the wallet's balance. Warn from that comparison. **Never
match on the text of an RPC error**, in any form — not `includes("insufficient funds")`,
not a regex, not a switch on the message.

**Reason.** The strings are not a stable contract, and they have just changed. **Zero8
activates on Arc Testnet on 3 September 2026 at 15:00 UTC**, upgrading reth/revm, and the
insufficient-balance error text becomes revm 38's `OutOfFunds` variant. `BREAKING_CHANGES.md`
confirms nothing consensus-affecting moved — the contract is unaffected — but any client
reading that message stops recognising it.

**The failure mode is silent, and that is what makes it serious.** A frontend that parses
the string does not throw when the string changes; it simply stops matching, and therefore
stops warning. The user sees no warning, submits, and the transaction fails — or worse,
succeeds into the state rule 3 describes. Nothing in the UI reports that the check broke.

Given rule 3 — a holder was measurably left with 471 trillion tokens and 0.0016 USDC,
unable to sell — a gas warning that fails silently on a node upgrade is the worst version
of this bug. The check that protects the user must not depend on a string the node is free
to reword.

`scripts/smoke-r15.js` does it the right way and is worth copying: it compares balance
against `gasLimit * gasPrice` **before** submitting, and asserts on state afterwards —
tokens still held, no tokens received — never on a message.

### When you DO need to tell one revert from another, decode the selector

Sometimes the distinction matters — `EconomicsChanged` should re-fetch and re-present terms
(rule 5), while `SlippageExceeded` should re-quote. Do that by decoding the **4-byte custom
error selector** against the ABI. It is ABI data, not prose, so it is stable across the node
upgrades that move the strings.

**On Arc, ethers does not decode it for you.** Measured against the live deployment: a
reverting `staticCall` comes back as a raw provider error with `code: 3` and the selector in
**`e.data`** — `e.revert` is `undefined` and `e.shortMessage` is `undefined`, so the
idiomatic ethers v6 handling silently matches nothing.

```js
const sel = e.data || e.error?.data || "";
if (sel === factory.interface.getError("EconomicsChanged").selector) { /* re-fetch terms */ }
```

Verified: `EconomicsChanged()` is `0x444df1ec`, and that is exactly what a stale pin returns
from `0xEDeed1F0...`. `scripts/verify-frontend-txshapes.js` asserts it.

---

## 5. Fetch the economics hash immediately before launching. Never cache it.

**Rule.** Read `currentEconomicsHash()` in the same user action that sends `createToken`.
Do not read it at page load, do not hold it across a wallet-confirmation dialog, do not
reuse one between attempts. If the transaction fails with `EconomicsChanged`, re-fetch and
re-present the terms — do not silently retry with a fresh hash, because the terms the user
agreed to have genuinely changed.

**Reason.** It moves. `symbolLockDuration` is one of the twelve values inside
`currentEconomicsHash()`, and setting it to 0 this session **moved the hash**, so any
`createToken` carrying a pre-change pin now reverts `EconomicsChanged`. Nothing was live so
nothing broke — but that is exactly the behaviour the frontend has to survive, and it will
happen again: every one of those twelve values is owner-settable at any time.

The revert is the guard working. It exists so a creator cannot be charged terms they never
saw. A cached hash turns a correct protection into a confusing failure at the worst moment,
after the user has already approved a spend.

**The twelve hashed values:** `defaultBuyFeeBps`, `defaultSellFeeBps`,
`defaultGraduationThresholdUsdc`, `defaultCreatorBuyFeeBps`, `defaultCreatorSellFeeBps`,
`maxCreatorLaunchBps`, `creatorLaunchWindow`, `lpRecipient`, `activeSnipeTaxTableVersion`,
`defaultSnipeTaxTreasuryBps`, `caseSensitiveSymbols`, `symbolLockDuration`.

**`creationFeeUsdc` and `launchCooldown` are NOT among them** — which is rule 1's whole
point for the fee, and why the launch cooldown can change under a pinned launch without
tripping anything.


---

## 6. Gas: read the fee from the chain every time, floor at 20 Gwei, display in USDC

Source: `docs.arc.io/arc/references/gas-and-fees`, verified 29 August 2026.

**Rules.**

- **`maxFeePerGas` must be at least 20 Gwei.** Verbatim: *"Set `maxFeePerGas` to at least
  20 Gwei"*, and *"Transactions submitted below this floor may remain pending indefinitely
  or fail outright."* This is not advisory — below the floor a transaction can hang forever
  rather than fail fast, which is the worst outcome for a UI to explain.
- **Size the gas reserve against a live reading, never the floor.** The maximum base fee is
  **20,000 Gwei** — *"Hard ceiling that bounds worst-case cost"* — a **thousand times** the
  floor. A reserve computed from the floor, or from a quiet-period sample, is wrong by up
  to 1000x exactly when the network is busy. Call `eth_gasPrice` (*"Quick estimation for
  simple transactions"*) or `eth_feeHistory` (*"Fine-grained estimation when you need
  historical context"*) immediately before submitting, and add headroom on top.
- **Display fees in USDC, never Gwei.** Verbatim: *"Because Arc denominates gas in USDC,
  surface fee estimates to users in dollar terms rather than raw Gwei."* Gwei is meaningless
  to a consumer on a chain where gas is dollar-denominated.
- **Add a small priority tip.** *"A value of 0 Gwei is accepted, but a small tip (for
  example, 1 Gwei) can improve inclusion time during high-utilization periods."*
- **Never hardcode any of these numbers.** Verbatim: *"The parameters on this page reflect
  the current Arc Testnet configuration. Values such as the minimum base fee, maximum base
  fee, and throughput limits may change before mainnet launch."* Read them from the chain.

This rule and **rule 4** are the same discipline from two directions: get the number from
the chain, not from a constant and not from a string.

**Interaction with rule 3, which is the part that bites.** The gas reserve must be sized
from a live fee reading, because the ceiling is 1000x the floor. A reserve that looked
generous at 20 Gwei is inadequate at 20,000, and rule 3's failure — a holder who cannot
afford to sell — is exactly what happens when it is too small.

---

## 7. Check whether the connected wallet is blocklisted, and say so

Source: `docs.arc.io/integrate/infrastructure/indexing-events`, verified 29 August 2026.

**Rule.** On wallet connect, and before any trade, check whether the address is blocklisted
by USDC. If it is, say so in plain language and disable trading. Do not let the user
discover it by submitting a transaction that reverts with nothing useful.

**How.** The USDC contract at `0x3600000000000000000000000000000000000000` exposes
`isBlacklisted(address)` for a point-in-time check, and emits two indexable events:

```
Blocklisted(address indexed account)
UnBlocklisted(address indexed account)
```

Index those to keep a live view rather than polling per wallet.

**Why it matters more than it looks.** A blocklisted party cannot send or receive USDC, and
on Arc USDC is also the gas token — so a blocklisted user cannot transact at all. Every
path fails, and none of them explains why. Without this check the app looks broken rather
than restricted.

**It also partly mitigates R1**, which the register records as permanent and unmitigable:
Circle can pause or blocklist and there is no fallback path. That remains true for the
protocol. But at the *wallet* level the condition is now detectable in advance, so the
user gets an explanation instead of a wall. Detection is not mitigation of the underlying
risk — it is mitigation of the confusion, which is the part a frontend can actually own.


---

## 8. WalletConnect needs the same `wallet_addEthereumChain` treatment as injected wallets

Source: `docs.arc.io/integrate/connect-to-arc`, verified 29 August 2026.

**Rule.** The chain-add/switch path must run for WalletConnect sessions, not just injected
providers. `ensureArcNetwork` already does this for MetaMask and Rabby; the WalletConnect
path needs the same handling, with the chain params prefilled.

**Reason, verbatim:** *"Arc Testnet (chain ID 5042002) is not registered in the
WalletConnect chain registry. On first connection, WalletConnect issues a
`wallet_addEthereumChain` call per user."*

So every mobile user hits an add-chain prompt on first connect. That is unavoidable, but it
must be *expected and explained* rather than appearing as an unlabelled wallet popup in the
middle of a buy. Handle it in the connect step, before the user commits to a trade.

Chain params to prefill, from `/integrate/infrastructure` and `/arc-chain`:

| field | value |
|---|---|
| chainId | `5042002` (`0x4CEDB2`) |
| RPC | `https://rpc.testnet.arc.io` (documented; `rpc.testnet.arc.network` also works) |
| explorer | `https://testnet.arcscan.app` |
| native currency | **USDC, 18 decimals** — not ETH. This is the gas token |

The 18-decimal native currency is the part to get right: it is the same balance as the
6-decimal ERC-20 view (rule 3), and a wallet configured with the wrong decimals will
display gas costs off by a factor of a trillion.

---

## 9. A bought token is INVISIBLE in the wallet until it is added. Show the balance, and offer `wallet_watchAsset`.

Sources: `docs.metamask.io/wallet/how-to/display/tokens`, MetaMask support on token
autodetection, MetaMask/core PR #433. Verified 29 August 2026. Decimals and symbols below
were read off the live deployment, not off the source.

**Rule.** The token page must show **the connected wallet's balance of that token,
prominently** — not tucked into a drawer, not only after a trade — and must offer a
one-click **Add to wallet** button calling `wallet_watchAsset`. After a successful first
buy of a token the user does not yet hold, prompt it once, automatically.

**Reason.** MetaMask's token autodetection only runs on a fixed list of networks —
Ethereum, Linea, Avalanche, BNB, Polygon, Arbitrum, Optimism, Base, zkSync, Solana. **Arc
is not on that list and will not be.** So a token launched thirty seconds ago will never
appear in a wallet by itself. The buy succeeds, the tokens are in the account, and the
wallet shows nothing.

**On Arc this is worse than the same bug anywhere else, and that is the part to
understand.** USDC is the gas token, so it *is* the account's native balance — the headline
number in the wallet. After a buy the user watches that number **go down** and sees nothing
arrive. It does not read as "nothing happened"; it reads as "my money left and I got
nothing back." On a chain where USDC is an ordinary ERC-20 the user at least sees one line
item decrease and can reason about it. Here the only visible evidence of a successful trade
is the loss.

The token is not missing and the transaction did not fail. But we will never win that
argument after the fact, so the UI has to prevent it being asked.

### Pass `decimals: 18`. Not 6.

Verified on chain — `decimals()` on two live launch tokens returns **18**; USDC at
`0x3600…0000` returns **6**. `LFX1Token is ERC20` and does not override OpenZeppelin's
default, so 18 holds for every token this factory will ever launch.

**The trap is that this codebase drills the opposite number into you.** "USDC is 6 decimals
in contract amounts" is a standing rule in `CLAUDE.md` §5, 6 appears throughout
`terminal.html`, and it is the wrong answer here. Pass 6 and MetaMask displays the balance
**a trillion times too large** — the same failure mode as rule 8's native-currency
decimals, one field over. A holder with 471 trillion tokens (the real R15 figure) becomes
unreadable nonsense.

`terminal.html` already gets this right — `formatUnits(bal, 18)` for the launch token, 6
for USDC. Salvage that pairing deliberately rather than re-deriving it.

### The symbol can be longer than MetaMask accepts, and our contract does not care

| enforces | value |
|---|---|
| MetaMask `wallet_watchAsset` | **11 characters max** — raised from 6 in MetaMask/core PR #433, matching the extension's own manual add-token limit |
| MetaMask's how-to page | *"up to 5 characters"* — **stale doc text, not the enforced value.** Do not design to 5 |
| `LFX1.createToken` | **nothing.** No length check, no emptiness check, on either `name` or `symbol` |

`createToken` hashes the symbol for the (now disabled — rule 2) lock and otherwise passes it
straight to the constructor. Any string is accepted, including an empty one and a 200-character
one. So a creator can launch a token that **no buyer can ever add in one click**, and they
will not find out at launch — they will find out from buyers.

**This will not surface in testing.** Every token currently on testnet is a 7-character
symbol (`PRC4587`, `TXS1569`, `TXS3714`, `TXS2809`). All pass. The first failure will be a
real creator with a long ticker.

Two places to handle it, and both are needed:

- **The create form** warns at >11 characters, at the point the creator can still change it.
  A warning, not a block — the contract will accept it and refusing to launch what the
  contract allows is its own kind of lie. Say what the cost is: *"wallets can't one-click-add
  a symbol this long; your buyers will have to add it by hand."*
- **The token page** handles the rejection without treating it as a failed trade. The add
  failing has nothing to do with whether the buy worked.

### Do not gate anything on the return value

`wallet_watchAsset` resolves to a boolean. **A `false`, a rejection, or a throw is not an
error** — the user declined a convenience, and their tokens are unaffected. Never surface it
as a failed transaction, never retry it in a loop, and never block the trade flow on it.
Its behaviour when the token is already tracked is not reliably specified
(MetaMask/core #880), so it is not a source of truth for "does the user have this token
added" either. Treat the call as fire-and-forget.

### Always show the contract address too

`wallet_watchAsset` is not universally supported — support varies across WalletConnect
sessions and mobile wallets, the same split rule 8 already deals with. So the manual path
must always be available: show the token's contract address with a copy button on every
token page. That is the fallback when the button does nothing, and it costs one line of UI.

### Read the balance with `balanceOf`, after the receipt — never from the quote

The displayed post-trade balance must come from a fresh `balanceOf` call once the
transaction is mined, not from the `quoteBuy` figure the user was shown beforehand. The
snipe tax decays per second and the partial-fill clamp can bind between quote and
execution, so the amount actually received can be smaller than the amount quoted
(`CLAUDE.md` §8, and §7A on the clamp). Showing the quote as though it were the outcome
prints a number the contract did not honour — which is exactly what the ground rules of
this document forbid.

This is also the honest confirmation that the trade worked: not "we think you got X", but
the balance the chain reports.

---

# PART II — THE BUILD BRIEF

**The goal is one click to launch, one click to buy, one click to sell, fully
non-custodial.** A user browses without a wallet, clicks buy/sell/launch, is prompted to
connect, and from there every action is as few signatures as possible. Bridging is
invisible. This has to hold for someone in Seoul with no prior crypto and someone in London
with a MetaMask full of Base USDC.

Build it so a mobile app is a re-skin of the same flows, not a rewrite.

## Sources of truth

**Circle's and Arc's docs are the only source of truth** for anything CCTP, Arc, Gateway,
App Kit, or Bridge Kit. Never answer from memory or from these notes.
`developers.circle.com` and `docs.arc.io`. Both publish `llms.txt` indexes.

**The Arc MCP server is already connected** — `.mcp.json` at the repo root, project scope,
HTTP transport at `https://docs.arc.io/mcp`, no authentication. Query it *before* this file.
`CLAUDE.md` §9.5 records four things it corrected on its first query, which is the argument
for reaching for it by default. The `circle-skills` plugin is installed.

**CCTP V1 is legacy. Build on V2.** Circle segregates V1 under `/cctp/v1`. If you find
yourself reading a V1 page, you are on the wrong path.

## Onramp: CCTP V2 inbound from every supported chain

Do not build a bridge. Use Bridge Kit, which wraps CCTP V2's burn, attestation and mint
steps. Circle has done this work.

**This is the day-one onramp and it is not optional.** Arc launches with no USDC on it and
no user holding it. Every chain CCTP supports is a source of users; the onramp sits at the
top of the entire funnel. `CLAUDE.md` §8 records it as required non-contract scope — its
absence from the contract sections is not descoping.

Ignore Unified Balance for launch. It requires a prior Gateway deposit that nobody will have
on day one, and obtaining one costs its own transaction — so for a first-time user it is
more steps, not fewer. It is a returning-user optimisation and it can come later. CCTP with
Forwarding Service is also push-based and contract-centric, which keeps our backend out of
the trust path; Gateway's pull model does not.

### What I already verified — re-verify, don't trust it

- **Arc is domain 26** and is a Forwarding Service destination, with upfront fees supported.
  Standard Transfer *from* Arc is ~0.5s at 1 confirmation.
- **Inbound latency is set by the source chain, not Arc.** Fast Transfer:
  Base/Arbitrum/OP/Solana/Unichain ~8s, Ethereum ~20s. This is seconds, not minutes —
  bridging in is viable inside a trading session.
- **The supported-chains table lists "Arc testnet", not Arc mainnet.** Re-check on and after
  16 September. Do not assume the mainnet row inherits testnet's capabilities. `CLAUDE.md`
  §8 records the same gap from the other side: Arc mainnet is still absent from Circle's
  published CCTP address list.
- Fast Transfer carries a fee and a global allowance. Report what happens to the UX when the
  allowance is exhausted.

### Always Fast Transfer where the source supports it

This is the rule that decides whether the onramp feels instant or broken.

Fast Transfer is ~8 seconds from Base, Arbitrum, OP, Unichain, Solana, Ink, Linea, Plume,
World Chain, Codex, Morph, X Layer and EDGE; ~20 seconds from Ethereum and Starknet.
Standard Transfer on those same chains is **15–19 minutes**, ~30 minutes on Ink, 2–4 hours
on Starknet and **6–32 hours on Linea**.

Chains without Fast Transfer as a source — Polygon, Avalanche, Sei, Sonic, HyperEVM, Monad,
Aptos, Stellar, Injective, Cronos, XDC, Pharos — don't need it; their Standard times are
already seconds. So with the rule applied correctly, every supported route is seconds.

**The failure mode to design for: Fast Transfer has a global allowance and it can be
exhausted.** When it is, the route falls back to Standard, and a user who expected 8 seconds
from Base waits 19 minutes. Report what the SDK returns in that state, and surface it in the
UI **before the user commits**, not after. Give them the real quoted time and let them
decide.

Also report: Fast Transfer fees and who pays them; whether upfront fees on the source chain
remove the need for destination gas; and what the recovery path is when a transfer stalls
(`app-kit/references/bridge-error-recovery`). A stuck bridge with no status and no recovery
UI will generate more support load than everything else combined.

### Quote the bridge NET, not gross

The Forwarding Service fee is deducted from the USDC minted on the destination. Tell the
user what will actually land, and **make sure it clears their gas reserve**.

Arriving with exactly the trade amount and nothing for gas is a dead end — and it is
**rule 3's failure reached by a different route**. The user is on Arc, holding USDC, and
cannot move it. Landing a bridge that strands its own user is worse than refusing the quote.

### What it looks like

User clicks buy with no Arc USDC → inline panel, no page change, no external redirect →
source chain and amount, with the real ETA → funds arrive → **the original buy completes
automatically**. The word "bridge" should not appear, and the user should never have to come
back and start again.

Bridging **out** matters too — people who profit will want USDC off Arc. Arc as a source
settles in about half a second at one confirmation. Don't leave this to a later release; a
launchpad you can't withdraw from is a trust problem.

### The build-step collision — settle this before writing code

Bridge Kit and App Kit are npm packages (`@circle-fin/bridge-kit`, adapters for
viem/ethers/Solana). Our frontend is deliberately plain HTML/CSS/JS with no build tooling,
and `CLAUDE.md`'s stack line commits to that.

Three options: bundle only the onramp module with a one-off esbuild step and keep the trading
app buildless; find a CDN-hosted ESM build; or hand-roll CCTP V2 against the contracts and
the attestation API with plain ethers.

**I lean to the first** — one bundled module, checked in as a built artifact, the rest
untouched. Hand-rolling CCTP throws away the 95% Circle already did. Tell me if you disagree,
then do it.

## Getting to fewer signatures

Right now a first buy is realistically: connect, approve USDC, buy. A sell is: approve the
launch token, sell. That is not one click, and no amount of frontend work fixes it alone.

**Two of the four original paths are dead — the contract is frozen and `CLAUDE.md` records
it as CLOSED.** See the merge note at the end for what was dropped and why. Everything below
is frontend and infrastructure work requiring no contract change:

**1. Budgeted approval.** Two transactions the first time, one every time after. Zero
contract change. The floor, and what `terminal.html` already does — `APPROVAL_BUDGET_USDC`
is 500, a budget rather than `MaxUint256`.

⚠ **This does not extend to the creation fee, and the two must not be unified.** Rule 1
requires an exact-amount approval for `createToken`. That is not an inconsistency: they are
different hazards. R13 records that `creationFeeUsdc` is **absent from
`currentEconomicsHash()`**, so the owner can raise it between the creator seeing terms and
their transaction landing, and the pin cannot fire. Trading fees *are* hashed and snapshotted
per curve, so a standing trading approval is bounded by terms that cannot move underneath it.
**Do not refactor these into one "approve once" helper** — the shared shape is a coincidence,
not a common case.

**2. ERC-4337 smart accounts.** Arc supports 4337 with a full provider list — Privy, Dynamic,
Turnkey, Para, Crossmint, Thirdweb, ZeroDev, Pimlico, Biconomy, Circle Wallets. A smart
account batches approve+buy into one UserOperation, and a paymaster can sponsor the first
transaction so a user with zero USDC isn't stuck before they start. It also gives
email/passkey onboarding, which is what makes this work for users who have never held crypto.

**On Arc the paymaster argument is stronger than on any other chain**: USDC is the gas token,
so a zero-balance user cannot even *approve*. There is no "I hold ETH for gas but no USDC"
state to fall back on — zero balance is total paralysis, not partial.

**3. EIP-7702**, batching from a plain EOA with no smart account. `CLAUDE.md` §9.1 records
Arc as behaving *"as on Ethereum"* for EIP-7702, so this looks live — verify against
`evm-differences` before relying on it. **`terminal.html` already ships EIP-5792 batching as
progressive enhancement** (`wallet_getCapabilities` → `wallet_sendCalls`, with any
non-supporting wallet falling back silently). Salvage that; it is the safe half of this and
it is already written.

I want your recommendation on which combination gets to one click without custody, and what
it costs in build time. Be honest if 4337 is more than the remaining schedule can absorb —
budgeted approval plus a good connect flow may be the right launch answer, with 4337
following.

## Wallet and connection

- Browsing requires no wallet. Buy, sell, and launch buttons are always live and prompt
  connection on click. Never a gate in front of the content.
- Support injected wallets (MetaMask, Rabby), WalletConnect for mobile, and — depending on
  the 4337 answer — email/passkey.
- Auto-detect wrong network and offer to add/switch to Arc in one click, with the chain
  params prefilled. **Rule 8 carries the params and the WalletConnect caveat.**
- **No private keys in browser storage, in any form, under any framing.**
- **Balances change with no `Transfer` event.** Gas is deducted natively from the same
  balance the ERC-20 view reads, so any UI reconciling a balance from events will drift.
  Always read `balanceOf`. Rule 9 requires the same thing for the launch token, for an
  unrelated reason — between them, no balance in this app should ever be inferred.

## Taking inspiration from Pons

Study their interface for flow and information density, not for copy. What to take: how
little ceremony sits between landing and trading, one primary action per screen, and **the
token page as the unit of navigation**. `CLAUDE.md` §7C makes that last point the scope
decision for this whole build — a launchpad, not a trading terminal.

What not to take: their fee framing. Their docs claim a zero-fee pool means trading their
tokens doesn't cost a Uniswap fee on top. That's misleading — a 0% pool fee plus a 1% hook
fee costs a trader the same as a 1% LP fee. Do not reproduce that claim in our copy. Our
differentiator is being the one that doesn't do this.

**Hold our own copy to the same standard**, which is the harder half. `CLAUDE.md` §7A: never
market the creator split as "90/10" — it blends to **70%**, and both splits are readable on a
verified contract in thirty seconds. Never say "creators are capped at 2.5%" — the cap limits
only the *privileged* launch-buy path and nothing stops a second address. Say "up to 98%" of
the snipe tax, not "98%". Trust is the moat; a claim a competitor can falsify in one page
load costs more than the feature it oversold.

## Ground rules

Report before building. Inventory `create-token.html` and `terminal.html` first — `CLAUDE.md`
§7C says salvage the engine and ship neither. Verify every Circle/Arc claim against their
docs, **including the ones written above**. Flag anything where the interface would show a
number the contract wouldn't honour. Don't tell me it's finished when it's untested against
the live testnet deploy.

---

# MERGE NOTE — what became of the second document

Merged 29 August 2026 from `FRONTEND_BUILD_V2_2.md` ("Frontend — frictionless build"), which
existed in parallel and was never in the repo. This section exists because a `CLAUDE.md`
rewrite once silently dropped three whole sections and nothing could have noticed (§7A). A
merge that records what it discarded can be audited; one that doesn't, cannot.

**Merged in, substantively unchanged:** the goal statement, sources of truth, the entire CCTP
V2 onramp section (the Fast Transfer rule, the verified latencies, the allowance-exhaustion
failure mode, what it looks like, bridging out), the build-step collision question, the wallet
and connection bullets, the Pons framing, and the ground rules.

**Merged with additions** — all of them cross-references to facts already established
elsewhere in the repo, not new claims: the bridge-net-not-gross point now names rule 3 as the
failure it reaches; the 4337 entry states why a paymaster matters more on Arc than elsewhere;
EIP-7702 points at the EIP-5792 batching already shipped in `terminal.html`; the approval
entry states why it must not be unified with rule 1; and the Pons section turns the
fee-framing discipline onto our own copy.

**Dropped — both dead, and dead for the same reason.** The contract is frozen at
`0xEDeed1F05D34421Add0F59b7340588ab2BbaC04b`, 24,033 / 24,576 bytes, verified, with
`CLAUDE.md` recording it as CLOSED: *"No contract work remains and none should be started
without a reason written down first."*

| dropped | what it asked | why it is dead |
|---|---|---|
| **EIP-2612 permit on the USDC leg** | Whether `LFX1.buy` has a permit path, and what one would cost in bytecode — framed as *"`LFX1` freezes this week with 568 bytes left, so this is now or never"* | The freeze happened. "Now or never" resolved to never. The byte figure was stale too: **543** free, not 568 |
| **`LFX1Token` standing allowance** | Whether the token could grant the factory a standing allowance at deployment, making every sell a single transaction forever. Marked *"escalate now if it touches the contract"* | It touches the contract. It is also a trust regression the positioning cannot absorb: the factory could move any holder's tokens at will, on a project whose stated moat is verifiability |

Neither is lost — both are recorded here with their reasoning, so a post-mainnet contract
revision can pick them up deliberately rather than rediscovering them. **Neither is a reason
to reopen the contract before mainnet.** If one is revived it starts with a written reason,
per `CLAUDE.md` §5.

**One caveat carried over deliberately.** The *"what I already verified"* figures in the
onramp section came from the parallel document and have **not** been re-verified inside this
repo. Their own heading says to re-verify; that instruction is load-bearing, not modesty.
