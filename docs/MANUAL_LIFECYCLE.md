# Manual 2 USDC lifecycle rehearsal

Working directory: `C:\dev\arc-launch`, branch `ballista-migration`.
Prepared 14 September 2026. No mainnet transaction was run during preparation.

## Setup

Open PowerShell and run once:

```powershell
Set-Location -LiteralPath 'C:\dev\arc-launch'
```

The existing root `.env`/environment must contain `ARC_MAINNET_RPC_URL` and
`MAINNET_DEPLOYER_PRIVATE_KEY`, as configured in `hardhat.config.js:24-25`.
Use the existing dedicated key; do not paste it into commands or return it in output.
The task requires live chain 5042 and signer `0x0162C048740aF730c3a20F18A1B8E7B505198cFE`.
It uses the current compiled artifacts without compiling or modifying contracts.

The opt-in config is `manual-lifecycle.config.js:4`; the implementation is
`scripts/manual-lifecycle.js`. Every write checks the stack bindings, estimates gas,
and prints a receipt with `hash`, `blockNumber`, `status`, `gasUsed`,
`effectiveGasPriceWei`, `costUsdc`, and named factory/adapter/hook events.
50 gwei is a maximum fee cap. 0.30 USDC is the cumulative gas budget guard, not a forecast;
it retains at least 0.20 USDC after the current input plus maximum gas charge.
The crossing buy receives at least a 1.5M gas limit to avoid an estimator accepting a
cheap parked-graduation path. Unused gas is not charged (`scripts/manual-lifecycle.js:127`).

All state and public receipts are saved to `deployments/manual-lifecycle.json`.
The journal contains no key or signed transaction bytes. Do not delete or reset it to
retry a command. It saves the transaction hash before broadcasting; an ambiguous RPC
failure causes a stop, not another send. Rerunning a completed step recovers its receipt.
If a process is forcibly killed and leaves a `.lock`, first check that no task is still
running and resolve its saved transaction hash before removing only that lock.

## 1. Set threshold — one transaction, or no-op if already 2 USDC

```powershell
npx --no-install hardhat --config .\manual-lifecycle.config.js --network arcMainnet rehearsal --step threshold
```

Success: receipt status 1 and threshold readback `{ raw: 2000000, usdc: "2.000000" }`.
Send back the receipt and `threshold` block. A no-op has zero new gas.
This changes the default for future tokens; creation snapshots it permanently
(`contracts/LFX1.sol:352`, `contracts/LFX1.sol:818`).
The task does not restore the 8,000 USDC default afterwards; this is the disposable factory.

## 2. Approve USDC — one transaction, or no-op if already exact

```powershell
npx --no-install hardhat --config .\manual-lifecycle.config.js --network arcMainnet rehearsal --step approve
```

Success: allowance readback `2600000` raw USDC to the specified factory.
This covers the live-checked 0.50 creation fee and up to 2.10 for the crossing buy;
it is not an unlimited approval. Send back the receipt and `approve` block.
After the quoted fresh-curve buy, a small unused allowance remains.

## 3. Create token — one transaction

```powershell
npx --no-install hardhat --config .\manual-lifecycle.config.js --network arcMainnet rehearsal --step create
```

Success: `TokenCreated`, a saved token address, and token threshold readback `2000000`.
The task chooses a unique `Ballista Lifecycle <suffix>` / `LIFE<suffix>` name and symbol,
empty metadata URI, `poolBoost=false`, and reads a fresh economics hash immediately before
creation. It does not hide a second approval in this step.
Send back `createPlan`, the receipt, and the `create` block.
Source: `contracts/LFX1.sol:301`, `contracts/LFX1.sol:313`, `contracts/LFX1.sol:322`.

## 4. Cross threshold — one buy, with automatic graduation attempt inside it

```powershell
npx --no-install hardhat --config .\manual-lifecycle.config.js --network arcMainnet rehearsal --step buy
```

