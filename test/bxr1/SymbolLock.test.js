const { expect } = require('chai');
const { ethers } = require('hardhat');
const { deployRegistryWithAsset, getBXR1Factory } = require('./assetRegistryHelper');

const ONE = 1_000_000n;

// Two jobs. First, settle whether symbolLockDuration = 0 DISABLES the check or merely
// shortens it -- the difference decides whether the lock can be turned off by a setter or
// has to be cut out and redeployed. Second, report the gas and bytecode the lock costs,
// so "remove it" is a priced decision rather than a preference.
describe('Ballista — symbol lock: can a duration of 0 disable it?', function () {
  async function deploy() {
    const [owner, treasury, alice, bob] = await ethers.getSigners();
    const usdc = await (await ethers.getContractFactory('MockUSDC')).deploy();
    const registry = await deployRegistryWithAsset(await usdc.getAddress());
    const router = await (await ethers.getContractFactory('MockRouter')).deploy();
    const factory = await (await getBXR1Factory()).deploy(
      await registry.getAddress(), treasury.address, await router.getAddress()
    );
    for (const s of [alice, bob]) {
      await usdc.mint(s.address, 1_000n * ONE);
      await usdc.connect(s).approve(await factory.getAddress(), ethers.MaxUint256);
    }
    await factory.setLaunchCooldown(0); // isolate the symbol lock from the per-creator cooldown
    return { owner, factory, alice, bob, usdc, registry };
  }

  async function launch(factory, usdc, who, symbol) {
    const hash = await factory.currentEconomicsHash(await usdc.getAddress());
    return factory.connect(who).createToken('T', symbol, '', await usdc.getAddress(), hash, false);
  }

  it('with the default duration, a second launch of the same symbol reverts', async function () {
    const { factory, usdc, alice, bob } = await deploy();
    expect(await factory.symbolLockDuration()).to.equal(300n); // 5 minutes
    await launch(factory, usdc, alice, 'CAT');
    await expect(launch(factory, usdc, bob, 'CAT'))
      .to.be.revertedWithCustomError(factory, 'SymbolLocked');
  });

  it('symbolLockDuration = 0 DISABLES the check entirely, back to back', async function () {
    const { factory, usdc, alice, bob } = await deploy();
    await factory.setSymbolLockDuration(0);
    expect(await factory.symbolLockDuration()).to.equal(0n);

    // The write still happens -- symbolUnlocksAt = block.timestamp + 0 -- so the guard is
    // evaluated on every later launch. It just can never fire: the stored value is a past
    // or present timestamp, and the check is `block.timestamp >= unlocksAt`.
    await launch(factory, usdc, alice, 'CAT');
    await expect(launch(factory, usdc, bob, 'CAT')).to.not.be.reverted;
    await expect(launch(factory, usdc, alice, 'CAT')).to.not.be.reverted;
    await expect(launch(factory, usdc, bob, 'CAT')).to.not.be.reverted;
  });

  it('at duration 0 the same symbol relaunches inside ONE second, the tightest case', async function () {
    const { factory, usdc, alice, bob } = await deploy();
    await factory.setSymbolLockDuration(0);
    // Same whole-second timestamp for both, which is the boundary: unlocksAt == now.
    // `>=` makes it pass; `>` would not, so this is the assertion that pins the operator.
    await ethers.provider.send('evm_setAutomine', [false]);
    const a = await launch(factory, usdc, alice, 'SAME');
    const b = await launch(factory, usdc, bob, 'SAME');
    await ethers.provider.send('evm_mine', []);
    await ethers.provider.send('evm_setAutomine', [true]);
    const ra = await a.wait(), rb = await b.wait();
    expect(ra.status, 'first launch').to.equal(1);
    expect(rb.status, 'second launch in the same block').to.equal(1);
  });

  it('isSymbolAvailable() stays truthful at duration 0 -- it always returns true', async function () {
    const { factory, usdc, alice } = await deploy();
    await factory.setSymbolLockDuration(0);
    expect(await factory.isSymbolAvailable('CAT')).to.equal(true);
    await launch(factory, usdc, alice, 'CAT');
    // Still true immediately after a launch that used it. The view does not become a lie;
    // it reports "not currently locked", which is now permanently the case.
    expect(await factory.isSymbolAvailable('CAT')).to.equal(true);
  });

  it('turning it back on restores the lock -- the change is reversible', async function () {
    const { factory, usdc, alice, bob } = await deploy();
    await factory.setSymbolLockDuration(0);
    await launch(factory, usdc, alice, 'CAT');
    await expect(launch(factory, usdc, bob, 'CAT')).to.not.be.reverted;

    await factory.setSymbolLockDuration(300);
    await launch(factory, usdc, alice, 'DOG');
    await expect(launch(factory, usdc, bob, 'DOG'))
      .to.be.revertedWithCustomError(factory, 'SymbolLocked');
  });

  it('symbolLockDuration is inside the economics hash, so changing it invalidates pins', async function () {
    const { factory, usdc } = await deploy();
    const usdcAddress = await usdc.getAddress();
    const before = await factory.currentEconomicsHash(usdcAddress);
    await factory.setSymbolLockDuration(0);
    expect(await factory.currentEconomicsHash(usdcAddress)).to.not.equal(before);
  });
});

// Always-passing measurement, so it runs identically with the lock present and with it
// mutated out. Numbers only -- no assertions about the lock itself.
describe('symbol lock gas and size', function () {
  it('reports createToken gas and BXR1 bytecode size', async function () {
    const [, treasury, alice] = await ethers.getSigners();
    const usdc = await (await ethers.getContractFactory('MockUSDC')).deploy();
    const registry = await deployRegistryWithAsset(await usdc.getAddress());
    const router = await (await ethers.getContractFactory('MockRouter')).deploy();
    const BXR1 = await getBXR1Factory();
    const factory = await BXR1.deploy(
      await registry.getAddress(), treasury.address, await router.getAddress()
    );
    await usdc.mint(alice.address, 1_000n * ONE);
    await usdc.connect(alice).approve(await factory.getAddress(), ethers.MaxUint256);
    await factory.setLaunchCooldown(0);

    const size = (BXR1.bytecode.length - 2) / 2;
    const deployed = (await ethers.provider.getCode(await factory.getAddress()));
    const usdcAddress = await usdc.getAddress();
    const hash = await factory.currentEconomicsHash(usdcAddress);

    const first = await (await factory.connect(alice).createToken('T', 'AAA', '', usdcAddress, hash, false)).wait();
    const second = await (await factory.connect(alice).createToken('T', 'BBB', '', usdcAddress, hash, false)).wait();

    console.log(`      MEASURE deployed bytecode : ${(deployed.length - 2) / 2} bytes`);
    console.log(`      MEASURE createToken gas   : ${first.gasUsed} (cold symbol slot)`);
    console.log(`      MEASURE createToken gas   : ${second.gasUsed} (second, different symbol)`);
  });
});
