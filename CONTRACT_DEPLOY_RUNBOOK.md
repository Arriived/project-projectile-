# Contract deployment runbook — Arc mainnet

**Status: written 10 September 2026. Never executed.** §12.8 item 2 has asked for this
since 4 September; until now there was no path to mainnet from this repo at all.

`app/DEPLOY.md` covers the frontend and `indexer/RUNBOOK.md` the indexer. **This one covers
the contracts, and nothing here is interchangeable with either.**

---

## 0. What is being deployed, and the one thing to understand first

Three contracts, deployed in one sitting, across **three consecutive nonces**:

| | | |
|---|---|---|
| `BallistaFeeHook` | CREATE2, at a **mined** address | 8,153 bytes runtime |
| `BallistaV4Adapter` | CREATE, nonce *n+1* | 7,205 bytes runtime |
| `LFX1` | CREATE, nonce *n+2* | 24,033 bytes runtime — **frozen, unchanged since `38e3e9e`** |

⚠ **THEY FORM A CYCLE AND ALL THREE ARE IMMUTABLE.** The adapter holds the hook's address
(a `PoolKey` member) and LFX1's (its caller gate); the hook holds the adapter's (its gate)
and LFX1's (to read the creator); LFX1 holds the adapter's (as `initialRouter_`). **Nothing
can be corrected after deployment.** Replacing any one means replacing all three and
starting new pools — a different hook is a different `PoolId` (`PoolId.sol:14` hashes all
five key slots) and burned liquidity can never migrate.

⚠ **A MIS-BOUND STACK DEPLOYS CLEANLY.** Nothing reverts. Nothing logs. The first symptom
is every graduation reverting inside `beforeInitialize`, with every token parked at
`GRADUATION_READY` for ever. **Step 6 exists to catch that while nothing is at risk.**

Pons resolves this same cycle with an owner-gated one-time setter and can repair a wrong
wiring with one transaction. We chose ownerlessness, so **we cannot**, and the nonce
discipline in §1 is what stands in for that owner.

---

## 1. The key

**Generate a fresh, dedicated mainnet deployment key. Do not reuse the testnet deployer.**

`0x64140EAa0a3B6E4682C98e440837bd3d5482B4cb` is at **nonce 237** and has signed
deployments, parameter changes and test trades. It cannot carry a nonce prediction.

```bash
# Generate. Do this offline, on the machine that will sign.
node -e "const w=require('ethers').Wallet.createRandom(); console.log(w.address); console.log(w.privateKey)"
```

Put the private key in `MAINNET_DEPLOYER_PRIVATE_KEY` in `.env` — which `.gitignore`
already covers via `.env*` plus `!.env.example` (§12.7, closed).

### ⚠ THE STANDING RULE, AND IT IS ABSOLUTE

> **This key signs the three deployment transactions and nothing else. Ever.**
>
> Not a test transaction. Not a token approval. Not a "let me just check the RPC works".
> Not a gas top-up sent *from* it. Nothing.

The hook's mined salt embeds the adapter's and LFX1's addresses, both **predicted from this
key's nonce**. One stray transaction between steps shifts every later nonce, the salt no
longer lands on a flag-carrying address, and — because a hook's permissions **are** its
address — you get a hook whose `afterSwap` is never invoked. It deploys, registers pools,
emits its registration event, and charges nothing, for ever.

Steps 4 and 5 re-read the pending nonce and **abort** rather than continue. That is a
backstop, not a licence to be casual with the key.

⚠ Turn off any wallet, bot, monitor or IDE plugin that might broadcast from this address.
Use it from one machine, in one session.

---

## 2. Funding

### The stack itself is trivial

Measured — LFX1 on Arc mainnet by direct `eth_estimateGas`, the other two on a pinned Base
fork (§20.2, §20.18):

