// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {BaseHook} from "@uniswap/v4-periphery/src/utils/BaseHook.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";

// A hook that registers ANY pool, so an adapter can be driven with currencies
// BallistaFeeHook would refuse.
//
// ⚠ THIS IS A CONFIGURATION PRODUCTION CANNOT REACH, AND THAT IS THE POINT.
//
// BallistaFeeHook admits only a launched LFX1 token paired with USDC, and LFX1Token is
// plain OpenZeppelin ERC20 with no callbacks -- so no token that can re-enter during a
// transfer can ever be a currency in a real Ballista pool. The adapter's own
// ReentrancyGuard is therefore unreachable in production.
//
// It is still SHIPPED CODE, and CLAUDE.md 16.4 records exactly why it needs a live test
// anyway: the `v4-no-guard` mutation SURVIVED the first version of A3a. The test was green
// with the guard deleted, because the reenterer held no tokens and the nested call died on
// a transfer rather than on the guard. A guard a mutation has once escaped needs a test
// that still reaches it -- the test is what proves the guard is still there, and a guard
// nobody exercises is a guard nobody notices the removal of.
//
// So this fixture recreates the pre-hook world for that one purpose. It must NEVER be
// deployed anywhere real: it registers any pool at any price, by any caller.
//
// It carries the same three permission flags as the real hook so the adapter's flag check
// passes, and answers `adapter()` so the binding check passes. It takes no fee: afterSwap
// returns a zero delta, because nothing in this fixture is testing fee accrual.
contract PermissiveTestHook is BaseHook {
    address public immutable adapter;

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
        return IHooks.beforeInitialize.selector;
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
