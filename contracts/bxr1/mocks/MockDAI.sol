// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

// A second, differently-decimaled mock quote asset for BXR1's asset-genericity tests.
// 18 decimals (OZ ERC20's own default -- no override, unlike MockUSDC's 6), standing in
// for a DAI-shaped stablecoin so a curve quoted in it can be compared directly against
// one quoted in 6-decimal USDC.
contract MockDAI is ERC20 {
    constructor() ERC20("Mock DAI", "mDAI") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