| | gas | at Arc's 20 gwei floor |
|---|---|---|
| `LFX1` | **5,653,867** (Arc mainnet, measured) | **0.113 USDC** |
| hook, via CREATE2 | ~1,860,452 | ~0.037 USDC |
| adapter | ~1,500,000 (intrinsic floor for 7,205 bytes; not directly estimable — see below) | ~0.030 USDC |
| **total** | **~9.0M** | **~0.18 USDC** |

⚠ **The adapter cannot be gas-estimated before the hook exists**, because its constructor
calls `hook.adapter()` to verify the binding and a call to a codeless address returns empty.
That is the binding check working, not a defect. `scripts/deploy-v4-stack.js` reports it as
"not estimable in plan mode" and continues.

**Fund the key with 5 USDC.** That is ~25x the stack cost and leaves room for a failed
attempt, a re-mine, and the post-deploy reads.

### The real funding line is the throwaway's trading capital

⚠ **THE OFTEN-QUOTED "~54.2 USDC FLOOR" ON THE GRADUATION THRESHOLD IS STALE. Do not size
funding from it.** It came from the `2**64` ratio bound, which §15.4 records as **fixed** by
the wide branch. The live constants are `MAX_PRECISE_RATIO = 1 << 63` and
`MAX_AMOUNT_RATIO = 1 << 191` (`BallistaV4Adapter.sol:78-79`), putting the arithmetic floor
at ~3e-37 USDC, with v4's own `MIN_SQRT_PRICE` binding at ~3e-18. **A 10 USDC threshold is
exercised and passing** (`V4AdapterMath` M8).

**Throwaway threshold: 10 USDC.** Fund the test wallet with **50 USDC** — enough to cross a
10 USDC threshold with fees and gas, run several swaps to exercise the hook, and sweep and
claim, with margin.

---

## 3. Parameters

### Constructor arguments, in order

```
LFX1              (address usdc_, address treasury_, address initialRouter_)
BallistaFeeHook   (address poolManager_, address lfx1_, address usdc_, address protocolRecipient_, address adapter_)
BallistaV4Adapter (address poolManager_, address positionManager_, address permit2_, address lfx1_, address hook_)
```

⚠ **ORDER IS LOAD-BEARING AND THE TRAP IS SPECIFIC:** `adapter_` is **last** on the hook,
`hook_` is **last** on the adapter. `scripts/mine-hook-salt.js` appends the predicted
adapter as the final constructor argument by convention. **Reordering either constructor
changes the initcode and silently invalidates every mined salt** — and "silently" is exact:
the deployment still succeeds, at a different address, with the wrong flags.

### Addresses to supply

| | value | provenance |
|---|---|---|
| chain id | **5042** | measured on chain, `0x13b2` (§20.4) |
| USDC | `0x3600000000000000000000000000000000000000` | Circle; 1,798 bytes measured |
| v4 PoolManager | `0x8366a39cc670b4001a1121b8f6a443a643e40951` | 24,009 bytes; owner `0x33f2…51e8` |
| v4 PositionManager | `0x6049c9a0e26405c0985f9e3685c87d0ae917f82b` | 23,877 bytes; slot0 = `"Uniswap v4 Positions NFT"` |
| Permit2 | `0x000000000022D473030F116dDEE9F6B43aC78BA3` | 9,152 bytes |
| CREATE2 deployer | `0x4e59b44847b379578588920cA78FbF26c0B4956C` | 69 bytes, canonical |
| treasury / protocol recipient | **operator to supply** | — |

⚠ **`ARC_MAINNET_RPC_URL` must come from Circle directly or a Circle-named provider.** Not
a search result, not a chain-list aggregator. §9.5 already found the documented host and an
undocumented alias both answer; an RPC that responds is not evidence it is the right one.

### `initialRouter_` — the deliberate flag

**Decision: `initialRouter_` = the deployed adapter.** Pass `--bootstrap-router`.

