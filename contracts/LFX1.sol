// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 [LICENSOR]. Licensed under the Business Source License 1.1.
// Change Date: 2030-09-16. Change License: GPL-2.0-or-later. See LICENSE.
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";

import "./LFX1Token.sol";
import "./interfaces/IDEXRouter.sol";

contract LFX1 is Ownable, ReentrancyGuard, Pausable {
    using SafeERC20 for IERC20;

    uint256 public constant CURVE_TOKEN_SUPPLY = 807_000_000e18;

    uint256 public constant LP_TOKEN_RESERVE = 193_000_000e18;
    uint256 public constant TOTAL_TOKEN_SUPPLY = CURVE_TOKEN_SUPPLY + LP_TOKEN_RESERVE;

    uint256 public constant INITIAL_VIRTUAL_TOKEN_RESERVES = 1_075_000_000e18;
    uint256 public constant INITIAL_VIRTUAL_USDC_RESERVES = 2_667e6;

    uint256 public defaultGraduationThresholdUsdc = 8_000e6;
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

    uint256 public treasuryFeesAccrued;

    uint16 public defaultCreatorBuyFeeBps = 90;
    uint16 public defaultCreatorSellFeeBps = 50;

    mapping(address => uint256) public creatorFeesAccrued;

    uint16 public constant MAX_TOTAL_FEE_BPS = 9900;

    mapping(uint32 => uint16[]) private _snipeTaxTables;

    mapping(uint32 => uint16) public snipeTaxTableMaxBps;

    uint32 public activeSnipeTaxTableVersion;
    uint32 private _nextSnipeTaxTableVersion;

    uint16 public defaultSnipeTaxTreasuryBps = 7000;

    uint256 public creationFeeUsdc = 5e5;
    address public treasury;

    uint256 public launchCooldown = 10;
    mapping(address => uint256) public lastLaunchTimestamp;

    uint256 public symbolLockDuration = 5 minutes;

    mapping(bytes32 => uint256) public symbolUnlocksAt;

    bool public caseSensitiveSymbols = true;

    enum CurveState { ACTIVE, GRADUATION_READY, GRADUATED }

    struct Curve {
        address token;
        address creator;
        uint256 virtualTokenReserves;
        uint256 virtualUsdcReserves;
        uint256 realUsdcReserves;
        uint256 tokenReserves;
        CurveState state;

        uint16 buyFeeBps;
        uint16 sellFeeBps;

        uint16 creatorBuyFeeBps;
        uint16 creatorSellFeeBps;
        uint256 graduationThresholdUsdc;

        uint256 creationBlock;

        uint256 creationTimestamp;
        uint32 snipeTaxTableVersion;
        uint16 snipeTaxTreasuryBps;

        uint16 maxCreatorLaunchBps;
        uint32 creatorLaunchWindow;

        bool poolBoostEnabled;

        uint256 poolBoost;

        uint256 creatorLaunchPurchased;
    }

    mapping(address => Curve) private _curves;

    function curves(address token) external view returns (Curve memory) {
        return _curves[token];
    }
    IERC20 public immutable usdc;

    struct BuyQuote {
        uint256 tokensOut;
        uint256 newVirtualUsdc;
        uint256 newVirtualToken;
        uint256 actualUsdcIn;
        uint256 actualFee;
    }

    struct FeeSplit {
        uint256 creatorCut;
        uint256 treasuryCut;
        uint256 curveCut;
        uint256 snipeToTreasury;
    }

    struct SellQuote {
        uint256 actualTokensIn;
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

    event CreatorLaunchBuy(
        address indexed token,
        address indexed creator,
        uint256 usdcSpent,
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
    event DefaultCreatorFeesSet(uint16 creatorBuyFeeBps, uint16 creatorSellFeeBps);
    event SnipeTaxTablePublished(uint32 indexed version, uint16[] table, uint16 maxBps);
    event DefaultSnipeTaxTreasuryBpsSet(uint16 treasuryBps);
    event SnipeTaxCollected(address indexed token, address indexed buyer, uint256 toTreasury, uint256 toCurve);

    error BaseFeeCeilingExceeded();
    error BpsExceedsDenominator();
    error ClampCostExceededOffer();
    error ClampInputExceededOffer();
    error CreatorAllocationUsed();
    error CreatorBuyShareExceedsFee();
    error CreatorSellShareExceedsFee();
    error CurveMathError();
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
    error ZeroAmount();

    constructor(address usdc_, address treasury_, address initialRouter_) Ownable(msg.sender) {
        if (!(usdc_ != address(0) && treasury_ != address(0))) revert ZeroAddress();
        usdc = IERC20(usdc_);
        treasury = treasury_;

        if (initialRouter_ != address(0)) {

            routerProposedAt[initialRouter_] = block.timestamp;
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
            defaultGraduationThresholdUsdc,
            defaultCreatorBuyFeeBps,
            defaultCreatorSellFeeBps,
            maxCreatorLaunchBps,
            creatorLaunchWindow,
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
        bytes32 expectedEconomicsHash,
        bool poolBoostEnabled
    ) external nonReentrant whenNotPaused returns (address token) {

        if (!(router != address(0))) revert RouterNotSet();

        if (!(uint256(defaultBuyFeeBps) + uint256(snipeTaxTableMaxBps[activeSnipeTaxTableVersion]) <= uint256(MAX_TOTAL_FEE_BPS))) revert BaseFeeCeilingExceeded();
        if (!(expectedEconomicsHash == currentEconomicsHash())) revert EconomicsChanged();
        if (!(block.timestamp >= lastLaunchTimestamp[msg.sender] + launchCooldown)) revert LaunchCooldownActive(lastLaunchTimestamp[msg.sender] + launchCooldown);

        bytes32 symbolHash = caseSensitiveSymbols
            ? keccak256(bytes(symbol))
            : keccak256(bytes(_toUpperAscii(symbol)));
        uint256 unlocksAt = symbolUnlocksAt[symbolHash];
        if (!(unlocksAt == 0 || block.timestamp >= unlocksAt)) revert SymbolLocked(unlocksAt);

        if (creationFeeUsdc > 0) {
            usdc.safeTransferFrom(msg.sender, address(this), creationFeeUsdc);
            treasuryFeesAccrued += creationFeeUsdc;
        }

        lastLaunchTimestamp[msg.sender] = block.timestamp;
        symbolUnlocksAt[symbolHash] = block.timestamp + symbolLockDuration;

        LFX1Token newToken = new LFX1Token(
            name,
            symbol,
            TOTAL_TOKEN_SUPPLY,
            msg.sender,
            address(this),
            metadataURI
        );
        token = address(newToken);

        _curves[token] = Curve({
            token: token,
            creator: msg.sender,
            virtualTokenReserves: INITIAL_VIRTUAL_TOKEN_RESERVES,
            virtualUsdcReserves: INITIAL_VIRTUAL_USDC_RESERVES,
            realUsdcReserves: 0,
            tokenReserves: CURVE_TOKEN_SUPPLY,
            state: CurveState.ACTIVE,
            buyFeeBps: defaultBuyFeeBps,
            sellFeeBps: defaultSellFeeBps,
            creatorBuyFeeBps: defaultCreatorBuyFeeBps,
            creatorSellFeeBps: defaultCreatorSellFeeBps,
            graduationThresholdUsdc: defaultGraduationThresholdUsdc,
            creationBlock: block.number,
            creationTimestamp: block.timestamp,
            snipeTaxTableVersion: activeSnipeTaxTableVersion,
            snipeTaxTreasuryBps: defaultSnipeTaxTreasuryBps,
            maxCreatorLaunchBps: maxCreatorLaunchBps,
            creatorLaunchWindow: creatorLaunchWindow,
            creatorLaunchPurchased: 0,
            poolBoostEnabled: poolBoostEnabled,
            poolBoost: 0
        });

        emit TokenCreated(token, msg.sender, name, symbol, metadataURI);
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

        uint256 newVirtualToken = _ceilDiv(k, newVirtualUsdc);
        if (!(newVirtualToken <= virtualTokenReserves)) revert CurveMathError();
        uint256 tokensOut = virtualTokenReserves - newVirtualToken;

        if (tokensOut <= tokenReservesAvailable) {

            q.tokensOut = tokensOut;
            q.newVirtualUsdc = newVirtualUsdc;
            q.newVirtualToken = newVirtualToken;
            q.actualUsdcIn = usdcIn;
            q.actualFee = fee;
            return q;
        }

        // Clamp: solve the curve backwards from the tokens actually available to the
        // input that buys exactly them, then re-add the fee.
        q.tokensOut = tokenReservesAvailable;
        q.newVirtualToken = virtualTokenReserves - q.tokensOut;

        q.newVirtualUsdc = _ceilDiv(k, q.newVirtualToken);
        uint256 clampedUsdcInAfterFee = q.newVirtualUsdc - virtualUsdcReserves;

        q.actualUsdcIn = _ceilDiv(clampedUsdcInAfterFee * BPS_DENOMINATOR, BPS_DENOMINATOR - buyFeeBps);
        q.actualFee = q.actualUsdcIn - clampedUsdcInAfterFee;

        if (!(q.actualUsdcIn <= usdcIn)) revert ClampCostExceededOffer();
    }

    function updateMetadataURI(address token, string calldata newURI) external {
        Curve storage c = _curves[token];
        if (!(c.token == token)) revert UnknownToken();
        if (!(msg.sender == c.creator)) revert NotCreator();

        string memory oldURI = LFX1Token(token).metadataURI();
        LFX1Token(token).setMetadataURI(newURI);
        emit MetadataURIUpdated(token, msg.sender, oldURI, newURI);
    }

    function _settleBuy(
        address token,
        Curve storage c,
        BuyQuote memory q,
        uint16 taxBps
    ) internal {
        FeeSplit memory f = _splitBuyFee(c, q.actualUsdcIn, q.actualFee);

        c.virtualUsdcReserves = q.newVirtualUsdc;
        c.virtualTokenReserves = q.newVirtualToken;

        c.realUsdcReserves += (q.actualUsdcIn - q.actualFee) + f.curveCut;
        c.tokenReserves -= q.tokensOut;

        bool crossedThreshold =
            c.realUsdcReserves >= c.graduationThresholdUsdc || c.tokenReserves == 0;

        _routeCreatorCut(token, c, f.creatorCut);
        if (taxBps > 0) {
            emit SnipeTaxCollected(token, msg.sender, f.snipeToTreasury, f.curveCut);
        }

        usdc.safeTransferFrom(msg.sender, address(this), q.actualUsdcIn);
        if (f.treasuryCut > 0) treasuryFeesAccrued += f.treasuryCut;
        IERC20(token).safeTransfer(msg.sender, q.tokensOut);
        emit Trade(token, msg.sender, true, q.actualUsdcIn, q.tokensOut);

        if (crossedThreshold) {

            c.state = CurveState.GRADUATION_READY;
            emit GraduationReady(token);
            if (!_performGraduation(token)) emit GraduationAttemptFailed(token);
        }
    }

    function creatorLaunchBuy(address token, uint256 usdcIn, uint256 minTokensOut)
        external
        nonReentrant
        whenNotPaused
    {
        Curve storage c = _curves[token];
        if (!(c.token == token)) revert UnknownToken();
        if (!(msg.sender == c.creator)) revert NotCreator();
        if (!(block.timestamp <= c.creationTimestamp + c.creatorLaunchWindow)) revert LaunchWindowClosed(c.creationTimestamp + c.creatorLaunchWindow);
        if (!(c.state == CurveState.ACTIVE)) revert CurveNotActive(c.state);
        if (!(usdcIn > 0)) revert ZeroAmount();

        uint256 cap = (CURVE_TOKEN_SUPPLY * uint256(c.maxCreatorLaunchBps)) / BPS_DENOMINATOR;
        if (!(c.creatorLaunchPurchased < cap)) revert CreatorAllocationUsed();
        uint256 remainingAllowance = cap - c.creatorLaunchPurchased;

        uint256 available =
            c.tokenReserves < remainingAllowance ? c.tokenReserves : remainingAllowance;

        BuyQuote memory q = _quoteBuy(
            usdcIn, c.buyFeeBps, c.virtualUsdcReserves, c.virtualTokenReserves, available
        );
        if (!(q.tokensOut >= minTokensOut)) revert SlippageExceeded(q.tokensOut, minTokensOut);

        c.creatorLaunchPurchased += q.tokensOut;
        emit CreatorLaunchBuy(
            token,
            msg.sender,
            q.actualUsdcIn,
            q.tokensOut,
            (c.creatorLaunchPurchased * BPS_DENOMINATOR) / CURVE_TOKEN_SUPPLY
        );

        _settleBuy(token, c, q, 0);
    }

    function buy(address token, uint256 usdcIn, uint256 minTokensOut) external nonReentrant whenNotPaused {
        Curve storage c = _curves[token];
        if (!(c.token == token)) revert UnknownToken();
        if (!(c.state == CurveState.ACTIVE)) revert CurveNotActive(c.state);
        if (!(block.number > c.creationBlock)) revert TradingNotOpenYet();
        if (!(usdcIn > 0)) revert ZeroAmount();

        uint16 taxBps = _snipeTaxBps(c);
        BuyQuote memory q = _quoteBuy(
            usdcIn, c.buyFeeBps + taxBps, c.virtualUsdcReserves, c.virtualTokenReserves, c.tokenReserves
        );
        if (!(q.tokensOut >= minTokensOut)) revert SlippageExceeded(q.tokensOut, minTokensOut);

        _settleBuy(token, c, q, taxBps);
    }

    function _quoteSell(
        uint256 tokensIn,
        uint16 sellFeeBps,
        uint256 virtualUsdcReserves,
        uint256 virtualTokenReserves,
        uint256 realUsdcReservesAvailable
    ) internal pure returns (SellQuote memory q) {
        uint256 k = virtualUsdcReserves * virtualTokenReserves;
        uint256 newVirtualToken = virtualTokenReserves + tokensIn;

        uint256 newVirtualUsdc = _ceilDiv(k, newVirtualToken);
        if (!(newVirtualUsdc <= virtualUsdcReserves)) revert CurveMathError();
        uint256 usdcOutGross = virtualUsdcReserves - newVirtualUsdc;

        if (usdcOutGross <= realUsdcReservesAvailable) {

            q.actualTokensIn = tokensIn;
            q.newVirtualToken = newVirtualToken;
            q.newVirtualUsdc = newVirtualUsdc;
            q.usdcOutGross = usdcOutGross;
            q.fee = (usdcOutGross * sellFeeBps) / BPS_DENOMINATOR;
            return q;
        }

        // Clamp: same inversion as the buy side, driven by available USDC instead.
        q.usdcOutGross = realUsdcReservesAvailable;
        q.newVirtualUsdc = virtualUsdcReserves - q.usdcOutGross;

        q.newVirtualToken = _ceilDiv(k, q.newVirtualUsdc);
        q.actualTokensIn = q.newVirtualToken - virtualTokenReserves;
        q.fee = (q.usdcOutGross * sellFeeBps) / BPS_DENOMINATOR;

        if (!(q.actualTokensIn <= tokensIn)) revert ClampInputExceededOffer();
    }

    function sell(address token, uint256 tokensIn, uint256 minUsdcOut) external nonReentrant whenNotPaused {
        Curve storage c = _curves[token];
        if (!(c.token == token)) revert UnknownToken();
        if (!(c.state == CurveState.ACTIVE)) revert CurveNotActive(c.state);
        if (!(block.number > c.creationBlock)) revert TradingNotOpenYet();
        if (!(tokensIn > 0)) revert ZeroAmount();

        SellQuote memory q = _quoteSell(tokensIn, c.sellFeeBps, c.virtualUsdcReserves, c.virtualTokenReserves, c.realUsdcReserves);

        uint256 usdcOut = q.usdcOutGross - q.fee;
        if (!(usdcOut >= minUsdcOut)) revert SlippageExceeded(usdcOut, minUsdcOut);

        c.virtualTokenReserves = q.newVirtualToken;
        c.virtualUsdcReserves = q.newVirtualUsdc;
        c.realUsdcReserves -= q.usdcOutGross;
        c.tokenReserves += q.actualTokensIn;

        uint256 creatorCut = _creatorCut(q.usdcOutGross, c.creatorSellFeeBps, q.fee);
        _routeCreatorCut(token, c, creatorCut);

        IERC20(token).safeTransferFrom(msg.sender, address(this), q.actualTokensIn);
        uint256 treasuryCut = q.fee - creatorCut;
        if (treasuryCut > 0) treasuryFeesAccrued += treasuryCut;
        usdc.safeTransfer(msg.sender, usdcOut);

        emit Trade(token, msg.sender, false, usdcOut, q.actualTokensIn);
    }

    // Rounds up. Every division on the curve rounds against the trader.
    function _ceilDiv(uint256 a, uint256 b) internal pure returns (uint256) {
        return (a + b - 1) / b;
    }

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
        uint256 actualUsdcIn,
        uint256 actualFee
    ) internal view returns (FeeSplit memory f) {
        uint256 baseFee = (actualUsdcIn * c.buyFeeBps) / BPS_DENOMINATOR;
        if (baseFee > actualFee) baseFee = actualFee;
        uint256 snipeTax = actualFee - baseFee;

        f.creatorCut = _creatorCut(actualUsdcIn, c.creatorBuyFeeBps, baseFee);

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
            creatorFeesAccrued[c.creator] += cut;
            emit CreatorFeeAccrued(token, c.creator, cut);
        }
    }

    function claimTreasuryFees() external nonReentrant returns (uint256 amount) {
        amount = treasuryFeesAccrued;
        if (!(amount > 0)) revert NothingToClaim();
        treasuryFeesAccrued = 0;
        usdc.safeTransfer(treasury, amount);
        emit TreasuryFeesClaimed(treasury, amount);
    }

    function claimCreatorFees() external nonReentrant returns (uint256 amount) {
        amount = creatorFeesAccrued[msg.sender];
        if (!(amount > 0)) revert NothingToClaim();
        creatorFeesAccrued[msg.sender] = 0;
        usdc.safeTransfer(msg.sender, amount);
        emit CreatorFeesClaimed(msg.sender, amount);
    }

    function _performGraduation(address token) internal returns (bool success) {
        if (router == address(0)) return false;
        Curve storage c = _curves[token];

        uint256 tokenLiquidity = LP_TOKEN_RESERVE + c.tokenReserves;

        uint256 usdcLiquidity = c.realUsdcReserves + c.poolBoost;

        IERC20(token).forceApprove(router, tokenLiquidity);
        usdc.forceApprove(router, usdcLiquidity);

        try IDEXRouter(router).addLiquidity(
            token,
            address(usdc),
            tokenLiquidity,
            usdcLiquidity,
            0,
            0,
            BURN_ADDRESS,
            block.timestamp + 15 minutes
        ) returns (uint256, uint256, uint256 liquidity) {
            if (liquidity == 0) {

                IERC20(token).forceApprove(router, 0);
                usdc.forceApprove(router, 0);
                return false;
            }

            c.state = CurveState.GRADUATED;
            c.tokenReserves = 0;
            c.realUsdcReserves = 0;
            c.poolBoost = 0;
            emit Graduated(token, tokenLiquidity, usdcLiquidity, liquidity);
            return true;
        } catch {
            IERC20(token).forceApprove(router, 0);
            usdc.forceApprove(router, 0);
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

    function quoteBuy(address token, uint256 usdcIn) external view returns (BuyQuote memory) {
        Curve storage c = _curves[token];
        if (!(c.token == token)) revert UnknownToken();
        if (!(c.state == CurveState.ACTIVE)) revert CurveNotActive(c.state);

        return _quoteBuy(usdcIn, c.buyFeeBps + _snipeTaxBps(c), c.virtualUsdcReserves, c.virtualTokenReserves, c.tokenReserves);
    }

    function quoteSell(address token, uint256 tokensIn) external view returns (SellQuote memory) {
        Curve storage c = _curves[token];
        if (!(c.token == token)) revert UnknownToken();
        if (!(c.state == CurveState.ACTIVE)) revert CurveNotActive(c.state);
        return _quoteSell(tokensIn, c.sellFeeBps, c.virtualUsdcReserves, c.virtualTokenReserves, c.realUsdcReserves);
    }

    function currentPrice(address token) external view returns (uint256) {
        Curve storage c = _curves[token];
        if (!(c.token == token)) revert UnknownToken();
        return (c.virtualUsdcReserves * 1e18) / c.virtualTokenReserves;
    }

    function graduationProgressBps(address token) external view returns (uint256) {
        Curve storage c = _curves[token];
        if (!(c.token == token)) revert UnknownToken();

        if (c.state != CurveState.ACTIVE) return BPS_DENOMINATOR;
        if (c.realUsdcReserves >= c.graduationThresholdUsdc || c.tokenReserves == 0) {
            return BPS_DENOMINATOR;
        }
        uint256 byThreshold =
            (c.realUsdcReserves * BPS_DENOMINATOR) / c.graduationThresholdUsdc;
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

    function setCreationFee(uint256 creationFeeUsdc_) external onlyOwner {
        creationFeeUsdc = creationFeeUsdc_;
    }

    function setLaunchCooldown(uint256 launchCooldown_) external onlyOwner {
        launchCooldown = launchCooldown_;
    }

    function setSymbolLockDuration(uint256 symbolLockDuration_) external onlyOwner {
        symbolLockDuration = symbolLockDuration_;
    }

    function setDefaultGraduationThreshold(uint256 thresholdUsdc_) external onlyOwner {
        defaultGraduationThresholdUsdc = thresholdUsdc_;
    }

    function setCaseSensitiveSymbols(bool caseSensitive_) external onlyOwner {
        caseSensitiveSymbols = caseSensitive_;
        emit CaseSensitiveSymbolsSet(caseSensitive_);
    }

    function setTreasury(address treasury_) external onlyOwner {
        if (!(treasury_ != address(0))) revert ZeroAddress();
        treasury = treasury_;
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }
}
