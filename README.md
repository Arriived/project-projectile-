# Arc Launch — contracts (testnet build)

Compiles clean against Solidity 0.8.24 with OpenZeppelin 5.1, and now has a real test
suite (19 tests, all passing) exercising actual contract execution, not just compilation.
Not deployed anywhere yet, not audited by a third party, no real funds should touch this.

## Security pass — what was found and fixed

A close re-read of the original draft surfaced six real issues, fixed before this was
tested further:

1. **Rounding leaked value to traders on every single trade.** The constant-product math
   rounded in the trader's favor instead of the protocol's — meaning the curve was
   quietly bleeding a tiny amount of value on every buy and sell, forever. Fixed by
   rounding the intermediate virtual-reserve calculation up (ceiling division) instead
   of down, the same direction production AMMs like Uniswap use and for the same reason.
2. **Global fee/threshold changes retroactively hit every live token.** `buy()`/`sell()`
   read fee and graduation-threshold values live from storage, so changing the default
   fee instantly changed the deal for tokens that had already launched under a different
   one. Fixed by snapshotting fee and threshold into each token's own curve state at
   creation — a token now trades under the terms it launched with, permanently, no
   matter what the global defaults change to later. Covered by a dedicated test.
3. **Graduation could silently "succeed" with zero liquidity.** If the DEX router
   returned without reverting but handed back zero LP liquidity, the contract would mark
   the token graduated and move on as if nothing was wrong. Added a `require(liquidity >
   0)` check — verified with a mock router built specifically to return zero.
4. **Checks-effects-interactions ordering was loose.** `buy()`/`sell()` fired external
   token transfers before finalizing internal state. The `nonReentrant` guard already
   blocked exploitation of this given the token set involved (standard ERC20s, no
   transfer hooks), but it's fixed properly now regardless — all state changes happen
   before any external call, which is the correct pattern independent of what tokens
   happen to be in play today.
5. **Case-sensitive symbol matching was trivially bypassable.** "CAT" and "cat" hashed
   differently, so the on-chain uniqueness check could be dodged with a single
   capitalization change. Symbols are now uppercased before hashing.
6. **No emergency stop.** Added `pause()`/`unpause()`, gated to the owner (multisig,
   before real funds are at stake), covering `createToken`, `buy`, and `sell`. Existing
   balances are untouched by a pause — it only blocks new actions.

None of this replaces a real third-party audit before mainnet. It does mean what ships
to an auditor is meaningfully tighter than a first draft.

## Running the tests

Network sandboxing in this environment blocks Hardhat's default compiler downloader, so
contracts are compiled with the `solc` npm package directly and the tests load the
resulting ABI/bytecode rather than using Hardhat's own compile step:

```
node compile-all.js          # compiles contracts/ + mocks/, writes artifacts-manual/
npx hardhat test --no-compile
```

19 tests currently pass, covering: fixed-supply minting with no reachable mint function,
cooldown enforcement, exact and case-variant symbol collisions, creation fee collection,
per-token fee/threshold snapshotting (including the retroactive-change test above),
the fee hard cap and its owner-only gate, buy/sell price movement, the rounding-safety
round-trip check, slippage protection, pause behavior, and three graduation scenarios
(success, broken-router zero-liquidity revert, and no-router-set revert).

On a real machine with normal network access, `npx hardhat test` alone would work fine
without the manual compile step — this workaround is specific to this sandboxed
environment.

## What's here

- **`contracts/ArcLaunchToken.sol`** — the ERC20 deployed per launch. Fixed supply,
  minted once in the constructor, no `mint()` function exists in the contract at all.
  Records the creator's address on-chain so launch history is queryable directly from
  the chain, not from a backend you control (and could quietly edit).
- **`contracts/ArcLaunchFactory.sol`** — everything else: token creation, the bonding
  curve (buy/sell), graduation to a DEX, fees, the anti-spam guards, and the pause switch.
- **`contracts/interfaces/IDEXRouter.sol`** — minimal interface for the graduation step.
  No DEX has been publicly confirmed as an Arc launch partner yet — `router` is unset
  until you call `setRouter()` with a real, verified address.
- **`contracts/mocks/`** — `MockUSDC` (mintable test stand-in), `MockRouter` (simulates
  a working DEX router), `MockBrokenRouter` (simulates one that fails silently) — test
  infrastructure only, never deploy these anywhere real.
