// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";

import "./BXR1Token.sol";
import "./AssetRegistry.sol";
import "./CurveMath.sol";
import "../interfaces/IDEXRouter.sol";

contract BXR1 is Ownable, ReentrancyGuard, Pausable {
    using SafeERC20 for IERC20;

    uint256 public constant CURVE_TOKEN_SUPPLY = 807_000_000e18;

    uint256 public constant LP_TOKEN_RESERVE = 193_000_000e18;
    uint256 public constant TOTAL_TOKEN_SUPPLY = CURVE_TOKEN_SUPPLY + LP_TOKEN_RESERVE;

    uint256 public constant INITIAL_VIRTUAL_TOKEN_RESERVES = 1_075_000_000e18;
    // No INITIAL_VIRTUAL_QUOTE_RESERVES constant. That figure is asset-specific -- a
    // curve quoted in an 18-decimal asset needs a different raw magnitude than one
    // quoted in 6-decimal USDC to open at the same price -- so it lives in
    // AssetRegistry.AssetConfig.initialVirtualReserve and is read once, at createToken,
    // never re-read for an existing curve. See createToken and AssetRegistry.sol.

    uint256 public defaultGraduationThreshold = 8_000e6;
    address public constant BURN_ADDRESS = 0x000000000000000000000000000000000000dEaD;

    address public router;

    uint256 public constant ROUTER_TIMELOCK = 24 hours;

    mapping(address => uint256) public routerProposedAt;

    uint16 public defaultBuyFeeBps = 100;
    uint16 public defaultSellFeeBps = 100;
    uint16 public constant MAX_FEE_BPS = 1000;
    uint256 public constant BPS_DENOMINATOR = 10_000;

    uint16 public maxCreatorLaunchBps = 250;

    uint32 public creatorLaunchWindow = 3;

    // Asset-keyed, not a single total. Fees on a curve accrue in THAT curve's quote
    // asset (Curve.quoteAsset), and different curves can carry different quote assets, so
    // a single global counter would conflate amounts owed in different tokens under one
    // number. claimTreasuryFees(asset) / claimCreatorFees(asset) both take the asset to
    // settle, for exactly this reason.
    mapping(address => uint256) public treasuryFeesAccrued;

    address public lpRecipient = BURN_ADDRESS;

    uint16 public defaultCreatorBuyFeeBps = 90;
    uint16 public defaultCreatorSellFeeBps = 50;

    // creator => quote asset => amount owed. Same reasoning as treasuryFeesAccrued above.
    mapping(address => mapping(address => uint256)) public creatorFeesAccrued;

    uint16 public constant MAX_TOTAL_FEE_BPS = 9900;

    mapping(uint32 => uint16[]) private _snipeTaxTables;

    mapping(uint32 => uint16) public snipeTaxTableMaxBps;

    uint32 public activeSnipeTaxTableVersion;
    uint32 private _nextSnipeTaxTableVersion;

    uint16 public defaultSnipeTaxTreasuryBps = 7000;

    uint256 public creationFee = 5e5;
    address public treasury;

    uint256 public launchCooldown = 10;
    mapping(address => uint256) public lastLaunchTimestamp;

    uint256 public symbolLockDuration = 5 minutes;

    mapping(bytes32 => uint256) public symbolUnlocksAt;

    bool public caseSensitiveSymbols = true;

    enum CurveState { ACTIVE, GRADUATION_READY, GRADUATED }

    struct Curve {
        address token;
        // Snapshotted ONCE, at createToken, from AssetRegistry.getAsset(quoteAsset).
        // Never re-read from the registry for the life of this curve -- an asset being
        // disabled, or re-registered with different flags or a different
        // initialVirtualReserve, affects only launches created AFTER the change.
        address quoteAsset;
        address creator;
        uint256 virtualTokenReserves;
        uint256 virtualQuoteReserves;
        uint256 realQuoteReserves;
        uint256 tokenReserves;
        CurveState state;

        uint16 buyFeeBps;
        uint16 sellFeeBps;

        uint16 creatorBuyFeeBps;
        uint16 creatorSellFeeBps;
        uint256 graduationThreshold;

        uint256 creationBlock;

        uint256 creationTimestamp;
        uint32 snipeTaxTableVersion;
        uint16 snipeTaxTreasuryBps;

        uint16 maxCreatorLaunchBps;
        uint32 creatorLaunchWindow;

        address lpRecipient;
        bool poolBoostEnabled;

        uint256 poolBoost;

        uint256 creatorLaunchPurchased;
    }

    mapping(address => Curve) private _curves;

    function curves(address token) external view returns (Curve memory) {
        return _curves[token];
    }

    // No single `usdc` immutable any more. Each curve carries its own quote asset
    // (Curve.quoteAsset, snapshotted at creation); this is the registry that decides
    // whether an asset may be used for a NEW curve at all. See createToken.
    AssetRegistry public immutable assetRegistry;

    // BuyQuote and SellQuote now live in CurveMath.sol, alongside the functions that
    // build them (_quoteBuy / _quoteSell delegate there). FeeSplit stays here: it is
    // built by _splitBuyFee, which was measured and deliberately NOT extracted -- see
    // CurveMath.sol's header comment.
    struct FeeSplit {
        uint256 creatorCut;
        uint256 treasuryCut;
        uint256 curveCut;
        uint256 snipeToTreasury;
    }

    event TokenCreated(address indexed token, address indexed creator, string name, string symbol, string metadataURI);
    event Trade(address indexed token, address indexed trader, bool isBuy, uint256 quoteAmount, uint256 tokenAmount);
    event Graduated(address indexed token, uint256 tokenLiquidity, uint256 quoteLiquidity, uint256 lpTokensBurned);
    event GraduationReady(address indexed token);
    event GraduationAttemptFailed(address indexed token);
    event CaseSensitiveSymbolsSet(bool caseSensitive);

    event CreatorLaunchBuy(
        address indexed token,
        address indexed creator,
        uint256 quoteSpent,
        uint256 tokensReceived,
        uint256 bpsOfCurveSupply
    );
    event RouterProposed(address indexed router, uint256 activatableAt);

    event MetadataURIUpdated(
        address indexed token,
        address indexed creator,
        string oldURI,
        string newURI
    );
    event PoolBoostAccrued(address indexed token, uint256 amount, uint256 total);
    event RouterActivated(address indexed router);
    event MaxCreatorLaunchBpsSet(uint16 maxCreatorLaunchBps);
    event CreatorLaunchWindowSet(uint32 creatorLaunchWindow);
    event RouterRevoked(address indexed router, bool wasLive);
    event CreatorFeeAccrued(address indexed token, address indexed creator, uint256 amount);
    event CreatorFeesClaimed(address indexed creator, uint256 amount);
    event TreasuryFeesClaimed(address indexed treasury, uint256 amount);
    event LpRecipientSet(address indexed oldRecipient, address indexed newRecipient);
    event LaunchCooldownSet(uint256 oldValue, uint256 newValue);
    event SymbolLockDurationSet(uint256 oldValue, uint256 newValue);
    event CreationFeeSet(uint256 oldValue, uint256 newValue);
    event DefaultGraduationThresholdSet(uint256 oldValue, uint256 newValue);
    event DefaultFeesSet(uint16 oldBuyFeeBps, uint16 newBuyFeeBps, uint16 oldSellFeeBps, uint16 newSellFeeBps);
    event DefaultCreatorFeesSet(uint16 creatorBuyFeeBps, uint16 creatorSellFeeBps);
    event SnipeTaxTablePublished(uint32 indexed version, uint16[] table, uint16 maxBps);
    event DefaultSnipeTaxTreasuryBpsSet(uint16 treasuryBps);
    event SnipeTaxCollected(address indexed token, address indexed buyer, uint256 toTreasury, uint256 toCurve);

    error AssetNotEnabled(address asset);
    error AssetMisbehaves(address asset, bool rebasing, bool transferRestricted, bool transferFee);
    error BaseFeeCeilingExceeded();
    error BpsExceedsDenominator();
    error CreatorAllocationUsed();
    error CreatorBuyShareExceedsFee();
    error CreatorSellShareExceedsFee();
    error CurveNotActive(CurveState state);
    error EconomicsChanged();
    error FeeBelowCreatorShare();
    error FeeExceedsCeiling();
    error GraduationFailed();
    error LaunchCooldownActive(uint256 readyAt);
    error LaunchWindowClosed(uint256 closedAt);
    error NotCreator();
    error NotReadyToGraduate(CurveState state);
    error NothingToClaim();
    error RouterNotProposed();
    error RouterNotSet();
    error RouterTimelockPending(uint256 activatableAt);
    error SlippageExceeded(uint256 received, uint256 minRequested);
    error SnipeTaxCeilingExceeded();
    error SymbolLocked(uint256 unlocksAt);
    error TradingNotOpenYet();
    error UnknownToken();
    error ZeroAddress();
    error QuoteTransferMismatch();
    error ZeroAmount();
    error OwnershipCannotBeRenounced();

    constructor(address assetRegistry_, address treasury_, address initialRouter_) Ownable(msg.sender) {
        if (!(assetRegistry_ != address(0) && treasury_ != address(0))) revert ZeroAddress();
        assetRegistry = AssetRegistry(assetRegistry_);
        treasury = treasury_;

        if (initialRouter_ != address(0)) {

            emit RouterProposed(initialRouter_, block.timestamp);
            router = initialRouter_;
            emit RouterActivated(initialRouter_);
        }

        uint16[] memory opening = new uint16[](8);
        opening[0] = 9800;
        opening[1] = 9500;
        opening[2] = 9000;
        opening[3] = 8000;
        opening[4] = 6000;
        opening[5] = 4000;
        opening[6] = 2000;
        opening[7] = 0;
        _publishSnipeTaxTable(opening);
    }

    function publishSnipeTaxTable(uint16[] calldata table)
        external
        onlyOwner
        returns (uint32 version)
    {
        uint16[] memory copied = new uint16[](table.length);
        for (uint256 i = 0; i < table.length; i++) {
            copied[i] = table[i];
        }
        return _publishSnipeTaxTable(copied);
    }

    function _publishSnipeTaxTable(uint16[] memory table) internal returns (uint32 version) {
        uint16 maxBps = 0;
        for (uint256 i = 0; i < table.length; i++) {
            if (table[i] > maxBps) maxBps = table[i];
        }

        if (!(uint256(maxBps) + uint256(MAX_FEE_BPS) <= uint256(MAX_TOTAL_FEE_BPS) || uint256(maxBps) + uint256(defaultBuyFeeBps) <= uint256(MAX_TOTAL_FEE_BPS))) revert SnipeTaxCeilingExceeded();

        version = _nextSnipeTaxTableVersion++;
        _snipeTaxTables[version] = table;
        snipeTaxTableMaxBps[version] = maxBps;
        activeSnipeTaxTableVersion = version;
        emit SnipeTaxTablePublished(version, table, maxBps);
    }

    function snipeTaxTable(uint32 version) external view returns (uint16[] memory) {
        return _snipeTaxTables[version];
    }

    function currentSnipeTaxBps(address token) external view returns (uint16) {
        Curve storage c = _curves[token];
        if (!(c.token == token)) revert UnknownToken();
        return _snipeTaxBps(c);
    }

    function _snipeTaxBps(Curve storage c) internal view returns (uint16) {
        uint16[] storage table = _snipeTaxTables[c.snipeTaxTableVersion];
        uint256 elapsed = block.timestamp - c.creationTimestamp;
        if (elapsed >= table.length) return 0;
        return table[elapsed];
    }

    function setDefaultSnipeTaxTreasuryBps(uint16 treasuryBps_) external onlyOwner {
        if (!(treasuryBps_ <= BPS_DENOMINATOR)) revert BpsExceedsDenominator();
        defaultSnipeTaxTreasuryBps = treasuryBps_;
        emit DefaultSnipeTaxTreasuryBpsSet(treasuryBps_);
    }

    function currentEconomicsHash() public view returns (bytes32) {
        return keccak256(abi.encode(
            defaultBuyFeeBps,
            defaultSellFeeBps,
            defaultGraduationThreshold,
            defaultCreatorBuyFeeBps,
            defaultCreatorSellFeeBps,
            maxCreatorLaunchBps,
            creatorLaunchWindow,
            lpRecipient,
            activeSnipeTaxTableVersion,
            defaultSnipeTaxTreasuryBps,
            caseSensitiveSymbols,
            symbolLockDuration
        ));
    }

    function createToken(
        string calldata name,
        string calldata symbol,
        string calldata metadataURI,
        address quoteAsset,
        bytes32 expectedEconomicsHash,
        bool poolBoostEnabled
    ) external nonReentrant whenNotPaused returns (address token) {

        if (!(router != address(0))) revert RouterNotSet();

        if (!(uint256(defaultBuyFeeBps) + uint256(snipeTaxTableMaxBps[activeSnipeTaxTableVersion]) <= uint256(MAX_TOTAL_FEE_BPS))) revert BaseFeeCeilingExceeded();
        if (!(expectedEconomicsHash == currentEconomicsHash())) revert EconomicsChanged();
        if (!(block.timestamp >= lastLaunchTimestamp[msg.sender] + launchCooldown)) revert LaunchCooldownActive(lastLaunchTimestamp[msg.sender] + launchCooldown);

        // The asset gate. A void check rather than one returning the resolved config:
        // holding an extra local across the rest of this function is stack-too-deep at
        // 0.8.24 with the optimizer at 200 runs, the same reason BallistaV4Adapter.sol
        // splits _seed out of addLiquidity. CLAUDE.md section 5 is explicit that the fix
        // is to extract a function and never viaIR. _buildCurve below does its own
        // registry read for the one field it actually needs, in its own stack frame.
        _requireAssetUsable(quoteAsset);

        bytes32 symbolHash = caseSensitiveSymbols
            ? keccak256(bytes(symbol))
            : keccak256(bytes(_toUpperAscii(symbol)));
        uint256 unlocksAt = symbolUnlocksAt[symbolHash];
        if (!(unlocksAt == 0 || block.timestamp >= unlocksAt)) revert SymbolLocked(unlocksAt);

        if (creationFee > 0) {
            IERC20(quoteAsset).safeTransferFrom(msg.sender, address(this), creationFee);
            treasuryFeesAccrued[quoteAsset] += creationFee;
        }

        lastLaunchTimestamp[msg.sender] = block.timestamp;
        symbolUnlocksAt[symbolHash] = block.timestamp + symbolLockDuration;

        BXR1Token newToken = new BXR1Token(
            name,
            symbol,
            TOTAL_TOKEN_SUPPLY,
            msg.sender,
            address(this),
            metadataURI
        );
        token = address(newToken);

        _curves[token] = _buildCurve(token, quoteAsset, poolBoostEnabled);

        emit TokenCreated(token, msg.sender, name, symbol, metadataURI);
    }

    // The gate alone, as a void check: createToken calls this early and holds no return
    // value across the rest of the function, which is what the stack-too-deep fix needs.
    function _requireAssetUsable(address quoteAsset) internal view {
        AssetRegistry.AssetConfig memory cfg = assetRegistry.getAsset(quoteAsset);
        if (!cfg.enabled) revert AssetNotEnabled(quoteAsset);
        if (cfg.rebasing || cfg.transferRestricted || cfg.transferFee) {
            revert AssetMisbehaves(quoteAsset, cfg.rebasing, cfg.transferRestricted, cfg.transferFee);
        }
    }

    // Everything the new Curve needs that ISN'T one of createToken's own parameters.
    // Extracted for the same stack-too-deep reason as _requireAssetUsable above: building
    // this struct literal inline, on top of createToken's own six parameters and locals,
    // is one field too many for 0.8.24 at 200 runs. Never viaIR (CLAUDE.md section 5).
    //
    // Reads the registry a second time (createToken's own _requireAssetUsable call above
    // already read it once, for the gate) rather than threading the looked-up value
    // through as a parameter -- that parameter is exactly the local createToken cannot
    // afford to hold. A second view call to an already-registered asset is cheap and
    // never reverts here: _requireAssetUsable already proved `enabled` moments earlier
    // in the same transaction, and nothing between the two calls can change it.
    function _buildCurve(
        address token,
        address quoteAsset,
        bool poolBoostEnabled
    ) internal view returns (Curve memory c) {
        c.token = token;
        c.quoteAsset = quoteAsset;
        c.creator = msg.sender;
        c.virtualTokenReserves = INITIAL_VIRTUAL_TOKEN_RESERVES;
        // In quoteAsset's own native decimals -- see AssetRegistry.AssetConfig.
        c.virtualQuoteReserves = assetRegistry.getAsset(quoteAsset).initialVirtualReserve;
        c.tokenReserves = CURVE_TOKEN_SUPPLY;
        c.state = CurveState.ACTIVE;
        c.buyFeeBps = defaultBuyFeeBps;
        c.sellFeeBps = defaultSellFeeBps;
        c.creatorBuyFeeBps = defaultCreatorBuyFeeBps;
        c.creatorSellFeeBps = defaultCreatorSellFeeBps;
        c.graduationThreshold = defaultGraduationThreshold;
        c.creationBlock = block.number;
        c.creationTimestamp = block.timestamp;
        c.snipeTaxTableVersion = activeSnipeTaxTableVersion;
        c.snipeTaxTreasuryBps = defaultSnipeTaxTreasuryBps;
        c.maxCreatorLaunchBps = maxCreatorLaunchBps;
        c.creatorLaunchWindow = creatorLaunchWindow;
        c.lpRecipient = lpRecipient;
        c.poolBoostEnabled = poolBoostEnabled;
        // realQuoteReserves, creatorLaunchPurchased and poolBoost are left at their
        // zero default, exactly as the original inline literal set them explicitly.
    }

    // The asset gate. A CREATION-TIME gate, not a warning read anywhere else: an asset
    // that is not enabled, or that carries any of the three misbehaviour flags, can
    // never become a curve's quote asset -- it does not matter whether it was never
    // registered (AssetRegistry's zero-value sentinel has enabled == false) or was
    // registered and explicitly disabled. Both refuse identically. Returns only the one
    // field createToken actually needs, rather than the whole AssetConfig, which is both
    // the smallest interface and part of why extracting this fixes the stack-too-deep.
    function _resolveQuoteAsset(address quoteAsset) internal view returns (uint256 initialVirtualReserve) {
        AssetRegistry.AssetConfig memory cfg = assetRegistry.getAsset(quoteAsset);
        if (!cfg.enabled) revert AssetNotEnabled(quoteAsset);
        if (cfg.rebasing || cfg.transferRestricted || cfg.transferFee) {
            revert AssetMisbehaves(quoteAsset, cfg.rebasing, cfg.transferRestricted, cfg.transferFee);
        }
        return cfg.initialVirtualReserve;
    }

    function _toUpperAscii(string memory str) internal pure returns (string memory) {
        bytes memory b = bytes(str);
        for (uint256 i = 0; i < b.length; i++) {
            if (b[i] >= 0x61 && b[i] <= 0x7A) {
                b[i] = bytes1(uint8(b[i]) - 32);
            }
        }
        return string(b);
    }

    // Delegates to CurveMath.quoteBuy -- see CurveMath.sol. Kept as a thin internal
    // wrapper (rather than calling CurveMath.quoteBuy at every call site) so the
    // three call sites below read exactly as they did before the extraction.
    function _quoteBuy(
        uint256 quoteIn,
        uint16 buyFeeBps,
        uint256 virtualQuoteReserves,
        uint256 virtualTokenReserves,
        uint256 tokenReservesAvailable
    ) internal pure returns (CurveMath.BuyQuote memory q) {
        return CurveMath.quoteBuy(quoteIn, buyFeeBps, virtualQuoteReserves, virtualTokenReserves, tokenReservesAvailable);
    }

    function updateMetadataURI(address token, string calldata newURI) external {
        Curve storage c = _curves[token];
        if (!(c.token == token)) revert UnknownToken();
        if (!(msg.sender == c.creator)) revert NotCreator();

        string memory oldURI = BXR1Token(token).metadataURI();
        BXR1Token(token).setMetadataURI(newURI);
        emit MetadataURIUpdated(token, msg.sender, oldURI, newURI);
    }

    function _settleBuy(
        address token,
        Curve storage c,
        CurveMath.BuyQuote memory q,
        uint16 taxBps
    ) internal {
        FeeSplit memory f = _splitBuyFee(c, q.actualQuoteIn, q.actualFee);

        c.virtualQuoteReserves = q.newVirtualQuote;
        c.virtualTokenReserves = q.newVirtualToken;

        c.realQuoteReserves += (q.actualQuoteIn - q.actualFee) + f.curveCut;
        c.tokenReserves -= q.tokensOut;

        bool crossedThreshold =
            c.realQuoteReserves >= c.graduationThreshold || c.tokenReserves == 0;

        _routeCreatorCut(token, c, f.creatorCut);
        if (taxBps > 0) {
            emit SnipeTaxCollected(token, msg.sender, f.snipeToTreasury, f.curveCut);
        }

        // The only site that CREDITS realQuoteReserves from a requested amount, so the
        // only one where a short transfer under-collateralises the pool rather than
        // merely short-paying the caller. Both reads are inside ReentrancyGuard's
        // nonReentrant, held by buy() and creatorLaunchBuy() -- the only two callers of
        // _settleBuy -- so nothing else can move the quote asset between them.
        //
        // Kept as a GENERAL defence, not an Arc-USDC-specific one. It was proven exact
        // against Arc USDC's 18dp-native / 6dp-ERC20 duality; here it does the same job
        // against any registered asset that turns out to under-deliver on transfer --
        // exactly the fee-on-transfer misbehaviour AssetRegistry's `transferFee` flag is
        // meant to keep out at registration, with this check as the loud backstop if one
        // ever gets through.
        IERC20 quote = IERC20(c.quoteAsset);
        uint256 balBeforeBuy = quote.balanceOf(address(this));
        quote.safeTransferFrom(msg.sender, address(this), q.actualQuoteIn);
        if (quote.balanceOf(address(this)) - balBeforeBuy != q.actualQuoteIn) revert QuoteTransferMismatch();
        if (f.treasuryCut > 0) treasuryFeesAccrued[c.quoteAsset] += f.treasuryCut;
        IERC20(token).safeTransfer(msg.sender, q.tokensOut);
        emit Trade(token, msg.sender, true, q.actualQuoteIn, q.tokensOut);

        if (crossedThreshold) {

            c.state = CurveState.GRADUATION_READY;
            emit GraduationReady(token);
            if (!_performGraduation(token)) emit GraduationAttemptFailed(token);
        }
    }

    function creatorLaunchBuy(address token, uint256 quoteIn, uint256 minTokensOut)
        external
        nonReentrant
        whenNotPaused
    {
        Curve storage c = _curves[token];
        if (!(c.token == token)) revert UnknownToken();
        if (!(msg.sender == c.creator)) revert NotCreator();
        if (!(block.timestamp <= c.creationTimestamp + c.creatorLaunchWindow)) revert LaunchWindowClosed(c.creationTimestamp + c.creatorLaunchWindow);
        if (!(c.state == CurveState.ACTIVE)) revert CurveNotActive(c.state);
        if (!(quoteIn > 0)) revert ZeroAmount();

        uint256 cap = (CURVE_TOKEN_SUPPLY * uint256(c.maxCreatorLaunchBps)) / BPS_DENOMINATOR;
        if (!(c.creatorLaunchPurchased < cap)) revert CreatorAllocationUsed();
        uint256 remainingAllowance = cap - c.creatorLaunchPurchased;

        uint256 available =
            c.tokenReserves < remainingAllowance ? c.tokenReserves : remainingAllowance;

        CurveMath.BuyQuote memory q = _quoteBuy(
            quoteIn, c.buyFeeBps, c.virtualQuoteReserves, c.virtualTokenReserves, available
        );
        if (!(q.tokensOut >= minTokensOut)) revert SlippageExceeded(q.tokensOut, minTokensOut);

        c.creatorLaunchPurchased += q.tokensOut;
        emit CreatorLaunchBuy(
            token,
            msg.sender,
            q.actualQuoteIn,
            q.tokensOut,
            (c.creatorLaunchPurchased * BPS_DENOMINATOR) / CURVE_TOKEN_SUPPLY
        );

        _settleBuy(token, c, q, 0);
    }

    function buy(address token, uint256 quoteIn, uint256 minTokensOut) external nonReentrant whenNotPaused {
        Curve storage c = _curves[token];
        if (!(c.token == token)) revert UnknownToken();
        if (!(c.state == CurveState.ACTIVE)) revert CurveNotActive(c.state);
        if (!(block.number > c.creationBlock)) revert TradingNotOpenYet();
        if (!(quoteIn > 0)) revert ZeroAmount();

        uint16 taxBps = _snipeTaxBps(c);
        CurveMath.BuyQuote memory q = _quoteBuy(
            quoteIn, c.buyFeeBps + taxBps, c.virtualQuoteReserves, c.virtualTokenReserves, c.tokenReserves
        );
        if (!(q.tokensOut >= minTokensOut)) revert SlippageExceeded(q.tokensOut, minTokensOut);

        _settleBuy(token, c, q, taxBps);
    }

    // Delegates to CurveMath.quoteSell -- see CurveMath.sol.
    function _quoteSell(
        uint256 tokensIn,
        uint16 sellFeeBps,
        uint256 virtualQuoteReserves,
        uint256 virtualTokenReserves,
        uint256 realQuoteReservesAvailable
    ) internal pure returns (CurveMath.SellQuote memory q) {
        return CurveMath.quoteSell(tokensIn, sellFeeBps, virtualQuoteReserves, virtualTokenReserves, realQuoteReservesAvailable);
    }

    function sell(address token, uint256 tokensIn, uint256 minQuoteOut) external nonReentrant whenNotPaused {
        Curve storage c = _curves[token];
        if (!(c.token == token)) revert UnknownToken();
        if (!(c.state == CurveState.ACTIVE)) revert CurveNotActive(c.state);
        if (!(block.number > c.creationBlock)) revert TradingNotOpenYet();
        if (!(tokensIn > 0)) revert ZeroAmount();

        CurveMath.SellQuote memory q = _quoteSell(tokensIn, c.sellFeeBps, c.virtualQuoteReserves, c.virtualTokenReserves, c.realQuoteReserves);

        uint256 quoteOut = q.quoteOutGross - q.fee;
        if (!(quoteOut >= minQuoteOut)) revert SlippageExceeded(quoteOut, minQuoteOut);

        c.virtualTokenReserves = q.newVirtualToken;
        c.virtualQuoteReserves = q.newVirtualQuote;
        c.realQuoteReserves -= q.quoteOutGross;
        c.tokenReserves += q.actualTokensIn;

        uint256 creatorCut = _creatorCut(q.quoteOutGross, c.creatorSellFeeBps, q.fee);
        _routeCreatorCut(token, c, creatorCut);

        IERC20(token).safeTransferFrom(msg.sender, address(this), q.actualTokensIn);
        uint256 treasuryCut = q.fee - creatorCut;
        if (treasuryCut > 0) treasuryFeesAccrued[c.quoteAsset] += treasuryCut;
        IERC20(c.quoteAsset).safeTransfer(msg.sender, quoteOut);

        emit Trade(token, msg.sender, false, quoteOut, q.actualTokensIn);
    }

    // _ceilDiv moved into CurveMath.sol -- it was only ever called from _quoteBuy and
    // _quoteSell, both of which now delegate there. Every division on the curve still
    // rounds against the trader; the rounding direction did not change, only its
    // address.

    function _creatorCut(uint256 tradeAmount, uint16 creatorFeeBps, uint256 feeCharged)
        internal
        pure
        returns (uint256 cut)
    {
        if (creatorFeeBps == 0) return 0;
        cut = (tradeAmount * creatorFeeBps) / BPS_DENOMINATOR;
        if (cut > feeCharged) cut = feeCharged;
    }

    function _splitBuyFee(
        Curve storage c,
        uint256 actualQuoteIn,
        uint256 actualFee
    ) internal view returns (FeeSplit memory f) {
        uint256 baseFee = (actualQuoteIn * c.buyFeeBps) / BPS_DENOMINATOR;
        if (baseFee > actualFee) baseFee = actualFee;
        uint256 snipeTax = actualFee - baseFee;

        f.creatorCut = _creatorCut(actualQuoteIn, c.creatorBuyFeeBps, baseFee);

        if (snipeTax > 0) {
            f.snipeToTreasury = (snipeTax * c.snipeTaxTreasuryBps) / BPS_DENOMINATOR;
            f.curveCut = snipeTax - f.snipeToTreasury;
        }
        f.treasuryCut = (baseFee - f.creatorCut) + f.snipeToTreasury;
    }

    function _routeCreatorCut(address token, Curve storage c, uint256 cut) internal {
        if (cut == 0) return;
        if (c.poolBoostEnabled) {
            c.poolBoost += cut;
            emit PoolBoostAccrued(token, cut, c.poolBoost);
        } else {
            creatorFeesAccrued[c.creator][c.quoteAsset] += cut;
            emit CreatorFeeAccrued(token, c.creator, cut);
        }
    }

    // Asset-parametrized: fees accrue per (asset), and treasuryFeesAccrued is now keyed
    // that way. A treasury owed fees in more than one asset claims each separately.
    function claimTreasuryFees(address asset) external nonReentrant returns (uint256 amount) {
        amount = treasuryFeesAccrued[asset];
        if (!(amount > 0)) revert NothingToClaim();
        treasuryFeesAccrued[asset] = 0;
        IERC20(asset).safeTransfer(treasury, amount);
        emit TreasuryFeesClaimed(treasury, amount);
    }

    // Asset-parametrized for the same reason: creatorFeesAccrued is now keyed by
    // (creator, asset). A creator who launched against more than one quote asset claims
    // each asset's balance separately.
    function claimCreatorFees(address asset) external nonReentrant returns (uint256 amount) {
        amount = creatorFeesAccrued[msg.sender][asset];
        if (!(amount > 0)) revert NothingToClaim();
        creatorFeesAccrued[msg.sender][asset] = 0;
        IERC20(asset).safeTransfer(msg.sender, amount);
        emit CreatorFeesClaimed(msg.sender, amount);
    }

    function _performGraduation(address token) internal returns (bool success) {
        if (router == address(0)) return false;
        Curve storage c = _curves[token];
        IERC20 quote = IERC20(c.quoteAsset);

        uint256 tokenLiquidity = LP_TOKEN_RESERVE + c.tokenReserves;

        uint256 quoteLiquidity = c.realQuoteReserves + c.poolBoost;

        IERC20(token).forceApprove(router, tokenLiquidity);
        quote.forceApprove(router, quoteLiquidity);

        try IDEXRouter(router).addLiquidity(
            token,
            c.quoteAsset,
            tokenLiquidity,
            quoteLiquidity,
            tokenLiquidity,
            quoteLiquidity,
            c.lpRecipient,
            block.timestamp + 15 minutes
        ) returns (uint256 amountA, uint256 amountB, uint256 liquidity) {
            // Clear whatever the router did not consume, on every path. A router that
            // takes less than it was offered otherwise leaves a live allowance over the
            // pooled balance for as long as it stays configured.
            IERC20(token).forceApprove(router, 0);
            quote.forceApprove(router, 0);

            if (liquidity == 0) {
                return false;
            }

            c.state = CurveState.GRADUATED;
            c.tokenReserves = 0;
            c.realQuoteReserves = 0;
            c.poolBoost = 0;
            // The amounts the router ACTUALLY took, not the amounts it was offered.
            emit Graduated(token, amountA, amountB, liquidity);
            return true;
        } catch {
            IERC20(token).forceApprove(router, 0);
            quote.forceApprove(router, 0);
            return false;
        }
    }

    function graduate(address token) external nonReentrant {
        Curve storage c = _curves[token];
        if (!(c.token == token)) revert UnknownToken();
        if (!(c.state == CurveState.GRADUATION_READY)) revert NotReadyToGraduate(c.state);
        if (!(router != address(0))) revert RouterNotSet();
        if (!(_performGraduation(token))) revert GraduationFailed();
    }

    function quoteBuy(address token, uint256 quoteIn) external view returns (CurveMath.BuyQuote memory) {
        Curve storage c = _curves[token];
        if (!(c.token == token)) revert UnknownToken();
        if (!(c.state == CurveState.ACTIVE)) revert CurveNotActive(c.state);

        return _quoteBuy(quoteIn, c.buyFeeBps + _snipeTaxBps(c), c.virtualQuoteReserves, c.virtualTokenReserves, c.tokenReserves);
    }

    function quoteSell(address token, uint256 tokensIn) external view returns (CurveMath.SellQuote memory) {
        Curve storage c = _curves[token];
        if (!(c.token == token)) revert UnknownToken();
        if (!(c.state == CurveState.ACTIVE)) revert CurveNotActive(c.state);
        return _quoteSell(tokensIn, c.sellFeeBps, c.virtualQuoteReserves, c.virtualTokenReserves, c.realQuoteReserves);
    }

    // ⚠ KNOWN RESIDUAL: the `1e18` scaling here is a WAD convention calibrated for a
    // 6dp-quote/18dp-token pair (see the historical USDC-only build). It is left exactly
    // as it was rather than adding a normalisation layer -- curve math is not supposed
    // to know about decimals, and this function already carried a fixed, uncalibrated
    // scale factor before this change. For a quote asset whose decimals differ from 6,
    // this still returns a valid raw ratio, just at a different magnitude than a caller
    // calibrated to USDC would expect. Not fixed here; flagged for whoever consumes it.
    function currentPrice(address token) external view returns (uint256) {
        Curve storage c = _curves[token];
        if (!(c.token == token)) revert UnknownToken();
        return (c.virtualQuoteReserves * 1e18) / c.virtualTokenReserves;
    }

    function graduationProgressBps(address token) external view returns (uint256) {
        Curve storage c = _curves[token];
        if (!(c.token == token)) revert UnknownToken();

        if (c.state != CurveState.ACTIVE) return BPS_DENOMINATOR;
        if (c.realQuoteReserves >= c.graduationThreshold || c.tokenReserves == 0) {
            return BPS_DENOMINATOR;
        }
        uint256 byThreshold =
            (c.realQuoteReserves * BPS_DENOMINATOR) / c.graduationThreshold;
        uint256 bySupply =
            ((CURVE_TOKEN_SUPPLY - c.tokenReserves) * BPS_DENOMINATOR) / CURVE_TOKEN_SUPPLY;
        return byThreshold >= bySupply ? byThreshold : bySupply;
    }

    function isSymbolAvailable(string calldata symbol) external view returns (bool) {
        bytes32 symbolHash = caseSensitiveSymbols
            ? keccak256(bytes(symbol))
            : keccak256(bytes(_toUpperAscii(symbol)));
        uint256 unlocksAt = symbolUnlocksAt[symbolHash];
        return unlocksAt == 0 || block.timestamp >= unlocksAt;
    }

    function proposeRouter(address router_) external onlyOwner {
        if (!(router_ != address(0))) revert ZeroAddress();
        routerProposedAt[router_] = block.timestamp;
        emit RouterProposed(router_, block.timestamp + ROUTER_TIMELOCK);
    }

    function activateRouter(address router_) external onlyOwner {
        if (!(router_ != address(0))) revert ZeroAddress();
        uint256 proposedAt = routerProposedAt[router_];
        if (!(proposedAt != 0)) revert RouterNotProposed();
        if (!(block.timestamp >= proposedAt + ROUTER_TIMELOCK)) revert RouterTimelockPending(proposedAt + ROUTER_TIMELOCK);
        routerProposedAt[router_] = 0;
        router = router_;
        emit RouterActivated(router_);
    }

    function revokeRouter(address router_) external onlyOwner {
        if (!(router_ != address(0))) revert ZeroAddress();
        routerProposedAt[router_] = 0;
        bool wasLive = (router == router_);
        if (wasLive) router = address(0);
        emit RouterRevoked(router_, wasLive);
    }

    function setDefaultFees(uint16 buyFeeBps_, uint16 sellFeeBps_) external onlyOwner {
        if (!(buyFeeBps_ <= MAX_FEE_BPS && sellFeeBps_ <= MAX_FEE_BPS)) revert FeeExceedsCeiling();

        if (!(defaultCreatorBuyFeeBps <= buyFeeBps_ && defaultCreatorSellFeeBps <= sellFeeBps_)) revert FeeBelowCreatorShare();
        emit DefaultFeesSet(defaultBuyFeeBps, buyFeeBps_, defaultSellFeeBps, sellFeeBps_);
        defaultBuyFeeBps = buyFeeBps_;
        defaultSellFeeBps = sellFeeBps_;
    }

    function setDefaultCreatorFees(uint16 creatorBuyFeeBps_, uint16 creatorSellFeeBps_)
        external
        onlyOwner
    {
        if (!(creatorBuyFeeBps_ <= defaultBuyFeeBps)) revert CreatorBuyShareExceedsFee();
        if (!(creatorSellFeeBps_ <= defaultSellFeeBps)) revert CreatorSellShareExceedsFee();
        defaultCreatorBuyFeeBps = creatorBuyFeeBps_;
        defaultCreatorSellFeeBps = creatorSellFeeBps_;
        emit DefaultCreatorFeesSet(creatorBuyFeeBps_, creatorSellFeeBps_);
    }

    function setMaxCreatorLaunchBps(uint16 maxCreatorLaunchBps_) external onlyOwner {
        if (!(maxCreatorLaunchBps_ <= BPS_DENOMINATOR)) revert BpsExceedsDenominator();
        maxCreatorLaunchBps = maxCreatorLaunchBps_;
        emit MaxCreatorLaunchBpsSet(maxCreatorLaunchBps_);
    }

    function setCreatorLaunchWindow(uint32 creatorLaunchWindow_) external onlyOwner {
        creatorLaunchWindow = creatorLaunchWindow_;
        emit CreatorLaunchWindowSet(creatorLaunchWindow_);
    }

    function setCreationFee(uint256 creationFee_) external onlyOwner {
        emit CreationFeeSet(creationFee, creationFee_);
        creationFee = creationFee_;
    }

    function setLpRecipient(address lpRecipient_) external onlyOwner {
        if (!(lpRecipient_ != address(0) && lpRecipient_ != address(this))) revert ZeroAddress();
        emit LpRecipientSet(lpRecipient, lpRecipient_);
        lpRecipient = lpRecipient_;
    }

    function setLaunchCooldown(uint256 launchCooldown_) external onlyOwner {
        emit LaunchCooldownSet(launchCooldown, launchCooldown_);
        launchCooldown = launchCooldown_;
    }

    function setSymbolLockDuration(uint256 symbolLockDuration_) external onlyOwner {
        emit SymbolLockDurationSet(symbolLockDuration, symbolLockDuration_);
        symbolLockDuration = symbolLockDuration_;
    }

    function setDefaultGraduationThreshold(uint256 threshold_) external onlyOwner {
        emit DefaultGraduationThresholdSet(defaultGraduationThreshold, threshold_);
        defaultGraduationThreshold = threshold_;
    }

    function setCaseSensitiveSymbols(bool caseSensitive_) external onlyOwner {
        caseSensitiveSymbols = caseSensitive_;
        emit CaseSensitiveSymbolsSet(caseSensitive_);
    }

    function setTreasury(address treasury_) external onlyOwner {
        if (!(treasury_ != address(0))) revert ZeroAddress();
        treasury = treasury_;
    }

    function renounceOwnership() public pure override {
        revert OwnershipCannotBeRenounced();
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }
}
