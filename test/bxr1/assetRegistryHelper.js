const { ethers } = require('hardhat');

// Mirrors AssetRegistry.AssetKind. Solidity enums cross the ABI boundary as plain
// uint8s, so these are just the two values ethers hands back / accepts -- not a real
// enum, and there is nothing to keep "in sync" beyond the two integers themselves.
const ASSET_KIND = { STANDARD: 0, LEVERAGED: 1 };

/// Deploys an AssetRegistry and registers `asset` with USDC-equivalent defaults: 6
/// decimals, enabled, none of the three misbehaviour flags set,
/// initialVirtualReserve = 2_667e6 -- EXACTLY BXR1's historic
/// INITIAL_VIRTUAL_USDC_RESERVES constant (see CLAUDE.md and the original LFX1.sol) --
/// and defaultGraduationThreshold = 8_000e6, EXACTLY BXR1's former GLOBAL default
/// (defaultGraduationThreshold was a single BXR1-wide state variable before it moved
/// into AssetConfig; see BXR1.sol's own comment at the top of the contract). Both
/// match what every existing test already expects a fresh USDC-equivalent registration
/// to produce. `overrides` lets a test register with different decimals, misbehaviour
/// flags, opening reserve, or graduation threshold for its own purposes -- e.g. the
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
    overrides.initialVirtualReserve ?? 2_667_000_000n,
    overrides.defaultGraduationThreshold ?? 8_000_000_000n,
    // 5e5 -- EXACTLY BXR1's former GLOBAL creationFee default (0.5 USDC at 6dp),
    // now per-asset. Matches every existing test's expectation of that figure.
    overrides.creationFee ?? 500_000n,
    // AssetRegistry.AssetKind.STANDARD by default -- see CLAUDE.md section 27 and
    // test/bxr1/LeveragedLaunch.test.js for LEVERAGED registrations, which pass
    // overrides.kind explicitly.
    overrides.kind ?? ASSET_KIND.STANDARD
  );
  return registry;
}

/// The test-suite equivalent of the old `ballista.setDefaultGraduationThreshold(x)` --
/// removed from BXR1 along with the rest of the global state var, since the threshold
/// is now per-asset and (like initialVirtualReserve) has no separate setter of its own,
/// only re-registration. Reads `asset`'s CURRENT config and re-registers it with every
/// field unchanged except defaultGraduationThreshold, so a test that used to change
/// just the threshold still changes just the threshold -- decimals, the misbehaviour
/// flags, `enabled`, and initialVirtualReserve all carry over exactly as they were.
///
/// Returns the registerAsset() CALL ITSELF (a promise of a TransactionResponse),
/// NOT its awaited receipt -- the one async step this function does internally
/// (the getAsset read) happens first and is awaited, but the write is left for the
/// caller to await. Every ordinary call site already does `await setGraduationThreshold(
/// ...)`, which works identically either way; what this buys is that
/// `expect(setGraduationThreshold(...)).to.emit(registry, 'AssetRegistered')` also
/// works, because chai's emit matcher needs the transaction promise itself, not its
/// resolved value.
async function setGraduationThreshold(registry, asset, newThreshold) {
  const current = await registry.getAsset(asset);
  return registry.registerAsset(
    asset,
    current.decimals,
    current.enabled,
    current.rebasing,
    current.transferRestricted,
    current.transferFee,
    current.initialVirtualReserve,
    newThreshold,
    current.creationFee,
    current.kind
  );
}

/// The mirror of setGraduationThreshold above, for the other field
/// currentEconomicsHash pins: initialVirtualReserve. Same re-registration shape,
/// same "returns the call itself" reasoning.
async function setInitialVirtualReserve(registry, asset, newInitialVirtualReserve) {
  const current = await registry.getAsset(asset);
  return registry.registerAsset(
    asset,
    current.decimals,
    current.enabled,
    current.rebasing,
    current.transferRestricted,
    current.transferFee,
    newInitialVirtualReserve,
    current.defaultGraduationThreshold,
    current.creationFee,
    current.kind
  );
}

/// The mirror again, for creationFee itself -- the test-suite equivalent of the
/// old `ballista.setCreationFee(x)`, removed from BXR1 along with the rest of
/// the global state var now that the fee is per-asset with no BXR1-side setter,
/// only re-registration.
async function setCreationFee(registry, asset, newCreationFee) {
  const current = await registry.getAsset(asset);
  return registry.registerAsset(
    asset,
    current.decimals,
    current.enabled,
    current.rebasing,
    current.transferRestricted,
    current.transferFee,
    current.initialVirtualReserve,
    current.defaultGraduationThreshold,
    newCreationFee,
    current.kind
  );
}

/// The mirror again, for kind itself -- e.g. flipping a registered asset from
/// STANDARD to LEVERAGED or back. Same re-registration shape. The caller is
/// responsible for the new kind's own invariant (a LEVERAGED asset's exchangeRate()
/// must not revert or answer 0), exactly as registerAsset itself enforces.
async function setAssetKind(registry, asset, newKind) {
  const current = await registry.getAsset(asset);
  return registry.registerAsset(
    asset,
    current.decimals,
    current.enabled,
    current.rebasing,
    current.transferRestricted,
    current.transferFee,
    current.initialVirtualReserve,
    current.defaultGraduationThreshold,
    current.creationFee,
    newKind
  );
}

/// _quoteBuy, _quoteSell and _ceilDiv were extracted out of BXR1.sol into an external
/// CurveMath library (see contracts/bxr1/CurveMath.sol -- measured 345 bytes freed).
/// BXR1's own deployed bytecode now carries two unresolved link placeholders, so
/// `ethers.getContractFactory('BXR1')` cannot be called directly any more -- Hardhat
/// needs the library's deployed address passed as `{ libraries: { CurveMath: addr } }`.
///
/// Deployed ONCE and cached for the life of the process. CurveMath is stateless (no
/// storage, pure functions only), so its address never needs to change within a test
/// run, and redeploying it before every fixture would be pure waste. Every test file
/// that used to write `ethers.getContractFactory('BXR1')` now writes
/// `getBXR1Factory()` in exactly that position -- same return type, same `.deploy(...)`
/// chain, nothing else about the call site changes.
let _curveMathAddress;

async function getBXR1Factory() {
  if (!_curveMathAddress) {
    const lib = await (await ethers.getContractFactory('CurveMath')).deploy();
    await lib.waitForDeployment();
    _curveMathAddress = await lib.getAddress();
  }
  return ethers.getContractFactory('BXR1', { libraries: { CurveMath: _curveMathAddress } });
}

module.exports = {
  deployRegistryWithAsset,
  setGraduationThreshold,
  setInitialVirtualReserve,
  setCreationFee,
  setAssetKind,
  getBXR1Factory,
  ASSET_KIND,
  USDC_EQUIVALENT_INITIAL_VIRTUAL_RESERVE: 2_667_000_000n,
  USDC_EQUIVALENT_DEFAULT_GRADUATION_THRESHOLD: 8_000_000_000n,
};
