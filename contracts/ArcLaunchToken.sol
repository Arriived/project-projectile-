// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title ArcLaunchToken
/// @notice Fixed-supply ERC20 deployed by ArcLaunchFactory for each new token launch.
/// @dev Entire supply is minted ONCE, in the constructor, to the factory. There is no
///      mint() function anywhere in this contract — this is deliberate. A mintable
///      post-launch token is the single most common rug-pull vector (creator quietly
///      inflates supply after people have bought in). Removing the capability entirely,
///      rather than just not calling it, means holders don't have to trust a promise —
///      they can verify it by reading the contract.
contract ArcLaunchToken is ERC20 {
    /// @notice Off-chain metadata pointer (e.g. IPFS/Arweave URI) holding image, description,
    ///         and social links. Kept as a simple string so the factory can index/display it
    ///         without needing a separate on-chain registry.
    string public metadataURI;

    /// @notice The wallet that requested this token's creation. Recorded on-chain (not just
    ///         in a backend DB) so a creator's launch history can be reconstructed by anyone,
    ///         directly from the chain — this is the raw data the reputation/Launch Health
    ///         Score layer reads from.
    address public immutable creator;

    constructor(
        string memory name_,
        string memory symbol_,
        uint256 totalSupply_,
        address creator_,
        address mintTo_,
        string memory metadataURI_
    ) ERC20(name_, symbol_) {
        creator = creator_;
        metadataURI = metadataURI_;
        _mint(mintTo_, totalSupply_);
    }
}
