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
interface IBXR1 {
    function buy(address token, uint256 quoteIn, uint256 minTokensOut) external;
    function sell(address token, uint256 tokensIn, uint256 minQuoteOut) external;
    function graduate(address token) external;
    function claimCreatorFees(address asset) external returns (uint256);
    function createToken(string calldata, string calldata, string calldata, address, bytes32, bool)
        external returns (address);
    function currentEconomicsHash() external view returns (bytes32);
    function claimTreasuryFees(address asset) external returns (uint256);
    function creatorLaunchBuy(address token, uint256 quoteIn, uint256 minTokensOut) external;
    function updateMetadataURI(address token, string calldata newURI) external;
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
    bool public creatorLaunchBuyReentered;
    bool public updateMetadataReentered;

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
        try ballista.creatorLaunchBuy(token, 1e6, 0) { creatorLaunchBuyReentered = true; } catch {}
        try ballista.createToken("R", "REENT", "u", quoteAsset, ballista.currentEconomicsHash(), false) {
            createTokenReentered = true;
        } catch {}
        try ballista.updateMetadataURI(token, "reentered") { updateMetadataReentered = true; } catch {}

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
        return ballista.createToken(name, symbol, "ipfs://x", quoteAsset, ballista.currentEconomicsHash(), false);
    }

    fallback() external payable { revert("HostileCreator: no"); }
    receive() external payable { revert("HostileCreator: no"); }
}

contract BXR1MassLauncher {
    IBXR1 public immutable ballista;
    address public immutable quoteAsset;
    address[] public launched;

    constructor(address b, address quoteAsset_) {
        ballista = IBXR1(b);
        quoteAsset = quoteAsset_;
    }

    function launchMany(string calldata prefix, uint256 n) external {
        for (uint256 i = 0; i < n; i++) {
            launched.push(
                ballista.createToken(
                    prefix,
                    string.concat(prefix, _toString(i)),
                    "ipfs://x",
                    quoteAsset,
                    ballista.currentEconomicsHash()
                , false)
            );
        }
    }

    function count() external view returns (uint256) { return launched.length; }

    function _toString(uint256 v) internal pure returns (string memory) {
        if (v == 0) return "0";
        uint256 d; uint256 t = v;
        while (t != 0) { d++; t /= 10; }
        bytes memory buf = new bytes(d);
        while (v != 0) { d--; buf[d] = bytes1(uint8(48 + v % 10)); v /= 10; }
        return string(buf);
    }
}

contract BXR1LauncherFactory {
    address public immutable ballista;
    address public immutable quoteAsset;
    address[] public children;

    constructor(address b, address quoteAsset_) {
        ballista = b;
        quoteAsset = quoteAsset_;
    }

    function spawnAndLaunch(string calldata, uint256 n) external {
        for (uint256 i = 0; i < n; i++) {
            BXR1MassLauncher child = new BXR1MassLauncher(ballista, quoteAsset);
            children.push(address(child));
        }
    }

    function count() external view returns (uint256) { return children.length; }
}
