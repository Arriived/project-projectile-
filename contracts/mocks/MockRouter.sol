// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "../interfaces/IDEXRouter.sol";

contract MockRouter is IDEXRouter {
    address public lastLpRecipient;

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

        // Recorded so a test can assert WHERE the LP went, not merely that graduation
        // succeeded. lpRecipient is snapshotted per curve, and a snapshot nobody reads
        // back is indistinguishable from one that is ignored.
        lastLpRecipient = to;
        return (amountADesired, amountBDesired, amountADesired + amountBDesired);
    }
}

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

contract MockRevertingRouter is IDEXRouter {
    function addLiquidity(
        address,
        address,
        uint256,
        uint256,
        uint256,
        uint256,
        address,
        uint256
    ) external pure returns (uint256, uint256, uint256) {
        revert("MockRevertingRouter: simulated failure");
    }
}
