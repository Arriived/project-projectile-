// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 [LICENSOR]. Licensed under the Business Source License 1.1.
// Change Date: 2030-09-16. Change License: GPL-2.0-or-later. See LICENSE.
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "../interfaces/IDEXRouter.sol";

interface IBallista {
    function buy(address token, uint256 usdcIn, uint256 minTokensOut) external;
    function sell(address token, uint256 tokensIn, uint256 minUsdcOut) external;
    function graduate(address token) external;
    function claimCreatorFees() external returns (uint256);
    function createToken(string calldata, string calldata, string calldata, bytes32, bool)
        external returns (address);
    function currentEconomicsHash() external view returns (bytes32);
}

contract MaliciousRouter is IDEXRouter {
    address public immutable thief;

    constructor(address thief_) { thief = thief_; }

    function addLiquidity(
        address tokenA,
        address tokenB,
        uint256 amountADesired,
        uint256 amountBDesired,
        uint256,
        uint256,
        address,
        uint256
    ) external returns (uint256, uint256, uint256) {

        IERC20(tokenA).transferFrom(msg.sender, thief, amountADesired);
        IERC20(tokenB).transferFrom(msg.sender, thief, amountBDesired);

        return (amountADesired, amountBDesired, 1);
    }
}

contract ReentrantRouter is IDEXRouter {
    IBallista public immutable ballista;
    address public token;
    string public lastFailure;
    bool public reenterAttempted;

    constructor(address ballista_) { ballista = IBallista(ballista_); }
    function setToken(address t) external { token = t; }

    function addLiquidity(
        address, address, uint256 a, uint256 b, uint256, uint256, address, uint256
    ) external returns (uint256, uint256, uint256) {
        reenterAttempted = true;

        try ballista.buy(token, 1e6, 0) { lastFailure = "BUY REENTERED"; }
        catch { lastFailure = "buy blocked"; }
        try ballista.sell(token, 1e18, 0) { lastFailure = "SELL REENTERED"; }
        catch { lastFailure = string.concat(lastFailure, " | sell blocked"); }
        try ballista.graduate(token) { lastFailure = string.concat(lastFailure, " | GRADUATE REENTERED"); }
        catch { lastFailure = string.concat(lastFailure, " | graduate blocked"); }
        try ballista.claimCreatorFees() { lastFailure = string.concat(lastFailure, " | CLAIM REENTERED"); }
        catch { lastFailure = string.concat(lastFailure, " | claim blocked"); }
        return (a, b, 1);
    }
}

contract GasGuzzlerRouter is IDEXRouter {
    uint256 public sink;
    function addLiquidity(
        address, address, uint256, uint256, uint256, uint256, address, uint256
    ) external returns (uint256, uint256, uint256) {
        while (true) { sink++; }
        return (0, 0, 0);
    }
}

contract GarbageRouter is IDEXRouter {
    function addLiquidity(
        address, address, uint256, uint256, uint256, uint256, address, uint256
    ) external pure returns (uint256, uint256, uint256) {
        return (type(uint256).max, type(uint256).max, type(uint256).max);
    }
}

contract HostileCreator {
    IBallista public immutable ballista;
    constructor(address b) { ballista = IBallista(b); }

    function launch(string calldata name, string calldata symbol) external returns (address) {
        return ballista.createToken(name, symbol, "ipfs://x", ballista.currentEconomicsHash(), false);
    }

    fallback() external payable { revert("HostileCreator: no"); }
    receive() external payable { revert("HostileCreator: no"); }
}

contract MassLauncher {
    IBallista public immutable ballista;
    address[] public launched;

    constructor(address b) { ballista = IBallista(b); }

    function launchMany(string calldata prefix, uint256 n) external {
        for (uint256 i = 0; i < n; i++) {
            launched.push(
                ballista.createToken(
                    prefix,
                    string.concat(prefix, _toString(i)),
                    "ipfs://x",
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

contract LauncherFactory {
    address public immutable ballista;
    address[] public children;

    constructor(address b) { ballista = b; }

    function spawnAndLaunch(string calldata, uint256 n) external {
        for (uint256 i = 0; i < n; i++) {
            MassLauncher child = new MassLauncher(ballista);
            children.push(address(child));
        }
    }

    function count() external view returns (uint256) { return children.length; }
}

contract PartialConsumeRouter is IDEXRouter {
    address public immutable beneficiary;
    constructor(address b) { beneficiary = b; }

    function addLiquidity(
        address tokenA, address tokenB, uint256 amountADesired, uint256 amountBDesired,
        uint256, uint256, address to, uint256
    ) external returns (uint256, uint256, uint256) {

        IERC20(tokenA).transferFrom(msg.sender, to, amountADesired / 2);
        IERC20(tokenB).transferFrom(msg.sender, address(this), amountBDesired / 2);
        return (amountADesired / 2, amountBDesired / 2, 1);
    }

    function sweepResidualAllowance(address usdcAddr, address factory) external returns (uint256) {
        uint256 remaining = IERC20(usdcAddr).allowance(factory, address(this));
        if (remaining == 0) return 0;
        uint256 bal = IERC20(usdcAddr).balanceOf(factory);
        uint256 take = remaining < bal ? remaining : bal;
        IERC20(usdcAddr).transferFrom(factory, beneficiary, take);
        return take;
    }
}
