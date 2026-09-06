// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";

// Read-only window onto a v4 pool, for the fork test.
//
// v4 keeps pool state behind extsload rather than public getters, so reading it means
// computing the state slot and unpacking Slot0. This delegates BOTH of those to
// Uniswap's own StateLibrary rather than reimplementing them in test JavaScript. A
// hand-rolled unpack in the test would be a second, unverified copy of v4's storage
// layout sitting in the one place that is supposed to be checking the first -- and if
// it were wrong, the price assertion would compare the adapter against a bug rather
// than against the chain.
//
// This is a TEST FIXTURE. It holds nothing, is never deployed to a real network, and
// is not part of the adapter.
contract V4PoolLens {
    using StateLibrary for IPoolManager;

    function slot0(IPoolManager manager, PoolKey calldata key)
        external
        view
        returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)
    {
        return manager.getSlot0(key.toId());
    }

    function liquidity(IPoolManager manager, PoolKey calldata key) external view returns (uint128) {
        return manager.getLiquidity(key.toId());
    }

    function poolId(PoolKey calldata key) external pure returns (bytes32) {
        return PoolId.unwrap(key.toId());
    }
}