⚠ **This spends the constructor's one untimelocked router activation**
(`LFX1.sol:216-221`). It exists once per factory and every later router must pass a public
`RouterProposed` and a full 24 hours.

**Why this reverses the earlier "clean hands" position:** that argument assumed a
**hookless** adapter, where bootstrapping would permanently forfeit fee capture on
everything graduated before a switch (§18.4). That is no longer the case — the adapter is
hook-bound, and its constructor rejects a zero hook, wrong flag bits, and a hook not bound
back to itself. **Nothing is forfeited by activating at block zero**, and 24 hours of an
inert factory on Arc's opening day is a real cost against one first impression.

Without the flag the script defaults to `address(0)`, `createToken` reverts `RouterNotSet`
(`LFX1.sol:310`), and the only route to a live router is `proposeRouter` + 24h. **The
untimelocked path is always an explicit flag, never a default.**

---

## 4. Pre-flight, and its abort conditions

```bash
node scripts/deploy-v4-stack.js \
  --poolManager <..> --positionManager <..> --permit2 <..> \
  --usdc 0x3600000000000000000000000000000000000000 \
  --treasury <..> --bootstrap-router
```

**Plan mode. It sends nothing.** Every address, nonce, salt and gas figure below is
computed before a single transaction exists.

### ⚠ A CONTROL CANNOT BE A SUBJECT

The probe reads **three known-good addresses first** — USDC, the CREATE2 deployer,
Multicall3 — and aborts if fewer than three return code, because *a probe that returns empty
for everything proves nothing* (§10, §12.8).

⚠ **This bit on the first run.** The first version used PoolManager as both a control and a
subject, so on a chain with no v4 it reported "the probe is broken" when the probe was fine
and the absence was real. Controls must be independent of anything under test.

### Abort on any of these

- fewer than three controls return code → **the probe is broken; fix it, do not proceed**
- PoolManager, PositionManager or Permit2 returns 0 bytes → **v4 is not there; go to §10**
- the mined address does not decode to **exactly** `BEFORE_INITIALIZE + AFTER_SWAP + AFTER_SWAP_RETURNS_DELTA` (`address & 0x3FFF == 0x2044`)
- the pending nonce is not what step 4 or 5 expects

---

## 5. The deploy sequence

```bash
node scripts/deploy-v4-stack.js <same args> --bootstrap-router --execute
```

| step | action | gate |
|---|---|---|
| 1 | predict adapter at *n+1* and LFX1 at *n+2* | — |
| 2 | mine the salt against **real** initcode embedding both | flags must decode to exactly `0x2044` |
| 3 | CREATE2 the hook (nonce *n*) | code must be present at the mined address |
| 4 | **re-read pending nonce**, then deploy the adapter | **abort** unless nonce == *n+1*; address must equal the prediction |
| 5 | **re-read pending nonce**, then deploy LFX1 | **abort** unless nonce == *n+2*; address must equal the prediction |
| 6 | read the binding back | **hard stop** on any mismatch |

⚠ **THE SALT IS VALID FOR ONE `initCodeHash` AND NOTHING ELSE.** Any change to the hook's
source — a comment included — its compiler settings, or any constructor argument produces
different initcode and the salt no longer lands on a flag-carrying address. **Re-mine after
any change. Never carry a salt across an edit.**

If step 4 or 5 aborts on a nonce mismatch: **do not "just deploy and see".** Re-run plan
mode from scratch. The prediction and the salt are both invalid.

---

## 6. The read-back gate — a hard stop, not a check

Seven reads, in both directions:

```
hook.adapter()            == <adapter>
hook.lfx1()               == <LFX1>
hook.usdc()               == 0x3600…0000
hook.protocolRecipient()  == <treasury>
adapter.hook()            == <hook>
adapter.lfx1()            == <LFX1>
lfx1.router()             == <adapter>     (or address(0) without --bootstrap-router)
```

