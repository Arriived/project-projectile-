const { expect } = require('chai');
const { ethers } = require('hardhat');
const { deployRegistryWithAsset } = require('./assetRegistryHelper');

const DEAD = '0x000000000000000000000000000000000000dEaD';

// R17. renounceOwnership() is inherited from Ownable and was live: one transaction would
// permanently freeze every setter, including revokeRouter() -- which section 1.5 names as
// the ONLY hard stop against a malicious router. It is now overridden to revert.
//
// The last two tests are deliberately about what this does NOT fix. R17 closes the
// labelled path, not the class, and a test suite that only proved the happy half would
// license exactly the misreading the register warns against.
describe('Ballista — R17: ownership cannot be renounced', function () {
  async function deploy() {
    const [owner, treasury, stranger] = await ethers.getSigners();
    const usdc = await (await ethers.getContractFactory('MockUSDC')).deploy();
    const registry = await deployRegistryWithAsset(await usdc.getAddress());
    const router = await (await ethers.getContractFactory('MockRouter')).deploy();
    const factory = await (await ethers.getContractFactory('BXR1')).deploy(
      await registry.getAddress(), treasury.address, await router.getAddress()
    );
    return { owner, treasury, stranger, factory, router };
  }

  it('the owner cannot renounce', async function () {
    const { factory } = await deploy();
    await expect(factory.renounceOwnership())
      .to.be.revertedWithCustomError(factory, 'OwnershipCannotBeRenounced');
  });

  it('a stranger cannot renounce either -- it reverts for everyone, not just non-owners', async function () {
    const { factory, stranger } = await deploy();
    // Ownable would have rejected this with OwnableUnauthorizedAccount. The override
    // replaces the modifier, so the refusal is unconditional.
    await expect(factory.connect(stranger).renounceOwnership())
      .to.be.revertedWithCustomError(factory, 'OwnershipCannotBeRenounced');
  });

  it('ownership survives the attempt, and the emergency lever still works', async function () {
    const { factory, owner, router } = await deploy();
    await expect(factory.renounceOwnership()).to.be.reverted;
    expect(await factory.owner()).to.equal(owner.address);

    // The thing R17 exists to protect: revokeRouter is still callable.
    await factory.revokeRouter(await router.getAddress());
    expect(await factory.router()).to.equal(ethers.ZeroAddress);
  });

  it('normal ownership transfer is unaffected', async function () {
    const { factory, stranger } = await deploy();
    await factory.transferOwnership(stranger.address);
    expect(await factory.owner()).to.equal(stranger.address);
    await expect(factory.connect(stranger).renounceOwnership())
      .to.be.revertedWithCustomError(factory, 'OwnershipCannotBeRenounced');
  });

  // ── what R17 does NOT fix ────────────────────────────────────────────
  it('RESIDUAL: transferOwnership to a dead address achieves the same freeze', async function () {
    const { factory, router } = await deploy();
    // Ownable rejects address(0) only. Any other address is accepted, including one whose
    // key nobody holds -- so renunciation remains reachable, one step removed.
    await factory.transferOwnership(DEAD);
    expect(await factory.owner()).to.equal(DEAD);

    // And the contract is now exactly as frozen as renouncing would have made it.
    await expect(factory.revokeRouter(await router.getAddress()))
      .to.be.revertedWithCustomError(factory, 'OwnableUnauthorizedAccount');
    await expect(factory.pause())
      .to.be.revertedWithCustomError(factory, 'OwnableUnauthorizedAccount');
  });

  it('RESIDUAL: a mistyped address is the same freeze with no warning at all', async function () {
    const { factory } = await deploy();
    const typo = '0x00000000000000000000000000000000DeaDBeef';
    await factory.transferOwnership(typo);
    expect(await factory.owner()).to.equal(ethers.getAddress(typo));
    // Nothing in the contract distinguishes this from an intended transfer. R17 does not
    // help here, and the register must not be read as "the owner cannot brick the contract".
    await expect(factory.pause())
      .to.be.revertedWithCustomError(factory, 'OwnableUnauthorizedAccount');
  });
});
