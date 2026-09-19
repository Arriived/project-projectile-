// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "../../interfaces/IDEXRouter.sol";

// Regression fixture for the cross-curve broken-router drain (CLAUDE.md section 26.6).
// Pulls ONLY the quote-asset side via transferFrom and returns liquidity == 0, leaving
// the launched-token side entirely untouched. contracts/mocks/MockRouter.sol's own
// MockBrokenRouter pulls BOTH sides, which self-limits its damage to one curve: the
// drained curve's own token balance is then zero, so any retry's token-side
// transferFrom fails regardless of how much quote-asset balance is available elsewhere.
// Draining only the quote side leaves the token side intact, so a later retry through
// an honest router can still succeed -- paying for it out of whatever OTHER curves'
// quote-asset funds happen to be sitting in the same pooled BXR1 balance. This is the
// surgical, realistic shape of a malicious or misbehaving router, and it is what
// section 26.6's fix closes.
contract QuoteOnlyDrainRouter is IDEXRouter {
    using SafeERC20 for IERC20;

    function addLiquidity(
        address,
        address tokenB,
        uint256,
        uint256 amountBDesired,
        uint256,
        uint256,
        address,
        uint256
    ) external returns (uint256 amountA, uint256 amountB, uint256 liquidity) {
        IERC20(tokenB).safeTransferFrom(msg.sender, address(this), amountBDesired);
        return (0, amountBDesired, 0);
    }
}
