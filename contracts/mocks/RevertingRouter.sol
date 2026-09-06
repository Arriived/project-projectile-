// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {IDEXRouter} from "../interfaces/IDEXRouter.sol";

// A router that always reverts, for proving graduation is RECOVERABLE.
//
// LFX1 wraps the router call in try/catch, so a reverting router must leave the curve
// at GRADUATION_READY with its reserves intact and retryable, not consumed. That
// property is what makes the v4 adapter's own price check safe to revert on: if a
// failed attempt destroyed the curve, refusing to seed a hostile pool would be worse
// than seeding it.
//
// This is a TEST FIXTURE and is never deployed to a real network.
contract RevertingRouter is IDEXRouter {
    error RouterIsBroken();

    function addLiquidity(address, address, uint256, uint256, uint256, uint256, address, uint256)
        external
        pure
        override
        returns (uint256, uint256, uint256)
    {
        revert RouterIsBroken();
    }
}
