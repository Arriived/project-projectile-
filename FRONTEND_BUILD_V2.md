# Frontend build — hard rules

Requirements the frontend must satisfy because of something in the contract, not because
of taste. Each one has a reason attached. **If you are about to remove one of these as a
needless restriction, read the reason first** — every entry here exists because removing it
costs a user money.

The broader frontend requirements (price impact as a headline number, `minTokensOut` never
defaulting to zero, "creator bought X% at launch", stale quotes inside the snipe window)
live in `CLAUDE.md` §8. They are not duplicated here, because two copies of a number go
stale at different rates.

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
