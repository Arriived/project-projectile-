const { ethers } = require('hardhat');

/// Deploys an AssetRegistry and registers `asset` with USDC-equivalent defaults: 6
/// decimals, enabled, none of the three misbehaviour flags set, and
/// initialVirtualReserve = 2_667e6 -- EXACTLY BXR1's historic
/// INITIAL_VIRTUAL_USDC_RESERVES constant (see CLAUDE.md and the original LFX1.sol),
/// so a curve opened against this asset starts at the identical virtual-reserve figure
/// every existing test already expects. `overrides` lets a test register with different
/// decimals, misbehaviour flags, or opening reserve for its own purposes -- e.g. the
/// second-decimals cycle test, or a test proving the creation-time gate refuses a
/// disabled or misbehaving asset.
///
/// Every BXR1 fixture needs a live, enabled asset before createToken can be called at
/// all (createToken's first real check after the router/fee/cooldown guards is the
/// asset gate), so this collapses the two-step dance -- deploy the registry, register
/// the asset -- into one call, the same reason routerHelper.js exists for the router
/// timelock.
async function deployRegistryWithAsset(asset, overrides = {}) {
  const registry = await (await ethers.getContractFactory('AssetRegistry')).deploy();
  await registry.registerAsset(
    asset,
    overrides.decimals ?? 6,
    overrides.enabled ?? true,
    overrides.rebasing ?? false,
    overrides.transferRestricted ?? false,
    overrides.transferFee ?? false,
    overrides.initialVirtualReserve ?? 2_667_000_000n
  );
  return registry;
}

module.exports = { deployRegistryWithAsset, USDC_EQUIVALENT_INITIAL_VIRTUAL_RESERVE: 2_667_000_000n };
