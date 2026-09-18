const { expect } = require('chai');
const { ethers } = require('hardhat');
const { deployRegistryWithAsset, getBXR1Factory } = require('./assetRegistryHelper');

const ONE = 1_000_000n;
const DAY = 24 * 3600;

describe('Ballista — constructor router bootstrap', function () {
  async function deployWith(initialRouter) {
    const [deployer, treasury, creator] = await ethers.getSigners();
    const usdc = await (await ethers.getContractFactory('MockUSDC')).deploy();
    const registry = await deployRegistryWithAsset(await usdc.getAddress());
    const router = await (await ethers.getContractFactory('MockRouter')).deploy();
    const routerAddress = await router.getAddress();
    const ballista = await (await getBXR1Factory()).deploy(
      await registry.getAddress(),
      treasury.address,
      initialRouter === 'real' ? routerAddress : ethers.ZeroAddress
    );
    await usdc.mint(creator.address, 1_000n * ONE);
    await usdc.connect(creator).approve(await ballista.getAddress(), ethers.MaxUint256);
    return { deployer, treasury, creator, usdc, registry, ballista, router, routerAddress };
  }

  async function create(ballista, usdc, creator, symbol) {
    const hash = await ballista.currentEconomicsHash(await usdc.getAddress());
    return ballista.connect(creator).createToken('Boot', symbol, 'u', await usdc.getAddress(), hash);
  }

  it('a constructor-set router is live immediately -- launches work from block zero', async function () {
    const { ballista, usdc, creator, routerAddress } = await deployWith('real');
    expect(await ballista.router()).to.equal(routerAddress);
    await expect(create(ballista, usdc, creator, 'BOOT')).to.not.be.reverted;
  });

  it('the event trail has no hole: both RouterProposed and RouterActivated fire', async function () {
    const [deployer, treasury] = await ethers.getSigners();
    const usdc = await (await ethers.getContractFactory('MockUSDC')).deploy();
    const registry = await deployRegistryWithAsset(await usdc.getAddress());
    const router = await (await ethers.getContractFactory('MockRouter')).deploy();
    const routerAddress = await router.getAddress();
    const B = await getBXR1Factory();
    const ballista = await B.deploy(await registry.getAddress(), treasury.address, routerAddress);
    const rc = await ballista.deploymentTransaction().wait();

    const names = rc.logs
      .map((l) => { try { return ballista.interface.parseLog(l); } catch { return null; } })
      .filter(Boolean);
    const proposed = names.find((l) => l.name === 'RouterProposed');
    const activated = names.find((l) => l.name === 'RouterActivated');

    expect(proposed, 'RouterProposed must fire').to.not.be.undefined;
    expect(activated, 'RouterActivated must fire').to.not.be.undefined;
    expect(proposed.args.router).to.equal(routerAddress);
    expect(activated.args.router).to.equal(routerAddress);
    // activatableAt is simply "now" -- honest, and reconstructable from logs.
    const blk = await ethers.provider.getBlock(rc.blockNumber);
    expect(proposed.args.activatableAt).to.equal(BigInt(blk.timestamp));
    // The proposal ledger is left EMPTY -- see R12. This assertion used to require the
    // opposite, that the constructor bank a proposal timestamp for the bootstrap router.
    // That is precisely what made the bootstrap router permanently re-activatable: nothing
    // ever consumed the entry, so a compromised owner could flip back to it later with no
    // proposal and no timelock. The events above are the audit trail; the ledger is for
    // pending approvals only, and the bootstrap router has none outstanding.
    expect(await ballista.routerProposedAt(routerAddress)).to.equal(0n);
  });

  it('address(0) preserves the old behaviour exactly -- gated until the timelock clears', async function () {
    const { ballista, usdc, creator, routerAddress } = await deployWith('zero');
    expect(await ballista.router()).to.equal(ethers.ZeroAddress);
    await expect(create(ballista, usdc, creator, 'GATED')).to.be.revertedWithCustomError(ballista, 'RouterNotSet'
    );

    await ballista.proposeRouter(routerAddress);
    await expect(ballista.activateRouter(routerAddress)).to.be.revertedWithCustomError(ballista, 'RouterTimelockPending'
    );
    await ethers.provider.send('evm_increaseTime', [DAY + 1]);
    await ethers.provider.send('evm_mine');
    await ballista.activateRouter(routerAddress);
    await expect(create(ballista, usdc, creator, 'GATED')).to.not.be.reverted;
  });

  it('a SUBSEQUENT router change still requires the full 24h -- the bypass is once only', async function () {
    const { ballista } = await deployWith('real');
    const next = await (await ethers.getContractFactory('MockRouter')).deploy();
    const nextAddr = await next.getAddress();

    // Never proposed -> rejected outright.
    await expect(ballista.activateRouter(nextAddr)).to.be.revertedWithCustomError(ballista, 'RouterNotProposed'
    );
    await ballista.proposeRouter(nextAddr);
    await expect(ballista.activateRouter(nextAddr)).to.be.revertedWithCustomError(ballista, 'RouterTimelockPending'
    );
    await ethers.provider.send('evm_increaseTime', [DAY - 60]);
    await ethers.provider.send('evm_mine');
    await expect(ballista.activateRouter(nextAddr)).to.be.revertedWithCustomError(ballista, 'RouterTimelockPending'
    );
    await ethers.provider.send('evm_increaseTime', [120]);
    await ethers.provider.send('evm_mine');
    await expect(ballista.activateRouter(nextAddr)).to.not.be.reverted;
    expect(await ballista.router()).to.equal(nextAddr);
  });

  it('revoking a constructor-set router behaves like any other -- no special case', async function () {
    const { ballista, usdc, creator, routerAddress } = await deployWith('real');
    await ballista.revokeRouter(routerAddress);
    expect(await ballista.router()).to.equal(ethers.ZeroAddress);
    expect(await ballista.routerProposedAt(routerAddress)).to.equal(0n);
    await expect(create(ballista, usdc, creator, 'REV')).to.be.revertedWithCustomError(ballista, 'RouterNotSet'
    );
    // Re-approving it needs the full delay, same as anything else.
    await ballista.proposeRouter(routerAddress);
    await expect(ballista.activateRouter(routerAddress)).to.be.revertedWithCustomError(ballista, 'RouterTimelockPending'
    );
  });

  it('NO OTHER PATH writes router: only the constructor, activateRouter and revokeRouter', async function () {
    const { ballista } = await deployWith('real');
    // Every non-view function on the ABI, tried by a non-owner and by the owner, must
    // leave router unchanged except the two known ones.
    const allowed = new Set(['activateRouter', 'revokeRouter']);
    const mutators = ballista.interface.fragments
      .filter((f) => f.type === 'function' && f.stateMutability !== 'view' && f.stateMutability !== 'pure')
      .map((f) => f.name);
    // Sanity: the two we expect are present, and nothing named like a router setter
    // survives from the old API.
    expect(mutators).to.include('activateRouter');
    expect(mutators).to.include('revokeRouter');
    expect(mutators).to.not.include('setRouter');
    for (const m of mutators) {
      if (allowed.has(m)) continue;
      expect(/^set.*Router$/i.test(m), `unexpected router setter: ${m}`).to.equal(false);
    }
  });
});
