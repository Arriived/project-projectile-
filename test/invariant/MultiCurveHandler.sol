// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import "../../contracts/Ballista.sol";
import "../../contracts/mocks/MockUSDC.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice Drives randomized trading across SEVERAL curves at once, plus creator-fee
///         claims. The single-curve handler cannot catch a class of bug that matters
///         here: every token's reserves and every creator's accrued fees are backed by
///         ONE pooled USDC balance, so an accounting error on one token would be paid
///         for out of another token's money.
contract MultiCurveHandler {
    Ballista public immutable factory;
    MockUSDC public immutable usdc;
    address[] public tokens;

    uint256 public buysExecuted;
    uint256 public sellsExecuted;
    uint256 public claimsExecuted;

    /// @notice Set if a buy ever failed to raise the marginal price, or a sell failed to
    ///         lower it. Asserted as an invariant -- a curve that can move the wrong way
    ///         is a curve someone can round-trip for free.
    bool public priceMonotonicityViolated;

    constructor(Ballista factory_, MockUSDC usdc_, address[] memory tokens_) {
        factory = factory_;
        usdc = usdc_;
        tokens = tokens_;
    }

    function _pick(uint256 seed) internal view returns (address) {
        return tokens[seed % tokens.length];
    }

    function _price(address token) internal view returns (uint256) {
        Ballista.Curve memory c = factory.curves(token);
        if (c.virtualTokenReserves == 0) return 0;
        return (c.virtualUsdcReserves * 1e18) / c.virtualTokenReserves;
    }

    function buy(uint256 seed, uint256 amountSeed) external {
        address token = _pick(seed);
        if (factory.curves(token).state != Ballista.CurveState.ACTIVE) return;

        // Retuned for the $8,000 curve. The old 20k ceiling was sized for a $67,000
        // threshold; here a single 20k buy clamps to full depletion and graduates the
        // curve on the fuzzer's FIRST call, after which every later call no-ops -- which
        // is exactly what the vacuity guard caught. 250 keeps a depth-50 run inside the
        // curve for most of its length while still reaching graduation sometimes.
        uint256 usdcIn = 1e6 + (amountSeed % (250e6));
        usdc.mint(address(this), usdcIn);
        usdc.approve(address(factory), usdcIn);

        uint256 before = _price(token);
        try factory.buy(token, usdcIn, 0) {
            buysExecuted++;
            // A buy must never lower the marginal price.
            if (factory.curves(token).state == Ballista.CurveState.ACTIVE) {
                if (_price(token) < before) priceMonotonicityViolated = true;
            }
        } catch {}
    }

    function sell(uint256 seed, uint256 pctSeed) external {
        address token = _pick(seed);
        if (factory.curves(token).state != Ballista.CurveState.ACTIVE) return;

        uint256 balance = IERC20(token).balanceOf(address(this));
        if (balance == 0) return;
        uint256 tokensIn = (balance * (1 + (pctSeed % 100))) / 100;
        if (tokensIn == 0) return;
        IERC20(token).approve(address(factory), tokensIn);

        uint256 before = _price(token);
        try factory.sell(token, tokensIn, 0) {
            sellsExecuted++;
            // A sell must never raise the marginal price.
            if (_price(token) > before) priceMonotonicityViolated = true;
        } catch {}
    }

    /// @notice Claiming mid-run is the interesting case: it moves USDC out of the
    ///         contract, so if reserves and creator fees were ever double-counted
    ///         against the same balance, this is what would expose it.
    function claim() external {
        try factory.claimCreatorFees() { claimsExecuted++; } catch {}
    }

    function tokenCount() external view returns (uint256) { return tokens.length; }
}
