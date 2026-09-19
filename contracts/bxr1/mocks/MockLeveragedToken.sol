// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "../interfaces/ILeveragedToken.sol";

// 18-decimal ERC20 (OZ's own default -- no override) standing in for a Bounce-style
// leveraged token registered as a LEVERAGED quote asset: buyers hold and spend it via
// the curve exactly like MockUSDC/MockDAI, and AssetRegistry additionally reads its
// exchangeRate() to convert the registry's USD-denominated launch terms into this
// token's own raw units at createToken time.
//
// `setShouldRevert` gives test/bxr1/LeveragedLaunch.test.js the other half of
// AssetRegistry's "rate == 0 or a reverting exchangeRate() both revert" requirement --
// a rate of 0 is reachable via setRate(0) alone, a reverting call needs this.
contract MockLeveragedToken is ERC20, ILeveragedToken {
    uint256 private _rate;
    bool public shouldRevert;

    error MockLeveragedTokenReverts();

    constructor(uint256 initialRate) ERC20("Mock Leveraged Token", "mLT") {
        _rate = initialRate;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function setRate(uint256 rate) external {
        _rate = rate;
    }

    function setShouldRevert(bool value) external {
        shouldRevert = value;
    }

    function exchangeRate() external view returns (uint256) {
        if (shouldRevert) revert MockLeveragedTokenReverts();
        return _rate;
    }
}
