// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "../../contracts/Ballista.sol";
import "../../contracts/mocks/MockUSDC.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice Drives randomized buy/sell calls against a single live curve. Foundry's
///         invariant fuzzer calls the public functions here in random order, with
///         random arguments, many times per run — this is what actually generates
///         the "thousands of random inputs" a scanner or a human reviewer wouldn't
///         think to try by hand.
contract CurveHandler {
    Ballista public immutable factory;
    MockUSDC public immutable usdc;
    address public immutable token;

    // Counters, asserted on in the invariant test. Without these, a change that made
    // every single call revert would still show up as a passing run: fail_on_revert
    // is false and the try/catch below swallows failures, so "nothing ever executed"
    // and "everything executed correctly" look identical from the outside.
    uint256 public buysExecuted;
    uint256 public sellsExecuted;

    constructor(Ballista factory_, MockUSDC usdc_, address token_) {
        factory = factory_;
        usdc = usdc_;
        token = token_;
    }

    function buy(uint256 usdcAmountSeed) external {
        // Bound to a sane range — an unbounded fuzzer would mostly generate amounts
        // that just revert on "insufficient balance" and waste run budget on that
        // instead of exploring real curve behavior.
        //
        // The ceiling is 20k rather than 5k deliberately. At 5k, with sells pulling
        // reserves back down, a depth-50 run never accumulated the 67,000 USDC needed
        // to graduate — measured, not assumed — so the state machine's highest-stakes
        // transition was never fuzzed at all. 20k reaches the threshold in roughly
        // seven buys while still leaving most of a run for ordinary trading below it.
        // Retuned for the $8,000 curve. The old 20k ceiling was sized for a $67,000
        // threshold; here a single 20k buy clamps to full depletion and graduates the
        // curve on the fuzzer's FIRST call, after which every later call no-ops -- which
        // is exactly what the vacuity guard caught. 250 keeps a depth-50 run inside the
        // curve for most of its length while still reaching graduation sometimes.
        uint256 usdcIn = 1e6 + (usdcAmountSeed % (250e6));
        usdc.mint(address(this), usdcIn);
        usdc.approve(address(factory), usdcIn);
        try factory.buy(token, usdcIn, 0) {
            buysExecuted++;
        } catch {}
    }

    function sell(uint256 pctSeed) external {
        uint256 balance = IERC20(token).balanceOf(address(this));
        if (balance == 0) return;
        uint256 pct = 1 + (pctSeed % 100);
        uint256 tokensIn = (balance * pct) / 100;
        if (tokensIn == 0) return;
        IERC20(token).approve(address(factory), tokensIn);
        try factory.sell(token, tokensIn, 0) {
            sellsExecuted++;
        } catch {}
    }
}
