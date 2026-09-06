// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

// Attack fixtures for BallistaV4Adapter. TEST ONLY -- never deployed to a real network.
//
// These are 18-decimal, because the token side of a graduation is 18dp (LFX1Token extends
// OZ ERC20 and never overrides decimals()). The existing MockFeeOnTransferUSDC is 6dp and
// models the USDC side, so it answers a different question.

// An ERC20 that calls back into a chosen target at a chosen point in its own ERC20
// methods. Used to probe whether the adapter can be re-entered, and -- more importantly --
// whether a callback can reach something OTHER than the adapter while the adapter's
// Permit2 approvals are live.
//
// It RECORDS the outcome of the reentrant call instead of reverting on it. A fixture that
// reverts tells you only that something happened; one that records tells you what the
// attacker actually achieved, which is the question.
contract ReenteringToken is ERC20 {
    address public target;
    bytes public payload;
    uint8 public trigger; // 0 = disarmed, 1 = during transferFrom, 2 = during approve
    // ⚠ WHICH transferFrom matters, and it is not the first one. The adapter pulls the
    // token at step 1, BEFORE any approval is set and while the PoolManager is still
    // locked -- reentering there reaches nothing. The interesting call is the SECOND
    // one: Permit2 moving the token during settle, which happens INSIDE PoolManager's
    // unlock with both Permit2 approvals live. `skip` selects it.
    uint256 public skip;
    uint256 public seen;
    bool public fired;
    bool public callSucceeded;
    bytes public callReturndata;

    constructor() ERC20("Reentering", "REENT") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function arm(address target_, bytes calldata payload_, uint8 trigger_, uint256 skip_) external {
        target = target_;
        payload = payload_;
        trigger = trigger_;
        skip = skip_;
        seen = 0;
        fired = false;
        callSucceeded = false;
        callReturndata = "";
    }

    function _fire(uint8 at) private {
        if (trigger != at || fired) return;
        if (seen++ < skip) return;
        fired = true; // once only, or the recursion never terminates
        (bool ok, bytes memory ret) = target.call(payload);
        callSucceeded = ok;
        callReturndata = ret;
    }

    function transferFrom(address from, address to, uint256 value) public override returns (bool) {
        _fire(1);
        return super.transferFrom(from, to, value);
    }

    function approve(address spender, uint256 value) public override returns (bool) {
        bool r = super.approve(spender, value);
        _fire(2);
        return r;
    }
}

// A fee-on-transfer 18dp token. The adapter transfers in `amountADesired` and then
// approves and prices that same figure, so a token that delivers less than it claims
// leaves the adapter approving and pricing more than it holds.
contract FeeOnTransferToken18 is ERC20 {
    uint256 public immutable feeBps;

    constructor(uint256 feeBps_) ERC20("FeeOnTransfer", "FOT") {
        feeBps = feeBps_;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function _update(address from, address to, uint256 value) internal override {
        if (from == address(0) || to == address(0) || feeBps == 0) {
            super._update(from, to, value);
            return;
        }
        uint256 fee = (value * feeBps) / 10_000;
        super._update(from, to, value - fee);
        super._update(from, address(0xFEE), fee);
    }
}

// A plain 18dp token, for direct calls to the adapter that need a well-behaved
// counterparty rather than a hostile one.
contract PlainToken18 is ERC20 {
    constructor() ERC20("Plain", "PLAIN") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

// Calls the adapter and then, from inside the resulting token callback, calls it again.
// Exists to prove the ReentrancyGuard actually holds rather than assuming it does.
contract AdapterReenterer {
    address public immutable adapter;
    bool public secondCallSucceeded;
    bytes public secondCallReturndata;

    constructor(address adapter_) {
        adapter = adapter_;
    }

    function reenter(
        address tokenA,
        address tokenB,
        uint256 amountA,
        uint256 amountB,
        address to,
        uint256 deadline
    ) external {
        (bool ok, bytes memory ret) = adapter.call(
            abi.encodeWithSignature(
                "addLiquidity(address,address,uint256,uint256,uint256,uint256,address,uint256)",
                tokenA, tokenB, amountA, amountB, uint256(0), uint256(0), to, deadline
            )
        );
        secondCallSucceeded = ok;
        secondCallReturndata = ret;
    }
}

// Moves an EMPTY v4 pool to an exact target price.
//
// This is the recovery tool, and whether it works decides whether pool poisoning is a
// delay or a permanent loss -- the single most important distinction in this whole
// exercise (CLAUDE.md R7: a stall with a key is not a lock without one).
//
// It works, if it works, because a pool with zero liquidity has nothing to trade
// against: SwapMath.computeSwapStep consumes no input and simply advances the price to
// the target, so a swap bounded by sqrtPriceLimitX96 lands on that limit exactly and
// settles no currency. That is why `amountSpecified` here is a single wei -- the amount
// is irrelevant, the price limit does the work.
contract V4PriceMover is IUnlockCallback {
    using StateLibrary for IPoolManager;

    IPoolManager public immutable poolManager;

    constructor(IPoolManager poolManager_) {
        poolManager = poolManager_;
    }

    function moveTo(PoolKey calldata key, uint160 targetSqrtPriceX96) external {
        poolManager.unlock(abi.encode(key, targetSqrtPriceX96));
    }

    function unlockCallback(bytes calldata data) external override returns (bytes memory) {
        require(msg.sender == address(poolManager), "only pm");
        (PoolKey memory key, uint160 target) = abi.decode(data, (PoolKey, uint160));

        (uint160 current,,,) = poolManager.getSlot0(key.toId());
        poolManager.swap(
            key,
            SwapParams({
                zeroForOne: target < current,
                amountSpecified: -1, // exact input, one wei; the price limit does the work
                sqrtPriceLimitX96: target
            }),
            ""
        );
        return "";
    }
}

// Swaps a pool that DOES have liquidity to a target price, settling whatever it owes.
//
// V4PriceMover only works on an empty pool, where a swap consumes nothing. Once an
// attacker has backed a poisoned price with real liquidity, correcting it means trading
// against that liquidity and PAYING for it -- which is the difference between a griefing
// attack that costs the attacker nothing and one that costs them their position. This
// measures which.
//
// Fund it with tokens first; it settles what it owes out of its own balance and keeps
// whatever the swap returns, so the caller can read the cost as a balance delta.
contract V4Swapper is IUnlockCallback {
    using StateLibrary for IPoolManager;

    IPoolManager public immutable poolManager;

    constructor(IPoolManager poolManager_) {
        poolManager = poolManager_;
    }

    function swapToPrice(PoolKey calldata key, uint160 target) external {
        poolManager.unlock(abi.encode(key, target));
    }

    function unlockCallback(bytes calldata data) external override returns (bytes memory) {
        require(msg.sender == address(poolManager), "only pm");
        (PoolKey memory key, uint160 target) = abi.decode(data, (PoolKey, uint160));

        (uint160 current,,,) = poolManager.getSlot0(key.toId());
        // A very large exact-input, bounded by the price limit: the swap stops when the
        // price reaches the target rather than when the input is exhausted.
        BalanceDelta d = poolManager.swap(
            key,
            SwapParams({
                zeroForOne: target < current,
                amountSpecified: -1e30,
                sqrtPriceLimitX96: target
            }),
            ""
        );
        _resolve(key.currency0, d.amount0());
        _resolve(key.currency1, d.amount1());
        return "";
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
