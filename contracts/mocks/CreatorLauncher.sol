// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

interface IBallistaLaunch {
    function createToken(string calldata, string calldata, string calldata, bytes32, bool)
        external returns (address);
    function currentEconomicsHash() external view returns (bytes32);
    function creatorLaunchBuy(address token, uint256 usdcIn, uint256 minTokensOut) external;
    function sell(address token, uint256 tokensIn, uint256 minUsdcOut) external;
}

contract CreatorLauncher {
    IBallistaLaunch public immutable ballista;
    IERC20 public immutable usdc;
    address public token;

    constructor(address ballista_, address usdc_) {
        ballista = IBallistaLaunch(ballista_);
        usdc = IERC20(usdc_);
    }

    function approveAll() external {
        usdc.approve(address(ballista), type(uint256).max);
    }

    function launchAndLoop(string calldata symbol, uint256 usdcEach, uint256 times)
        external
        returns (address)
    {
        token = ballista.createToken("Loop", symbol, "ipfs://x", ballista.currentEconomicsHash(), false);
        for (uint256 i = 0; i < times; i++) {

            try ballista.creatorLaunchBuy(token, usdcEach, 0) {} catch {}
        }
        return token;
    }

    function launchBuyApproveAndDump(string calldata symbol, uint256 usdcIn)
        external
        returns (bool sellReverted, bytes memory err)
    {
        token = ballista.createToken("Dump", symbol, "ipfs://x", ballista.currentEconomicsHash(), false);
        ballista.creatorLaunchBuy(token, usdcIn, 0);
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