Wait until the token's snipe-tax table has elapsed. If the task says the window is open,
wait and rerun; nothing was sent. It uses pinned-block `quoteBuy` calls and a binary search
for the lowest offered input whose quoted reserve credit reaches the threshold, capped at
2.10 USDC. It verifies the immediately smaller input does not cross. No curve formula is
reimplemented (`scripts/manual-lifecycle.js:41`; `contracts/LFX1.sol:698`).

For an untouched 1% fee curve, the offline real-contract quote yielded 2.020202 USDC input,
0.020202 fee and 2.000000 reserve credit. This is an example, not a fixed live input.
The task uses 0.5% token-output slippage and rechecks reserves after the search.
Concurrent trades can still change state before inclusion; inspect the actual readback.

Success has TWO possible results; status 1 alone does not prove graduation:
- `GRADUATED`: `GraduationReady`, `PoolRegistered`, `PoolSeeded`, and `Graduated`.
- `GRADUATION_READY`: `GraduationReady` and `GraduationAttemptFailed`; reserves remain parked.
If it remains ACTIVE or any read fails, stop and send the output. Do not continue into swaps.
Source: `contracts/LFX1.sol:442`, `contracts/LFX1.sol:462`, `contracts/LFX1.sol:675`.

Send back `buyQuote`, the buy receipt, and `readback`, including the events and gas.

## 5. Independent readback — no transaction, no gas

```powershell
npx --no-install hardhat --config .\manual-lifecycle.config.js --network arcMainnet rehearsal --step read
```

Send back the complete `readback` block, or the public `deployments/manual-lifecycle.json`.
It reports:
- curve state and reserves;
- expected pool id even when parked; a registered pool and observed slot0 when graduated;
- current sqrtPriceX96/tick and USDC per whole token, accounting for currency ordering;
- the `PoolSeeded` position id, liquidity, recipient and live NFT owner;
- this graduation's offered-minus-consumed dust, plus absolute adapter token/USDC balances
  (the shared adapter's USDC balance may also contain prior pools' dust);
- factory token balance, hook registration, pending fees and both recipients' credits;
- crossing receipt gas, price and USDC cost.

Expected LP owner is the token's `lpRecipient`, checked against the live position owner;
inspect the printed address rather than assuming a burn address. The adapter verifies
owner and liquidity itself (`contracts/BallistaV4Adapter.sol:300`, `contracts/BallistaV4Adapter.sol:303`).

Graduation occurs inside the crossing buy, not as a second transaction. The task attempts
`debug_traceTransaction` with `callTracer` and reports adapter `addLiquidity` subcall gas
separately if available. That subcall excludes factory setup/cleanup. If tracing is unsupported,
separate graduation gas is explicitly unknown; never substitute the Base measurement or
charge the buy receipt twice (`scripts/manual-lifecycle.js:186`).

## After graduation has been reviewed and confirmed

Do not run these when parked. Each command independently requires GRADUATED, nonzero
position liquidity, matching owner, and hook registration, plus the operator flag.
The exact-input swaps use Uniswap's Arc Universal Router 2.1.1, a live v4 Quoter quote,
0.5% output slippage, and a five-minute deadline. A full-router eth_call must succeed before
submitting the swap. Each swap command can send TWO exact-amount approvals plus ONE swap:
ERC-20 -> Permit2, then Permit2 -> router (30-minute expiry), then execute. Every receipt
is printed and journaled separately. Unneeded approvals are skipped.

### 6. Pool buy: 0.10 USDC -> launch token

```powershell
npx --no-install hardhat --config .\manual-lifecycle.config.js --network arcMainnet rehearsal --step pool-buy --graduation-confirmed
```

Success: swap status 1, positive received tokens and hook `FeeAccrued` in launch tokens.
Send all approval/swap receipts, `pool-buyQuote`, and `pool-buyAfter`.
The reverse-swap amount comes from this receipt's actual token Transfer logs, not a quote
and not the original curve-buy balance (`scripts/manual-lifecycle.js:63`).
If a timeout occurred after submission, rerun this same command to recover that amount.

