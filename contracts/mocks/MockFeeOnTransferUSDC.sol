// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 [LICENSOR]. Licensed under the Business Source License 1.1.
// Change Date: 2030-09-16. Change License: GPL-2.0-or-later. See LICENSE.
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice TEST ONLY. A USDC stand-in that takes 1bp on every transfer, so the
///         recipient receives less than the amount requested.
///
///         This exists to prove the balance-delta check in _settleBuy can go RED. A
///         test written against a well-behaved mock passes whether or not the check is
///         there, which makes it worthless as evidence. Circle's USDC is not
///         fee-on-transfer and this is not a prediction that it will become so -- the
///         point is that the failure would otherwise be SILENT: reserves credited from
///         the requested amount while less arrived, socialised across every curve
///         sharing the pooled balance, and surfacing only when the last sellers found
///         the pot short.
contract MockFeeOnTransferUSDC is ERC20 {
    uint256 public constant FEE_BPS = 1; // 1bp

    constructor() ERC20("Mock Fee-on-Transfer USDC", "fUSDC") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function _update(address from, address to, uint256 value) internal override {
        // Mints and burns move at face value; only transfers between holders are taxed,
        // which is how a real fee-on-transfer token behaves.
        if (from == address(0) || to == address(0)) {
            super._update(from, to, value);
            return;
        }
        uint256 fee = (value * FEE_BPS) / 10_000;
        if (fee == 0) {
            super._update(from, to, value);
            return;
        }
        super._update(from, to, value - fee);
        super._update(from, address(0), fee); // burn the fee
    }
}
