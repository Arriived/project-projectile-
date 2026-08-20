// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../../contracts/Ballista.sol";
import "../../contracts/mocks/MockUSDC.sol";
import "../../contracts/mocks/MockRouter.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "./MultiCurveHandler.sol";

/// @notice Pooled-solvency invariant across MULTIPLE curves plus creator fees.
///
///         Every curve's realUsdcReserves and every creator's unclaimed fees are backed
///         by a single USDC balance on the factory. The single-curve invariant cannot
///         see whether token A's accounting is quietly being covered by token B's
///         money, which is exactly the shape a real insolvency would take.
contract MultiCurveInvariantTest is Test {
    Ballista factory;
    MockUSDC usdc;
    MultiCurveHandler handler;
    address[] tokens;

    uint256 constant TOKEN_COUNT = 3;

    function setUp() public {
        vm.warp(1_800_000_000);

        usdc = new MockUSDC();
        factory = new Ballista(address(usdc), address(this));
        factory.setRouter(address(new MockRouter()));
        // The snipe tax is a launch-window mechanism; leaving it on would make almost
        // every fuzzed buy land in the taxed window and starve the steady-state paths.
        uint16[] memory none = new uint16[](0);
        factory.publishSnipeTaxTable(none);
        factory.setLaunchCooldown(0);

        usdc.mint(address(this), 1_000e6);
        usdc.approve(address(factory), type(uint256).max);

        for (uint256 i = 0; i < TOKEN_COUNT; i++) {
            tokens.push(
                factory.createToken(
                    "Multi",
                    string.concat("MUL", vm.toString(i)),
                    "",
                    factory.currentEconomicsHash()
                )
            );
        }

        // Trading opens the block AFTER creation. Without this every fuzzed call would
        // revert and the invariants would pass while exercising nothing.
        vm.roll(block.number + 1);

        handler = new MultiCurveHandler(factory, usdc, tokens);
        targetContract(address(handler));
    }

    /// @notice The one that matters: the factory's USDC must always cover the sum of
    ///         every curve's reserves PLUS every unclaimed creator fee, simultaneously.
    function invariant_pooledUsdcCoversAllCurvesAndCreatorFees() public view {
        uint256 owed = factory.creatorFeesAccrued(address(this));
        for (uint256 i = 0; i < tokens.length; i++) {
            Ballista.Curve memory c = factory.curves(tokens[i]);
            // Only a COMPLETED graduation moves a curve's reserves out to the DEX.
            if (c.state != Ballista.CurveState.GRADUATED) {
                owed += c.realUsdcReserves;
            }
        }
        assertGe(
            usdc.balanceOf(address(factory)),
            owed,
            "pooled USDC fell below curve reserves plus unclaimed creator fees"
        );
    }

    /// @notice Each token's own balance must cover its own accounted reserves.
    function invariant_eachTokenBalanceCoversItsReserves() public view {
        for (uint256 i = 0; i < tokens.length; i++) {
            Ballista.Curve memory c = factory.curves(tokens[i]);
            if (c.state == Ballista.CurveState.GRADUATED) continue;
            assertGe(
                IERC20(tokens[i]).balanceOf(address(factory)),
                c.tokenReserves,
                "a token balance fell below that curve's accounted reserves"
            );
        }
    }

    /// @notice A buy must never lower the marginal price and a sell must never raise it.
    ///         If either direction can be inverted, a round trip becomes free money.
    function invariant_curvePriceIsMonotonic() public view {
        assertFalse(
            handler.priceMonotonicityViolated(),
            "curve price moved the wrong way for a trade direction"
        );
    }

    /// @notice Guards the invariants above against passing vacuously -- fail_on_revert
    ///         is false and the handler swallows every failure, so "nothing executed"
    ///         and "everything was correct" are otherwise indistinguishable.
    function afterInvariant() public view {
        assertGt(handler.buysExecuted(), 0, "no buy ever executed -- proved nothing");
        assertGt(handler.sellsExecuted(), 0, "no sell ever executed -- proved nothing");
    }
}
