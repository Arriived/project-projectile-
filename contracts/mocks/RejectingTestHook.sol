// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {BaseHook} from "@uniswap/v4-periphery/src/utils/BaseHook.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";

// A hook whose beforeInitialize always refuses. TEST ONLY.
//
// ⚠ WHY THIS EXISTS, AND WHY IT IS ONE FIXTURE RATHER THAN NINE TESTS.
//
// Each of BallistaFeeHook's registration guards is asserted BY NAME on a direct call
// (V4Binding rows 13-21). The other half of that pairing is meant to drive the same
// condition THROUGH graduation and show the parked-curve outcome -- because a guard that
// is never reached on the real path is not protecting anything.
//
// Every one of those conditions is UNREACHABLE through a real graduation. The adapter is
// callable only by LFX1, it always builds fee 0 / tickSpacing 60 / hooks = the hook, it
// always passes a launched token against USDC, and LFX1 always has a curve record with a
// non-zero creator. So there is no graduation that produces a wrong fee, a wrong spacing,
// an unknown curve, a zero creator or a missing USDC side.
//
// What CAN be shown, and is the thing those nine assertions were really for, is that a
// refusal from the hook reaches LFX1 as the parked-curve outcome rather than as a loss:
// hook reverts -> adapter reverts -> LFX1's try/catch -> GraduationAttemptFailed, state
// stays GRADUATION_READY, reserves intact, retryable. That is one property, so it is one
// test, driven by this fixture.
contract RejectingTestHook is BaseHook {
    address public immutable adapter;

    error AlwaysRefuses();

    constructor(IPoolManager poolManager_, address adapter_) BaseHook(poolManager_) {
        adapter = adapter_;
    }

    function getHookPermissions() public pure override returns (Hooks.Permissions memory) {
        return Hooks.Permissions({
            beforeInitialize: true,
            afterInitialize: false,
            beforeAddLiquidity: false,
            afterAddLiquidity: false,
            beforeRemoveLiquidity: false,
            afterRemoveLiquidity: false,
            beforeSwap: false,
            afterSwap: true,
            beforeDonate: false,
            afterDonate: false,
            beforeSwapReturnDelta: false,
            afterSwapReturnDelta: true,
            afterAddLiquidityReturnDelta: false,
            afterRemoveLiquidityReturnDelta: false
        });
    }

    function _beforeInitialize(address, PoolKey calldata, uint160) internal pure override returns (bytes4) {
        revert AlwaysRefuses();
    }

    function _afterSwap(address, PoolKey calldata, SwapParams calldata, BalanceDelta, bytes calldata)
        internal
        pure
        override
        returns (bytes4, int128)
    {
        return (IHooks.afterSwap.selector, 0);
    }
}
