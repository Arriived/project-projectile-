// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

// Answers BallistaV4Adapter's construction-time binding check and nothing else.
//
// Used ONLY where a test needs a correctly-flagged, correctly-bound hook address but
// never calls a hook callback -- the pure-math harness being the case that motivated it.
// It deliberately implements no IHooks function, so any test that accidentally routes a
// real pool through it fails immediately rather than half-working.
contract MockHookBinding {
    address public immutable adapter;

    constructor(address adapter_) {
        adapter = adapter_;
    }
}
