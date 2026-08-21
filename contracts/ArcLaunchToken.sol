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

    /// @notice The Ballista factory that deployed this token.
    /// @dev The only address allowed to update metadataURI. Permissioning goes through
    ///      the factory rather than straight to the creator so the update EVENT lives on
    ///      one well-known address instead of being scattered across every token an
    ///      indexer would otherwise have to subscribe to individually.
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

    /// @notice Replaces the off-chain metadata pointer. Factory-only; the factory
    ///         checks that the caller is this token's creator and emits the audit event.
    /// @dev Deliberately NOT restricted beyond that. Socials are usually added after a
    ///      launch rather than before, and the alternative -- immutable metadata --
    ///      pushes creators into relaunching just to add a Telegram link.
    ///
    ///      The obvious abuse is launching with clean links, attracting buyers, then
    ///      swapping them. That is not preventable on-chain, so it is made VISIBLE
    ///      instead: every update emits old and new on the factory, and the frontend is
    ///      expected to surface "socials updated N hours ago" from those events.
    function setMetadataURI(string calldata newURI) external {
        require(msg.sender == factory, "only the factory may update metadata");
        metadataURI = newURI;
    }
}
