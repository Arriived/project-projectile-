// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";

// The slice of Uniswap's PositionManager this adapter uses.
//
// Declared here rather than imported because v4-periphery's own IPositionManager
// reaches "permit2/src/interfaces/IAllowanceTransfer.sol" (via IPermit2Forwarder.sol:4),
// and no npm package provides that path -- the `permit2` package was unpublished from
// npm on 2026-08-11 and a scoped Uniswap one has never existed. The periphery package
// declares zero dependencies and its remappings.txt points at Foundry `lib/` paths that
// are absent from the npm tarball. So the import is not merely inconvenient, it is
// unresolvable under Hardhat.
//
// Every selector below was verified against the DEPLOYED bytecode on Base at block
// 50,900,000 -- not transcribed from memory:
//   modifyLiquidities(bytes,uint256)  0xdd46508f
//   initializePool(...)               0xf7020405
//   nextTokenId()                     0x75794a3c
//   ownerOf(uint256)                  0x6352211e
// Signatures come from v4-periphery 1.0.3: PositionManager.sol:172,
// PoolInitializer_v4.sol:13, IPositionManager.sol:50, IPositionManager.sol:56.
interface IV4PositionManager {
    function modifyLiquidities(bytes calldata unlockData, uint256 deadline) external payable;

    // ⚠ CORRECTED. This previously read "Swallows a PoolAlreadyInitialized revert and
    // returns type(int24).max instead". It does not discriminate: PoolInitializer_v4.sol:16
    // is a BARE `catch {}` that returns type(int24).max for ANY revert -- a hook
    // rejection, a tick-spacing error, currencies out of order. Relying on it therefore
    // collapses several distinct failures into one indistinguishable outcome, and it
    // makes PositionManager (not the adapter) the msg.sender that a hook's
    // beforeInitialize observes.
    function initializePool(PoolKey calldata key, uint160 sqrtPriceX96) external payable returns (int24);

    function nextTokenId() external view returns (uint256);

    function getPositionLiquidity(uint256 tokenId) external view returns (uint128 liquidity);

    function ownerOf(uint256 tokenId) external view returns (address);
}

// The slice of Permit2 (IAllowanceTransfer) this adapter uses.
// Selector verified against the deployed Permit2 on Base: 0x87517c45.
interface IPermit2Allowance {
    function approve(address token, address spender, uint160 amount, uint48 expiration) external;
}

// The one function BallistaV4Adapter reads on its hook, at construction only.
//
// Declared minimally rather than importing BallistaFeeHook so that the adapter does not
// drag the hook (and through it LFX1, and through that all of OpenZeppelin's ERC20 and
// Ownable) into its own compilation unit for a single view call.
interface IHookBinding {
    function adapter() external view returns (address);
}
