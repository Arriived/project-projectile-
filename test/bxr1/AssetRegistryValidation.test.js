const { expect } = require('chai');
const { ethers } = require('hardhat');
const { ASSET_KIND } = require('./assetRegistryHelper');

// AssetRegistry.registerAsset's `decimals` parameter is caller-typed, not read from the
// asset itself anywhere else in the file -- every downstream figure (launchTerms()'s
// conversion scale, and every USDC-equivalent test fixture that assumes 6dp) is computed
// FROM this parameter. A mistyped value would silently misprice every curve quoted in
// that asset rather than reverting anywhere near the mistake. Checked once, at
// registration, against the asset's own IERC20Metadata.decimals().
describe('BXR1 — AssetRegistry rejects decimals that do not match the token', function () {
  it('registering MockUSDC with 18 reverts; with 6 succeeds', async function () {
    const usdc = await (await ethers.getContractFactory('MockUSDC')).deploy();
    const usdcAddress = await usdc.getAddress();
    expect(await usdc.decimals(), 'MockUSDC must actually be 6dp for this test to mean anything').to.equal(6);

    const registry = await (await ethers.getContractFactory('AssetRegistry')).deploy();

    await expect(
      registry.registerAsset(
        usdcAddress, 18, true, false, false, false,
        2_667_000_000n, 8_000_000_000n, 500_000n, ASSET_KIND.STANDARD
      )
    ).to.be.revertedWithCustomError(registry, 'DecimalsMismatch').withArgs(usdcAddress, 18, 6);

    await expect(
      registry.registerAsset(
        usdcAddress, 6, true, false, false, false,
        2_667_000_000n, 8_000_000_000n, 500_000n, ASSET_KIND.STANDARD
      )
    ).to.not.be.reverted;

    expect((await registry.getAsset(usdcAddress)).decimals).to.equal(6);
  });
});
