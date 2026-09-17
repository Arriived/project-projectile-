// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

// BXR1-specific copy of contracts/mocks/CreatorLauncher.sol. The original's
// IBallistaLaunch interface hardcodes LFX1's five-argument createToken signature;
// BXR1's createToken takes a sixth argument, the quote asset, so a call through the old
// interface would encode the wrong selector entirely. Renamed (BXR1CreatorLauncher, not
// CreatorLauncher) so this file can compile alongside the untouched original without a
// duplicate-artifact-name collision in Hardhat.
interface IBXR1Launch {
    function createToken(string calldata, string calldata, string calldata, address, bytes32, bool)
        external returns (address);
    // Asset-scoped, per the graduation threshold moving into AssetRegistry -- see
    // BXR1.sol. Every call site below now passes address(usdc) explicitly.
    function currentEconomicsHash(address quoteAsset) external view returns (bytes32);
    function creatorLaunchBuy(address token, uint256 quoteIn, uint256 minTokensOut) external;
    function sell(address token, uint256 tokensIn, uint256 minQuoteOut) external;
}

contract BXR1CreatorLauncher {
    IBXR1Launch public immutable ballista;
    IERC20 public immutable usdc;
    address public token;

    constructor(address ballista_, address usdc_) {
        ballista = IBXR1Launch(ballista_);
        usdc = IERC20(usdc_);
    }

    function approveAll() external {
        usdc.approve(address(ballista), type(uint256).max);
    }

    function launchAndLoop(string calldata symbol, uint256 quoteEach, uint256 times)
        external
        returns (address)
    {
        token = ballista.createToken("Loop", symbol, "ipfs://x", address(usdc), ballista.currentEconomicsHash(address(usdc)), false);
        for (uint256 i = 0; i < times; i++) {

            try ballista.creatorLaunchBuy(token, quoteEach, 0) {} catch {}
        }
        return token;
    }

    function launchBuyApproveAndDump(string calldata symbol, uint256 quoteIn)
        external
        returns (bool sellReverted, bytes memory err)
    {
        token = ballista.createToken("Dump", symbol, "ipfs://x", address(usdc), ballista.currentEconomicsHash(address(usdc)), false);
        ballista.creatorLaunchBuy(token, quoteIn, 0);
        uint256 held = IERC20(token).balanceOf(address(this));
        IERC20(token).approve(address(ballista), held);
        try ballista.sell(token, held, 0) {
            sellReverted = false;
        } catch (bytes memory reason) {
            sellReverted = true;
            err = reason;
        }
    }
}
