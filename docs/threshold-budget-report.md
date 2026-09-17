# Read-only threshold budget — 2026-09-14

## Result and limits
Recommended budget candidate: 2.000000 USDC (2_000_000 raw).
This is not a verified absolute minimum, nor a verified live v4 graduation.
LFX1.setDefaultGraduationThreshold has no lower-bound check (C:/dev/arc-launch/contracts/LFX1.sol:818-820).
A smaller positive threshold is configurable; successful minimum v4 mint was not measured.
No mainnet transaction was submitted, no key loaded, no mainnet gas spent.

## Live read-only RPC evidence
Endpoint: https://rpc.arc-scan.org (repo provenance CLAUDE.md:6923).
eth_chainId: 0x13b2 (5042); sampled eth_blockNumber: 0x13d94ef.
USDC.balanceOf(0x0162C048740aF730c3a20F18A1B8E7B505198cFE): 3314740 (3.314740 USDC).
Factory: 0x1629a7449f5F799eE0Ac04313a1A61D9FF43eA7f.
creationFeeUsdc: 500000; defaultGraduationThresholdUsdc: 8000000000.
defaultBuyFeeBps: 100; defaultSellFeeBps: 100; activeSnipeTaxTableVersion: 0.
eth_gasPrice: 0x4a817c801 (20,000,000,001 wei).
eth_getBalance, owner and router reads returned HTTP 503; no result inferred.

## Local quote evidence
Script: budget-readonly.cjs, using existing compiled LFX1 artifact in C:/dev/arc-launch.
Ephemeral Hardhat network, MockUSDC, placeholder router; not an Arc fork.
Fresh token, poolBoost=false, 30-second wait before buying; fees 1% each.
quoteBuy(100000): actualUsdcIn=100000, actualFee=1000, tokensOut=39902905741406674442905.
quoteSell(all those tokens): usdcOutGross=98999, fee=989; net return=98010.
Buy/sell loss=1990 raw (0.001990 USDC); no fee claims credited to budget.
After selling, quoteBuy(2020202): actualUsdcIn=2020202, actualFee=20202.
Final quote credits 2000000 raw reserves; previous round trip leaves 1 raw reserve.
Balance after creation, round trip and final quoted buy, before gas: 0.792548 USDC.
Quote functions used directly; no curve formula reimplementation.

## Gas
No live transactions: actual mainnet gas used=0; actual cost=0 USDC.
Local simulated receipts (gas units; not live Arc estimates):
- MockUSDC deploy 521411; local factory deploy 5608622; local mock funding 68385. Setup only, excluded from lifecycle budget.
- Threshold setter 30021; USDC approval 46335; create 1068946.
- First buy 175331; token approval 46463; sell 102488.
- Final buy with v4 graduation: not simulated; gas unknown.
Planning allowance: 0.300000 USDC total gas, equivalent to 6000000 gas at a 50-gwei maximum fee.
That allowance is a budget assumption, not an estimate or assurance that graduation fits.
Residual headroom after that gas allowance: 0.492548 USDC.
Budget uses 3.314740 truncated ERC-20 balance; it does not double count native USDC as separate funds.
A failed or parked graduation is not a completed lifecycle (LFX1.sol:462-466).
