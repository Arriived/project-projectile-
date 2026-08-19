// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../../contracts/ArcLaunchFactory.sol";
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
    ArcLaunchFactory factory;
    MockUSDC usdc;
    address token;
    CurveHandler handler;

    function setUp() public {
        vm.warp(1_800_000_000); // realistic-ish timestamp — Foundry's local chain
        // starts near zero, which would make the very first createToken() call
        // revert on the cooldown check (block.timestamp >= 0 + launchCooldown).
        // Never an issue on any real chain, where timestamps are always this large.

        usdc = new MockUSDC();
        factory = new ArcLaunchFactory(address(usdc), address(this));

        usdc.mint(address(this), 1_000e6);
        usdc.approve(address(factory), 1_000e6);
        token = factory.createToken("Invariant Test", "INVT", "");

        handler = new CurveHandler(factory, usdc, token);
        targetContract(address(handler));
    }

    /// forge-config: default.invariant.runs = 256
    function invariant_factoryHoldsEnoughUsdcToBackItsOwnAccounting() public view {
        (, , , , uint256 realUsdcReserves, , bool graduated, , , ) = factory.curves(token);
        if (graduated) return; // post-graduation, funds have moved to the DEX by design
        assertGe(
            usdc.balanceOf(address(factory)),
            realUsdcReserves,
            "factory's real USDC balance fell below what its own accounting claims to hold"
        );
    }

    function invariant_factoryHoldsEnoughTokenToBackItsOwnAccounting() public view {
        (, , , , , uint256 tokenReserves, bool graduated, , , ) = factory.curves(token);
        if (graduated) return;
        assertGe(
            IERC20(token).balanceOf(address(factory)),
            tokenReserves,
            "factory's real token balance fell below what its own accounting claims to hold"
        );
    }
}
