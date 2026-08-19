// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice Test-only USDC stand-in that can refuse transfers to specific addresses,
///         mirroring the blocklist real Circle USDC actually enforces.
/// @dev This is the realistic version of "the creator cannot receive funds". A plain
///      ERC20 has no recipient callback, so a creator contract cannot reject an
///      incoming transfer by reverting — but a blocklisted creator address makes the
///      transfer itself revert, which is exactly the case that would brick every trade
///      on a token if creator fees were pushed inside buy()/sell() instead of accrued.
///      Never deploy anything like this to a real network.
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
