// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../../contracts/Ballista.sol";
import "../../contracts/mocks/MockUSDC.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "./CurveHandler.sol";

/// @notice Solvency invariant: no matter what sequence of buys/sells happens, the
///         factory must always physically hold at least as much USDC and token
///         supply as its own internal accounting says it owes. If this ever breaks,
///         it means the curve math (or the accounting bookkeeping around it) has a
///         path where the contract could become unable to honor a future sell —
///         precisely the "does the curve ever let someone extract more than they
///         put in" question, tested by brute force across thousands of random
///         trade sequences instead of by hand-picked examples.
contract CurveInvariantTest is Test {
    Ballista factory;
    MockUSDC usdc;
    address token;
    CurveHandler handler;

    function setUp() public {
        vm.warp(1_800_000_000); // realistic-ish timestamp — Foundry's local chain
        // starts near zero, which would make the very first createToken() call
        // revert on the cooldown check (block.timestamp >= 0 + launchCooldown).
        // Never an issue on any real chain, where timestamps are always this large.

        usdc = new MockUSDC();
        factory = new Ballista(address(usdc), address(this));

        usdc.mint(address(this), 1_000e6);
        usdc.approve(address(factory), 1_000e6);
        token = factory.createToken(
            "Invariant Test",
            "INVT",
            "",
            factory.currentEconomicsHash()
        );

        // Ballista opens trading only in the block AFTER creation. Without this roll,
        // every handler call would revert on that check, fail_on_revert = false would
        // swallow it, and both invariants would pass while testing nothing at all.
        vm.roll(block.number + 1);

        handler = new CurveHandler(factory, usdc, token);
        targetContract(address(handler));
    }

    /// forge-config: default.invariant.runs = 256
    function invariant_factoryHoldsEnoughUsdcToBackItsOwnAccounting() public view {
        (, , , , uint256 realUsdcReserves, , Ballista.CurveState state, , , , ) =
            factory.curves(token);
        // Only a COMPLETED graduation moves funds out to the DEX. A curve sitting in
        // GRADUATION_READY still physically holds everything it owes, so it stays
        // subject to the invariant rather than being waved through.
        if (state == Ballista.CurveState.GRADUATED) return;
        assertGe(
            usdc.balanceOf(address(factory)),
            realUsdcReserves,
            "factory's real USDC balance fell below what its own accounting claims to hold"
        );
    }

    function invariant_factoryHoldsEnoughTokenToBackItsOwnAccounting() public view {
        (, , , , , uint256 tokenReserves, Ballista.CurveState state, , , , ) =
            factory.curves(token);
        if (state == Ballista.CurveState.GRADUATED) return;
        assertGe(
            IERC20(token).balanceOf(address(factory)),
            tokenReserves,
            "factory's real token balance fell below what its own accounting claims to hold"
        );
    }

    /// @notice Guards the two invariants above against passing vacuously. Both use
    ///         try/catch and fail_on_revert = false, so a change that made every call
    ///         revert would otherwise look identical to a clean run.
    /// @dev    This has to be afterInvariant() rather than an invariant_ function.
    ///         Foundry asserts invariants against the post-setUp state as well, where
    ///         a "something has executed by now" claim is legitimately false and would
    ///         fail before the fuzzer ever starts. afterInvariant() runs at the end of
    ///         each run instead, which is the only point where the claim is meaningful.
    function afterInvariant() public view {
        assertGt(
            handler.buysExecuted(),
            0,
            "no buy ever executed -- the invariants above proved nothing"
        );
    }
}
