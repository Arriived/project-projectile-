// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../../contracts/LFX1.sol";
import "../../contracts/mocks/MockUSDC.sol";
import "../../contracts/mocks/MockRouter.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "./CrossCurveHandler.sol";

/// @notice Cross-curve contamination, in two forms that catch different bugs.
///
///         AGGREGATE: the factory's USDC exactly equals every curve's reserves plus pool
///         boosts plus creator fees plus treasury fees. This is the property §7 asks for,
///         tightened from `>=` to `==` (see the invariant's own note).
///
///         PER-CURVE: a call aimed at one curve leaves every other curve, creator-fee
///         balance and token balance exactly where they were. The aggregate form cannot
///         see this -- take a dollar of accounting off curve A and put it on curve B and
///         the sum is identical, while A's holders are short. Curves are configured
///         asymmetrically (distinct creators, one with pool boost on) so a bug keyed to
///         the wrong curve reads visibly different state rather than an identical copy.
contract CrossCurveInvariantTest is Test {
    LFX1 factory;
    MockUSDC usdc;
    CrossCurveHandler handler;

    address[] tokens;
    address[] creators;
    bytes32[] frozenConfig;

    uint256 constant TOKEN_COUNT = 3;
    uint256 constant POOL_BOOST_TOKEN = 1;

    function setUp() public {
        vm.warp(1_800_000_000);

        usdc = new MockUSDC();
        factory = new LFX1(address(usdc), address(this), address(0));

        address routerAddr = address(new MockRouter());
        factory.proposeRouter(routerAddr);
        vm.warp(block.timestamp + factory.ROUTER_TIMELOCK() + 1);
        factory.activateRouter(routerAddr);

        // The snipe tax is a launch-window mechanism; leaving it on would land almost
        // every fuzzed buy in the taxed window and starve the steady-state paths.
        uint16[] memory none = new uint16[](0);
        factory.publishSnipeTaxTable(none);
        factory.setLaunchCooldown(0);

        // A DISTINCT creator per token. creatorFeesAccrued is keyed by creator, so tokens
        // sharing one would merge their fee balances and make the cross-creator half of
        // the isolation check vacuous.
        for (uint256 i; i < TOKEN_COUNT; i++) {
            address creator = makeAddr(string.concat("creator", vm.toString(i)));
            creators.push(creator);
            usdc.mint(creator, 1_000e6);

            vm.startPrank(creator);
            usdc.approve(address(factory), type(uint256).max);
            tokens.push(
                factory.createToken(
                    "Cross",
                    string.concat("XCV", vm.toString(i)),
                    "",
                    factory.currentEconomicsHash(),
                    i == POOL_BOOST_TOKEN
                )
            );
            vm.stopPrank();
        }

        for (uint256 i; i < TOKEN_COUNT; i++) {
            frozenConfig.push(_configFingerprint(tokens[i]));
        }

        // Trading opens the block AFTER creation. Without this every fuzzed call would
        // revert and the invariants would pass while exercising nothing.
        vm.roll(block.number + 1);

        handler = new CrossCurveHandler(factory, usdc, tokens, creators);
        targetContract(address(handler));
    }

    /// @notice Everything a curve fixes at creation and must never revisit.
    ///
    ///         Split across two helpers rather than one 15-field abi.encode: encoding the
    ///         whole set in a single expression is stack-too-deep at 0.8.24 with the
    ///         optimizer settings this project ships. Extracting is the house fix; viaIR
    ///         would change the bytecode under test to something the deployment is not.
    function _configFingerprint(address token) internal view returns (bytes32) {
        LFX1.Curve memory c = factory.curves(token);
        return keccak256(abi.encode(_configIdentityAndFees(c), _configTimingAndCaps(c)));
    }

    function _configIdentityAndFees(LFX1.Curve memory c) private pure returns (bytes32) {
        return keccak256(
            abi.encode(
                c.token,
                c.creator,
                c.buyFeeBps,
                c.sellFeeBps,
                c.creatorBuyFeeBps,
                c.creatorSellFeeBps,
                c.graduationThresholdUsdc
            )
        );
    }

    /// @notice `lpRecipient` belongs here specifically. §1.8 makes it immutable per curve
    ///         precisely so an owner cannot redirect pending graduations after tokens
    ///         launched advertising burned LP -- a snapshot with no check that it stays
    ///         put is the same shape as one that is read live.
    function _configTimingAndCaps(LFX1.Curve memory c) private pure returns (bytes32) {
        return keccak256(
            abi.encode(
                c.creationBlock,
                c.creationTimestamp,
                c.snipeTaxTableVersion,
                c.snipeTaxTreasuryBps,
                c.maxCreatorLaunchBps,
                c.creatorLaunchWindow,
                c.lpRecipient,
                c.poolBoostEnabled
            )
        );
    }

    /// @notice AGGREGATE. Exact, not `>=`.
    ///
    ///         Every dollar the factory holds is backing a curve's reserves, sitting in a
    ///         pool boost, or owed to a creator or the treasury -- and every such dollar is
    ///         actually held. The `>=` form next door stays green while the factory holds
    ///         MORE than it can account for, which is the residue a contamination bug
    ///         leaves after stranding value on the wrong curve. §1.7's warning applies in
    ///         both directions: omit treasury fees and the accrual reads as surplus.
    function invariant_pooledUsdcExactlyBacksAllAccounting() public view {
        uint256 accounted = factory.treasuryFeesAccrued();
        for (uint256 i; i < tokens.length; i++) {
            LFX1.Curve memory c = factory.curves(tokens[i]);
            accounted += c.realUsdcReserves + c.poolBoost;
        }
        for (uint256 i; i < creators.length; i++) {
            accounted += factory.creatorFeesAccrued(creators[i]);
        }
        assertEq(
            usdc.balanceOf(address(factory)),
            accounted,
            "factory USDC does not exactly equal reserves + boosts + creator fees + treasury fees"
        );
    }

    /// @notice PER-CURVE. The one the aggregate cannot see.
    function invariant_aTradeOnOneCurveDoesNotMoveAnother() public view {
        assertFalse(
            handler.isolationViolated(),
            string.concat(
                "cross-curve contamination: ",
                handler.violationKind(),
                " (token ",
                vm.toString(handler.violatingToken()),
                ")"
            )
        );
    }

    /// @notice Economics are snapshotted per token at creation and pinned by the economics
    ///         hash the creator signed. Nothing in the trading path may edit them
    ///         afterwards, for the targeted curve or any other.
    function invariant_curveConfigIsFrozenAfterCreation() public view {
        for (uint256 i; i < tokens.length; i++) {
            assertEq(
                _configFingerprint(tokens[i]),
                frozenConfig[i],
                "a curve's creation-time economics changed after launch"
            );
        }
    }

    /// @notice Guards the invariants above against passing vacuously -- fail_on_revert is
    ///         false and the handler swallows every failure, so "nothing executed" and
    ///         "everything was correct" are otherwise indistinguishable.
    ///
    ///         Only the buy path is asserted here. Claims were asserted here first and it
    ///         was wrong twice over: a claim needs a prior buy on one specific token, so a
    ///         run can legitimately contain none; and once any invariant in this file has
    ///         failed, forge replays the cached counterexample from
    ///         cache/invariant/failures before fuzzing, which is a short sequence
    ///         containing no claim -- so the guard went red on a CORRECT contract until
    ///         that cache was cleared. Claim liveness is proved deterministically below,
    ///         where neither effect can reach it.
    function afterInvariant() public view {
        assertGt(handler.buysExecuted(), 0, "no buy ever executed -- proved nothing");
    }

    /// @notice Every handler path, proved reachable deterministically. MultiCurveHandler's
    ///         creator-claim path is dead for exactly the reason this test exists to rule
    ///         out: it claims as the handler while the creator is the test contract, so it
    ///         reverts into the catch on every call and its counter never leaves zero.
    function test_allHandlerPathsAreReachable() public {
        handler.buy(0, 100e6);
        assertGt(handler.buysExecuted(), 0, "handler buy path is broken");

        handler.sell(0, 50);
        assertGt(handler.sellsExecuted(), 0, "handler sell path is broken");

        // Token 0 is not the pool-boost token, so its creator has real accrued fees.
        assertGt(factory.creatorFeesAccrued(creators[0]), 0, "no creator fees accrued to claim");
        handler.claimCreator(0);
        assertGt(handler.creatorClaimsExecuted(), 0, "handler creator-claim path is broken");

        assertGt(factory.treasuryFeesAccrued(), 0, "no treasury fees accrued to claim");
        handler.claimTreasury();
        assertGt(handler.treasuryClaimsExecuted(), 0, "handler treasury-claim path is broken");
    }

    /// @notice The pool-boost token routes its creator's cut into poolBoost instead of
    ///         creatorFeesAccrued. Proves the asymmetry is real rather than configured and
    ///         then never exercised.
    function test_poolBoostTokenAccruesBoostNotCreatorFees() public {
        handler.buy(POOL_BOOST_TOKEN, 100e6);
        assertGt(factory.curves(tokens[POOL_BOOST_TOKEN]).poolBoost, 0, "pool boost never accrued");
        assertEq(
            factory.creatorFeesAccrued(creators[POOL_BOOST_TOKEN]),
            0,
            "pool-boost token accrued claimable creator fees"
        );
    }
}
