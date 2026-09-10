// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {BallistaV4Adapter} from "../BallistaV4Adapter.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
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
// through this harness is `pure` and touches none of the immutables.
//
// ⚠ `lfx1` is the exception and CANNOT be zero -- the adapter's constructor rejects it,
// because an adapter whose caller gate names address(0) is an adapter nothing can call.
// address(1) is used rather than a plausible-looking address so that a harness leaking
// into anything real fails loudly instead of half-working (CLAUDE.md section 12.6:
// fixtures use real-shaped values, and where a value must NOT be real it should be
// obviously impossible rather than merely wrong).
contract V4AdapterMathHarness is BallistaV4Adapter {
    // The hook is passed in because the parent's constructor now verifies it -- zero
    // address, flag bits, and that the hook names THIS contract as its adapter. A test
    // therefore has to mine a correctly-flagged MockHookBinding bound to this harness's
    // own predicted address, which is the same dance production performs. That is more
    // setup than a math test wants, and it is kept anyway rather than making the checks
    // skippable: a `virtual` escape on a constructor check is a way for a future subclass
    // to turn it off, and this check is the one guarding the deployment's only
    // silent-at-both-ends failure.
    constructor(IHooks hook_)
        BallistaV4Adapter(
            IPoolManager(address(0)),
            IV4PositionManager(address(0)),
            IPermit2Allowance(address(0)),
            address(1),
            hook_
        )
    {}

    function sqrt(uint256 x) external pure returns (uint256) {
        return _sqrt(x);
    }

    function sqrtPriceX96(uint256 amount0, uint256 amount1) external pure returns (uint160) {
        return _sqrtPriceX96(amount0, amount1);
    }
}
