// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {BallistaV4Adapter} from "../BallistaV4Adapter.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IV4PositionManager, IPermit2Allowance} from "../interfaces/IV4Minimal.sol";

// Exposes the adapter's price math for local, unforked unit testing.
//
// It INHERITS the adapter rather than restating the formulas, so the harness exercises
// the shipped code. A harness holding its own copy would be the failure CLAUDE.md
// 14.2.1 records against verify:theme -- a check that passes against a copy while the
// real thing drifts. If _sqrt or _sqrtPriceX96 changes, this moves with it and the
// tests speak about the change; they cannot silently go on describing the old version.
//
// The zero constructor arguments are deliberate and safe: every function reached
// through this harness is `pure` and touches none of the three immutables.
contract V4AdapterMathHarness is BallistaV4Adapter {
    constructor()
        BallistaV4Adapter(IPoolManager(address(0)), IV4PositionManager(address(0)), IPermit2Allowance(address(0)))
    {}

    function sqrt(uint256 x) external pure returns (uint256) {
        return _sqrt(x);
    }

    function sqrtPriceX96(uint256 amount0, uint256 amount1) external pure returns (uint160) {
        return _sqrtPriceX96(amount0, amount1);
    }
}
