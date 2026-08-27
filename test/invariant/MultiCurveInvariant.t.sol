// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../../contracts/LFX1.sol";
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
    LFX1 factory;
    MockUSDC usdc;
    MultiCurveHandler handler;
    address[] tokens;

    uint256 constant TOKEN_COUNT = 3;

    function setUp() public {
        vm.warp(1_800_000_000);

        usdc = new MockUSDC();
        factory = new LFX1(address(usdc), address(this), address(0));
        // Router activation is timelocked now: propose, wait out ROUTER_TIMELOCK, activate.
        address routerAddr = address(new MockRouter());
        factory.proposeRouter(routerAddr);
        vm.warp(block.timestamp + factory.ROUTER_TIMELOCK() + 1);
        factory.activateRouter(routerAddr);
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
                , false)
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
        // Unclaimed treasury fees are pooled in the same balance and owed just as
        // creator fees are -- see the note in CurveInvariant.
        owed += factory.treasuryFeesAccrued();
        for (uint256 i = 0; i < tokens.length; i++) {
            LFX1.Curve memory c = factory.curves(tokens[i]);
            // Only a COMPLETED graduation moves a curve's reserves out to the DEX.
            if (c.state != LFX1.CurveState.GRADUATED) {
                owed += c.realUsdcReserves;
            }
        }
        assertGe(
            usdc.balanceOf(address(factory)),
            owed,
            "pooled USDC fell below curve reserves plus unclaimed creator and treasury fees"
        );
    }

    /// @notice Each token's own balance must cover its own accounted reserves.
    function invariant_eachTokenBalanceCoversItsReserves() public view {
        for (uint256 i = 0; i < tokens.length; i++) {
            LFX1.Curve memory c = factory.curves(tokens[i]);
            if (c.state == LFX1.CurveState.GRADUATED) continue;
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
    }

    /// @notice The sell path deliberately is NOT asserted in afterInvariant. Handler
    ///         state resets between runs, and a sell needs a prior buy on the SAME one
    ///         of three tokens, so a given 50-call run can legitimately contain no
    ///         successful sell -- asserting it there fails on sequencing luck rather
    ///         than on a real defect. This proves the path is reachable deterministically
    ///         instead, so "sells never execute" still cannot pass unnoticed.
    /// The drained-on-graduation property, as a DETERMINISTIC test rather than an
    /// invariant. As an invariant it was vacuous: the handler caps buys at ~250 USDC to
    /// keep curves alive, so nothing ever reaches the 8,000 threshold and the assertion
    /// never ran -- commenting out `c.realUsdcReserves = 0` in _performGraduation left
    /// it passing. Raising the handler's cap would have graduated every curve on the
    /// fuzzer's first call and hollowed out the solvency invariants instead, which is
    /// the trade the handler comment already warns about. Forcing the state here proves
    /// the property without touching the fuzz.
    function test_graduatedCurveIsFullyDrained() public {
        usdc.mint(address(this), 1_000_000e6);
        usdc.approve(address(factory), type(uint256).max);
        vm.roll(block.number + 1);
        // Past the snipe window, so the spend actually reaches the curve.
        vm.warp(block.timestamp + 30);

        // BOTH graduation arms, because they drain differently. A depleting buy leaves
        // tokenReserves already at zero, so `c.tokenReserves = 0` is redundant on that
        // path -- an earlier version of this test used only a depleting buy and passed
        // happily with that assignment commented out.
        //
        // Threshold arm: cross 8,000 USDC with tokens still on the curve.
        address viaThreshold = tokens[0];
        factory.buy(viaThreshold, 8_100e6, 0);
        LFX1.Curve memory c = factory.curves(viaThreshold);
        assertTrue(c.state == LFX1.CurveState.GRADUATED, "threshold arm did not graduate");
        assertEq(c.realUsdcReserves, 0, "threshold-graduated curve still holds USDC");
        assertEq(c.tokenReserves, 0, "threshold-graduated curve still holds tokens");
        assertEq(c.poolBoost, 0, "threshold-graduated curve still holds pool boost");

        // Depletion arm: a buy far larger than the curve can fill.
        address viaDepletion = tokens[1];
        factory.buy(viaDepletion, 400_000e6, 0);
        c = factory.curves(viaDepletion);
        assertTrue(c.state == LFX1.CurveState.GRADUATED, "depletion arm did not graduate");
        assertEq(c.realUsdcReserves, 0, "depletion-graduated curve still holds USDC");
        assertEq(c.tokenReserves, 0, "depletion-graduated curve still holds tokens");

        // A POOL-BOOST-ENABLED token, because every token above has boost off, which
        // leaves poolBoost at zero anyway and makes `c.poolBoost = 0` redundant. Without
        // this arm, commenting that assignment out still passed.
        factory.setLaunchCooldown(0);
        address boosted = factory.createToken(
            "Boosted", "BOOST", "ipfs://b", factory.currentEconomicsHash(), true
        );
        vm.roll(block.number + 1);
        vm.warp(block.timestamp + 30);
        factory.buy(boosted, 4_000e6, 0);
        assertGt(factory.curves(boosted).poolBoost, 0, "setup failed: no boost accrued");
        factory.buy(boosted, 8_100e6, 0);
        c = factory.curves(boosted);
        assertTrue(c.state == LFX1.CurveState.GRADUATED, "boosted token did not graduate");
        assertEq(c.poolBoost, 0, "graduated curve still holds pool boost");
    }

    function test_sellPathIsReachable() public {
        handler.buy(0, 100e6);
        assertGt(handler.buysExecuted(), 0, "handler buy path is broken");
        handler.sell(0, 50);
        assertGt(handler.sellsExecuted(), 0, "handler sell path is broken");
    }

    /// @notice The claim path, for the same reason and with more history: it was dead for
    ///         its entire life. It claimed as the handler while every token here is
    ///         created by the test contract, so it reverted into the catch on all 4,274
    ///         calls of a full run while reporting "0 reverts" -- the catch, not success.
    ///         Nothing noticed, because afterInvariant only gates on buys.
    function test_claimPathIsReachable() public {
        handler.buy(0, 100e6);
        assertGt(factory.creatorFeesAccrued(address(this)), 0, "no creator fees accrued");
        handler.claim(0);
        assertGt(handler.claimsExecuted(), 0, "handler claim path is broken");
    }
}
