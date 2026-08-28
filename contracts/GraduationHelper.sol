// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 [LICENSOR]. Licensed under the Business Source License 1.1.
// Change Date: 2030-09-16. Change License: GPL-2.0-or-later. See LICENSE.
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface ILFX1Curves {
    enum CurveState { ACTIVE, GRADUATION_READY, GRADUATED }

    struct Curve {
        address token;
        address creator;
        uint256 virtualTokenReserves;
        uint256 virtualUsdcReserves;
        uint256 realUsdcReserves;
        uint256 tokenReserves;
        CurveState state;
        uint16 buyFeeBps;
        uint16 sellFeeBps;
        uint16 creatorBuyFeeBps;
        uint16 creatorSellFeeBps;
        uint256 graduationThresholdUsdc;
        uint256 creationBlock;
        uint256 creationTimestamp;
        uint32 snipeTaxTableVersion;
        uint16 snipeTaxTreasuryBps;
        uint16 maxCreatorLaunchBps;
        uint32 creatorLaunchWindow;
        address lpRecipient;
        bool poolBoostEnabled;
        uint256 poolBoost;
        uint256 creatorLaunchPurchased;
    }

    function curves(address token) external view returns (Curve memory);
    function LP_TOKEN_RESERVE() external view returns (uint256);
    function graduate(address token) external;
}

interface IUniswapV2Factory {
    function getPair(address, address) external view returns (address);
}

interface IUniswapV2Pair {
    function token0() external view returns (address);
    function getReserves() external view returns (uint112, uint112, uint32);
    function swap(uint256 amount0Out, uint256 amount1Out, address to, bytes calldata data) external;
    function sync() external;
}

