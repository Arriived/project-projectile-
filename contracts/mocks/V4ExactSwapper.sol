// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";

// Drives EXACT-INPUT and EXACT-OUTPUT swaps with controlled amounts. TEST ONLY.
//
// The existing V4Swapper only does swapToPrice, which bounds the swap by a price limit and
// leaves the amounts to fall out. Rows 23, 25 and 31 assert a fee that is a fixed fraction
// of a specific amount, so they need the amount to be the input, not the output.
//
// ⚠ WHAT THIS RECORDS, AND WHY THERE ARE TWO DIFFERENT DELTAS.
// PoolManager.swap returns the swapper's NET delta -- the hook's afterSwap delta has
// already been applied to it (PoolManager.sol:35 reassigns swapDelta from
// key.hooks.afterSwap, and :40 accounts that adjusted value to msg.sender). The hook, by
// contrast, is handed the PRE-hook gross delta. So:
//
//   netAmount0/1     what the trader actually receives or pays, fee already deducted
//   FeeAccrued's     the pool's GROSS deltas, which is what the fee is a fraction of
//   amount0/amount1
//
// A test that compares the fee against the NET amount is off by the fee itself. Both are
// recorded here so the assertion can name which one it means.
//
// ⚠ AND IT MUST BE PROVED BEFORE IT IS TRUSTED. A swapper that quietly swaps something
// other than what it was asked makes every fee assertion downstream green and meaningless
// -- the same class as the etched Arachnid runtime being one byte wrong. spent0/spent1
// and gained0/gained1 are measured from THIS CONTRACT'S OWN BALANCES across the unlock,
// independently of anything PoolManager reports, so the self-proof in the test suite can
// check the swapper against a source the swapper does not control.
contract V4ExactSwapper is IUnlockCallback {
    IPoolManager public immutable poolManager;

    int128 public netAmount0;
    int128 public netAmount1;
    uint256 public spent0;
    uint256 public spent1;
    uint256 public gained0;
    uint256 public gained1;

    constructor(IPoolManager poolManager_) {
        poolManager = poolManager_;
    }

    /// @param amountSpecified NEGATIVE for exact input, POSITIVE for exact output.
    function swap(PoolKey calldata key, bool zeroForOne, int256 amountSpecified) external {
        uint256 b0 = _bal(key.currency0);
        uint256 b1 = _bal(key.currency1);

        poolManager.unlock(abi.encode(key, zeroForOne, amountSpecified));

        uint256 a0 = _bal(key.currency0);
        uint256 a1 = _bal(key.currency1);
        spent0 = b0 > a0 ? b0 - a0 : 0;
        gained0 = a0 > b0 ? a0 - b0 : 0;
        spent1 = b1 > a1 ? b1 - a1 : 0;
        gained1 = a1 > b1 ? a1 - b1 : 0;
    }

    function unlockCallback(bytes calldata data) external override returns (bytes memory) {
        require(msg.sender == address(poolManager), "only pm");
        (PoolKey memory key, bool zeroForOne, int256 amountSpecified) =
            abi.decode(data, (PoolKey, bool, int256));

        BalanceDelta d = poolManager.swap(
            key,
            SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: amountSpecified,
                // Wide open: the swap must be bounded by the AMOUNT, never by the price,
                // or "exact input" quietly becomes "as much as the limit allowed".
                sqrtPriceLimitX96: zeroForOne
                    ? TickMath.MIN_SQRT_PRICE + 1
                    : TickMath.MAX_SQRT_PRICE - 1
            }),
            ""
        );
        netAmount0 = d.amount0();
        netAmount1 = d.amount1();
        _resolve(key.currency0, d.amount0());
        _resolve(key.currency1, d.amount1());
        return "";
    }

    function _bal(Currency c) private view returns (uint256) {
        return IERC20(Currency.unwrap(c)).balanceOf(address(this));
    }

    function _resolve(Currency c, int128 amt) private {
        if (amt < 0) {
            uint256 owed = uint256(uint128(-amt));
            poolManager.sync(c);
            IERC20(Currency.unwrap(c)).transfer(address(poolManager), owed);
            poolManager.settle();
        } else if (amt > 0) {
            poolManager.take(c, address(this), uint256(uint128(amt)));
        }
    }
}