### 7. Pool sell: those received tokens -> USDC

```powershell
npx --no-install hardhat --config .\manual-lifecycle.config.js --network arcMainnet rehearsal --step pool-sell --graduation-confirmed
```

Success: swap status 1 and hook `FeeAccrued` in USDC.
Send all approval/swap receipts, `pool-sellQuote`, and `pool-sellAfter`.
The native USDC balance also pays gas, so its wallet delta alone is not the swap payout.
`FeeAccrued` gives pool gross deltas and the fee; net output is positive gross output minus fee.
The hook takes 1% of the unspecified side, hence output currency on these exact-input swaps
(`contracts/BallistaFeeHook.sol:266`, `contracts/BallistaFeeHook.sol:273`, `contracts/BallistaFeeHook.sol:326`).

### 8. Sweep — one transaction, credits escrow; no payout yet

```powershell
npx --no-install hardhat --config .\manual-lifecycle.config.js --network arcMainnet rehearsal --step sweep --graduation-confirmed
```

Success: `FeesSwept`, pending buckets zero, credited USDC/token amounts for both recipients.
Split is 50/50; any odd raw unit goes to the creator. Send `beforeSweep`, receipt with
`FeesSwept`, and `afterSweep` (`contracts/BallistaFeeHook.sol:348`).

### 9. Claim creator USDC — one transaction

```powershell
npx --no-install hardhat --config .\manual-lifecycle.config.js --network arcMainnet rehearsal --step claim-usdc --graduation-confirmed
```

Success: `Claimed` naming the deployer and USDC, with remaining creator USDC owed zero.
Send the receipt and `claim-usdc` block. `Claimed.amount` is gross payout; gas is reported
separately (`contracts/BallistaFeeHook.sol:380`). If nothing is owed, no transaction is sent.

### 10. Claim creator token — one transaction

```powershell
npx --no-install hardhat --config .\manual-lifecycle.config.js --network arcMainnet rehearsal --step claim-token --graduation-confirmed
```

Success: `Claimed` naming the deployer and launch token, with remaining creator token owed zero.
Send the receipt and `claim-token` block (`contracts/BallistaFeeHook.sol:388`).

These are the creator's TWO hook claims. They do not claim factory curve fees, nor the
protocol recipient's credits. The latter remain owed to `0x64140E...B4cb`; that recipient
must separately call its own `claim()` and `claimToken(token)` because the hook pays
`msg.sender`. The task never changes recipient or uses the testnet/protocol key.

## Sources and verification

- Arc router: https://raw.githubusercontent.com/Uniswap/sdks/main/sdks/universal-router-sdk/src/utils/constants.ts (5042 / V2_1_1).
- Arc reader addresses: https://raw.githubusercontent.com/Uniswap/sdks/main/sdks/sdk-core/src/addresses.ts (ARC_ADDRESSES).
- Correct UR 2.1.1 struct: https://raw.githubusercontent.com/Uniswap/sdks/main/sdks/v4-sdk/src/utils/v4Planner.ts (SWAP_EXACT_IN_SINGLE_STRUCT_V2_1_1, includes minHopPriceX36).
- Repo action and quote interfaces: node_modules/@uniswap/v4-periphery/src/libraries/Actions.sol; src/interfaces/IV4Quoter.sol.

Seven offline checks passed: actual LFX1 quote boundary, insufficient budget, already-crossed
reserve, both currency orderings/directions and UR encoding, v4 price conversion, receipt
transfer recovery, and network guard. Eight deliberate mutations were caught under
`scripts/mutation_lease.py`; task bytes were restored exactly and the lease released.

```powershell
node .\node_modules\hardhat\internal\cli\cli.js --config .\test\manual-lifecycle.config.js test --no-compile .\test\ManualLifecycle.test.js
```

These checks do not establish live Arc graduation or router compatibility. The manual
commands perform live checks and stop on RPC, binding, quote, or simulation failure.
