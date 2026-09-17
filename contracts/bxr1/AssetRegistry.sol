// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";

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
    struct AssetConfig {
        address asset;
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
        // The curve's opening quote-side virtual reserve, in THIS ASSET'S OWN NATIVE
        // DECIMALS -- not normalised, not derived from `decimals` by this contract or by
        // BXR1. BXR1's curve math (_quoteBuy / _quoteSell) works in raw integer units and
        // never converts between decimal scales, so a curve quoted in an 18-decimal asset
        // needs a different raw magnitude here than one quoted in 6-decimal USDC to open
        // at the same real-world price. Whoever registers the asset is responsible for
        // choosing this number; the registry only stores and returns it.
        uint256 initialVirtualReserve;
        // Same reasoning as initialVirtualReserve: a raw-unit figure whose meaningful
        // magnitude depends on this asset's own decimals, so it lives here rather than
        // as a single BXR1-wide default. Zero is deliberately NOT rejected -- BXR1's
        // dual graduation trigger has always allowed a zero threshold (the depletion
        // arm still reaches GRADUATION_READY, and graduationProgressBps's >= early
        // return means a zero threshold never divides by zero), so this field keeps
        // that same degenerate-but-not-blocked behaviour, matching initialVirtualReserve
        // in every way except this one check.
        uint256 defaultGraduationThreshold;
    }

    mapping(address => AssetConfig) private _assets;

    event AssetRegistered(
        address indexed asset,
        uint8 decimals,
        bool rebasing,
        bool transferRestricted,
        bool transferFee,
        uint256 initialVirtualReserve,
        uint256 defaultGraduationThreshold
    );
    event AssetEnabledSet(address indexed asset, bool enabled);

    error ZeroAddress();
    error ZeroDecimals();
    error ZeroInitialVirtualReserve();
    error UnknownAsset(address asset);

    constructor() Ownable(msg.sender) {}

    // Registers or re-registers an asset in one call. Re-registering an asset already in
    // use by a live curve does NOT retroactively change that curve -- see the header
    // comment. Only a createToken call made AFTER this transaction sees the new values.
    function registerAsset(
        address asset,
        uint8 decimals,
        bool enabled,
        bool rebasing,
        bool transferRestricted,
        bool transferFee,
        uint256 initialVirtualReserve,
        uint256 defaultGraduationThreshold
    ) external onlyOwner {
        if (asset == address(0)) revert ZeroAddress();
        if (decimals == 0) revert ZeroDecimals();
        if (initialVirtualReserve == 0) revert ZeroInitialVirtualReserve();

        _assets[asset] = AssetConfig({
            asset: asset,
            decimals: decimals,
            enabled: enabled,
            rebasing: rebasing,
            transferRestricted: transferRestricted,
            transferFee: transferFee,
            initialVirtualReserve: initialVirtualReserve,
            defaultGraduationThreshold: defaultGraduationThreshold
        });

        emit AssetRegistered(asset, decimals, rebasing, transferRestricted, transferFee, initialVirtualReserve, defaultGraduationThreshold);
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
}
