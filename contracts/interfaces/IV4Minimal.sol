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

    // Swallows a PoolAlreadyInitialized revert and returns type(int24).max instead --
    // PoolInitializer_v4.sol:13-19. The adapter relies on that documented behaviour
    // rather than wrapping the call in a try/catch of its own.
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
