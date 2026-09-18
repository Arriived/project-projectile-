const { expect } = require('chai');
const { ethers } = require('hardhat');
const { activateRouter } = require('../routerHelper');
const { deployRegistryWithAsset, getBXR1Factory } = require('./assetRegistryHelper');

const ONE = 1_000_000n;
const BURN = '0x000000000000000000000000000000000000dEaD';
const GRADUATED = 2n;

// lpRecipient exists so the V4 build can send the position to a locker instead of the
// burn address, without touching the core contract again. It is SNAPSHOTTED per curve
// rather than read live at graduation -- see the note in this file's first test for why
// that distinction is the whole point.
describe('BXR1 — lpRecipient', function () {
  this.timeout(600000);

  async function env() {
    const [deployer, treasury, creator, a, locker] = await ethers.getSigners();
    const usdc = await (await ethers.getContractFactory('MockUSDC')).deploy();
    const registry = await deployRegistryWithAsset(await usdc.getAddress());
    const ballista = await (await getBXR1Factory())
      .deploy(await registry.getAddress(), treasury.address, ethers.ZeroAddress);
    const router = await (await ethers.getContractFactory('MockRouter')).deploy();
    await activateRouter(ballista, await router.getAddress());
    for (const s of [creator, a]) {
      await usdc.mint(s.address, 500_000_000n * ONE);
      await usdc.connect(s).approve(await ballista.getAddress(), ethers.MaxUint256);
    }
    return { deployer, treasury, creator, a, locker, usdc, registry, ballista, router };
  }

  async function launch(ballista, usdc, creator, symbol) {
    const hash = await ballista.currentEconomicsHash(await usdc.getAddress());
    const rc = await (await ballista.connect(creator)
      .createToken('Lp', symbol, 'u', await usdc.getAddress(), hash)).wait();
    return rc.logs.map((l) => { try { return ballista.interface.parseLog(l); } catch { return null; } })
      .find((l) => l && l.name === 'TokenCreated').args.token;
  }
  const past = async (s = 30) => {
    await ethers.provider.send('evm_increaseTime', [s]);
    await ethers.provider.send('evm_mine');
  };

  it('defaults to the burn address', async function () {
    const { ballista } = await env();
    expect(await ballista.lpRecipient()).to.equal(BURN);
  });

  it('rejects the zero address', async function () {
    const { ballista, locker } = await env();
    await expect(ballista.setLpRecipient(ethers.ZeroAddress))
      .to.be.revertedWithCustomError(ballista, 'ZeroAddress');
    await expect(ballista.setLpRecipient(locker.address)).to.not.be.reverted;
    expect(await ballista.lpRecipient()).to.equal(locker.address);
  });

  it('rejects the factory itself -- LP sent there is unrecoverable', async function () {
    const { ballista } = await env();
    // The factory can only ever move usdc and launched tokens; there is no rescue path
    // for an arbitrary ERC20, so LP delivered to it would be stranded permanently.
    await expect(ballista.setLpRecipient(await ballista.getAddress()))
      .to.be.revertedWithCustomError(ballista, 'ZeroAddress');
  });

  it('LpRecipientSet indexes both addresses so a watcher can filter', async function () {
    const { ballista } = await env();
    const frag = ballista.interface.getEvent('LpRecipientSet');
    expect(frag.inputs.map((i) => i.indexed),
      'both address params must be indexed').to.deep.equal([true, true]);
  });

  it('emits old and new', async function () {
    const { ballista, locker } = await env();
    await expect(ballista.setLpRecipient(locker.address))
      .to.emit(ballista, 'LpRecipientSet').withArgs(BURN, locker.address);
  });

  it('only the owner can move it', async function () {
    const { ballista, creator, locker } = await env();
    await expect(ballista.connect(creator).setLpRecipient(locker.address)).to.be.reverted;
  });

  it('LP actually reaches the configured recipient at graduation', async function () {
    const { ballista, usdc, router, creator, a, locker } = await env();
    await ballista.setLpRecipient(locker.address);
    const t = await launch(ballista, usdc, creator, 'LPGO');
    await past();
    await ballista.connect(a).buy(t, 400_000n * ONE, 0);

    expect((await ballista.curves(t)).state).to.equal(GRADUATED);
    expect(await router.lastLpRecipient(),
      'LP must go where the curve snapshotted, not to the burn default')
      .to.equal(locker.address);
  });

  // THE TRUST PROPERTY. Graduation approves the entire LP allocation, so whoever
  // lpRecipient names at that moment receives it. If it were read LIVE, an owner could
  // let tokens launch advertising burned LP and then redirect every pending graduation
  // to themselves -- the same magnitude of lever as swapping the router, which this
  // contract deliberately protects with a 24h timelock. Snapshotting removes the lever
  // entirely for anything already launched.
  it('SNAPSHOTTED: moving the global cannot redirect a token that already launched', async function () {
    const { ballista, usdc, router, creator, a, locker } = await env();
    const t = await launch(ballista, usdc, creator, 'PINNED');          // launched under BURN
    expect((await ballista.curves(t)).lpRecipient).to.equal(BURN);

    await ballista.setLpRecipient(locker.address);                 // owner moves it after
    expect(await ballista.lpRecipient()).to.equal(locker.address);
    expect((await ballista.curves(t)).lpRecipient,
      'the live token keeps the recipient it launched with').to.equal(BURN);

    await past();
    await ballista.connect(a).buy(t, 400_000n * ONE, 0);
    expect((await ballista.curves(t)).state).to.equal(GRADUATED);
    expect(await router.lastLpRecipient(),
      'LP must still burn -- the post-launch change must not reach this token')
      .to.equal(BURN);
  });

  it('a token launched AFTER the change picks the new recipient up', async function () {
    const { ballista, usdc, router, creator, a, locker } = await env();
    await ballista.setLpRecipient(locker.address);
    const t = await launch(ballista, usdc, creator, 'AFTER');
    expect((await ballista.curves(t)).lpRecipient).to.equal(locker.address);
    await past();
    await ballista.connect(a).buy(t, 400_000n * ONE, 0);
    expect(await router.lastLpRecipient()).to.equal(locker.address);
  });

  it('is pinned by the economics hash', async function () {
    const { ballista, usdc, creator, locker } = await env();
    const stale = await ballista.currentEconomicsHash(await usdc.getAddress());
    await ballista.setLpRecipient(locker.address);
    await expect(
      ballista.connect(creator).createToken('X', 'XPIN', 'u', await usdc.getAddress(), stale)
    ).to.be.revertedWithCustomError(ballista, 'EconomicsChanged');
  });
});
