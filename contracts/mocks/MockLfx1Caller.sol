// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IDEXRouter} from "../interfaces/IDEXRouter.sol";

// Sits BETWEEN LFX1 and BallistaV4Adapter, and is the adapter's `lfx1`.
//
// ⚠ WHY IT HAS TO BE IN THE MIDDLE RATHER THAN BESIDE. The adapter accepts exactly one
// caller. A suite that needs BOTH a real LFX1 graduation AND an attacker driving the
// adapter directly cannot have the real LFX1 in that slot -- the attacker would be
// refused -- and cannot have a bare mock in it either, because then LFX1's own
// graduation would be refused. Putting a permissionless forwarder in the slot and making
// it LFX1's router as well lets both reach the adapter, which is what restores the
// adversarial tests written before the gate existed.
//
// ⚠ WHAT THAT MEANS FOR WHAT THOSE TESTS PROVE. With this in place the adapter is
// effectively UN-GATED, which is the pre-gate world. That is deliberate: those attacks
// are retained as DEFENCE IN DEPTH -- they show the adapter's internals hold even if the
// outer gate is one day removed. Every one of them is paired with a sibling asserting
// that the same attack is refused outright on the real, gated configuration.
//
// It implements IDEXRouter exactly so LFX1 can be pointed at it unchanged.
contract MockLfx1Caller is IDEXRouter {
    address public adapter;

    error AdapterAlreadySet();

    // Set once, after the adapter is deployed -- the pair is circular otherwise.
    function setAdapter(address adapter_) external {
        if (adapter != address(0)) revert AdapterAlreadySet();
        adapter = adapter_;
    }

    function addLiquidity(
        address tokenA,
        address tokenB,
        uint256 amountADesired,
        uint256 amountBDesired,
        uint256 amountAMin,
        uint256 amountBMin,
        address to,
        uint256 deadline
    ) external override returns (uint256 amountA, uint256 amountB, uint256 liquidity) {
        IERC20(tokenA).transferFrom(msg.sender, address(this), amountADesired);
        IERC20(tokenB).transferFrom(msg.sender, address(this), amountBDesired);
        IERC20(tokenA).approve(adapter, amountADesired);
        IERC20(tokenB).approve(adapter, amountBDesired);
        return IDEXRouter(adapter).addLiquidity(
            tokenA, tokenB, amountADesired, amountBDesired, amountAMin, amountBMin, to, deadline
        );
    }
}