/// @notice Bundles "correct the pair" and "graduate" into ONE transaction.
///
/// The value here is atomicity, not funding. Correcting an adversarially skewed pair is
/// already an arbitrage -- measured against real V2, 0.0286 USDC in for tokens marked at
/// 815 USDC -- so nobody needs paying to want it. But that arbitrage is only realisable
/// IF graduation completes: both buy and sell are closed at GRADUATION_READY, so while a
/// curve is stranded the attacker's dust pair is the token's only venue. A searcher who
/// swaps and stops holds an illiquid position, and the attacker re-skews for dust before
/// anyone calls graduate(). Unbundled, the correction can be griefed forever; bundled,
/// there is no gap to interleave into.
///
/// This contract holds NO privilege in LFX1 and custodies nothing between transactions.
/// It calls the public, permissionless graduate() like any other address. A bug here
/// cannot strand or damage a curve -- the fallback is the same two-transaction sequence
/// anyone could do by hand, slower and grief-able but never lossy.
///
/// The swap amounts are supplied by the CALLER, not solved for here. A searcher can size
/// them off-chain far better than this contract can on-chain, and keeping the solver out
/// keeps the trusted surface to the part that matters: the bundle.
contract GraduationHelper is ReentrancyGuard {
    using SafeERC20 for IERC20;

    ILFX1Curves public immutable lfx1;
    IUniswapV2Factory public immutable factory;
    IERC20 public immutable usdc;

    error NotReadyToGraduate();
    error NothingToCorrect();
    /// @notice The pair cannot be brought into the admissible window by donation alone.
    error CorrectionNotSolvable();
    /// @notice Carries what the correction actually needs, so the next attempt is sized
    ///         rather than guessed.
    error UsdcCorrectionExceedsCap(uint256 required, uint256 cap);
    error TokenCorrectionExceedsCap(uint256 required, uint256 cap);

    event Corrected(
        address indexed token,
        address indexed caller,
        uint256 usdcDonated,
        uint256 tokensDonated
    );

    constructor(address lfx1_, address factory_, address usdc_) {
        lfx1 = ILFX1Curves(lfx1_);
        factory = IUniswapV2Factory(factory_);
        usdc = IERC20(usdc_);
    }

    /// @notice Reserves of `pair` mapped onto (token, usdc) rather than (token0, token1).
    function _reserves(address pair, address token)
        internal
        view
        returns (uint256 rT, uint256 rU)
    {
        (uint112 r0, uint112 r1,) = IUniswapV2Pair(pair).getReserves();
        return IUniswapV2Pair(pair).token0() == token
            ? (uint256(r0), uint256(r1))
            : (uint256(r1), uint256(r0));
    }

    /// @notice The deposit LFX1 will attempt at graduation.
    function _target(address token) internal view returns (uint256 T, uint256 U) {
        ILFX1Curves.Curve memory c = lfx1.curves(token);
        if (c.state != ILFX1Curves.CurveState.GRADUATION_READY) revert NotReadyToGraduate();
        T = lfx1.LP_TOKEN_RESERVE() + c.tokenReserves;
        U = c.realUsdcReserves + c.poolBoost;
    }

    /// @notice What the pair must be donated for LFX1's strict mins to pass.
    ///
    ///         V2 admits a WINDOW, not exact proportionality. With amountAMin/BMin equal
    ///         to the desired amounts, `quote` must land on the desired figure, which
    ///         holds exactly when D = T*rU - U*rT lies in (-rU, rT). Requiring rT*U ==
    ///         rU*T instead would be correct but far more expensive -- it forces the
    ///         reserves onto the reduced ratio a:b, and with gcd(T,U) small that donation
    ///         runs to the whole LP allocation.
    function correctionNeeded(address token)
        public
        view
        returns (uint256 usdcNeeded, uint256 tokensNeeded)
    {
        (uint256 T, uint256 U) = _target(token);
        address pair = factory.getPair(token, address(usdc));
        // No pair means V2 takes the zero-reserve branch and never evaluates the mins.
        if (pair == address(0)) return (0, 0);
        (uint256 rT, uint256 rU) = _reserves(pair, token);
        if (rT == 0 && rU == 0) return (0, 0);
        return _correction(T, U, rT, rU);
    }

    /// @dev The admissible window is D = T*rU - U*rT in **[0, rT)**, and only that.
    ///
    ///      Branch 1 of V2's `_addLiquidity` is taken when `quote(T, rT, rU) <= U`, i.e.
    ///      D < rT, and passes when it equals U, i.e. D >= 0. Branch 2 is taken when
    ///      D >= rT and would pass only when D <= 0, so it can never succeed under strict
    ///      mins. An earlier version of this function admitted D in (-rU, rT) on the
    ///      assumption branch 2 covered the negative half; it does not, and corrections
    ///      computed that way left `graduate()` reverting with GraduationFailed.
    ///
    ///      Two levers. A unit of USDC moves D by +T (coarse); a token moves it by -U and
    ///      lifts the ceiling by 1 (fine). USDC alone cannot always land inside a window
    ///      narrower than its own step, so the token side does the final placement.
    function _correction(uint256 T, uint256 U, uint256 rT, uint256 rU)
        internal
        pure
        returns (uint256 usdcNeeded, uint256 tokensNeeded)
    {
        uint256 lhs = T * rU;
        uint256 rhs = U * rT;

        if (lhs >= rhs && lhs - rhs < rT) return (0, 0);

        uint256 d;
        if (lhs < rhs) {
            usdcNeeded = (rhs - lhs + T - 1) / T; // ceil, lands D in [0, T)
            d = lhs + T * usdcNeeded - rhs;
        } else {
            d = lhs - rhs;
        }

        uint256 ceiling = rT;
        if (d >= ceiling) {
            tokensNeeded = (d - ceiling) / (U + 1) + 1;
            uint256 drop = U * tokensNeeded;
            if (drop > d) revert CorrectionNotSolvable();
            d -= drop;
            ceiling += tokensNeeded;
        }
        // Loud rather than a bare GraduationFailed two calls later.
        if (d >= ceiling) revert CorrectionNotSolvable();
    }

    /// @param token         The stranded curve's token.
    /// @param swapUsdcIn    USDC to swap into the pair first, caller-sized. 0 to skip.
    /// @param swapTokenIn   Tokens to swap into the pair first, caller-sized. 0 to skip.
    /// @param maxUsdcSpend  Cap on USDC pulled from the caller, swap plus donation.
    /// @param maxTokenSpend Cap on tokens pulled from the caller, swap plus donation.
    /// @param beneficiary   Receives the swap output. This is where the arbitrage lands.
    ///
    /// Passed as a struct because the flat argument list was stack-too-deep at 0.8.24 with
    /// the optimizer settings this project ships. Restructuring is the house fix; viaIR
    /// would change the bytecode under test to something a deployment would not have.
    struct Correction {
        address token;
        uint256 swapUsdcIn;
        uint256 swapTokenIn;
        uint256 maxUsdcSpend;
        uint256 maxTokenSpend;
        address beneficiary;
    }

    /// @notice Correct the pair and graduate, atomically.
    function correctAndGraduate(Correction calldata p) external nonReentrant {
        (uint256 T, uint256 U) = _target(p.token);
        address pair = factory.getPair(p.token, address(usdc));

        if (pair != address(0)) {
            if (p.swapUsdcIn > 0 || p.swapTokenIn > 0) {
                _swap(pair, p.token, p.swapUsdcIn, p.swapTokenIn, p.beneficiary);
            }
            _applyCorrection(p, pair, T, U);
        }

        // Reverts on failure, which unwinds the correction with it. The curve is left
        // exactly as it was: GRADUATION_READY, reserves intact, still retryable.
        lfx1.graduate(p.token);
    }

    function _applyCorrection(
        Correction calldata p,
        address pair,
        uint256 T,
        uint256 U
    ) internal {
        (uint256 rT, uint256 rU) = _reserves(pair, p.token);
        (uint256 needU, uint256 needT) = _correction(T, U, rT, rU);

        if (p.swapUsdcIn + needU > p.maxUsdcSpend) {
            revert UsdcCorrectionExceedsCap(p.swapUsdcIn + needU, p.maxUsdcSpend);
        }
        if (p.swapTokenIn + needT > p.maxTokenSpend) {
            revert TokenCorrectionExceedsCap(p.swapTokenIn + needT, p.maxTokenSpend);
        }

        if (needU > 0) usdc.safeTransferFrom(msg.sender, pair, needU);
        if (needT > 0) IERC20(p.token).safeTransferFrom(msg.sender, pair, needT);
        if (needU > 0 || needT > 0) {
            IUniswapV2Pair(pair).sync();
            emit Corrected(p.token, msg.sender, needU, needT);
        }
    }

    function _swap(
        address pair,
        address token,
        uint256 usdcIn,
        uint256 tokenIn,
        address beneficiary
    ) internal {
        (uint256 rT, uint256 rU) = _reserves(pair, token);
        bool tokenIsZero = IUniswapV2Pair(pair).token0() == token;

        if (usdcIn > 0) {
            usdc.safeTransferFrom(msg.sender, pair, usdcIn);
            uint256 inWithFee = usdcIn * 997;
            uint256 out = (inWithFee * rT) / (rU * 1000 + inWithFee);
            IUniswapV2Pair(pair).swap(
                tokenIsZero ? out : 0, tokenIsZero ? 0 : out, beneficiary, ""
            );
        }
        if (tokenIn > 0) {
            IERC20(token).safeTransferFrom(msg.sender, pair, tokenIn);
            uint256 inWithFee = tokenIn * 997;
            uint256 out = (inWithFee * rU) / (rT * 1000 + inWithFee);
            IUniswapV2Pair(pair).swap(
                tokenIsZero ? 0 : out, tokenIsZero ? out : 0, beneficiary, ""
            );
        }
    }
}
