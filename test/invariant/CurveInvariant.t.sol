// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../../contracts/LFX1.sol";
import "../../contracts/mocks/MockUSDC.sol";
import "../../contracts/mocks/MockRouter.sol";
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
    LFX1 factory;
    MockUSDC usdc;
    address token;
    CurveHandler handler;

    function setUp() public {
        vm.warp(1_800_000_000); // realistic-ish timestamp — Foundry's local chain
        // starts near zero, which would make the very first createToken() call
        // revert on the cooldown check (block.timestamp >= 0 + launchCooldown).
        // Never an issue on any real chain, where timestamps are always this large.

        usdc = new MockUSDC();
        factory = new LFX1(address(usdc), address(this), address(0));

        // createToken() now refuses to launch without a router, so one is required
        // here. This also means the fuzzer drives curves through a real graduation
        // rather than parking them at GRADUATION_READY -- graduation is the
        // highest-stakes transition in the contract, so it should be fuzzed.
        // Router activation is timelocked now: propose, wait out ROUTER_TIMELOCK, activate.
        address routerAddr = address(new MockRouter());
        factory.proposeRouter(routerAddr);
        vm.warp(block.timestamp + factory.ROUTER_TIMELOCK() + 1);
        factory.activateRouter(routerAddr);

        usdc.mint(address(this), 1_000e6);
        usdc.approve(address(factory), 1_000e6);
        token = factory.createToken(
            "Invariant Test",
            "INVT",
            "",
            factory.currentEconomicsHash()
        , false);

        // LFX1 opens trading only in the block AFTER creation. Without this roll,
        // every handler call would revert on that check, fail_on_revert = false would
        // swallow it, and both invariants would pass while testing nothing at all.
        vm.roll(block.number + 1);

        handler = new CurveHandler(factory, usdc, token);
        targetContract(address(handler));
    }

    /// forge-config: default.invariant.runs = 256
    function invariant_factoryHoldsEnoughUsdcToBackItsOwnAccounting() public view {
        // curves() returns the struct itself now, rather than a flat tuple that had to
        // be re-counted by hand every time a field was added.
        LFX1.Curve memory c = factory.curves(token);
        // Accrued creator fees are a real USDC obligation sitting in the contract, and
        // unlike curve reserves they are NOT discharged by graduation -- so they are
        // counted in every state. This test contract is the creator of the only token,
        // so its accrual is the whole outstanding creator liability.
        uint256 owed = factory.creatorFeesAccrued(address(this));
        // Only a COMPLETED graduation moves the curve's own reserves out to the DEX.
        if (c.state != LFX1.CurveState.GRADUATED) {
            owed += c.realUsdcReserves;
        }
        assertGe(
            usdc.balanceOf(address(factory)),
            owed,
            "factory's USDC balance fell below curve reserves plus unclaimed creator fees"
        );
    }

    function invariant_factoryHoldsEnoughTokenToBackItsOwnAccounting() public view {
        LFX1.Curve memory c = factory.curves(token);
        if (c.state == LFX1.CurveState.GRADUATED) return;
        assertGe(
            IERC20(token).balanceOf(address(factory)),
            c.tokenReserves,
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
