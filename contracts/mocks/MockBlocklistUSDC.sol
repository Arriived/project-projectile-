// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract MockBlocklistUSDC is ERC20 {
    mapping(address => bool) public blocked;

    constructor() ERC20("Mock Blocklist USDC", "bUSDC") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function setBlocked(address account, bool isBlocked) external {
        blocked[account] = isBlocked;
    }

    function _update(address from, address to, uint256 value) internal override {
        require(!blocked[to], "MockBlocklistUSDC: recipient blocked");
        require(!blocked[from], "MockBlocklistUSDC: sender blocked");
        super._update(from, to, value);
    }
}
