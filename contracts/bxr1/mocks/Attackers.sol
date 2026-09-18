// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "../../interfaces/IDEXRouter.sol";

// BXR1-specific subset of contracts/mocks/Attackers.sol -- ONLY the four contracts whose
// IBallista interface calls createToken/claimCreatorFees/claimTreasuryFees, which BXR1
// changed the signature of (a quote asset argument, per-asset accrual). The other four
// contracts in the original file (MaliciousRouter, GasGuzzlerRouter, GarbageRouter,
// PartialConsumeRouter) implement only IDEXRouter.addLiquidity, which is untouched and
// asset-agnostic already, so they are reused directly from the original file -- there is
// no BXR1 copy of them, and none is needed.
//
// Renamed with a BXR1 prefix (BXR1ReentrantRouter, not ReentrantRouter) so this file can
// compile alongside the untouched original without a duplicate-contract-name collision
// in Hardhat's artifact lookup.
// creatorLaunchBuy and updateMetadataURI were removed from BXR1 entirely 2026-09-18
// (see CLAUDE.md section 26) and are gone from this interface too, rather than kept
// as declarations for functions that no longer exist on the real contract.
interface IBXR1 {
    function buy(address token, uint256 quoteIn, uint256 minTokensOut) external;
    function sell(address token, uint256 tokensIn, uint256 minQuoteOut) external;
    function graduate(address token) external;
    function claimCreatorFees(address asset) external returns (uint256);
    function createToken(string calldata, string calldata, string calldata, address, bytes32)
        external returns (address);
    // Asset-scoped, per the graduation threshold moving into AssetRegistry -- see
    // BXR1.sol. Every call site below now passes the quote asset explicitly.
    function currentEconomicsHash(address quoteAsset) external view returns (bytes32);
    function claimTreasuryFees(address asset) external returns (uint256);
}

contract BXR1ReentrantRouter is IDEXRouter {
    IBXR1 public immutable ballista;
    address public immutable quoteAsset;
    address public token;
    bool public reenterAttempted;

    bool public buyReentered;
    bool public sellReentered;
    bool public graduateReentered;
    bool public claimCreatorReentered;
    bool public claimTreasuryReentered;
    bool public createTokenReentered;

    constructor(address ballista_, address quoteAsset_) {
        ballista = IBXR1(ballista_);
        quoteAsset = quoteAsset_;
    }
    function setToken(address t) external { token = t; }

    function addLiquidity(
        address, address, uint256 a, uint256 b, uint256, uint256, address, uint256
    ) external returns (uint256, uint256, uint256) {
        reenterAttempted = true;

        try ballista.buy(token, 1e6, 0) { buyReentered = true; } catch {}
        try ballista.sell(token, 1e18, 0) { sellReentered = true; } catch {}
        try ballista.graduate(token) { graduateReentered = true; } catch {}
        try ballista.claimCreatorFees(quoteAsset) { claimCreatorReentered = true; } catch {}
        try ballista.claimTreasuryFees(quoteAsset) { claimTreasuryReentered = true; } catch {}
        try ballista.createToken("R", "REENT", "u", quoteAsset, ballista.currentEconomicsHash(quoteAsset)) {
            createTokenReentered = true;
        } catch {}

        return (a, b, 1);
    }
}

contract BXR1HostileCreator {
    IBXR1 public immutable ballista;
    address public immutable quoteAsset;
    constructor(address b, address quoteAsset_) {
        ballista = IBXR1(b);
        quoteAsset = quoteAsset_;
    }

    function launch(string calldata name, string calldata symbol) external returns (address) {
        return ballista.createToken(name, symbol, "ipfs://x", quoteAsset, ballista.currentEconomicsHash(quoteAsset));
    }

    fallback() external payable { revert("HostileCreator: no"); }
    receive() external payable { revert("HostileCreator: no"); }
}

// BXR1MassLauncher and BXR1LauncherFactory were removed 2026-09-18, along with
// launchCooldown itself (CLAUDE.md section 26). Both existed solely to demonstrate
// that the cooldown was per-address and trivially bypassable by launching from a
// fresh contract each time; with no cooldown left at all, there is nothing left to
// demonstrate a bypass of.
