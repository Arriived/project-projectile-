// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {Pool} from "@uniswap/v4-core/src/libraries/Pool.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {FullMath} from "@uniswap/v4-core/src/libraries/FullMath.sol";
import {LiquidityAmounts} from "@uniswap/v4-periphery/src/libraries/LiquidityAmounts.sol";
import {Actions} from "@uniswap/v4-periphery/src/libraries/Actions.sol";

import {IDEXRouter} from "./interfaces/IDEXRouter.sol";
import {IV4PositionManager, IPermit2Allowance, IHookBinding} from "./interfaces/IV4Minimal.sol";

// Seeds a Uniswap v4 pool through the ONE method the frozen LFX1 factory calls.
//
// LFX1 is frozen and speaks a v2 router interface. This contract implements that
// interface and nothing else, so graduation can reach v4 with no change to LFX1 and
// no change to any contract already deployed.
//
// OWNERLESS BY CONSTRUCTION. No owner, no withdraw, no upgrade, no pause, no rescue.
// Nothing can ever remove value from it. That is deliberate, and it is what makes it
// safe for the residue described at step 1 below to remain here.
//
// PHASE 1: hooks are address(0) and the pool fee is 0. The fee-capturing hook is
// phase 2 and is out of scope. A hook is part of the PoolKey, so phase 2 will create
// a different pool rather than modify this one.
//
// The function split below is imposed by the stack, not by taste: inlining _seed into
// addLiquidity is stack-too-deep at 0.8.24 with the optimizer at 200 runs. CLAUDE.md
// section 5 is explicit that the fix is to extract a function and never viaIR.
contract BallistaV4Adapter is IDEXRouter, ReentrancyGuard {
    using SafeERC20 for IERC20;
    using StateLibrary for IPoolManager;

    IPoolManager public immutable poolManager;
    IV4PositionManager public immutable positionManager;
    IPermit2Allowance public immutable permit2;

    // The ONLY address permitted to call addLiquidity. See the gate comment there.
    address public immutable lfx1;

    // The fee hook every pool this adapter creates will carry. Part of the PoolKey, so it
    // is fixed for the life of this contract: a different hook is a different PoolId and
    // therefore a different pool (PoolId.sol:14).
    IHooks public immutable hook;

    // Zero LP fee. The rationale is recorded in CLAUDE.md section 6 and is NOT
    // "Uniswap charges a fee on top of ours" -- it is that anyone can add liquidity to
    // a permissionless pool and take a pro-rata share of LP fees, so a fee here would
    // be dilutable. Under a zero-fee pool the position accrues nothing, which is why
    // burning it costs the protocol nothing.
    uint24 public constant POOL_FEE = 0;

    // Conventional spacing. It has no economic effect on a single full-range position
    // -- the boundary ticks sit at the extremes of the price range and are never
    // crossed in practice -- but it is part of the PoolKey, so it has to be a
    // deliberate constant rather than an accident. 60 aligns the full range to
    // +/-887220 (floor(887272 / 60) * 60).
    int24 public constant TICK_SPACING = 60;

    address public constant BURN_ADDRESS = 0x000000000000000000000000000000000000dEaD;

    // Two ratio bounds, because the price derivation has two branches -- see
    // _sqrtPriceX96. The precise form needs amount1 * 2**192 to survive a uint256,
    // which caps amount1/amount0 near 2**64; the wide form trades 32 bits of precision
    // for a ceiling of 2**192. Both are set a full factor of two inside the arithmetic
    // limit so that breaching one is a named revert rather than a revert from inside
    // FullMath with nothing to say about the cause.
    uint256 private constant MAX_PRECISE_RATIO = 1 << 63;
    uint256 private constant MAX_AMOUNT_RATIO = 1 << 191;

    // Derived from v4-core's own constants, never written as a literal 0x2044. A v4-core
    // bump that moved a bit would otherwise leave this silently describing the old layout
    // -- the same failure scripts/mine-hook-salt.js avoids by parsing Hooks.sol at run
    // time instead of hardcoding the target.
    uint160 private constant REQUIRED_HOOK_FLAGS =
        Hooks.BEFORE_INITIALIZE_FLAG | Hooks.AFTER_SWAP_FLAG | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG;

    error ZeroAmount();
    error IdenticalCurrencies();
    error DeadlineExpired();
    error AmountRatioOutOfRange();
    error SqrtPriceOutOfRange(uint256 sqrtPriceX96);
    error PoolPriceMismatch(uint160 expectedSqrtPriceX96, uint160 actualSqrtPriceX96);
    error NoLiquidityMinted();
    error PositionNotMinted(uint256 tokenId, address expectedOwner, address actualOwner);
    error NothingConsumed();
    error ZeroAddress();
    error NotLfx1(address caller);
    error ZeroHook();
    error HookFlagsWrong(uint160 flags, uint160 required);
    error HookNotBoundToThis(address hookThinksAdapterIs);

    event PoolSeeded(
        address indexed currency0,
        address indexed currency1,
        uint256 tokenId,
        uint160 sqrtPriceX96,
        uint128 liquidity,
        uint256 consumed0,
        uint256 consumed1,
        address recipient
    );

    // ⚠ `lfx1` is the OUTER HALF OF A TWO-ENDED GATE and is not a convenience field.
    // See the comment on addLiquidity. Zero-checked because an adapter with lfx1 ==
    // address(0) is an adapter nothing can ever call.
    //
    // ⚠ THE THREE HOOK CHECKS BELOW EXIST BECAUSE A WRONG HOOK IS THE ONLY FAILURE IN
    // THIS DEPLOYMENT THAT IS SILENT AT BOTH ENDS. They are ordered cheapest-first and
    // each catches something the others do not.
    constructor(
        IPoolManager poolManager_,
        IV4PositionManager positionManager_,
        IPermit2Allowance permit2_,
        address lfx1_,
        IHooks hook_
    ) {
        if (lfx1_ == address(0)) revert ZeroAddress();

        // 1. ZERO HOOK. This is the dangerous one and it does NOT announce itself.
        //    Hooks.isValidHookAddress(IHooks(0), fee) returns TRUE for a static fee --
        //    a hookless pool is perfectly legal v4 -- so an adapter built with
        //    hooks: address(0) graduates SUCCESSFULLY, creates the pool, burns the LP,
        //    and then takes no fee for the rest of time. Nothing reverts, nothing logs,
        //    and the pool looks healthy. Liquidity is burned, so it can never migrate to
        //    a corrected pool either.
        //
        //    ⚠ IT IS DELIBERATELY REDUNDANT WITH CHECK 2, and the red-proof showed why
        //    that is worth stating: removing this line does NOT let a zero hook through,
        //    because uint160(0) & ALL_HOOK_MASK is 0 and 0 != REQUIRED_HOOK_FLAGS, so
        //    check 2 rejects it anyway -- with HookFlagsWrong(0, 0x2044), which reads
        //    like a mis-mined salt rather than the far more likely truth that someone
        //    passed address(0). This check exists to NAME the failure, not to be the only
        //    barrier against it. Do not delete it as redundant.
        if (address(hook_) == address(0)) revert ZeroHook();

        // 2. FLAG BITS. A v4 hook's permissions ARE its address: PoolManager calls only
        //    the callbacks whose bit is set (Hooks.sol, hasPermission). A non-zero hook
        //    at a wrongly-flagged address passes check 1 and then simply never has
        //    afterSwap invoked -- the same silent failure by another route.
        //
        //    ⚠ THIS IS NOT REDUNDANT WITH BaseHook's OWN CONSTRUCTOR CHECK. That one
        //    asserts OUR HOOK's address matches the permissions our hook DECLARES. It is
        //    a fact about the hook, and it never runs for whatever address THIS contract
        //    was handed. The two constrain different things.
        uint160 flags = uint160(address(hook_)) & Hooks.ALL_HOOK_MASK;
        if (flags != REQUIRED_HOOK_FLAGS) revert HookFlagsWrong(flags, REQUIRED_HOOK_FLAGS);

        // 3. THE BINDING ITSELF. Checks 1 and 2 are satisfied by any correctly-flagged
        //    address, including one produced by a mis-predicted deployment nonce. This
        //    asks the hook who IT thinks its adapter is and requires the answer to be us.
        //
        //    ⚠ THIS IS WHAT MAKES THE NONCE PREDICTION SELF-VERIFYING. The hook is mined
        //    and deployed first, carrying this contract's PREDICTED CREATE address. If
        //    that prediction was wrong -- a stray transaction moved the nonce -- this
        //    deployment reverts here instead of succeeding into a pair that can never
        //    graduate. address(this) is already final inside a constructor.
        //
        //    It does not prove the hook is a BallistaFeeHook, only that it names us. A
        //    crafted impostor could answer correctly; a mistyped or mis-predicted address
        //    cannot. Deliberate mis-binding stays out of scope -- only the deployer can
        //    choose this argument. CLAUDE.md section 20.7's post-deploy read-back remains
        //    the check that proves the pair in BOTH directions.
        address boundTo = IHookBinding(address(hook_)).adapter();
        if (boundTo != address(this)) revert HookNotBoundToThis(boundTo);

        poolManager = poolManager_;
        positionManager = positionManager_;
        permit2 = permit2_;
        lfx1 = lfx1_;
        hook = hook_;
    }

    // The only entry point. The signature is IDEXRouter's, unchanged, because LFX1 is
    // frozen and calls exactly this.
    //
    // ⚠️​ DO NOT REMOVE THE msg.sender == lfx1 GATE BELOW. IT IS THE OUTER HALF OF A
    // TWO-ENDED GATE AND REMOVING IT REOPENS A HOLE NOTHING WILL REPORT.
    //
    // BallistaFeeHook.beforeInitialize admits only `sender == adapter`. On its own that
    // proves nothing, because it would mean only that SOMEONE routed through this
    // contract. If this function is callable by anyone, an attacker buys dust off a live
    // curve and calls it with their own two amounts at a ratio of their choosing -- and
    // this contract obediently initialises that token's pool at the attacker's price,
    // for the entire ACTIVE phase of the curve, days or weeks before graduation. The
    // real graduation then fails its own price check and the curve parks at
    // GRADUATION_READY with both sides closed and holders frozen.
    //
    // With the gate, the only caller is LFX1._performGraduation, which is reachable only
    // on a threshold crossing or from the permissionless graduate() -- and both pass the
    // curve's TRUE reserves (LFX1.sol:656-664), never an attacker's ratio. That closes
    // the pre-token window, the whole ACTIVE window and the parked window together.
    //
    // Nothing reverts, nothing logs and every other test still passes if this line is
    // deleted. `A_addLiquidity_rejects_a_caller_that_is_not_LFX1` in the fork suite is
    // the only thing standing between a future edit and a silently reopened hole.
    // CLAUDE.md section 20.6.
    //
    // amountAMin / amountBMin are ACCEPTED AND NOT ENFORCED AS WRITTEN. That is the
    // one place this contract knowingly departs from its v2 counterpart. See "the
    // strict-min substitute" in _seed: the protection is kept, by a different and
    // exact mechanism, because the literal mins are unsatisfiable here.
    function addLiquidity(
        address tokenA,
        address tokenB,
        uint256 amountADesired,
        uint256 amountBDesired,
        uint256, /* amountAMin */
        uint256, /* amountBMin */
        address to,
        uint256 deadline
    ) external override nonReentrant returns (uint256 amountA, uint256 amountB, uint256 liquidity) {
        if (msg.sender != lfx1) revert NotLfx1(msg.sender);
        if (block.timestamp > deadline) revert DeadlineExpired();
        if (tokenA == tokenB) revert IdenticalCurrencies();
        if (amountADesired == 0 || amountBDesired == 0) revert ZeroAmount();

        // 1. Pull the FULL desired amounts, never a computed subset.
        //
        // Load-bearing, and not an efficiency choice. LFX1 zeroes tokenReserves,
        // realUsdcReserves and poolBoost unconditionally after a successful call,
        // whatever was actually taken (LFX1.sol:677-679). Anything left unpulled
        // therefore sits in the FACTORY with no accounting entry, and every LFX1
        // payout path is bounded by accounting rather than by balance -- so nothing
        // could ever reach it again (CLAUDE.md R14). Pulling everything moves the
        // residue here instead, where this contract being ownerless burns it.
        // Stranded either way; the difference is that here it is intended, bounded
        // and visible rather than an unexplained factory balance.
        IERC20(tokenA).safeTransferFrom(msg.sender, address(this), amountADesired);
        IERC20(tokenB).safeTransferFrom(msg.sender, address(this), amountBDesired);

        // 2. Sort into v4 currency order. v4 requires currency0 < currency1
        //    (PoolManager.sol:121), and roughly half of all launched tokens sort below
        //    USDC, so both branches are exercised in practice.
        //
        //    The destructuring also does the un-sorting: _seed returns amounts in
        //    (currency0, currency1) order, and the else-branch binds them to
        //    (amountB, amountA) so what leaves this function is always in the
        //    caller's (tokenA, tokenB) order. Written this way rather than with
        //    intermediate locals because those locals are stack-too-deep here.
        if (tokenA < tokenB) {
            (amountA, amountB, liquidity) = _seed(tokenA, tokenB, amountADesired, amountBDesired, to, deadline);
        } else {
            (amountB, amountA, liquidity) = _seed(tokenB, tokenA, amountBDesired, amountADesired, to, deadline);
        }
    }

    // Everything downstream of sorting. Takes the currencies already in v4 order.
    function _seed(
        address currency0,
        address currency1,
        uint256 amount0,
        uint256 amount1,
        address to,
        uint256 deadline
    ) private returns (uint256 consumed0, uint256 consumed1, uint256 mintedLiquidity) {
        PoolKey memory key = PoolKey({
            currency0: Currency.wrap(currency0),
            currency1: Currency.wrap(currency1),
            fee: POOL_FEE,
            tickSpacing: TICK_SPACING,
            hooks: hook
        });

        // 3 and 4. Price from the amounts actually held, then initialise and verify.
        uint160 sqrtPriceX96 = _initialiseAndVerifyPrice(key, amount0, amount1);

        uint256 tokenId;
        {
            uint256 balance0Before = IERC20(currency0).balanceOf(address(this));
            uint256 balance1Before = IERC20(currency1).balanceOf(address(this));

            tokenId = _mintFullRange(key, sqrtPriceX96, amount0, amount1, to, deadline);

            // 6. Measure what was actually taken -- balance deltas, not the amounts
            //    asked for. Same reasoning as LFX1 measuring its USDC pull rather than
            //    trusting the transfer to have moved what it claimed (CLAUDE.md 1.6).
            //    The read is safe against dust left by an earlier graduation of the
            //    same token, because that dust sits in both readings and cancels.
            consumed0 = balance0Before - IERC20(currency0).balanceOf(address(this));
            consumed1 = balance1Before - IERC20(currency1).balanceOf(address(this));
        }
        if (consumed0 == 0 || consumed1 == 0) revert NothingConsumed();

        // 7. NEVER report a non-zero liquidity for a pool this contract did not
        //    actually seed. LFX1 gates only on liquidity == 0 (LFX1.sol:670): a false
        //    non-zero marks the token GRADUATED with the LP already gone, and nothing
        //    can undo it. So the position is read back from the chain and its owner
        //    confirmed before any figure is returned.
        mintedLiquidity = uint256(positionManager.getPositionLiquidity(tokenId));
        if (mintedLiquidity == 0) revert NoLiquidityMinted();
        {
            address actualOwner = positionManager.ownerOf(tokenId);
            if (actualOwner != to) revert PositionNotMinted(tokenId, to, actualOwner);
        }

        emit PoolSeeded(
            currency0, currency1, tokenId, sqrtPriceX96, uint128(mintedLiquidity), consumed0, consumed1, to
        );
    }

    // 4. Initialise, then verify.
    //
    // ⚠ CORRECTED. This comment previously read "initializePool swallows
    // PoolAlreadyInitialized and returns type(int24).max instead". That overstated the
    // wrapper's precision in the direction that matters. PoolInitializer_v4.sol:14-18 is
    // a BARE `catch {}`:
    //
    //     try poolManager.initialize(key, sqrtPriceX96) returns (int24 tick) { return tick; }
    //     catch { return type(int24).max; }
    //
    // It swallows EVERY revert, not PoolAlreadyInitialized specifically -- a hook
    // rejection, a tick-spacing error, currencies out of order, all of it. So this
    // contract cannot presently tell "the pool already existed" from "something refused
    // us", and every one of those surfaces below as PoolPriceMismatch(expected, 0). That
    // is the same class of defect as a comment asserting a protection that does not hold,
    // and it is why the hook's own revert reason can never reach a caller today.
    //
    // The fix is to call poolManager.initialize directly and catch the 4-byte
    // Pool.PoolAlreadyInitialized selector specifically, re-raising everything else --
    // which is also what makes a `sender == adapter` gate possible in the hook, since the
    // wrapper otherwise makes PositionManager the msg.sender that beforeInitialize sees.
    //
    // THE STRICT-MIN SUBSTITUTE.
    //
    // The v2 protection against CLAUDE.md section 1.1 -- an attacker seeding the
    // pair at a ratio of their choosing so we deposit at THEIR price -- is
    // amountAMin/amountBMin set equal to the desired amounts. That works there
    // because a fresh pair takes the zero-reserve branch and never evaluates the
    // requires at all, so the tightest setting is also free.
    //
    // Those literal mins cannot be carried across. A full-range v4 mint consumes
    // an integer liquidity, so one side is always a little short of the offer and
    // "consumed >= desired" would revert on EVERY honest graduation.
    //
    // So the check moves off the amounts and onto the price, where it is exact. If
    // this adapter initialised the pool, slot0 holds precisely the value just
    // passed and the comparison is free -- structurally the same "free in the
    // normal case" property section 1.1 depends on, and with NO tolerance
    // constant, which section 1.1 is emphatic about. If someone else initialised
    // first at a different price, this reverts.
    //
    // Reverting is the correct outcome and is not a denial of service: LFX1 wraps
    // the call in try/catch, zeroes its approvals, emits GraduationAttemptFailed
    // and leaves the curve in GRADUATION_READY with reserves intact, where the
    // permissionless graduate(address) can retry (LFX1.sol:656-687). That is v2's
    // recovery shape exactly -- an adversarial pool parks the curve until the
    // price is corrected, and a v4 pool can be swapped to an exact target price
    // via sqrtPriceLimitX96. The residual is CLAUDE.md R6, the griefing race,
    // unchanged in character.
    function _initialiseAndVerifyPrice(PoolKey memory key, uint256 amount0, uint256 amount1)
        private
        returns (uint160 sqrtPriceX96)
    {
        sqrtPriceX96 = _sqrtPriceX96(amount0, amount1);

        // ⚠ DIRECT, NOT THROUGH positionManager.initializePool, AND FOR TWO REASONS.
        //
        // 1. msg.sender. PoolManager passes its OWN caller to the hook
        //    (PoolManager.initialize calls key.hooks.beforeInitialize, and Hooks.sol
        //    encodes msg.sender into that call). Routing through the PositionManager
        //    wrapper therefore makes POSITION MANAGER the `sender` a hook observes --
        //    which is permissionless and identifies nothing. Calling PoolManager
        //    directly is what makes `sender == adapter` mean anything at all.
        //
        // 2. The wrapper's catch is BARE. PoolInitializer_v4.sol:14-18 returns
        //    type(int24).max for ANY revert, so a hook rejection, a tick-spacing error
        //    and an already-existing pool are indistinguishable, and the hook's own
        //    reason can never reach a caller or a test.
        //
        // So the already-initialised case is caught HERE, by selector, and everything
        // else is re-raised verbatim.
        try poolManager.initialize(key, sqrtPriceX96) returns (int24) {
            // Fresh pool, initialised at our price. Fall through to the check anyway --
            // it is nearly free and it is the one assertion that matters.
        } catch (bytes memory reason) {
            // ⚠ Pool.sol:101 throws through CustomRevert.revertWith(bytes4), which is
            // `mstore(0, selector); revert(0, 0x04)` -- a BARE four-byte body with no
            // ABI wrapper and no arguments. Matching on length AND selector is what
            // stops this from swallowing a longer revert that merely happens to start
            // with the same four bytes.
            bytes4 selector;
            if (reason.length == 4) {
                assembly ("memory-safe") {
                    selector := mload(add(reason, 0x20))
                }
            }
            if (selector != Pool.PoolAlreadyInitialized.selector) {
                // Not ours to interpret. Re-raise verbatim so the hook's own error --
                // NotAdapter, WrongFee, UnknownCurve -- survives to the caller and to
                // the tests that must name it (CLAUDE.md section 16.4).
                assembly ("memory-safe") {
                    revert(add(reason, 0x20), mload(reason))
                }
            }
            // Already initialised. That is reachable on exactly one path: a previous
            // graduation attempt whose addLiquidity RETURNED but produced zero
            // liquidity, which LFX1 treats as a non-reverting failure (LFX1.sol:672-674)
            // so the adapter's effects commit while the curve parks. The retry lands
            // here, and the price check below is what decides whether it may proceed.
        }

        (uint160 poolSqrtPriceX96,,,) = poolManager.getSlot0(key.toId());
        if (poolSqrtPriceX96 != sqrtPriceX96) {
            revert PoolPriceMismatch(sqrtPriceX96, poolSqrtPriceX96);
        }
    }

    // 5. Mint one full-range position to `to`.
    //
    // `to` is honoured rather than hardcoded to BURN_ADDRESS. LFX1 passes the
    // per-curve lpRecipient SNAPSHOT (LFX1.sol:663), which defaults to 0x...dEaD and
    // which CLAUDE.md section 1.8 exists to keep immutable per token. Hardcoding the
    // burn here would silently override that snapshot and break the locker path the
    // snapshot was built to allow.
    //
    // PositionManager uses _mint, not _safeMint (PositionManager.sol:365), so a
    // recipient implementing nothing -- the burn address included -- cannot make this
    // revert.
    function _mintFullRange(
        PoolKey memory key,
        uint160 sqrtPriceX96,
        uint256 amount0,
        uint256 amount1,
        address to,
        uint256 deadline
    ) private returns (uint256 tokenId) {
        uint128 liquidity = LiquidityAmounts.getLiquidityForAmounts(
            sqrtPriceX96,
            TickMath.getSqrtPriceAtTick(TickMath.minUsableTick(TICK_SPACING)),
            TickMath.getSqrtPriceAtTick(TickMath.maxUsableTick(TICK_SPACING)),
            amount0,
            amount1
        );
        if (liquidity == 0) revert NoLiquidityMinted();

        // Read BEFORE minting: PositionManager assigns nextTokenId and then
        // post-increments it (PositionManager.sol:360-362), so this is the id our
        // position is about to take.
        tokenId = positionManager.nextTokenId();

        _permitApprove(Currency.unwrap(key.currency0), amount0);
        _permitApprove(Currency.unwrap(key.currency1), amount1);

        positionManager.modifyLiquidities(_encodeMint(key, liquidity, amount0, amount1, to), deadline);

        // Clear both legs of the Permit2 grant on the way out, on every success path,
        // mirroring LFX1.sol:668-670. A mint that consumed less than it was approved
        // for otherwise leaves a live allowance over this contract's balance.
        _permitApprove(Currency.unwrap(key.currency0), 0);
        _permitApprove(Currency.unwrap(key.currency1), 0);
    }

    // The unlockData PositionManager expects: abi.encode(bytes actions, bytes[] params)
    // under strict encoding (CalldataDecoder.sol decodeActionsRouterParams), where
    // actions is a packed run of uint8 action ids.
    //
    // MINT_POSITION then SETTLE_PAIR. SETTLE_PAIR pays exactly _getFullDebt for each
    // currency (PositionManager.sol _settlePair), so the pool takes what the mint
    // actually owes and nothing more -- amount0Max/amount1Max below are a cap, not the
    // amount transferred, and no sweep step is needed to recover an overpayment.
    function _encodeMint(PoolKey memory key, uint128 liquidity, uint256 amount0, uint256 amount1, address to)
        private
        pure
        returns (bytes memory)
    {
        bytes memory actions = abi.encodePacked(uint8(Actions.MINT_POSITION), uint8(Actions.SETTLE_PAIR));

        bytes[] memory params = new bytes[](2);
        // MINT_POSITION: CalldataDecoder.sol decodeMintParams
        params[0] = abi.encode(
            key,
            TickMath.minUsableTick(TICK_SPACING),
            TickMath.maxUsableTick(TICK_SPACING),
            uint256(liquidity),
            _toUint128(amount0),
            _toUint128(amount1),
            to,
            bytes("")
        );
        // SETTLE_PAIR: CalldataDecoder.sol decodeCurrencyPair
        params[1] = abi.encode(key.currency0, key.currency1);

        return abi.encode(actions, params);
    }

    // PositionManager settles through Permit2 whenever the payer is not itself
    // (PositionManager.sol:_pay), so reaching it takes two grants: an ordinary ERC-20
    // approval to Permit2, and a Permit2 allowance to PositionManager. Neither needs a
    // signature. The expiration is this block; the allowance is consumed and then
    // zeroed inside this same transaction regardless.
    function _permitApprove(address token, uint256 amount) private {
        IERC20(token).forceApprove(address(permit2), amount);
        permit2.approve(token, address(positionManager), _toUint160(amount), uint48(block.timestamp));
    }

    // sqrtPriceX96 = sqrt(amount1 / amount0) * 2**96, computed as
    // sqrt(amount1 * 2**192 / amount0) so the shift happens before the root and no
    // precision is discarded.
    //
    // THE 1e12 SCALE FACTOR IS IMPLICIT, AND THAT IS THE POINT. A launched token is 18
    // decimals (LFX1Token extends OZ ERC20 and never overrides decimals()) while USDC
    // is 6, so the raw amounts already differ by 1e12 and the price derived from them
    // is a RAW-UNIT price -- which is exactly what v4 stores. Adding an explicit
    // decimal adjustment here would apply the factor twice. An adapter wrong by 1e12
    // in either direction would still mint, still return a non-zero liquidity, and
    // still leave LFX1 marking the token graduated, with the pool permanently open at
    // a nonsense price and nothing on chain reporting it. That is why the fork test
    // asserts the resulting pool PRICE and not merely that a pool exists.
    // TWO BRANCHES, and the second one exists because of a permanent stall, not for
    // completeness. The precise form overflows once amount1/amount0 passes ~2**64, and
    // that ratio is REACHABLE: tokenLiquidity tops out near 1e27, so any graduation
    // threshold below roughly 54 USDC produces it. A default graduation is at 8,000
    // USDC and runs at about 1.2e17, some 70x inside the precise branch -- but the
    // threshold is an owner setter, it is SNAPSHOTTED PER CURVE at creation, and there
    // is no path to change it afterwards. So a single mis-set threshold would have left
    // every token launched under it reverting here forever, parked at GRADUATION_READY
    // with both sides closed and no recovery: CLAUDE.md R7 with the key thrown away.
    //
    // The wide branch gives up 32 bits of precision (still ~1e-19 relative, far below
    // anything a pool price expresses) and raises the ceiling to 2**192, which puts it
    // beyond what v4 itself can represent -- MIN/MAX_SQRT_PRICE bound the ratio at
    // about 2**128 either side. So AmountRatioOutOfRange is now unreachable through
    // any pool v4 would accept, and the guard stands as a backstop rather than a limit.
    function _sqrtPriceX96(uint256 amount0, uint256 amount1) internal pure returns (uint160) {
        uint256 ratio = amount1 / amount0;
        uint256 sqrtPrice;

        if (ratio < MAX_PRECISE_RATIO) {
            // sqrt(amount1 / amount0) * 2**96, with the shift taken before the root so
            // no precision is discarded.
            sqrtPrice = _sqrt(FullMath.mulDiv(amount1, 1 << 192, amount0));
        } else if (ratio < MAX_AMOUNT_RATIO) {
            // sqrt(x * 2**128) == sqrt(x) * 2**64, so shifting 64 in and 64 out gives
            // the same quantity with the intermediate kept 128 bits smaller.
            sqrtPrice = _sqrt(FullMath.mulDiv(amount1, 1 << 64, amount0)) << 64;
        } else {
            revert AmountRatioOutOfRange();
        }

        if (sqrtPrice < TickMath.MIN_SQRT_PRICE || sqrtPrice >= TickMath.MAX_SQRT_PRICE) {
            revert SqrtPriceOutOfRange(sqrtPrice);
        }
        return uint160(sqrtPrice);
    }

    // Floor integer square root. Babylonian, seeded with a power of two just above
    // sqrt(x) so that seven iterations always suffice for a full 256-bit input.
    function _sqrt(uint256 x) internal pure returns (uint256) {
        if (x == 0) return 0;

        uint256 xx = x;
        uint256 r = 1;
        if (xx >= 0x100000000000000000000000000000000) {
            xx >>= 128;
            r <<= 64;
        }
        if (xx >= 0x10000000000000000) {
            xx >>= 64;
            r <<= 32;
        }
        if (xx >= 0x100000000) {
            xx >>= 32;
            r <<= 16;
        }
        if (xx >= 0x10000) {
            xx >>= 16;
            r <<= 8;
        }
        if (xx >= 0x100) {
            xx >>= 8;
            r <<= 4;
        }
        if (xx >= 0x10) {
            xx >>= 4;
            r <<= 2;
        }
        if (xx >= 0x8) {
            r <<= 1;
        }

        unchecked {
            r = (r + x / r) >> 1;
            r = (r + x / r) >> 1;
            r = (r + x / r) >> 1;
            r = (r + x / r) >> 1;
            r = (r + x / r) >> 1;
            r = (r + x / r) >> 1;
            r = (r + x / r) >> 1;
            uint256 r1 = x / r;
            return r < r1 ? r : r1;
        }
    }

    function _toUint128(uint256 v) private pure returns (uint128) {
        require(v <= type(uint128).max, "uint128 overflow");
        return uint128(v);
    }

    function _toUint160(uint256 v) private pure returns (uint160) {
        require(v <= type(uint160).max, "uint160 overflow");
        return uint160(v);
    }
}
