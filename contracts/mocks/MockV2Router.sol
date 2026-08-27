// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 [LICENSOR]. Licensed under the Business Source License 1.1.
// Change Date: 2030-09-16. Change License: GPL-2.0-or-later. See LICENSE.
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "../interfaces/IDEXRouter.sol";

/// @notice TEST ONLY. Reproduces UniswapV2Router02._addLiquidity's optimal-amount
///         branching, transcribed from v2-periphery's actual source:
///
///           if (reserveA == 0 && reserveB == 0) { (amountA, amountB) = desired; }
///           else {
///             amountBOptimal = quote(amountADesired, reserveA, reserveB);
///             if (amountBOptimal <= amountBDesired) {
///               require(amountBOptimal >= amountBMin, 'INSUFFICIENT_B_AMOUNT');
///               (amountA, amountB) = (amountADesired, amountBOptimal);
///             } else {
///               amountAOptimal = quote(amountBDesired, reserveB, reserveA);
///               assert(amountAOptimal <= amountADesired);
///               require(amountAOptimal >= amountAMin, 'INSUFFICIENT_A_AMOUNT');
///               (amountA, amountB) = (amountAOptimal, amountBDesired);
///             }
///           }
///
///         ⚠ THIS IS STILL A STUB. It reproduces the branch that the adversarial-pair
///         attack turns on, and nothing else -- no real pair contract, no LP token
///         accounting, no fee-on mint, no k-invariant. Conclusions drawn from it are
///         "mock-verified against transcribed V2 logic", NOT "fork-executed". A fork run
///         against the real router is what would settle it, and this file exists because
///         that run is blocked on an archive RPC, not as a substitute for it.
contract MockV2Router is IDEXRouter {
    using SafeERC20 for IERC20;

    // Pretend reserves, keyed by (tokenA, tokenB) in the order the caller passes them.
    mapping(address => mapping(address => uint256)) public reserveA;
    mapping(address => mapping(address => uint256)) public reserveB;
    bool public pairExists;

    uint256 public lastAmountA;
    uint256 public lastAmountB;
    address public lastLpRecipient;

    /// Seed an adversarial pair. Amounts are the pretend reserves, not transfers.
    function seedPair(address tokenA, address tokenB, uint256 rA, uint256 rB) external {
        reserveA[tokenA][tokenB] = rA;
        reserveB[tokenA][tokenB] = rB;
        pairExists = true;
    }

    function quote(uint256 amountA, uint256 rA, uint256 rB) public pure returns (uint256) {
        return (amountA * rB) / rA;
    }

    /// Extracted so addLiquidity stays under the stack limit -- the project rule is to
    /// restructure rather than enable viaIR.
    function _optimal(
        uint256 rA, uint256 rB, uint256 aDes, uint256 bDes, uint256 aMin, uint256 bMin
    ) internal pure returns (uint256 amountA, uint256 amountB) {
        if (rA == 0 && rB == 0) return (aDes, bDes);
        uint256 bOpt = quote(aDes, rA, rB);
        if (bOpt <= bDes) {
            require(bOpt >= bMin, "UniswapV2Router: INSUFFICIENT_B_AMOUNT");
            return (aDes, bOpt);
        }
        uint256 aOpt = quote(bDes, rB, rA);
        // The real router asserts this. If it can ever trip, that is a finding.
        assert(aOpt <= aDes);
        require(aOpt >= aMin, "UniswapV2Router: INSUFFICIENT_A_AMOUNT");
        return (aOpt, bDes);
    }

    function addLiquidity(
        address tokenA,
        address tokenB,
        uint256 amountADesired,
        uint256 amountBDesired,
        uint256 amountAMin,
        uint256 amountBMin,
        address to,
        uint256
    ) external returns (uint256 amountA, uint256 amountB, uint256 liquidity) {
        (amountA, amountB) = _optimal(
            reserveA[tokenA][tokenB], reserveB[tokenA][tokenB],
            amountADesired, amountBDesired, amountAMin, amountBMin
        );

        // Pull ONLY what was actually used, as the real router does.
        IERC20(tokenA).safeTransferFrom(msg.sender, address(this), amountA);
        IERC20(tokenB).safeTransferFrom(msg.sender, address(this), amountB);

        reserveA[tokenA][tokenB] += amountA;
        reserveB[tokenA][tokenB] += amountB;
        lastAmountA = amountA;
        lastAmountB = amountB;
        lastLpRecipient = to;
        liquidity = amountA + amountB; // non-zero stand-in; LP accounting is not modelled
    }
}
