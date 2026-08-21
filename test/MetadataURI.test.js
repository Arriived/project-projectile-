const { expect } = require('chai');
const { ethers } = require('hardhat');
const { activateRouter } = require('./routerHelper');

const ONE = 1_000_000n;

describe('Ballista — mutable metadata URI', function () {
  async function env() {
    const [deployer, treasury, creator, other] = await ethers.getSigners();
    const usdc = await (await ethers.getContractFactory('MockUSDC')).deploy();
    const ballista = await (await ethers.getContractFactory('Ballista'))
      .deploy(await usdc.getAddress(), treasury.address);
    const router = await (await ethers.getContractFactory('MockRouter')).deploy();
    await activateRouter(ballista, await router.getAddress());
    await ballista.setLaunchCooldown(0);
    for (const s of [creator, other]) {
      await usdc.mint(s.address, 1_000n * ONE);
      await usdc.connect(s).approve(await ballista.getAddress(), ethers.MaxUint256);
    }
    return { deployer, treasury, creator, other, usdc, ballista };
  }

  async function launch(ballista, creator, symbol, uri = 'ipfs://original') {
    const hash = await ballista.currentEconomicsHash();
    const rc = await (await ballista.connect(creator)
      .createToken('Meta', symbol, uri, hash, false)).wait();
    return rc.logs.map((l) => { try { return ballista.interface.parseLog(l); } catch { return null; } })
      .find((l) => l && l.name === 'TokenCreated').args.token;
  }

  it('the creator can update it, and the token reflects the change', async function () {
    const { ballista, creator } = await env();
    const t = await launch(ballista, creator, 'MET');
    const token = await ethers.getContractAt('ArcLaunchToken', t);
    expect(await token.metadataURI()).to.equal('ipfs://original');

    await ballista.connect(creator).updateMetadataURI(t, 'ipfs://with-socials');
    expect(await token.metadataURI()).to.equal('ipfs://with-socials');
  });

  it('emits BOTH old and new -- the entire protection against a link swap', async function () {
    const { ballista, creator } = await env();
    const t = await launch(ballista, creator, 'EVT');

    await expect(ballista.connect(creator).updateMetadataURI(t, 'ipfs://second'))
      .to.emit(ballista, 'MetadataURIUpdated')
      .withArgs(t, creator.address, 'ipfs://original', 'ipfs://second');

    // A second swap is equally auditable: the chain carries the whole history.
    await expect(ballista.connect(creator).updateMetadataURI(t, 'ipfs://third'))
      .to.emit(ballista, 'MetadataURIUpdated')
      .withArgs(t, creator.address, 'ipfs://second', 'ipfs://third');
  });

  it('nobody but the creator can update it', async function () {
    const { ballista, creator, other, deployer } = await env();
    const t = await launch(ballista, creator, 'AUTH');

    await expect(ballista.connect(other).updateMetadataURI(t, 'ipfs://hijack'))
      .to.be.revertedWith("only the token's creator may update metadata");
    // Not even the owner.
    await expect(ballista.connect(deployer).updateMetadataURI(t, 'ipfs://owner'))
      .to.be.revertedWith("only the token's creator may update metadata");
  });

  it('ATTACK: call the token directly, bypassing the factory and its audit event', async function () {
    const { ballista, creator } = await env();
    const t = await launch(ballista, creator, 'DIRECT');
    const token = await ethers.getContractAt('ArcLaunchToken', t);

    // Even the creator cannot go around the factory -- that would update the URI with
    // no MetadataURIUpdated event, which is the only record of a swap.
    await expect(token.connect(creator).setMetadataURI('ipfs://silent'))
      .to.be.revertedWith('only the factory may update metadata');
    expect(await token.metadataURI()).to.equal('ipfs://original');
  });

  it('works after graduation too -- socials outlive the curve', async function () {
    const { ballista, creator, usdc } = await env();
    const t = await launch(ballista, creator, 'GRAD');
    await usdc.mint(creator.address, 20_000n * ONE);
    // Past the snipe window: inside it a 9900 bps total fee leaves only ~1% of the
    // spend reaching the curve, which is nowhere near the graduation threshold.
    await ethers.provider.send('evm_increaseTime', [30]);
    await ethers.provider.send('evm_mine');
    await ballista.connect(creator).buy(t, 12_000n * ONE, 0);
    expect((await ballista.curves(t)).state).to.equal(2n);

    await expect(ballista.connect(creator).updateMetadataURI(t, 'ipfs://after-grad'))
      .to.emit(ballista, 'MetadataURIUpdated');
  });

  it('rejects an unknown token', async function () {
    const { ballista, creator } = await env();
    await expect(
      ballista.connect(creator).updateMetadataURI(ethers.Wallet.createRandom().address, 'x')
    ).to.be.revertedWith('unknown token');
  });
});
