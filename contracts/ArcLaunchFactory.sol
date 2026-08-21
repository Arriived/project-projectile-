// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";

import "./ArcLaunchToken.sol";
import "./interfaces/IDEXRouter.sol";

/// @title ArcLaunchFactory
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
contract ArcLaunchFactory is Ownable, ReentrancyGuard, Pausable {
    using SafeERC20 for IERC20;

    // ── Token economics (per launched token) ──────────────────────────────
    uint256 public constant CURVE_TOKEN_SUPPLY = 800_000_000e18; // sold via bonding curve
    uint256 public constant LP_TOKEN_RESERVE = 200_000_000e18; // reserved for DEX pool at graduation
    uint256 public constant TOTAL_TOKEN_SUPPLY = CURVE_TOKEN_SUPPLY + LP_TOKEN_RESERVE;

    // ── Bonding curve starting parameters (USDC assumed 6 decimals) ───────
    uint256 public constant INITIAL_VIRTUAL_TOKEN_RESERVES = 1_073_000_000e18;
    uint256 public constant INITIAL_VIRTUAL_USDC_RESERVES = 30_000e6;

    // ── Graduation ──────────────────────────────────────────────────────
    // DEFAULT applied to newly created tokens only. Existing tokens keep whatever value was
    // snapshotted into their Curve struct at launch — see the note on the struct above.
    uint256 public defaultGraduationThresholdUsdc = 69_000e6;
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
    uint256 public launchCooldown = 1 hours; // minimum gap between two launches from the same wallet
    mapping(address => uint256) public lastLaunchTimestamp;
    mapping(bytes32 => bool) public symbolTaken; // exact-match guard; fuzzy/near-duplicate
    // detection belongs in the off-chain indexer that feeds the discovery feed, not on-chain —
    // string-similarity checks are expensive and easy to route around on their own.

    // ── Curve state ─────────────────────────────────────────────────────
    struct Curve {
        address token;
        address creator;
        uint256 virtualTokenReserves;
        uint256 virtualUsdcReserves;
        uint256 realUsdcReserves;
        uint256 tokenReserves; // tokens still held by the curve, available to sell
        bool graduated;
        // Snapshotted at creation, NOT read live from storage on every trade. Without this,
        // an admin fee/threshold change instantly applies to every token already trading —
        // including ones whose holders bought in under a different, advertised deal. Every
        // token now trades under the terms it launched with, permanently, regardless of what
        // the global defaults change to afterwards.
        uint16 buyFeeBps;
        uint16 sellFeeBps;
        uint256 graduationThresholdUsdc;
    }

    mapping(address => Curve) public curves;
    IERC20 public immutable usdc;

    event TokenCreated(address indexed token, address indexed creator, string name, string symbol, string metadataURI);
    event Trade(address indexed token, address indexed trader, bool isBuy, uint256 usdcAmount, uint256 tokenAmount);
    event Graduated(address indexed token, uint256 tokenLiquidity, uint256 usdcLiquidity, uint256 lpTokensBurned);

    constructor(address usdc_, address treasury_) Ownable(msg.sender) {
        require(usdc_ != address(0) && treasury_ != address(0), "zero address");
        usdc = IERC20(usdc_);
        treasury = treasury_;
    }

    // ── Launch ──────────────────────────────────────────────────────────

    function createToken(
        string calldata name,
        string calldata symbol,
        string calldata metadataURI
    ) external nonReentrant whenNotPaused returns (address token) {
        require(
            block.timestamp >= lastLaunchTimestamp[msg.sender] + launchCooldown,
            "cooldown: wait before launching again"
        );
        // Case-normalized before hashing so "CAT", "cat", and "Cat" collide as the same
        // symbol on-chain. This stops the cheapest copycat trick; it does NOT catch
        // look-alikes like "CASHCATT" or "CA$HCAT" — that fuzzy-similarity check belongs
        // in the off-chain indexer feeding the discovery UI, not on-chain, per the note above.
        bytes32 symbolHash = keccak256(bytes(_toUpperAscii(symbol)));
        require(!symbolTaken[symbolHash], "symbol already launched");

        if (creationFeeUsdc > 0) {
            usdc.safeTransferFrom(msg.sender, treasury, creationFeeUsdc);
        }

        lastLaunchTimestamp[msg.sender] = block.timestamp;
        symbolTaken[symbolHash] = true;

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
            graduated: false,
            buyFeeBps: defaultBuyFeeBps,
            sellFeeBps: defaultSellFeeBps,
            graduationThresholdUsdc: defaultGraduationThresholdUsdc
        });

        emit TokenCreated(token, msg.sender, name, symbol, metadataURI);
    }

    /// @dev Uppercases ASCII a–z only. Symbols are expected to be plain ASCII tickers;
    ///      this is a spam-cost deterrent, not a cryptographic guarantee, by design.
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

    function buy(address token, uint256 usdcIn, uint256 minTokensOut) external nonReentrant whenNotPaused {
        Curve storage c = curves[token];
        require(c.token == token, "unknown token");
        require(!c.graduated, "already graduated: trade on the DEX");
        require(usdcIn > 0, "zero amount");

        uint256 fee = (usdcIn * c.buyFeeBps) / BPS_DENOMINATOR;
        uint256 usdcInAfterFee = usdcIn - fee;

        uint256 k = c.virtualUsdcReserves * c.virtualTokenReserves;
        uint256 newVirtualUsdc = c.virtualUsdcReserves + usdcInAfterFee;
        // Rounded UP (ceiling), not down. Rounding newVirtualToken down — the naive
        // approach — meant tokensOut came out slightly too HIGH on every single trade,
        // i.e. the curve was quietly bleeding value to traders, trade after trade, forever.
        // Rounding up here means any residual dust favors the curve, not the trader —
        // the standard direction used by production AMMs (Uniswap included) for exactly
        // this reason.
        uint256 newVirtualToken = _ceilDiv(k, newVirtualUsdc);
        require(newVirtualToken <= c.virtualTokenReserves, "curve math error");
        uint256 tokensOut = c.virtualTokenReserves - newVirtualToken;

        require(tokensOut >= minTokensOut, "slippage exceeded");
        require(tokensOut <= c.tokenReserves, "insufficient curve liquidity remaining");

        // Effects before interactions: all state finalized before any external call fires.
        c.virtualUsdcReserves = newVirtualUsdc;
        c.virtualTokenReserves = newVirtualToken;
        c.realUsdcReserves += usdcInAfterFee;
        c.tokenReserves -= tokensOut;
        uint256 thresholdForThisToken = c.graduationThresholdUsdc;
        bool shouldGraduate = !c.graduated && c.realUsdcReserves >= thresholdForThisToken;

        // Interactions.
        usdc.safeTransferFrom(msg.sender, address(this), usdcIn);
        if (fee > 0) usdc.safeTransfer(treasury, fee);
        IERC20(token).safeTransfer(msg.sender, tokensOut);
        emit Trade(token, msg.sender, true, usdcIn, tokensOut);

        if (shouldGraduate) {
            _graduate(token);
        }
    }

    function sell(address token, uint256 tokensIn, uint256 minUsdcOut) external nonReentrant whenNotPaused {
        Curve storage c = curves[token];
        require(c.token == token, "unknown token");
        require(!c.graduated, "already graduated: trade on the DEX");
        require(tokensIn > 0, "zero amount");

        uint256 k = c.virtualUsdcReserves * c.virtualTokenReserves;
        uint256 newVirtualToken = c.virtualTokenReserves + tokensIn;
        // Same rounding fix as buy(), mirrored: round newVirtualUsdc UP so usdcOutGross
        // comes out slightly LOW rather than slightly high — again, dust favors the
        // curve, not the trader.
        uint256 newVirtualUsdc = _ceilDiv(k, newVirtualToken);
        require(newVirtualUsdc <= c.virtualUsdcReserves, "curve math error");
        uint256 usdcOutGross = c.virtualUsdcReserves - newVirtualUsdc;

        require(usdcOutGross <= c.realUsdcReserves, "insufficient curve reserves");
        uint256 fee = (usdcOutGross * c.sellFeeBps) / BPS_DENOMINATOR;
        uint256 usdcOut = usdcOutGross - fee;
        require(usdcOut >= minUsdcOut, "slippage exceeded");

        // Effects before interactions.
        c.virtualTokenReserves = newVirtualToken;
        c.virtualUsdcReserves = newVirtualUsdc;
        c.realUsdcReserves -= usdcOutGross;
        c.tokenReserves += tokensIn;

        // Interactions.
        IERC20(token).safeTransferFrom(msg.sender, address(this), tokensIn);
        if (fee > 0) usdc.safeTransfer(treasury, fee);
        usdc.safeTransfer(msg.sender, usdcOut);

        emit Trade(token, msg.sender, false, tokensIn, usdcOut);
    }

    function _ceilDiv(uint256 a, uint256 b) internal pure returns (uint256) {
        return (a + b - 1) / b;
    }

    // ── Graduation ──────────────────────────────────────────────────────

    function _graduate(address token) internal {
        require(router != address(0), "router not set: no confirmed Arc DEX yet");
        Curve storage c = curves[token];
        c.graduated = true;

        uint256 tokenLiquidity = LP_TOKEN_RESERVE + c.tokenReserves; // reserve + any curve dust
        uint256 usdcLiquidity = c.realUsdcReserves;
        c.tokenReserves = 0;
        c.realUsdcReserves = 0;

        IERC20(token).forceApprove(router, tokenLiquidity);
        usdc.forceApprove(router, usdcLiquidity);

        (,, uint256 liquidity) = IDEXRouter(router).addLiquidity(
            token,
            address(usdc),
            tokenLiquidity,
            usdcLiquidity,
            0, // zero-slippage is deliberate here: this is the FIRST liquidity ever added
            0, // for this pair, so there's no existing pool price to be sandwiched against —
            BURN_ADDRESS, // this only stays safe as long as it's genuinely a first deposit,
            block.timestamp + 15 minutes // not a top-up of an existing pool. Recheck this
        );                                // assumption if the router logic ever changes.

        // A router call can technically succeed while returning zero — e.g. it silently
        // no-opped instead of reverting. Without this check, graduated would already be
        // true and the funds already gone, with no on-chain signal anything went wrong.
        require(liquidity > 0, "graduation failed: router returned no liquidity");

        emit Graduated(token, tokenLiquidity, usdcLiquidity, liquidity);
    }

    // ── Views ───────────────────────────────────────────────────────────

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

    // ── Admin (should be a multisig, not an EOA, before real funds are involved) ──

    function setRouter(address router_) external onlyOwner {
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

    /// @notice Sets the graduation threshold that will apply to tokens created AFTER this
    ///         call. Existing tokens keep the threshold they launched under.
    function setDefaultGraduationThreshold(uint256 thresholdUsdc_) external onlyOwner {
        defaultGraduationThresholdUsdc = thresholdUsdc_;
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
