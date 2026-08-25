const { expect } = require('chai');
const { ethers } = require('hardhat');
const { activateRouter } = require('./routerHelper');

const ONE = 1_000_000n;
const BURN = '0x000000000000000000000000000000000000dEaD';
const GRADUATED = 2n;

// lpRecipient exists so the V4 build can send the position to a locker instead of the
// burn address, without touching the core contract again. It is SNAPSHOTTED per curve
// rather than read live at graduation -- see the note in this file's first test for why
// that distinction is the whole point.
describe('LFX1 — lpRecipient', function () {
  this.timeout(600000);

  async function env() {
    const [deployer, treasury, creator, a, locker] = await ethers.getSigners();
    const usdc = await (await ethers.getContractFactory('MockUSDC')).deploy();
    const ballista = await (await ethers.getContractFactory('LFX1'))
      .deploy(await usdc.getAddress(), treasury.address, ethers.ZeroAddress);
    const router = await (await ethers.getContractFactory('MockRouter')).deploy();
    await activateRouter(ballista, await router.getAddress());
    await ballista.setLaunchCooldown(0);
    for (const s of [creator, a]) {
      await usdc.mint(s.address, 500_000_000n * ONE);
      await usdc.connect(s).approve(await ballista.getAddress(), ethers.MaxUint256);
    }
    return { deployer, treasury, creator, a, locker, usdc, ballista, router };
  }

  async function launch(ballista, creator, symbol) {
    const hash = await ballista.currentEconomicsHash();
    const rc = await (await ballista.connect(creator)
      .createToken('Lp', symbol, 'u', hash, false)).wait();
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
    const { ballista, router, creator, a, locker } = await env();
    await ballista.setLpRecipient(locker.address);
    const t = await launch(ballista, creator, 'LPGO');
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
    const { ballista, router, creator, a, locker } = await env();
    const t = await launch(ballista, creator, 'PINNED');          // launched under BURN
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
    const { ballista, router, creator, a, locker } = await env();
    await ballista.setLpRecipient(locker.address);
    const t = await launch(ballista, creator, 'AFTER');
    expect((await ballista.curves(t)).lpRecipient).to.equal(locker.address);
    await past();
    await ballista.connect(a).buy(t, 400_000n * ONE, 0);
    expect(await router.lastLpRecipient()).to.equal(locker.address);
  });

  it('is pinned by the economics hash', async function () {
    const { ballista, creator, locker } = await env();
    const stale = await ballista.currentEconomicsHash();
    await ballista.setLpRecipient(locker.address);
    await expect(
      ballista.connect(creator).createToken('X', 'XPIN', 'u', stale, false)
    ).to.be.revertedWithCustomError(ballista, 'EconomicsChanged');
  });
});
