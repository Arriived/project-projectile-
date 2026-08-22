// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 [LICENSOR]. Licensed under the Business Source License 1.1.
// Change Date: 2030-09-16. Change License: GPL-2.0-or-later. See LICENSE.
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract LFX1Token is ERC20 {

    string public metadataURI;

    address public immutable creator;

    address public immutable factory;

    constructor(
        string memory name_,
        string memory symbol_,
        uint256 totalSupply_,
        address creator_,
        address mintTo_,
        string memory metadataURI_
    ) ERC20(name_, symbol_) {
        creator = creator_;
        factory = msg.sender;
        metadataURI = metadataURI_;
        _mint(mintTo_, totalSupply_);
    }

    function setMetadataURI(string calldata newURI) external {
        require(msg.sender == factory, "only the factory may update metadata");
        metadataURI = newURI;
    }
}