⚠ **If any one fails: STOP. Do not create a token. Do not propose a router. Do not
announce the addresses.** A mis-bound stack is unfixable and the only remedy is to redeploy
all three — which is cheap now and impossible later.

The adapter's own constructor already refuses the common case (it asks the hook who its
adapter is and rejects any answer that is not itself). This gate is what proves the pair in
**both** directions, and it runs while nothing is at risk.

---

## 7. Verification — ⚠ the target is UNSETTLED

```bash
npx hardhat verify --network arcMainnet --contract contracts/LFX1.sol:LFX1 <addr> <ctor args>
```

⚠ **`hardhat.config.js`'s `arcMainnet` verification block is configured for Blockscout
because that is what Arc TESTNET runs. That is an assumption carried across, not a mainnet
fact.**

- **Uniswap's own Arc playbook flags confirming whether Arcscan is Etherscan-compatible or
  Blockscout before deploying.**
- **Circle's contract-addresses page still states mainnet addresses are not yet available**,
  so there is no published mainnet explorer endpoint to copy.

`ARC_MAINNET_EXPLORER_API` and `ARC_MAINNET_EXPLORER_URL` are **named blanks**. Confirm the
shape from Circle or a Circle-named source and fill them in. If Arcscan is
Etherscan-compatible, both the `apiURL` shape and the key requirement change.

⚠ **Getting this wrong is discovered after the bytecode is immutable**, and an unverified
factory undermines the one thing this project sells.

**Licence:** `SPDX-License-Identifier: UNLICENSED`, `license_type: none` on the explorer.
⚠ **Never select `unlicense`** — that is The Unlicense, a public-domain dedication, the
exact opposite (§7, R11).

---

## 8. Post-deploy checks — before any token is created

| check | expected |
|---|---|
| runtime sizes | LFX1 **24,033**, hook 8,153, adapter 7,205 |
| explorer status | `is_fully_verified: true`, `is_changed_bytecode: false`, `license_type: none` for all three |
| `lfx1.owner()` | the deployer |
| `lfx1.treasury()` | the treasury |
| `lfx1.router()` | the adapter |
| `lfx1.renounceOwnership()` | **reverts** (R17) |
| `lfx1.currentEconomicsHash()` | recorded — the frontend pins against it |
| snipe tax table | `[9800, 9500, 9000, 8000, 6000, 4000, 2000, 0]` |
| `symbolLockDuration` / `launchCooldown` | as intended (testnet ran 0 / 5) |
| the seven binding reads | re-run **from a different caller**, in a separate transaction |

⚠ **Re-running the binding reads from a different address is not superstition.** Step 6 ran
inside the deployment script, in the same process that computed the expected values. An
independent read is the only one that cannot be self-confirming.

---

## 9. The private-mainnet / throwaway phase

Per §20.5, before anything real:

1. `eth_getCode` non-empty on PoolManager, PositionManager, Permit2 — **with three
   known-good controls in the same run**.
2. The four hand-transcribed selectors of §15.2 answer **on Arc**, not on Base:
   `0x87517c45`, `0x36c78516` (Permit2) — closed on testnet — and `0xdd46508f`
   `modifyLiquidities`, `0xf7020405` `initializePool` (PositionManager), **which have never
   been probed on any Arc chain**. This closes them or the launch does not proceed.
3. A **full graduation** through the adapter, threshold **10 USDC**: pool initialised at the
   exact derived `sqrtPriceX96`, position minted full-range, LP verifiably at `0x…dEaD`, no
   unaccounted dust left in the factory.
4. A **hooked** graduation, then a swap, then a sweep, then a claim.
5. **Graduation gas measured on Arc**, against the 30,000,000 block limit. §20.12 measured
   **589,993** with the hook wired — on **Base**. Zero8 moved Arc's gas accounting once
   already (§2), so an Arc figure must be measured on Arc.

**Abort:** any of 1–4 failing, or 5 landing anywhere near the block limit.

