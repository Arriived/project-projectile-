// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

/// @title IDEXRouter
/// @notice Minimal Uniswap-V2-style router interface, used only for the addLiquidity call
///         fired at graduation. Kept intentionally narrow (one function) rather than
///         importing a full router interface, since the only integration point this
///         contract needs is "take token + quote asset, create the pool, return LP tokens."
/// @dev IMPORTANT: No DEX has been publicly confirmed as a launch partner on Arc as of this
///      writing. Do not hardcode a router address until one is confirmed and verified on
///      the Arc block explorer — set it via the factory owner's setRouter() instead, and
///      treat that as a placeholder until then.
interface IDEXRouter {
    function addLiquidity(
        address tokenA,
        address tokenB,
        uint256 amountADesired,
        uint256 amountBDesired,
        uint256 amountAMin,
        uint256 amountBMin,
        address to,
        uint256 deadline
    ) external returns (uint256 amountA, uint256 amountB, uint256 liquidity);
}
