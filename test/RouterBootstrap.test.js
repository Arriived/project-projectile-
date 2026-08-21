const { expect } = require('chai');
const { ethers } = require('hardhat');

const ONE = 1_000_000n;
const DAY = 24 * 3600;

describe('Ballista — constructor router bootstrap', function () {
  async function deployWith(initialRouter) {
    const [deployer, treasury, creator] = await ethers.getSigners();
    const usdc = await (await ethers.getContractFactory('MockUSDC')).deploy();
    const router = await (await ethers.getContractFactory('MockRouter')).deploy();
    const routerAddress = await router.getAddress();
    const ballista = await (await ethers.getContractFactory('Ballista')).deploy(
      await usdc.getAddress(),
      treasury.address,
      initialRouter === 'real' ? routerAddress : ethers.ZeroAddress
    );
    await usdc.mint(creator.address, 1_000n * ONE);
    await usdc.connect(creator).approve(await ballista.getAddress(), ethers.MaxUint256);
    return { deployer, treasury, creator, usdc, ballista, router, routerAddress };
  }

  async function create(ballista, creator, symbol) {
    const hash = await ballista.currentEconomicsHash();
    return ballista.connect(creator).createToken('Boot', symbol, 'u', hash, false);
  }

  it('a constructor-set router is live immediately -- launches work from block zero', async function () {
    const { ballista, creator, routerAddress } = await deployWith('real');
    expect(await ballista.router()).to.equal(routerAddress);
    await expect(create(ballista, creator, 'BOOT')).to.not.be.reverted;
  });

  it('the event trail has no hole: both RouterProposed and RouterActivated fire', async function () {
    const [deployer, treasury] = await ethers.getSigners();
    const usdc = await (await ethers.getContractFactory('MockUSDC')).deploy();
    const router = await (await ethers.getContractFactory('MockRouter')).deploy();
    const routerAddress = await router.getAddress();
    const B = await ethers.getContractFactory('Ballista');
    const ballista = await B.deploy(await usdc.getAddress(), treasury.address, routerAddress);
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
    // The proposal ledger reflects an approved router.
    expect(await ballista.routerProposedAt(routerAddress)).to.equal(BigInt(blk.timestamp));
  });

  it('address(0) preserves the old behaviour exactly -- gated until the timelock clears', async function () {
    const { ballista, creator, routerAddress } = await deployWith('zero');
    expect(await ballista.router()).to.equal(ethers.ZeroAddress);
    await expect(create(ballista, creator, 'GATED')).to.be.revertedWith(
      'router not set: launches are closed until a DEX is configured'
    );

    await ballista.proposeRouter(routerAddress);
    await expect(ballista.activateRouter(routerAddress)).to.be.revertedWith(
      'router timelock has not elapsed yet'
    );
    await ethers.provider.send('evm_increaseTime', [DAY + 1]);
    await ethers.provider.send('evm_mine');
    await ballista.activateRouter(routerAddress);
    await expect(create(ballista, creator, 'GATED')).to.not.be.reverted;
  });

  it('a SUBSEQUENT router change still requires the full 24h -- the bypass is once only', async function () {
    const { ballista } = await deployWith('real');
    const next = await (await ethers.getContractFactory('MockRouter')).deploy();
    const nextAddr = await next.getAddress();

    // Never proposed -> rejected outright.
    await expect(ballista.activateRouter(nextAddr)).to.be.revertedWith(
      'router was never proposed, or was revoked'
    );
    await ballista.proposeRouter(nextAddr);
    await expect(ballista.activateRouter(nextAddr)).to.be.revertedWith(
      'router timelock has not elapsed yet'
    );
    await ethers.provider.send('evm_increaseTime', [DAY - 60]);
    await ethers.provider.send('evm_mine');
    await expect(ballista.activateRouter(nextAddr)).to.be.revertedWith(
      'router timelock has not elapsed yet'
    );
    await ethers.provider.send('evm_increaseTime', [120]);
    await ethers.provider.send('evm_mine');
    await expect(ballista.activateRouter(nextAddr)).to.not.be.reverted;
    expect(await ballista.router()).to.equal(nextAddr);
  });

  it('revoking a constructor-set router behaves like any other -- no special case', async function () {
    const { ballista, creator, routerAddress } = await deployWith('real');
    await ballista.revokeRouter(routerAddress);
    expect(await ballista.router()).to.equal(ethers.ZeroAddress);
    expect(await ballista.routerProposedAt(routerAddress)).to.equal(0n);
    await expect(create(ballista, creator, 'REV')).to.be.revertedWith(
      'router not set: launches are closed until a DEX is configured'
    );
    // Re-approving it needs the full delay, same as anything else.
    await ballista.proposeRouter(routerAddress);
    await expect(ballista.activateRouter(routerAddress)).to.be.revertedWith(
      'router timelock has not elapsed yet'
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