⚠ **A pass on private mainnet is not a pass on public mainnet.** Re-run probes 1, 2 and 5
on public mainnet before the first real graduation.

---

## 10. The v2 abort branch

If anything in the v4 stack fails, graduation does not need v4 at all. LFX1's frozen
`addLiquidity` is a V2-signature call (§14.1).

| | |
|---|---|
| V2 router | `0x1f7d7550b1b028f7571e69a784071f0205fd2efa` |
| V2 factory | `0x89e5db8b5aa49aa85ac63f691524311aeb649eba` |

### Measured on Arc mainnet

- router **21,902 bytes**; `factory()` returns `0x89e5db8b…49eba` — the pair matches
- factory **13,859 bytes** — byte-for-byte the size of canonical mainnet `UniswapV2Factory`
- `allPairsLength()` = **28**; `createPair` estimates 2,527,631 gas
- ✅ **factory-side init code hash: MATCHED.** `allPairs(0)` = `0x573c4f9c…13b79`, and
  `keccak256(0xff ‖ factory ‖ keccak256(token0,token1) ‖ 96e8ac42…48845f)` reproduces it
  exactly (verified independently from the raw inputs)

### ⚠ THE ROUTER-SIDE PROBE IS THE ONE OUTSTANDING v2 GATE

**The factory match proves the FACTORY deploys pairs with the canonical hash. It does not
prove the ROUTER embeds the same one — and `pairFor` uses the router's copy**
(`UniswapV2Library.sol:18-26`). ⚠ The Arc router is **21,902 bytes against canonical
mainnet's 21,943 — 41 bytes shorter**, which is exactly why this cannot be assumed.

**The probe, zero gas:** search the router's runtime bytecode for
`96e8ac4277198ff8b6f785478aa9a39f403cb768dd02cbee326c3e7da348845f`.

Validated in both directions: present in canonical mainnet Router02 (21,943 bytes); **absent**
in mainnet USDC (2,186 bytes) and absent in the mainnet V2 Factory itself (13,859 bytes) —
both real contracts, so a `false` is a real answer and not an artefact.

⚠ **Absence does not by itself prove failure** — Arc's router may embed a different,
correct-for-Arc hash. It escalates to: recompute `allPairs(0)` using the hash actually found
in the router's bytecode and require it to match. If neither the canonical hash nor any
embedded candidate reproduces `allPairs(0)`, **do not activate the v2 router.**

**Traced failure mode if it is wrong:** `_addLiquidity` (`UniswapV2Router02.sol:45`) calls
`getReserves` → `pairFor` → `.getReserves()` on a codeless address → empty returndata →
decode reverts. That is **before** the two `safeTransferFrom` calls at `:73-74`, so **no
funds move**. LFX1 catches it (`LFX1.sol:655-687`), zeroes both approvals, emits
`GraduationAttemptFailed`, and the curve parks with reserves intact. Loud and recoverable.

### ⚠ WETH is a tripwire on Arc, and `addLiquidity` never touches it

`router.WETH()` returns `0x8bceaa40…17937f` — **53 bytes whose entire runtime reverts with
`0xea3559ef` on any call.** A deliberate poison pill, correct for a chain whose native asset
is USDC.

**Record it in the pre-flight; do not gate on it.** `addLiquidity`
(`UniswapV2Router02.sol:61-76`) touches `factory.getPair`/`createPair`, `getReserves`, the
pure `quote` and `pairFor`, two `safeTransferFrom`, and `pair.mint`. **Zero WETH
references** — `WETH` is first read at `:87`, inside `addLiquidityETH`.

⚠ **NEVER call any `*ETH` router function on Arc.** Every one is fatal.

### Switching to it

`proposeRouter(0x1f7d7550…)` → **24 hours** → `activateRouter(0x1f7d7550…)`. If
`--bootstrap-router` was used for v4, the constructor's untimelocked activation is already
spent and this is the only route — as it is for every router after the first.