- **`test/ArcLaunchFactory.test.js`** — 19 tests running against actual contract
  execution on a local EVM, not just a compile check.

## The two features this build has that a vanilla clone wouldn't

1. **Per-wallet launch cooldown + on-chain symbol uniqueness.** This is a direct
   response to what actually killed Noxa.fi on Robinhood Chain — not a hypothetical
   risk, a thing that already happened: 60,000+ launches in ~10 days, bot spam and
   copycat tokens flooding faster than moderation could keep up. `launchCooldown`
   (default 1 hour) and the on-chain `symbolTaken` mapping block the cheapest version
   of that. Note: this only stops *exact* symbol reuse and *rate*, not fuzzy near-copies
   ("CASHCAT" vs "CASHCATT") — that detection belongs in your off-chain indexer feeding
   the discovery UI, where string-similarity checks are actually practical.
2. **LP burned at graduation, by the contract, automatically.** Not a team promise to
   lock liquidity "soon" — by the time `_graduate()` finishes, the LP tokens are at
   `0x000...dEaD` and there is no function anywhere in this contract that can move them
   back out. Anyone can verify this by reading the code instead of trusting an announcement.

## Parameters you need to actually decide (currently illustrative placeholders)

| Constant | Current value | Notes |
|---|---|---|
| `CURVE_TOKEN_SUPPLY` / `LP_TOKEN_RESERVE` | 800M / 200M | 80/20 split sold-via-curve vs. reserved-for-DEX |
| `INITIAL_VIRTUAL_TOKEN_RESERVES` / `INITIAL_VIRTUAL_USDC_RESERVES` | 1.073B / 30,000 USDC | Loosely modeled on Pump.fun's publicly documented curve shape, translated to USDC — not verified against any Arc-specific decision |
| `graduationThresholdUsdc` | 69,000 USDC | Owner-adjustable via `setGraduationThreshold` |
| `buyFeeBps` / `sellFeeBps` | 1% / 1%, hard-capped at 10% (`MAX_FEE_BPS`) | Owner can't raise fees above the cap even if compromised |
| `creationFeeUsdc` | 5 USDC | Your primary anti-spam economic lever alongside the cooldown |

None of these are "correct" — they're a reasonable starting point to argue with, not a
spec. Assumes USDC uses 6 decimals, matching standard USDC across chains.

## What's deliberately NOT in this build yet

- **No third-party audit.** The self-review above catches real issues, but it is not a
  substitute for one. Get a real audit before this touches a mainnet with real USDC,
  full stop.
- **No confirmed router.** `setRouter()` is a no-op placeholder until an Arc DEX is
  actually live and verified.
- **No fuzzy-match anti-copycat, no off-chain indexer, no discovery feed, no reputation
  scoring layer.** This is the trading engine only — Launch Health Score and the
  discovery UI are separate pieces we haven't built yet.
- **Owner is a single address right now.** `pause()`, `setRouter()`, `setDefaultFees()`,
  and `setTreasury()` are all owner-gated — before any real money is at stake, `owner`
  needs to be transferred to a multisig, not left on a single EOA.
- **No deployment scripts yet.** Contracts are proven on a local test EVM; actually
  deploying to Arc testnet (with real testnet USDC from `faucet.circle.com`) is the
  next concrete step.

## Deploying to Arc testnet

1. Get testnet USDC from Circle's official faucet: `https://faucet.circle.com`
2. Point your deploy script (Foundry/Hardhat — not included here, ask if you want one
   scaffolded) at the Arc testnet RPC.
3. Deploy `ArcLaunchFactory` with `usdc_` = the testnet USDC token address and
   `treasury_` = your treasury wallet.
4. Leave `router` unset until a real DEX is confirmed — `createToken()` and trading
   both work fine pre-graduation without it; only `_graduate()` needs it, and it will
   revert safely (not silently) if called before `setRouter()`.

## Honest caveat

This gets you a working, testable curve on testnet. It does not manufacture retail
demand on Arc, and testnet activity doesn't carry over to mainnet as any kind of
reserved "position" — mainnet is a fresh deployment, fresh state, fresh users. What
building this now actually buys you: contracts that are debugged and ready to redeploy
the moment a real mainnet date drops, instead of starting from a blank file at T+0.
