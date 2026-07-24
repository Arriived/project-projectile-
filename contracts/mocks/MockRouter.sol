// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "../interfaces/IDEXRouter.sol";

/// @notice Test-only stand-in for a real Uniswap-V2-style router. Pulls the approved
///         tokens (proving the factory's forceApprove actually worked) and returns a
///         nonzero liquidity amount, simulating a successful pool creation.
contract MockRouter is IDEXRouter {
    using SafeERC20 for IERC20;

    function addLiquidity(
        address tokenA,
        address tokenB,
        uint256 amountADesired,
        uint256 amountBDesired,
        uint256,
        uint256,
        address to,
        uint256
    ) external returns (uint256 amountA, uint256 amountB, uint256 liquidity) {
        IERC20(tokenA).safeTransferFrom(msg.sender, address(this), amountADesired);
        IERC20(tokenB).safeTransferFrom(msg.sender, address(this), amountBDesired);
        // Fake LP token accounting for the test — real router would mint an actual LP
        // token to `to`. What matters for our test is: did the factory approve and send
        // the right amounts, and did `to` (the burn address) end up recorded as the
        // recipient.
        to; // recipient acknowledged, no LP token minted in this mock
        return (amountADesired, amountBDesired, amountADesired + amountBDesired);
    }
}

/// @notice Simulates a router that "succeeds" (doesn't revert) but returns zero
///         liquidity — the exact case the `require(liquidity > 0)` check in
///         ArcLaunchFactory._graduate is there to catch.
contract MockBrokenRouter is IDEXRouter {
    using SafeERC20 for IERC20;

    function addLiquidity(
        address tokenA,
        address tokenB,
        uint256 amountADesired,
        uint256 amountBDesired,
        uint256,
        uint256,
        address,
        uint256
    ) external returns (uint256, uint256, uint256) {
        IERC20(tokenA).safeTransferFrom(msg.sender, address(this), amountADesired);
        IERC20(tokenB).safeTransferFrom(msg.sender, address(this), amountBDesired);
        return (amountADesired, amountBDesired, 0);
    }
}
