// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {BallistaFeeHook} from "../BallistaFeeHook.sol";
import {BaseHook} from "@uniswap/v4-periphery/src/utils/BaseHook.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {LFX1} from "../LFX1.sol";

// The real hook, deployable at an address whose low bits do NOT carry the permission
// flags.
//
// WHY THIS IS NOT A COPY. It overrides exactly one function -- validateHookAddress --
// which v4-periphery declares `virtual` for precisely this purpose ("this function is
// virtual so that we can override it during testing", BaseHook.sol:28-30). Everything
// else, the constructor body included, is BallistaFeeHook's own code. A harness that
// restated any of the logic would be the failure CLAUDE.md 14.2.1 records: a check that
// passes against a copy while the real thing drifts.
//
// ⚠ IT MUST NEVER BE DEPLOYED ANYWHERE REAL. Without the address check, a hook deployed
// through this path has permission bits that disagree with getHookPermissions(), which is
// the silent failure the whole salt-mining exercise exists to prevent.
contract BallistaFeeHookTestable is BallistaFeeHook {
    constructor(
        IPoolManager poolManager_,
        LFX1 lfx1_,
        address usdc_,
        address protocolRecipient_,
        address adapter_
    ) BallistaFeeHook(poolManager_, lfx1_, usdc_, protocolRecipient_, adapter_) {}

    function validateHookAddress(BaseHook) internal pure override {}
}
