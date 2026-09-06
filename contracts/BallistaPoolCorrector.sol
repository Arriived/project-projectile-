// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";

// Puts a poisoned EMPTY v4 pool back to its intended price, in one permissionless call.
//
// WHY THIS EXISTS. CLAUDE.md §16.1 (F1): PoolManager.initialize checks tickSpacing,
// currency ordering and hook validity and NOTHING else -- there is no check that either
// currency is a contract (v4-core/src/PoolManager.sol:117, guards at 119-126). LFX1 tokens
// come from plain CREATE, so their addresses are keccak(rlp([factory, nonce])) and
// predictable (§12.4). An attacker can therefore pre-initialise the pool for every token a
// factory will ever create, at a hostile price, before any of them exist -- 51,508 gas
// each, no capital, no race.
//
// The adapter refuses such a pool and parks the curve at GRADUATION_READY with reserves
// intact, which is correct and is §15.3's strict-min substitute doing its job. But while
// parked, BOTH sides of the curve are closed (§1.4): holders are frozen and nobody can even
// buy the token to fund a correction. Recovery is permissionless and profitable, but it is
// not automatic -- someone external has to notice and construct an arbitrage. This turns
// that into a single call anyone can send.
//
// ⚠ THIS IS NOT IN THE GRADUATION PATH. The adapter is unmodified and still reverts on a
// mispriced pool exactly as before. Nothing here can make a graduation succeed that would
// otherwise have failed; it only makes putting the pool back cheap and obvious.
//
// ═══════════════════════════════════════════════════════════════════════════════════════
// ⚠ THE SAFETY ARGUMENT IS THE ABSENCE OF A SETTLE PATH. DO NOT ADD ONE.
// ═══════════════════════════════════════════════════════════════════════════════════════
//
// This contract holds no funds, has no approvals, and contains no code that can pay the
// PoolManager anything. That is not an oversight -- it is the entire enforcement mechanism,
// and it is what restricts this to empty pools without any check that could be wrong:
//
//   * An EMPTY pool has no liquidity to trade against. v4's swap consumes nothing and walks
//     the price straight to sqrtPriceLimitX96, so every currency delta is zero and unlock
//     returns cleanly.
//   * A pool WITH liquidity produces a non-zero delta, and PoolManager.unlock reverts it
//     with CurrencyNotSettled (v4-core/src/PoolManager.sol:112) before anything settles.
//
// ⚠ DO NOT "FIX" THIS BY CHECKING getLiquidity INSTEAD. That reports only the liquidity
// IN RANGE at the current price, and a corrective swap can cross into out-of-range
// positions -- so the check would pass and the swap would then trade against liquidity it
// never saw. The delta is exact where a liquidity read is not.
//
// ⚠ AND DO NOT ADD A SETTLE PATH TO "SUPPORT" LIQUID POOLS. Correcting a pool that holds
// liquidity is profitable arbitrage, but it costs real money, the amount is chosen by
// whoever seeded the liquidity, and in a public mempool the trade can be sandwiched. §16's
// design report weighed exactly that and declined it. A settle path here would let this
// contract pay for such a correction out of whatever it was holding, which is the unbounded
// attacker-sized trade that analysis rejected.
//
// OWNERLESS. No owner, no withdraw, no upgrade, no pause, no rescue. Anything transferred
// to this address is permanently stranded -- harmless, because there is no path that could
// spend it, which is the same property that makes the contract safe in the first place.
contract BallistaPoolCorrector is IUnlockCallback {
    using StateLibrary for IPoolManager;

    IPoolManager public immutable poolManager;

    error NotPoolManager(address caller);
    error PoolNotInitialized();

    event PoolCorrected(
        PoolId indexed poolId, uint160 fromSqrtPriceX96, uint160 toSqrtPriceX96, address indexed caller
    );

    constructor(IPoolManager poolManager_) {
        poolManager = poolManager_;
    }

    // Move `key`'s pool to `targetSqrtPriceX96`. Returns false if it was already there.
    //
    // ⚠ THE CALLER SUPPLIES THE TARGET, AND THIS CONTRACT DELIBERATELY CONTAINS NO PRICE
    // MATH. The target is derived from the amounts LFX1 will hand the adapter --
    // LP_TOKEN_RESERVE + tokenReserves against realUsdcReserves + poolBoost, all readable
    // from LFX1.curves(token) -- so it could have been computed here. It is not, for three
    // reasons:
    //
    //   1. Computing it would put a SECOND on-chain copy of the adapter's price derivation
    //      in the repo, free to drift from the first. That is CLAUDE.md §14.2.1's failure
    //      exactly: verify:theme checked one copy of the palette while a third drifted.
    //      One implementation, off-chain callers, nothing to diverge.
    //   2. It would couple this contract to LFX1's interface and to the adapter's PoolKey
    //      constants, so it would serve only LFX1 curves under one adapter version. As
    //      written it corrects any empty pool, including phase-2 hooked pools and any
    //      future factory.
    //   3. It grants an attacker nothing. Anyone can already initialise a pool for 51,508
    //      gas and swap an empty pool for free, so "move an empty pool to an arbitrary
    //      price" is a capability the chain hands out regardless of this contract.
    //
    // What a hostile caller achieves is therefore a REPEAT of the poisoning, not a new
    // attack: the adapter's own equality check still decides what price is acceptable and
    // still refuses anything else (§15.3), the curve stays parked with reserves intact, and
    // the next caller corrects it again. The authority on "what price is right" stays in
    // exactly one place, which is the adapter.
    function correct(PoolKey calldata key, uint160 targetSqrtPriceX96) external returns (bool moved) {
        (uint160 current,,,) = poolManager.getSlot0(key.toId());

        // Mirrors v4's own sentinel: an uninitialised pool has sqrtPriceX96 == 0
        // (v4-core/src/libraries/Pool.sol:101). Checked here so the failure is named
        // rather than surfacing from inside the swap.
        if (current == 0) revert PoolNotInitialized();

        // Already correct. A no-op rather than a revert, because a corrector that reverts
        // when there is nothing to do makes every caller race every other caller: two
        // people who both notice the same poisoned pool would have one of them fail. It
        // also means v4's PriceLimitAlreadyExceeded (Pool.sol:324, :333) is unreachable
        // from here -- a swap whose limit is the price it is already at reverts.
        if (current == targetSqrtPriceX96) return false;

        poolManager.unlock(abi.encode(key, targetSqrtPriceX96));

        emit PoolCorrected(key.toId(), current, targetSqrtPriceX96, msg.sender);
        return true;
    }

    function unlockCallback(bytes calldata data) external override returns (bytes memory) {
        // Only the PoolManager, and only re-entering our own unlock above. Without this,
        // anyone could drive the swap below with arbitrary parameters -- still unable to
        // move value, since there is no settle path, but able to move an arbitrary pool's
        // price while wearing this contract's identity.
        if (msg.sender != address(poolManager)) revert NotPoolManager(msg.sender);

        (PoolKey memory key, uint160 target) = abi.decode(data, (PoolKey, uint160));
        (uint160 current,,,) = poolManager.getSlot0(key.toId());

        // ⚠ THE PRICE LIMIT DOES THE WORK; amountSpecified IS IRRELEVANT. One wei of exact
        // input is enough, because the swap stops when the price reaches the limit rather
        // than when the input is exhausted. One wei is also the SAFEST value: against a
        // pool that unexpectedly holds liquidity it moves the price a negligible distance
        // before the unsettled delta reverts the whole thing.
        poolManager.swap(
            key,
            SwapParams({
                zeroForOne: target < current,
                amountSpecified: -1,
                sqrtPriceLimitX96: target
            }),
            ""
        );

        // ⚠ NOTHING IS SETTLED HERE, AND THAT IS THE POINT. See the header. If the swap
        // above moved any value, PoolManager.unlock reverts on CurrencyNotSettled and this
        // call never happened. Adding a settle path removes the only thing restricting this
        // contract to empty pools.
        return "";
    }
}
