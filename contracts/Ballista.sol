// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";

import "./ArcLaunchToken.sol";
import "./interfaces/IDEXRouter.sol";

/// @title Ballista
/// @notice Token launch + bonding curve trading + graduation, for a Pump.fun-style
///         launchpad on Arc, with two anti-spam / anti-rug features baked in from the
///         start rather than bolted on after a problem shows up:
///           1. Per-wallet launch cooldown + on-chain symbol uniqueness — this is the
///              direct fix for the failure mode that took down Noxa.fi on Robinhood
///              Chain (60k+ launches, bot spam, copycat tokens flooding the platform
///              faster than it could be moderated).
///           2. LP tokens sent to a burn address at graduation, permanently, by the
///              contract itself — not "the team promises to lock it," a guarantee
///              anyone can verify on-chain.
///
/// @dev PARAMETERS BELOW ARE ILLUSTRATIVE STARTING POINTS, not final business decisions.
///      The virtual-reserve and graduation-threshold constants are loosely modeled on
///      publicly documented Pump.fun curve parameters, translated to a USDC quote asset
///      (Arc uses USDC natively). Tune before any real deployment. This contract has NOT
///      been audited — do not point it at real funds until it has been.
contract Ballista is Ownable, ReentrancyGuard, Pausable {
    using SafeERC20 for IERC20;

    // ── Token economics (per launched token) ──────────────────────────────
    uint256 public constant CURVE_TOKEN_SUPPLY = 800_000_000e18; // sold via bonding curve
    /// @notice Tokens reserved for the DEX pool at graduation.
    /// @dev Sized for where this curve ACTUALLY graduates, not for full depletion.
    ///
    ///      The pool receives `LP_TOKEN_RESERVE + tokenReserves` — the reserve plus
    ///      whatever the curve never sold — which reduces to `TOTAL_TOKEN_SUPPLY - sold`.
    ///      The split between the two constants cancels out; only the total moves the
    ///      pool's opening price.
    ///
    ///      The Pump.fun-derived 200M was self-consistent at FULL depletion: sell all
    ///      800M, raise $87,912, and the pool opens just above the curve's last price
    ///      with no leftovers. But graduation fires at $67,000 — 92.6% of the curve —
    ///      leaving ~58.9M unsold tokens dumped into a pool sized for zero. That
    ///      dilution opened the pool ~11.4% BELOW the curve's final price: the last
    ///      buyer on the curve was instantly down 11%, on a gap predictable enough to
    ///      position against. 165M sizes the pool for the real graduation point.
    ///
    ///      Does not affect the $87,912 depletion ceiling or the $67,000 threshold's
    ///      margin — those depend on CURVE_TOKEN_SUPPLY and the virtual reserves, none
    ///      of which move here. Pool depth in USDC is likewise unchanged; the pool
    ///      still receives the full realUsdcReserves.
    uint256 public constant LP_TOKEN_RESERVE = 165_000_000e18;
    uint256 public constant TOTAL_TOKEN_SUPPLY = CURVE_TOKEN_SUPPLY + LP_TOKEN_RESERVE;

    // ── Bonding curve starting parameters (USDC assumed 6 decimals) ───────
    uint256 public constant INITIAL_VIRTUAL_TOKEN_RESERVES = 1_073_000_000e18;
    uint256 public constant INITIAL_VIRTUAL_USDC_RESERVES = 30_000e6;

    // ── Graduation ──────────────────────────────────────────────────────
    // DEFAULT applied to newly created tokens only. Existing tokens keep whatever value was
    // snapshotted into their Curve struct at launch — see the note on the struct above.
    // 67,000 rather than the Pump.fun-derived 69,000 — deliberate, ours.
    uint256 public defaultGraduationThresholdUsdc = 67_000e6;
    address public constant BURN_ADDRESS = 0x000000000000000000000000000000000000dEaD;
    address public router; // DEX router — set once a launch-partner DEX is confirmed on Arc

    // ── Fees ────────────────────────────────────────────────────────────
    // Also defaults-for-new-tokens-only, same reasoning as above.
    uint16 public defaultBuyFeeBps = 100; // 1%
    uint16 public defaultSellFeeBps = 100; // 1%
    uint16 public constant MAX_FEE_BPS = 1000; // hard ceiling (10%) — enforced per-token at creation, cannot be exceeded by any future admin action on that token
    uint256 public constant BPS_DENOMINATOR = 10_000;
    uint256 public creationFeeUsdc = 5e6; // 5 USDC, paid by creator at launch — this one IS live/global, since it's charged once at the moment of creation, not something an existing token holder is exposed to
    address public treasury;

    // ── Anti-spam ───────────────────────────────────────────────────────
    uint256 public launchCooldown = 10; // minimum gap between two launches from the same wallet — adjust via setLaunchCooldown(), no redeploy needed
    mapping(address => uint256) public lastLaunchTimestamp;

    /// @notice How long a symbol stays exclusively locked to its first claimant, at the
    ///         time it's claimed. After symbolUnlocksAt[hash] has passed, anyone can
    ///         launch that exact symbol again — including reusing one that was already
    ///         used. This is deliberately NOT a permanent lock: the bet is that
    ///         narrative-driven attention resolves in minutes, so whichever token was
    ///         first to market has already become "the" token for that name well before
    ///         the window closes, and a permanent on-chain reservation would mostly just
    ///         let one early, possibly abandoned launch squat a word forever. The token's
    ///         contract ADDRESS remains the actual canonical identity regardless of symbol
    ///         reuse — see the note on fuzzy-duplicate detection belonging off-chain, below.
    uint256 public symbolLockDuration = 5 minutes;
    // The unlock time is computed and stored ONCE, at claim time — not read live off
    // symbolLockDuration on every check. Same reasoning as the per-token fee/threshold
    // snapshot below: without this, changing symbolLockDuration would retroactively
    // shift the unlock time for every symbol already claimed, including ones mid-window
    // right now, not just symbols claimed after the change.
    mapping(bytes32 => uint256) public symbolUnlocksAt; // 0 = never claimed
    // detection belongs in the off-chain indexer that feeds the discovery feed, not on-chain —
    // string-similarity checks are expensive and easy to route around on their own.

    /// @notice When true (the launch default), symbol uniqueness is checked on the exact
    ///         string as typed — "Cat" and "cat" are different symbols. When false, symbols
    ///         are case-normalized before comparison, so "Cat" and "cat" collide as the same
    ///         symbol and only one can ever launch.
    /// @dev Deliberately lenient at launch: early on, blocking a dev from launching "Cat"
    ///      because someone already took "cat" costs more in missed narrative windows than
    ///      it prevents in spam — narrative-driven launches move in minutes, not the weeks
    ///      an on-chain policy takes to update. Meant to be tightened to false (strict) via
    ///      setCaseSensitiveSymbols() once there's enough launch volume to see whether
    ///      case-only duplicates actually become a spam vector in practice, rather than
    ///      assumed in advance.
    bool public caseSensitiveSymbols = true;

    // ── Curve state ─────────────────────────────────────────────────────
    /// @notice ACTIVE: normal curve trading. GRADUATION_READY: threshold crossed, curve
    ///         trading closed, DEX liquidity not yet successfully created — a transient
    ///         state, not a dead end. GRADUATED: DEX liquidity created, permanent.
    ///         One-way only: ACTIVE -> GRADUATION_READY -> GRADUATED. Nothing ever moves
    ///         backwards.
    enum CurveState { ACTIVE, GRADUATION_READY, GRADUATED }

    struct Curve {
        address token;
        address creator;
        uint256 virtualTokenReserves;
        uint256 virtualUsdcReserves;
        uint256 realUsdcReserves;
        uint256 tokenReserves; // tokens still held by the curve, available to sell
        CurveState state;
        // Snapshotted at creation, NOT read live from storage on every trade. Without this,
        // an admin fee/threshold change instantly applies to every token already trading —
        // including ones whose holders bought in under a different, advertised deal. Every
        // token now trades under the terms it launched with, permanently, regardless of what
        // the global defaults change to afterwards.
        uint16 buyFeeBps;
        uint16 sellFeeBps;
        uint256 graduationThresholdUsdc;
        // The block createToken() executed in. Trading opens the NEXT block — see the
        // require() in buy()/sell(). This does not stop a sniper with a bot watching the
        // mempool for the creation tx and firing in the very next block; it only removes
        // the specific unfairness of someone buying and selling inside the same block the
        // token was created in, before anyone else could possibly have seen it exists.
        uint256 creationBlock;
    }

    mapping(address => Curve) public curves;
    IERC20 public immutable usdc;

    /// @dev Return value of _quoteBuy. Pulling this computation into its own struct +
    ///      pure function (rather than inline in buy()) isn't just tidiness — buy() with
    ///      the clamp-on-insufficient-supply logic inlined hits Solidity's 16-local-slot
    ///      stack limit and fails to compile. This also happens to be exactly the shape
    ///      a future public quoteBuy() view would need, if one gets added later.
    struct BuyQuote {
        uint256 tokensOut;
        uint256 newVirtualUsdc;
        uint256 newVirtualToken;
        uint256 actualUsdcIn; // may be less than the usdcIn requested, if clamped
        uint256 actualFee;
    }

    /// @dev Mirror of BuyQuote for sell() — same stack-depth reasoning.
    struct SellQuote {
        uint256 actualTokensIn; // may be less than the tokensIn requested, if clamped
        uint256 newVirtualUsdc;
        uint256 newVirtualToken;
        uint256 usdcOutGross;
        uint256 fee;
    }

    event TokenCreated(address indexed token, address indexed creator, string name, string symbol, string metadataURI);
    event Trade(address indexed token, address indexed trader, bool isBuy, uint256 usdcAmount, uint256 tokenAmount);
    event Graduated(address indexed token, uint256 tokenLiquidity, uint256 usdcLiquidity, uint256 lpTokensBurned);
    event GraduationReady(address indexed token);
    event GraduationAttemptFailed(address indexed token);
    event CaseSensitiveSymbolsSet(bool caseSensitive);

    constructor(address usdc_, address treasury_) Ownable(msg.sender) {
        require(usdc_ != address(0) && treasury_ != address(0), "zero address");
        usdc = IERC20(usdc_);
        treasury = treasury_;
    }

    // ── Launch ──────────────────────────────────────────────────────────

    /// @notice Hash of every parameter createToken() reads from global defaults right
    ///         now. A frontend fetches this immediately before showing the "create"
    ///         button, then passes it back as expectedEconomicsHash — if any of these
    ///         values change between when the creator saw the terms and when their
    ///         transaction actually mines, createToken() reverts rather than silently
    ///         launching under different terms than what was shown. This does not
    ///         protect against changes to launchCooldown or creationFeeUsdc — those
    ///         affect eligibility to launch at all, not the economics of the token
    ///         once launched, so a mismatch there isn't the same kind of surprise.
    function currentEconomicsHash() public view returns (bytes32) {
        return keccak256(abi.encode(
            defaultBuyFeeBps,
            defaultSellFeeBps,
            defaultGraduationThresholdUsdc,
            caseSensitiveSymbols,
            symbolLockDuration
        ));
    }

    function createToken(
        string calldata name,
        string calldata symbol,
        string calldata metadataURI,
        bytes32 expectedEconomicsHash
    ) external nonReentrant whenNotPaused returns (address token) {
        // No router means nothing to graduate into. Without this check a token can be
        // launched, trade all the way to its threshold, flip to GRADUATION_READY --
        // where buy() and sell() are both closed -- and then sit there frozen, with
        // holders unable to exit, until an owner configures a router. Refusing the
        // launch outright costs nothing: it surfaces at the moment a creator tries,
        // when no one has any money in the curve, instead of at 67,000 USDC with
        // holders trapped. Paired with setRouter()'s zero-address rejection, so a
        // router that exists at launch cannot later be taken away.
        require(
            router != address(0),
            "router not set: launches are closed until a DEX is configured"
        );
        require(
            expectedEconomicsHash == currentEconomicsHash(),
            "economics changed since you last checked -- refresh and confirm the new terms"
        );
        require(
            block.timestamp >= lastLaunchTimestamp[msg.sender] + launchCooldown,
            "cooldown: wait before launching again"
        );
        // caseSensitiveSymbols controls whether "CAT", "cat", and "Cat" are treated as the
        // same symbol (false) or as distinct symbols (true, the launch default) — see the
        // NatSpec on the flag above for why this starts lenient.
        bytes32 symbolHash = caseSensitiveSymbols
            ? keccak256(bytes(symbol))
            : keccak256(bytes(_toUpperAscii(symbol)));
        uint256 unlocksAt = symbolUnlocksAt[symbolHash];
        require(
            unlocksAt == 0 || block.timestamp >= unlocksAt,
            "symbol locked: still within another launch's protection window"
        );

        if (creationFeeUsdc > 0) {
            usdc.safeTransferFrom(msg.sender, treasury, creationFeeUsdc);
        }

        lastLaunchTimestamp[msg.sender] = block.timestamp;
        symbolUnlocksAt[symbolHash] = block.timestamp + symbolLockDuration;

        ArcLaunchToken newToken = new ArcLaunchToken(
            name,
            symbol,
            TOTAL_TOKEN_SUPPLY,
            msg.sender,
            address(this),
            metadataURI
        );
        token = address(newToken);

        curves[token] = Curve({
            token: token,
            creator: msg.sender,
            virtualTokenReserves: INITIAL_VIRTUAL_TOKEN_RESERVES,
            virtualUsdcReserves: INITIAL_VIRTUAL_USDC_RESERVES,
            realUsdcReserves: 0,
            tokenReserves: CURVE_TOKEN_SUPPLY,
            state: CurveState.ACTIVE,
            buyFeeBps: defaultBuyFeeBps,
            sellFeeBps: defaultSellFeeBps,
            graduationThresholdUsdc: defaultGraduationThresholdUsdc,
            creationBlock: block.number
        });

        emit TokenCreated(token, msg.sender, name, symbol, metadataURI);
    }

    /// @dev Uppercases ASCII a–z only. Symbols are expected to be plain ASCII tickers;
    ///      this is a spam-cost deterrent, not a cryptographic guarantee, by design.
    ///      Only used when caseSensitiveSymbols is false.
    function _toUpperAscii(string memory str) internal pure returns (string memory) {
        bytes memory b = bytes(str);
        for (uint256 i = 0; i < b.length; i++) {
            if (b[i] >= 0x61 && b[i] <= 0x7A) {
                b[i] = bytes1(uint8(b[i]) - 32);
            }
        }
        return string(b);
    }

    // ── Trading ─────────────────────────────────────────────────────────

    /// @dev Pure curve math for a buy, including the clamp-to-remaining-supply case.
    ///      Takes only primitive values (no storage access) so it's cheap to reason
    ///      about and safe to eventually expose as a public quoteBuy() view.
    function _quoteBuy(
        uint256 usdcIn,
        uint16 buyFeeBps,
        uint256 virtualUsdcReserves,
        uint256 virtualTokenReserves,
        uint256 tokenReservesAvailable
    ) internal pure returns (BuyQuote memory q) {
        uint256 k = virtualUsdcReserves * virtualTokenReserves;
        uint256 fee = (usdcIn * buyFeeBps) / BPS_DENOMINATOR;
        uint256 usdcInAfterFee = usdcIn - fee;
        uint256 newVirtualUsdc = virtualUsdcReserves + usdcInAfterFee;
        // Rounded UP (ceiling), not down. Rounding newVirtualToken down — the naive
        // approach — meant tokensOut came out slightly too HIGH on every single trade,
        // i.e. the curve was quietly bleeding value to traders, trade after trade,
        // forever. Rounding up here means any residual dust favors the curve, not the
        // trader — the standard direction used by production AMMs (Uniswap included)
        // for exactly this reason.
        uint256 newVirtualToken = _ceilDiv(k, newVirtualUsdc);
        require(newVirtualToken <= virtualTokenReserves, "curve math error");
        uint256 tokensOut = virtualTokenReserves - newVirtualToken;

        if (tokensOut <= tokenReservesAvailable) {
            // Common case: enough supply remains to fill the full request.
            q.tokensOut = tokensOut;
            q.newVirtualUsdc = newVirtualUsdc;
            q.newVirtualToken = newVirtualToken;
            q.actualUsdcIn = usdcIn;
            q.actualFee = fee;
            return q;
        }

        // Not enough supply left to fill the full request. Clamp to exactly what
        // remains rather than reverting the whole trade — this is what stops the buy
        // that finishes a launch from being griefable by anyone slipping a smaller
        // purchase in first. The true cost is recomputed DETERMINISTICALLY from the
        // clamped, known token amount, rather than by inverting the ceil-divided
        // formula above — that inversion has its own rounding edge cases, and
        // duplicating it as a second math path is a second place for a bug to hide.
        // Deriving directly from tokenReservesAvailable (a known, exact stored value)
        // avoids that entirely.
        q.tokensOut = tokenReservesAvailable;
        q.newVirtualToken = virtualTokenReserves - q.tokensOut;
        // Ceiling, same reasoning as above: rounding dust favors the curve, so the
        // trade that empties it doesn't leak value on the way out.
        q.newVirtualUsdc = _ceilDiv(k, q.newVirtualToken);
        uint256 clampedUsdcInAfterFee = q.newVirtualUsdc - virtualUsdcReserves;
        // Invert the fee formula the same direction: round the required gross amount
        // UP, so the fee actually charged is never less than buyFeeBps of what was
        // actually spent.
        q.actualUsdcIn = _ceilDiv(clampedUsdcInAfterFee * BPS_DENOMINATOR, BPS_DENOMINATOR - buyFeeBps);
        q.actualFee = q.actualUsdcIn - clampedUsdcInAfterFee;

        // Buying fewer tokens should never cost more than buying the originally
        // requested, larger amount would have. This should be true by construction
        // given monotonic curve pricing — this is a defensive backstop, not a case
        // expected to ever actually fire. If it does, something upstream is wrong,
        // and reverting is far safer than silently overcharging.
        require(q.actualUsdcIn <= usdcIn, "clamp computed a higher cost than offered");
    }

    function buy(address token, uint256 usdcIn, uint256 minTokensOut) external nonReentrant whenNotPaused {
        Curve storage c = curves[token];
        require(c.token == token, "unknown token");
        require(c.state == CurveState.ACTIVE, "curve not open for trading: check DEX or wait for graduation");
        require(block.number > c.creationBlock, "trading opens next block");
        require(usdcIn > 0, "zero amount");

        BuyQuote memory q = _quoteBuy(usdcIn, c.buyFeeBps, c.virtualUsdcReserves, c.virtualTokenReserves, c.tokenReserves);

        require(q.tokensOut >= minTokensOut, "slippage exceeded");

        // Effects before interactions: all state finalized before any external call fires.
        c.virtualUsdcReserves = q.newVirtualUsdc;
        c.virtualTokenReserves = q.newVirtualToken;
        c.realUsdcReserves += (q.actualUsdcIn - q.actualFee);
        c.tokenReserves -= q.tokensOut;
        bool crossedThreshold = c.realUsdcReserves >= c.graduationThresholdUsdc;

        // Interactions. Only q.actualUsdcIn is ever pulled from the buyer — if the
        // request was clamped, the excess is simply never taken in the first place,
        // rather than taken and refunded in a separate transfer. One fewer external
        // call, one fewer way for a "refund" step to fail or be forgotten.
        usdc.safeTransferFrom(msg.sender, address(this), q.actualUsdcIn);
        if (q.actualFee > 0) usdc.safeTransfer(treasury, q.actualFee);
        IERC20(token).safeTransfer(msg.sender, q.tokensOut);
        emit Trade(token, msg.sender, true, q.actualUsdcIn, q.tokensOut);

        if (crossedThreshold) {
            // The trade above has ALREADY happened and succeeded, regardless of
            // whatever happens next. Curve trading closes here, permanently, whether
            // or not the DEX side manages to complete in this same transaction.
            c.state = CurveState.GRADUATION_READY;
            emit GraduationReady(token);

            // Best-effort automatic graduation. _performGraduation isolates the one
            // external call that can actually fail (the router) behind its own
            // try/catch, so a router hiccup — near the block gas limit is the common
            // real-world case — cannot unwind the buy that already succeeded above.
            // If it fails, state simply stays GRADUATION_READY: no funds are stuck,
            // no state is inconsistent, and anyone at all can retry later via
            // graduate() — this contract does not depend on its own frontend or
            // backend being up for a token to eventually reach the DEX.
            if (!_performGraduation(token)) {
                emit GraduationAttemptFailed(token);
            }
        }
    }

    /// @dev Pure curve math for a sell, mirroring _quoteBuy — same stack-depth and
    ///      future-quoteSell()-view reasoning.
    function _quoteSell(
        uint256 tokensIn,
        uint16 sellFeeBps,
        uint256 virtualUsdcReserves,
        uint256 virtualTokenReserves,
        uint256 realUsdcReservesAvailable
    ) internal pure returns (SellQuote memory q) {
        uint256 k = virtualUsdcReserves * virtualTokenReserves;
        uint256 newVirtualToken = virtualTokenReserves + tokensIn;
        // Same rounding fix as _quoteBuy, mirrored: round newVirtualUsdc UP so
        // usdcOutGross comes out slightly LOW rather than slightly high — again, dust
        // favors the curve, not the trader.
        uint256 newVirtualUsdc = _ceilDiv(k, newVirtualToken);
        require(newVirtualUsdc <= virtualUsdcReserves, "curve math error");
        uint256 usdcOutGross = virtualUsdcReserves - newVirtualUsdc;

        if (usdcOutGross <= realUsdcReservesAvailable) {
            // Common case: the curve holds enough real USDC to pay out the full
            // requested sell.
            q.actualTokensIn = tokensIn;
            q.newVirtualToken = newVirtualToken;
            q.newVirtualUsdc = newVirtualUsdc;
            q.usdcOutGross = usdcOutGross;
            q.fee = (usdcOutGross * sellFeeBps) / BPS_DENOMINATOR;
            return q;
        }

        // The curve can't pay out the full request. Clamp to exactly what it holds,
        // and recompute the true tokensIn needed DETERMINISTICALLY from that clamped,
        // known output — same reasoning as _quoteBuy: deriving from a known stored
        // value avoids duplicating the ceil-divided forward formula's own rounding
        // edge cases in a second, error-prone inversion.
        q.usdcOutGross = realUsdcReservesAvailable;
        q.newVirtualUsdc = virtualUsdcReserves - q.usdcOutGross;
        // Ceiling here too: dust favors the curve, meaning the seller must provide at
        // least enough tokens for the clamped payout, never fractionally short.
        q.newVirtualToken = _ceilDiv(k, q.newVirtualUsdc);
        q.actualTokensIn = q.newVirtualToken - virtualTokenReserves;
        q.fee = (q.usdcOutGross * sellFeeBps) / BPS_DENOMINATOR;

        // Selling for a smaller payout should never require MORE tokens than selling
        // for the originally requested, larger payout would have. Same defensive
        // backstop as _quoteBuy's equivalent check.
        require(q.actualTokensIn <= tokensIn, "clamp computed a higher input than offered");
    }

    function sell(address token, uint256 tokensIn, uint256 minUsdcOut) external nonReentrant whenNotPaused {
        Curve storage c = curves[token];
        require(c.token == token, "unknown token");
        require(c.state == CurveState.ACTIVE, "curve not open for trading: check DEX or wait for graduation");
        require(block.number > c.creationBlock, "trading opens next block");
        require(tokensIn > 0, "zero amount");

        SellQuote memory q = _quoteSell(tokensIn, c.sellFeeBps, c.virtualUsdcReserves, c.virtualTokenReserves, c.realUsdcReserves);

        uint256 usdcOut = q.usdcOutGross - q.fee;
        require(usdcOut >= minUsdcOut, "slippage exceeded");

        // Effects before interactions.
        c.virtualTokenReserves = q.newVirtualToken;
        c.virtualUsdcReserves = q.newVirtualUsdc;
        c.realUsdcReserves -= q.usdcOutGross;
        c.tokenReserves += q.actualTokensIn;

        // Interactions. Only q.actualTokensIn is ever pulled from the seller — same
        // "never take the excess in the first place" approach as buy().
        IERC20(token).safeTransferFrom(msg.sender, address(this), q.actualTokensIn);
        if (q.fee > 0) usdc.safeTransfer(treasury, q.fee);
        usdc.safeTransfer(msg.sender, usdcOut);

        emit Trade(token, msg.sender, false, usdcOut, q.actualTokensIn);
    }

    function _ceilDiv(uint256 a, uint256 b) internal pure returns (uint256) {
        return (a + b - 1) / b;
    }

    // ── Graduation ──────────────────────────────────────────────────────
    //
    // State only ever moves ACTIVE -> GRADUATION_READY -> GRADUATED, one-way, no
    // exceptions. Reaching GRADUATION_READY is decoupled from the DEX call actually
    // succeeding: the buy that crosses the threshold always closes curve trading in
    // the same transaction, permanently, whether or not the DEX side manages to
    // complete right then. A curve sitting in GRADUATION_READY is not stuck — anyone
    // can call graduate() to retry, and reserves are untouched until the DEX call
    // genuinely succeeds, so there is nothing to roll back if it doesn't.

    /// @dev The only place the router is actually called. Isolates that one external
    ///      call behind try/catch so a router failure never has to propagate up and
    ///      unwind whatever triggered this — the caller decides what "failure" means
    ///      for its own context (buy() logs and moves on; graduate() reverts, since
    ///      there's no trade to protect on that path).
    function _performGraduation(address token) internal returns (bool success) {
        if (router == address(0)) return false;
        Curve storage c = curves[token];

        uint256 tokenLiquidity = LP_TOKEN_RESERVE + c.tokenReserves; // reserve + any curve dust
        uint256 usdcLiquidity = c.realUsdcReserves;

        IERC20(token).forceApprove(router, tokenLiquidity);
        usdc.forceApprove(router, usdcLiquidity);

        try IDEXRouter(router).addLiquidity(
            token,
            address(usdc),
            tokenLiquidity,
            usdcLiquidity,
            0, // zero-slippage is deliberate here: this is the FIRST liquidity ever added
            0, // for this pair, so there's no existing pool price to be sandwiched against —
            BURN_ADDRESS, // this only stays safe as long as it's genuinely a first deposit,
            block.timestamp + 15 minutes // not a top-up of an existing pool. Recheck this
        ) returns (uint256, uint256, uint256 liquidity) { // assumption if the router logic ever changes.
            if (liquidity == 0) {
                // Router "succeeded" but silently did nothing. Don't leave a stale
                // approval sitting around from the attempt.
                IERC20(token).forceApprove(router, 0);
                usdc.forceApprove(router, 0);
                return false;
            }

            // Effects only happen on CONFIRMED success — reserves were never touched
            // by the failed-attempt path above, so there is no rollback to write.
            c.state = CurveState.GRADUATED;
            c.tokenReserves = 0;
            c.realUsdcReserves = 0;
            emit Graduated(token, tokenLiquidity, usdcLiquidity, liquidity);
            return true;
        } catch {
            IERC20(token).forceApprove(router, 0);
            usdc.forceApprove(router, 0);
            return false;
        }
    }

    /// @notice Permissionless retry for a curve sitting in GRADUATION_READY — most
    ///         commonly because the automatic attempt inside buy() failed, e.g. from
    ///         running near the block gas limit alongside the triggering trade.
    ///         Anyone can call this. Ballista's own frontend, backend, or indexer
    ///         being down does not block a token from eventually reaching the DEX.
    function graduate(address token) external nonReentrant {
        Curve storage c = curves[token];
        require(c.token == token, "unknown token");
        require(c.state == CurveState.GRADUATION_READY, "not ready to graduate");
        require(router != address(0), "router not set: no confirmed Arc DEX yet");
        require(_performGraduation(token), "graduation attempt failed -- check router and liquidity conditions");
    }

    // ── Views ───────────────────────────────────────────────────────────

    /// @notice Read-only preview of exactly what buy(token, usdcIn, ...) would do
    ///         right now — including correct clamp-to-remaining-supply behavior if
    ///         usdcIn exceeds what's left on the curve. Calls the exact same pure
    ///         function buy() itself uses, so a frontend price preview and the actual
    ///         execution can never silently diverge into two different math paths.
    function quoteBuy(address token, uint256 usdcIn) external view returns (BuyQuote memory) {
        Curve storage c = curves[token];
        require(c.token == token, "unknown token");
        require(c.state == CurveState.ACTIVE, "curve not open for trading: check DEX or wait for graduation");
        return _quoteBuy(usdcIn, c.buyFeeBps, c.virtualUsdcReserves, c.virtualTokenReserves, c.tokenReserves);
    }

    /// @notice Mirror of quoteBuy for sell() — same "exact same math as execution"
    ///         guarantee.
    function quoteSell(address token, uint256 tokensIn) external view returns (SellQuote memory) {
        Curve storage c = curves[token];
        require(c.token == token, "unknown token");
        require(c.state == CurveState.ACTIVE, "curve not open for trading: check DEX or wait for graduation");
        return _quoteSell(tokensIn, c.sellFeeBps, c.virtualUsdcReserves, c.virtualTokenReserves, c.realUsdcReserves);
    }

    /// @notice Current spot price of `token`, in USDC (6 decimals) per whole token.
    function currentPrice(address token) external view returns (uint256) {
        Curve storage c = curves[token];
        require(c.token == token, "unknown token");
        return (c.virtualUsdcReserves * 1e18) / c.virtualTokenReserves;
    }

    function graduationProgressBps(address token) external view returns (uint256) {
        Curve storage c = curves[token];
        require(c.token == token, "unknown token");
        if (c.realUsdcReserves >= c.graduationThresholdUsdc) return BPS_DENOMINATOR;
        return (c.realUsdcReserves * BPS_DENOMINATOR) / c.graduationThresholdUsdc;
    }

    /// @notice Whether `symbol` could be used in createToken() right now, under the
    ///         CURRENT caseSensitiveSymbols mode. Saves the frontend from reimplementing
    ///         the hashing/case-normalization/timing logic itself just to grey out a
    ///         taken symbol in the launch form.
    function isSymbolAvailable(string calldata symbol) external view returns (bool) {
        bytes32 symbolHash = caseSensitiveSymbols
            ? keccak256(bytes(symbol))
            : keccak256(bytes(_toUpperAscii(symbol)));
        uint256 unlocksAt = symbolUnlocksAt[symbolHash];
        return unlocksAt == 0 || block.timestamp >= unlocksAt;
    }

    // ── Admin (should be a multisig, not an EOA, before real funds are involved) ──

    /// @notice Points graduation at a DEX router. Can be swapped to a different
    ///         non-zero router at any time, but never cleared back to the zero address.
    /// @dev    Rejecting zero is what makes createToken()'s router check meaningful.
    ///         If the router could be unset, an owner could configure one, let a batch
    ///         of tokens launch against it, then clear it -- stranding every one of
    ///         them at GRADUATION_READY with trading closed and no way out. To halt
    ///         activity, use pause(); that is reversible and does not trap anyone
    ///         mid-curve.
    function setRouter(address router_) external onlyOwner {
        require(router_ != address(0), "router cannot be unset: use pause() to halt instead");
        router = router_;
    }

    /// @notice Sets the fee that will apply to tokens created AFTER this call. Every token
    ///         already live keeps the fee it launched with — see the Curve struct note.
    function setDefaultFees(uint16 buyFeeBps_, uint16 sellFeeBps_) external onlyOwner {
        require(buyFeeBps_ <= MAX_FEE_BPS && sellFeeBps_ <= MAX_FEE_BPS, "fee exceeds hard ceiling");
        defaultBuyFeeBps = buyFeeBps_;
        defaultSellFeeBps = sellFeeBps_;
    }

    function setCreationFee(uint256 creationFeeUsdc_) external onlyOwner {
        creationFeeUsdc = creationFeeUsdc_;
    }

    function setLaunchCooldown(uint256 launchCooldown_) external onlyOwner {
        launchCooldown = launchCooldown_;
    }

    /// @notice How long a claimed symbol stays locked before anyone can reuse it.
    ///         Does not retroactively change when already-claimed symbols unlock —
    ///         each symbol's own claimedAt timestamp plus this duration is what's
    ///         checked at the time of a NEW createToken() call, so changing this
    ///         immediately shifts the unlock time for every symbol already claimed,
    ///         not just future ones. Worth knowing before tuning this live.
    function setSymbolLockDuration(uint256 symbolLockDuration_) external onlyOwner {
        symbolLockDuration = symbolLockDuration_;
    }

    /// @notice Sets the graduation threshold that will apply to tokens created AFTER this
    ///         call. Existing tokens keep the threshold they launched under.
    function setDefaultGraduationThreshold(uint256 thresholdUsdc_) external onlyOwner {
        defaultGraduationThresholdUsdc = thresholdUsdc_;
    }

    /// @notice Toggles whether symbol uniqueness is case-sensitive ("Cat" != "cat", the
    ///         launch default) or case-normalized ("Cat" == "cat"). See the NatSpec on
    ///         caseSensitiveSymbols above for the reasoning. Only affects tokens created
    ///         after this call — symbols already claimed keep whatever hash they were
    ///         claimed under.
    function setCaseSensitiveSymbols(bool caseSensitive_) external onlyOwner {
        caseSensitiveSymbols = caseSensitive_;
        emit CaseSensitiveSymbolsSet(caseSensitive_);
    }

    function setTreasury(address treasury_) external onlyOwner {
        require(treasury_ != address(0), "zero address");
        treasury = treasury_;
    }

    /// @notice Emergency stop for createToken/buy/sell. Does NOT affect currently-held
    ///         balances — it only blocks new actions. Meant for "we found a bug, freeze
    ///         while we fix it," not day-to-day use. Once real funds are involved this
    ///         should require the multisig, same as every other admin function here.
    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }
}
