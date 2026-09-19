// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import "./interfaces/ILeveragedToken.sol";

// Approved quote assets for BXR1, keyed by address. Adding an asset is a registry write,
// never a BXR1 contract change -- that split is the entire point of this file.
//
// BXR1 resolves an asset's config exactly ONCE, at createToken time (BXR1.sol's
// createToken), and snapshots what it needs -- the asset address and the curve's opening
// virtual quote reserve -- into the Curve struct. Nothing here is ever re-read for an
// existing curve. Changing an entry, or disabling one, therefore affects only NEW
// createToken calls; it can never silently re-point a launch that already exists, which
// is the same per-launch-snapshot property every other BXR1 default already has.
contract AssetRegistry is Ownable {
    // Decided by the quote asset itself, not by a createToken parameter -- CLAUDE.md
    // section 27. A separate createToken-level parameter would duplicate what the
    // asset already is and allow a contradiction (a STANDARD curve quoted in a
    // leveraged token, or vice versa). LEVERAGED means: this asset's registry figures
    // below are USD-denominated at 6 decimals, converted to the asset's own native
    // units via launchTerms() using a live read of the asset's own exchangeRate().
    enum AssetKind { STANDARD, LEVERAGED }

    struct AssetConfig {
        address asset;
        AssetKind kind;
        uint8 decimals;
        bool enabled;
        // Three creation-time gates, checked by BXR1.createToken -- NOT warnings read
        // anywhere else. Registering an asset with one of these set does not stop it
        // being registered; it stops BXR1 from ever opening a curve against it, because
        // none of the three is something the fixed-supply, exact-balance-delta trading
        // path can safely reason about:
        //   rebasing            -- the balance BXR1 holds can change with no transfer,
        //                          which nothing in the curve's accounting expects.
        //   transferRestricted  -- a blocklist or similar can make BXR1's own outbound
        //                          transfer (a payout, a refund) revert for a reason
        //                          that has nothing to do with the trade itself.
        //   transferFee         -- a deflationary/fee-on-transfer token would silently
        //                          under-fund realQuoteReserves exactly the way a
        //                          fee-on-transfer USDC mock does today; the exact
        //                          balance-delta check in BXR1's _settleBuy catches this
        //                          LOUDLY on a single trade, but there is no reason to
        //                          let a launch start against an asset already known to
        //                          trigger it on every buy.
        bool rebasing;
        bool transferRestricted;
        bool transferFee;
        // The curve's opening quote-side virtual reserve. For STANDARD, THIS ASSET'S
        // OWN NATIVE DECIMALS -- not normalised, not derived from `decimals` by this
        // contract or by BXR1. BXR1's curve math (_quoteBuy / _quoteSell) works in raw
        // integer units and never converts between decimal scales, so a curve quoted
        // in an 18-decimal asset needs a different raw magnitude here than one quoted
        // in 6-decimal USDC to open at the same real-world price. For LEVERAGED, USD
        // at 6 decimals instead -- the same numbers a USDC entry would carry -- with
        // conversion to the asset's own native units done by launchTerms() at
        // createToken time, never stored converted (see CLAUDE.md section 27: the
        // point is that these three fields never change value with the LT's NAV,
        // only their CONVERTED reading does, and only at the one moment a curve is
        // created). Whoever registers the asset is responsible for choosing this
        // number; the registry only stores and returns it.
        uint256 initialVirtualReserve;
        // Same reasoning and same STANDARD/LEVERAGED split as initialVirtualReserve.
        // Zero is deliberately NOT rejected for STANDARD -- BXR1's dual graduation
        // trigger has always allowed a zero threshold (the depletion arm still
        // reaches GRADUATION_READY, and graduationProgressBps's >= early return means
        // a zero threshold never divides by zero), so this field keeps that same
        // degenerate-but-not-blocked behaviour, matching initialVirtualReserve in
        // every way except this one check.
        uint256 defaultGraduationThreshold;
        // The creation fee, same STANDARD/LEVERAGED split as the two fields above.
        // Moved here from a single BXR1-wide uint256 (5e5, i.e. 0.5 USDC at 6dp) for
        // the same reason initialVirtualReserve and defaultGraduationThreshold
        // already live here: BXR1 charges createToken's creation fee in the curve's
        // own quoteAsset (BXR1.sol's createToken,
        // IERC20(quoteAsset).safeTransferFrom(...)), so a single global raw-unit
        // default is calibrated for whichever asset it was chosen against and wrong
        // by orders of magnitude for any other decimals -- 5e5 raw units of an
        // 18-decimal asset is economically negligible.
        uint256 creationFee;
    }

    mapping(address => AssetConfig) private _assets;

    event AssetRegistered(
        address indexed asset,
        uint8 decimals,
        bool rebasing,
        bool transferRestricted,
        bool transferFee,
        uint256 initialVirtualReserve,
        uint256 defaultGraduationThreshold,
        uint256 creationFee,
        AssetKind kind
    );
    event AssetEnabledSet(address indexed asset, bool enabled);

    error ZeroAddress();
    error ZeroDecimals();
    error ZeroInitialVirtualReserve();
    error UnknownAsset(address asset);
    // Raised both when a LEVERAGED asset is registered against an exchangeRate() that
    // answers 0, and when launchTerms() reads a live rate of 0 for an already
    // registered LEVERAGED asset (a rate that started non-zero and was later zeroed).
    // A reverting exchangeRate() call needs no error of its own -- it is never caught,
    // so its own revert reason propagates unchanged.
    error ZeroExchangeRate(address asset);
    // `decimals` is a caller-typed number, not read from the asset itself elsewhere in
    // this file -- every downstream figure (initialVirtualReserve, launchTerms()'s
    // conversion scale) is computed FROM this parameter, never from a live decimals()
    // read, so a mistyped value here would silently misprice every curve against this
    // asset rather than reverting anywhere near the mistake. Checked once, at
    // registration, against the asset's own IERC20Metadata.decimals() -- which cannot
    // be re-registered out from under a live curve the way this parameter's caller-typed
    // value could be.
    error DecimalsMismatch(address asset, uint8 given, uint8 actual);

    constructor() Ownable(msg.sender) {}

    // Registers or re-registers an asset in one call. Re-registering an asset already in
    // use by a live curve does NOT retroactively change that curve -- see the header
    // comment. Only a createToken call made AFTER this transaction sees the new values.
    //
    // Registering a LEVERAGED asset reads its exchangeRate() once, here, purely as a
    // sanity check that the asset actually behaves like a leveraged token before it can
    // ever back a curve -- the read is discarded, never stored, and launchTerms() always
    // re-reads live at createToken time regardless of what this call observed. A
    // reverting exchangeRate() propagates out of this call unchanged; a rate of exactly
    // 0 is rejected explicitly, because a 0 rate would make every future launchTerms()
    // conversion divide by zero.
    function registerAsset(
        address asset,
        uint8 decimals,
        bool enabled,
        bool rebasing,
        bool transferRestricted,
        bool transferFee,
        uint256 initialVirtualReserve,
        uint256 defaultGraduationThreshold,
        uint256 creationFee,
        AssetKind kind
    ) external onlyOwner {
        if (asset == address(0)) revert ZeroAddress();
        if (decimals == 0) revert ZeroDecimals();
        if (initialVirtualReserve == 0) revert ZeroInitialVirtualReserve();
        uint8 actualDecimals = IERC20Metadata(asset).decimals();
        if (decimals != actualDecimals) revert DecimalsMismatch(asset, decimals, actualDecimals);
        if (kind == AssetKind.LEVERAGED) {
            if (ILeveragedToken(asset).exchangeRate() == 0) revert ZeroExchangeRate(asset);
        }

        _assets[asset] = AssetConfig({
            asset: asset,
            kind: kind,
            decimals: decimals,
            enabled: enabled,
            rebasing: rebasing,
            transferRestricted: transferRestricted,
            transferFee: transferFee,
            initialVirtualReserve: initialVirtualReserve,
            defaultGraduationThreshold: defaultGraduationThreshold,
            creationFee: creationFee
        });

        emit AssetRegistered(asset, decimals, rebasing, transferRestricted, transferFee, initialVirtualReserve, defaultGraduationThreshold, creationFee, kind);
        emit AssetEnabledSet(asset, enabled);
    }

    // The fast disable lever. Flips `enabled` only, leaving decimals, the misbehaviour
    // flags and the initial-reserve figure untouched. Existing curves are unaffected for
    // the same reason as above; this only stops NEW createToken calls against the asset.
    function setAssetEnabled(address asset, bool enabled) external onlyOwner {
        if (_assets[asset].asset != asset) revert UnknownAsset(asset);
        _assets[asset].enabled = enabled;
        emit AssetEnabledSet(asset, enabled);
    }

    // Zero-value sentinel for an unregistered asset: `.asset == address(0)` and
    // `.enabled == false`, the same shape BXR1.curves() uses for a token it never
    // created. BXR1.createToken tests `.enabled` directly, which is false either way, so
    // "never registered" and "explicitly disabled" both refuse a launch identically --
    // there is no separate existence check to forget.
    function getAsset(address asset) external view returns (AssetConfig memory) {
        return _assets[asset];
    }

    // Returns (initialVirtualReserve, graduationThreshold, creationFee) in the asset's
    // own NATIVE units -- what BXR1's curve math and safeTransferFrom calls actually
    // need. STANDARD: the stored values, unchanged, exactly what getAsset already
    // returns for those three fields. LEVERAGED: the stored values are USD at 6
    // decimals, converted here using a LIVE read of the asset's own exchangeRate() --
    // never cached, never stored converted, so every call reflects the LT's NAV at
    // that exact moment. BXR1 calls this ONCE per createToken (via _buildCurve and
    // _creationFeeOf, each in their own stack frame) and never again for that curve;
    // the result is then fixed forever in the Curve struct exactly like a STANDARD
    // asset's raw values always have been (CLAUDE.md section 27).
    //
    // Kept in the registry rather than in BXR1, so this conversion's bytes land here
    // instead of against BXR1's own tighter headroom: measured, BXR1 grew by only 101
    // bytes for this change (CLAUDE.md section 27.6). The alternative -- doing the
    // conversion inside BXR1 instead -- was never built or measured, so this is not a
    // comparison of two measured options, only the cost of the one that was built.
    function launchTerms(address asset) external view returns (
        uint256 initialVirtualReserveNative,
        uint256 graduationThresholdNative,
        uint256 creationFeeNative
    ) {
        AssetConfig memory cfg = _assets[asset];
        if (cfg.kind == AssetKind.STANDARD) {
            return (cfg.initialVirtualReserve, cfg.defaultGraduationThreshold, cfg.creationFee);
        }

        // LEVERAGED: cfg.{initialVirtualReserve,defaultGraduationThreshold,creationFee}
        // are USD at 6dp. rate is WAD-scaled USD per ONE WHOLE LT (1e18 == 1 USDC per
        // LT, matching ILeveragedToken.sol / Bounce's LeveragedToken semantics).
        //
        //   native units of the LT worth usd6 (6dp USD)
        //     = usd6 * 10**decimals            -- one full USD unit's worth of LT, if rate == 1e18
        //       * 1e18                         -- undo the WAD scale on `rate` ...
        //       / (rate * 1e6)                 -- ... and undo the 6dp scale on usd6, in one division
        //
        // Rounds UP on all three -- CurveMath.ceilDiv's exact shape, `(a + b - 1) / b`
        // -- matching "every division on the curve rounds against the trader"
        // (CurveMath.sol's own rule): a creator or the protocol never receives less
        // real USD value than the registry figure promises because of truncation.
        uint256 rate = ILeveragedToken(asset).exchangeRate();
        if (rate == 0) revert ZeroExchangeRate(asset);
        uint256 denominator = rate * 1e6;
        uint256 scale = (10 ** cfg.decimals) * 1e18;
        initialVirtualReserveNative = _ceilDiv(cfg.initialVirtualReserve * scale, denominator);
        graduationThresholdNative = _ceilDiv(cfg.defaultGraduationThreshold * scale, denominator);
        creationFeeNative = _ceilDiv(cfg.creationFee * scale, denominator);
    }

    // Verbatim the same shape as CurveMath.ceilDiv -- kept as a private copy here
    // rather than importing CurveMath, because CurveMath is BXR1's external library
    // (deployed once, linked into BXR1's bytecode) and has no reason to also become a
    // link-time dependency of AssetRegistry, which never otherwise needs it.
    function _ceilDiv(uint256 a, uint256 b) private pure returns (uint256) {
        return (a + b - 1) / b;
    }
}
