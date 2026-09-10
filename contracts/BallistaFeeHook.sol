// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {BaseHook} from "@uniswap/v4-periphery/src/utils/BaseHook.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta, BalanceDeltaLibrary} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";

import {LFX1} from "./LFX1.sol";

// Takes 1% of every swap on a graduated Ballista pool and splits it 50/50 between the
// protocol and the token's creator. That is the whole product. There is no buyback, no
// vesting, no creator tax, no custom pair asset, no conversion swap, and no owner.
//
// OWNERLESS BY CONSTRUCTION. No owner, no admin, no pause, no upgrade, no withdraw, no
// rescue, no delegatecall, no selfdestruct. The complete external surface is listed in the
// header block above `sweep` and is meant to be checked by exhaustion rather than by
// grepping for "Ownable".
//
// ─── WHY THE ESCROW LIVES IN THIS FILE ──────────────────────────────────────────────
// The pull-based property comes from CREDITING rather than TRANSFERRING, not from the
// balances living in another contract. Splitting them out would need its own
// authorisation (only this hook may credit), which is a new trust edge, a new immutable
// in both directions, and a fourth contract in the immutable cycle described in
// CLAUDE.md section 20.6 -- for no gain. Two mappings and two claim functions is the
// smallest thing that works.
//
// ─── THE IMMUTABLE CYCLE (CLAUDE.md section 20.6) ───────────────────────────────────
// LFX1 : adapter : hook is one set, permanently. The adapter holds this hook's address
// because `hooks` is a PoolKey member; this hook holds the adapter's address because that
// is its gate. Both are immutable, so replacing either means replacing the set and
// starting new pools -- a hook change is a different PoolId (PoolId.sol:14 hashes all
// five key slots) and burned liquidity can never migrate.
//
// ⚠ THE CONSTRUCTOR MUST NEVER READ msg.sender, AND IT DOES NOT.
// This contract is deployed through the permissionless Arachnid CREATE2 deployer, whose
// address derivation does not include the caller. Anyone who learns the salt and the
// initcode can therefore deploy it first. That is harmless ONLY because every immutable
// below comes from a constructor argument -- the resulting contract is byte-identical
// whoever sends the transaction, and the deployer gains nothing. Introducing any
// msg.sender-derived state here would turn a benign front-run into a theft.
contract BallistaFeeHook is BaseHook {
    using SafeERC20 for IERC20;
    using PoolIdLibrary for PoolKey;
    using BalanceDeltaLibrary for BalanceDelta;

    // ─── constants ──────────────────────────────────────────────────────────────────
    // 1% of the unspecified side of every swap.
    uint256 public constant FEE_BPS = 100;
    uint256 public constant BPS_DENOMINATOR = 10_000;

    // Pinned to what the adapter builds. These are defence in depth rather than the
    // load-bearing gate -- `sender == adapter` already means only the adapter can reach
    // here, and it always builds this exact key. They exist so that a future adapter
    // change cannot silently register a pool on different terms.
    uint24 public constant REQUIRED_FEE = 0;
    int24 public constant REQUIRED_TICK_SPACING = 60;

    // ─── immutables ─────────────────────────────────────────────────────────────────
    // `adapter` is LAST in the constructor by convention: scripts/mine-hook-salt.js
    // appends the predicted CREATE address as the final argument when it builds the
    // initcode it mines against.
    LFX1 public immutable lfx1;
    address public immutable usdc;
    address public immutable protocolRecipient;
    address public immutable adapter;

    // ─── state ──────────────────────────────────────────────────────────────────────
    struct Launch {
        address token; // the non-USDC currency
        address feeRecipient; // starts as LFX1's creator; transferable by its holder
        bool usdcIsCurrency0;
        bool registered;
    }

    mapping(PoolId => Launch) public launches;

    // Accrued but not yet split. Two slots rather than a currency-keyed mapping because a
    // Ballista pool has exactly two currencies, both known at registration.
    mapping(PoolId => uint256) public pendingUsdc;
    mapping(PoolId => uint256) public pendingToken;

    // The escrow. Credited by sweep, drained by the recipient.
    mapping(address => uint256) public owedUsdc;
    mapping(address => mapping(address => uint256)) public owedToken;

    // ─── events ─────────────────────────────────────────────────────────────────────
    //
    // ⚠ THE EVENT SURFACE IS A DELIVERABLE, NOT AN AFTERTHOUGHT, BECAUSE IT CANNOT BE
    // ADDED LATER. This hook returns an afterSwap delta, so PoolManager's own `Swap`
    // event reports the pool's internal swap and NOT what the trader actually paid --
    // Uniswap Foundation flag this exact class in their v4 analytics disclosure. An
    // indexer that reads only `Swap` will overstate what the trader received on an
    // exact-input swap by precisely the fee below.
    //
    // FeeAccrued therefore carries the pool's own swap deltas alongside the fee, so true
    // volume, true price and the trader's true net are all derivable FROM THIS EVENT
    // ALONE, with no join against PoolManager's log:
    //   trader net on currency0 = amount0 - (currency == currency0 ? feeAmount : 0)
    //   trader net on currency1 = amount1 - (currency == currency1 ? feeAmount : 0)
    //   execution price         = |amount1 / amount0|   (pool-internal, pre-fee)
    //   direction               = amount0 < 0  =>  zeroForOne
    // `zeroForOne` is deliberately NOT emitted: it is recoverable from the sign of
    // amount0, and this event is written on every trade forever.
    event PoolRegistered(
        PoolId indexed poolId,
        address indexed token,
        address indexed creator,
        bool usdcIsCurrency0,
        uint24 fee,
        int24 tickSpacing
    );

    event FeeAccrued(
        PoolId indexed poolId, address indexed currency, uint256 feeAmount, int128 amount0, int128 amount1
    );

    event FeesSwept(
        PoolId indexed poolId,
        address indexed token,
        address indexed feeRecipient,
        uint256 usdcToProtocol,
        uint256 usdcToCreator,
        uint256 tokenToProtocol,
        uint256 tokenToCreator
    );

    event FeeRecipientTransferred(PoolId indexed poolId, address indexed previous, address indexed next);

    event Claimed(address indexed recipient, address indexed currency, uint256 amount);

    // ─── errors ─────────────────────────────────────────────────────────────────────
    error NotAdapter(address sender);
    error WrongFee(uint24 fee);
    error WrongTickSpacing(int24 tickSpacing);
    error WrongHook(address hooks);
    error NoUsdcSide(address currency0, address currency1);
    error UnknownCurve(address token);
    error ZeroCreator(address token);
    error UnknownPool(PoolId poolId);
    error NotFeeRecipient(address sender);
    error ZeroAddress();
    error NothingOwed();

    constructor(
        IPoolManager poolManager_,
        LFX1 lfx1_,
        address usdc_,
        address protocolRecipient_,
        address adapter_
    ) BaseHook(poolManager_) {
        if (
            address(lfx1_) == address(0) || usdc_ == address(0) || protocolRecipient_ == address(0)
                || adapter_ == address(0)
        ) revert ZeroAddress();
        lfx1 = lfx1_;
        usdc = usdc_;
        protocolRecipient = protocolRecipient_;
        adapter = adapter_;
    }

    // ⚠ BaseHook's constructor calls validateHookAddress(this), which compares ALL
    // FOURTEEN permission bits of this contract's own address against the struct below
    // and reverts HookAddressNotValid otherwise (Hooks.sol validateHookPermissions).
    // So a mis-mined salt fails LOUDLY at deploy rather than producing a hook whose
    // afterSwap is never invoked. That check and scripts/mine-hook-salt.js are
    // complementary and neither replaces the other: this one proves the address matches
    // what we DECLARE here, the miner proves what we declare matches the three flags we
    // actually need.
    function getHookPermissions() public pure override returns (Hooks.Permissions memory) {
        return Hooks.Permissions({
            beforeInitialize: true,
            afterInitialize: false,
            beforeAddLiquidity: false,
            afterAddLiquidity: false,
            beforeRemoveLiquidity: false,
            afterRemoveLiquidity: false,
            beforeSwap: false,
            afterSwap: true,
            beforeDonate: false,
            afterDonate: false,
            beforeSwapReturnDelta: false,
            afterSwapReturnDelta: true,
            afterAddLiquidityReturnDelta: false,
            afterRemoveLiquidityReturnDelta: false
        });
    }

    // ────────────────────────────────────────────────────────────────────────────────
    // beforeInitialize -- the gate. One expensive read per pool, ever.
    //
    // ⚠ THE GATE IS TWO-ENDED AND BOTH ENDS ARE REQUIRED (CLAUDE.md section 20.6).
    // `sender == adapter` alone would be WORSE than a curve-state check, because
    // BallistaV4Adapter.addLiquidity is callable only by LFX1 -- if that caller
    // restriction is ever removed, an attacker can buy dust off a live curve, call
    // addLiquidity at a ratio of their choosing, and poison the pool for the entire
    // ACTIVE phase. This gate is only as strong as that one.
    //
    // ⚠ REGISTRATION IS IDEMPOTENT, NOT GUARDED BY AN "ALREADY REGISTERED" REVERT.
    // PoolManager calls beforeInitialize BEFORE it checks whether the pool already
    // exists -- the hook call sits above `_pools[id].initialize(...)` in
    // PoolManager.initialize, and Pool.sol:101 is what throws PoolAlreadyInitialized.
    // So a retried graduation re-enters here first. Reverting with our own error would
    // MASK the real reason and make the two cases indistinguishable to the adapter and
    // to its tests.
    function _beforeInitialize(address sender, PoolKey calldata key, uint160) internal override returns (bytes4) {
        if (sender != adapter) revert NotAdapter(sender);

        PoolId id = key.toId();
        if (launches[id].registered) return IHooks.beforeInitialize.selector;

        if (key.fee != REQUIRED_FEE) revert WrongFee(key.fee);
        if (key.tickSpacing != REQUIRED_TICK_SPACING) revert WrongTickSpacing(key.tickSpacing);
        if (address(key.hooks) != address(this)) revert WrongHook(address(key.hooks));

        // ⚠ USDC is identified by comparing against the immutable, NEVER by "whichever
        // is not currency0". Roughly a fifth of launch tokens sort below 0x3600...0000
        // and both orderings occur in production.
        address c0 = Currency.unwrap(key.currency0);
        address c1 = Currency.unwrap(key.currency1);
        bool usdcIsCurrency0 = (c0 == usdc);
        if (!usdcIsCurrency0 && c1 != usdc) revert NoUsdcSide(c0, c1);
        address token = usdcIsCurrency0 ? c1 : c0;

        // The existence check. curves() does not revert for an unknown token -- it
        // returns a zero-filled struct -- so identity is tested the way LFX1 itself
        // tests it, with c.token == token.
        LFX1.Curve memory curve = lfx1.curves(token);
        if (curve.token != token) revert UnknownCurve(token);
        // Unreachable while the check above holds, since LFX1 writes creator = msg.sender
        // at creation. Kept because the cost of being wrong is that half of every fee on
        // this pool accrues to address(0) forever, and because it makes that case
        // testable rather than merely argued.
        if (curve.creator == address(0)) revert ZeroCreator(token);

        launches[id] = Launch({
            token: token,
            feeRecipient: curve.creator,
            usdcIsCurrency0: usdcIsCurrency0,
            registered: true
        });

        emit PoolRegistered(id, token, curve.creator, usdcIsCurrency0, key.fee, key.tickSpacing);
        return IHooks.beforeInitialize.selector;
    }

    // ────────────────────────────────────────────────────────────────────────────────
    // afterSwap -- runs on every trade forever and cannot be changed. Keep it small.
    //
    // ⚠ IT MUST NEVER REVERT. A revert here bricks the pool permanently: every swap
    // reverts, liquidity is burned so it cannot be withdrawn, and there is no owner to
    // fix anything. Every path below either early-returns or completes; the magnitude is
    // widened to int256 before negation so that even int128.min cannot trip a checked
    // arithmetic revert.
    function _afterSwap(address, PoolKey calldata key, SwapParams calldata params, BalanceDelta delta, bytes calldata)
        internal
        override
        returns (bytes4, int128)
    {
        PoolId id = key.toId();
        // An unregistered pool carrying this hook is not an error and must not revert.
        // Read the one field rather than copying the struct -- the whole Launch in memory
        // is stack-too-deep here at 0.8.24 / 200 runs.
        if (!launches[id].registered) return (IHooks.afterSwap.selector, 0);

        (Currency feeCurrency, uint256 magnitude) = _unspecifiedSide(key, params, delta);
        // Rounds DOWN, so the hook can never claim more than the swap produced.
        uint256 fee = (magnitude * FEE_BPS) / BPS_DENOMINATOR;
        if (fee == 0) return (IHooks.afterSwap.selector, 0);

        _accrue(id, feeCurrency, fee, delta);
        return (IHooks.afterSwap.selector, int128(uint128(fee)));
    }

    // Which side of the swap is UNSPECIFIED, and how much of it moved.
    //
    // The one line worth reading twice is `specifiedIsCurrency0`. It is correct for all
    // four combinations and is easy to get subtly wrong:
    //   exact-in  + zeroForOne  -> specified is currency0 (the input)
    //   exact-in  + oneForZero  -> specified is currency1 (the input)
    //   exact-out + zeroForOne  -> specified is currency1 (the output)
    //   exact-out + oneForZero  -> specified is currency0 (the output)
    //
    // ⚠ The magnitude is widened to int256 BEFORE negation. `-x` on int128.min overflows
    // int128 and would revert -- inside afterSwap, which must never revert.
    function _unspecifiedSide(PoolKey calldata key, SwapParams calldata params, BalanceDelta delta)
        private
        pure
        returns (Currency feeCurrency, uint256 magnitude)
    {
        int128 unspecified;
        if ((params.amountSpecified < 0) == params.zeroForOne) {
            (feeCurrency, unspecified) = (key.currency1, delta.amount1());
        } else {
            (feeCurrency, unspecified) = (key.currency0, delta.amount0());
        }
        int256 wide = int256(unspecified);
        magnitude = uint256(wide < 0 ? -wide : wide);
    }

    // Extracted from _afterSwap because inlining it is stack-too-deep at 0.8.24 with the
    // optimizer at 200 runs. CLAUDE.md section 5 is explicit that the fix is to extract a
    // function and never viaIR.
    //
    // ⚠ STATE BEFORE THE EXTERNAL CALL. take() ends in currency.transfer()
    // (PoolManager.take), and on Arc the USDC side is a transparent upgradeable proxy
    // whose implementation Circle controls -- so that transfer is not categorically
    // callback-free. Writing the accrual first means a reentrant sweep() observes this
    // fee already booked rather than missing it, and a reentrant claim() can at worst
    // revert on an insufficient balance rather than corrupt the ledger.
    function _accrue(PoolId id, Currency feeCurrency, uint256 fee, BalanceDelta delta) private {
        address currencyAddress = Currency.unwrap(feeCurrency);
        if (currencyAddress == usdc) {
            pendingUsdc[id] += fee;
        } else {
            pendingToken[id] += fee;
        }
        poolManager.take(feeCurrency, address(this), fee);
        emit FeeAccrued(id, currencyAddress, fee, delta.amount0(), delta.amount1());
    }

    // ────────────────────────────────────────────────────────────────────────────────
    // The complete external surface beyond the IHooks callbacks:
    //
    //   sweep(PoolId)                        permissionless, no transfers
    //   claim()                              caller drains their own USDC
    //   claimToken(address)                  caller drains their own launch token
    //   transferFeeRecipient(PoolId,address) current recipient only
    //
    // plus the auto-generated getters for the public mappings and immutables. There is
    // nothing else: no owner, no admin, no pause, no upgrade, no withdraw, no rescue, no
    // delegatecall, no selfdestruct, no receive, no fallback.
    // ────────────────────────────────────────────────────────────────────────────────

    // ⚠ MAKES NO EXTERNAL CALL, AND THAT IS THE SAFETY ARGUMENT, NOT AN OPTIMISATION.
    // Because sweep only moves numbers, it cannot be blocked by a hostile fee recipient,
    // it cannot be sandwiched, it needs no slippage parameter, and it is safe to call
    // from inside a v4 unlock. Pons needs a PoolManagerAlreadyUnlocked guard at the
    // equivalent point only because their sweep performs a conversion swap; ours has
    // nothing to guard.
    function sweep(PoolId poolId) external {
        Launch memory launch = launches[poolId];
        if (!launch.registered) revert UnknownPool(poolId);

        uint256 u = pendingUsdc[poolId];
        uint256 t = pendingToken[poolId];
        if (u == 0 && t == 0) return; // a no-op sweep is not an error

        pendingUsdc[poolId] = 0;
        pendingToken[poolId] = 0;

        address recipient = launch.feeRecipient;
        // Immutable 50/50. The odd unit goes to the creator, deliberately: it is at most
        // one raw unit and the alternative is a silent rounding preference for ourselves.
        uint256 uProtocol = u / 2;
        uint256 uCreator = u - uProtocol;
        uint256 tProtocol = t / 2;
        uint256 tCreator = t - tProtocol;

        if (u != 0) {
            owedUsdc[protocolRecipient] += uProtocol;
            owedUsdc[recipient] += uCreator;
        }
        if (t != 0) {
            owedToken[protocolRecipient][launch.token] += tProtocol;
            owedToken[recipient][launch.token] += tCreator;
        }

        emit FeesSwept(poolId, launch.token, recipient, uProtocol, uCreator, tProtocol, tCreator);
    }

    // Zeroes before transferring, so a reentrant claim finds nothing owed. No guard is
    // needed and none is added.
    function claim() external {
        uint256 amount = owedUsdc[msg.sender];
        if (amount == 0) revert NothingOwed();
        owedUsdc[msg.sender] = 0;
        IERC20(usdc).safeTransfer(msg.sender, amount);
        emit Claimed(msg.sender, usdc, amount);
    }

    function claimToken(address token) external {
        uint256 amount = owedToken[msg.sender][token];
        if (amount == 0) revert NothingOwed();
        owedToken[msg.sender][token] = 0;
        IERC20(token).safeTransfer(msg.sender, amount);
        emit Claimed(msg.sender, token, amount);
    }

    // ⚠ IMMEDIATE AND WITHOUT A TIMELOCK, ON PURPOSE. LFX1 writes `creator` once in a
    // struct literal (LFX1.sol:342) and has no setter for it anywhere, so without this a
    // lost creator key would strand half of every graduated pool's fees forever. A
    // timelock on the only remedy protects nobody and delays the recovery.
    //
    // Balances ALREADY credited stay with the previous recipient: they were earned before
    // the transfer and moving them would let a new recipient claim history.
    function transferFeeRecipient(PoolId poolId, address newRecipient) external {
        Launch storage launch = launches[poolId];
        if (!launch.registered) revert UnknownPool(poolId);
        if (msg.sender != launch.feeRecipient) revert NotFeeRecipient(msg.sender);
        if (newRecipient == address(0)) revert ZeroAddress();

        address previous = launch.feeRecipient;
        launch.feeRecipient = newRecipient;
        emit FeeRecipientTransferred(poolId, previous, newRecipient);
    }
}
