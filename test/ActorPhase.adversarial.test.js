const { expect } = require('chai');
const { ethers } = require('hardhat');
const { time } = require('@nomicfoundation/hardhat-network-helpers');

const ONE = 1_000_000n;
const DAY = 24 * 3600;

// Findings from the actor/phase adversarial pass. Each of these asserts CURRENT
// behaviour, so the suite stays green -- they are characterisation tests, not fixes.
// If a fix lands, these are the tests that must be inverted, deliberately, with the
// operator's decision recorded. Reporting before fixing is the standing rule.
describe('Ballista — actor/phase pass: compromised owner', function () {
  async function deploy() {
    const [owner, treasury, creator, sniper] = await ethers.getSigners();
    const usdc = await (await ethers.getContractFactory('MockUSDC')).deploy();
    const routerA = await (await ethers.getContractFactory('MockRouter')).deploy();
    const routerB = await (await ethers.getContractFactory('MockRouter')).deploy();
    const routerC = await (await ethers.getContractFactory('MockRouter')).deploy();
    const a = await routerA.getAddress();
    const b = await routerB.getAddress();
    const c = await routerC.getAddress();
    const ballista = await (await ethers.getContractFactory('LFX1')).deploy(
      await usdc.getAddress(), treasury.address, a
    );
    for (const s of [creator, sniper]) {
      await usdc.mint(s.address, 10_000n * ONE);
      await usdc.connect(s).approve(await ballista.getAddress(), ethers.MaxUint256);
    }
    return { owner, treasury, creator, sniper, usdc, ballista, a, b, c };
  }

  function eventNames(receipt, contract) {
    return receipt.logs
      .map((l) => { try { return contract.interface.parseLog(l); } catch { return null; } })
      .filter(Boolean)
      .map((l) => l.name);
  }

  // R12 -- FIXED. Router approval is single-use. It was permanent: activateRouter never
  // cleared routerProposedAt, so any address that had ever matured stayed one transaction
  // away for the life of the contract, and the re-activation emitted only RouterActivated.
  // A compromised owner key could therefore skip the 24h timelock entirely by re-using a
  // previously-approved address, with no RouterProposed for a monitor to catch.
  //
  // The fix has two halves and BOTH are needed. Clearing on activation closes the normal
  // path; the constructor also had to stop writing routerProposedAt at all, because it
  // seeded the mapping directly without ever routing through activateRouter, leaving the
  // bootstrap router permanently approved even once the first half was in place.

  // R12a: the bootstrap router leaves no standing approval behind it.
  it('R12a: the BOOTSTRAP router leaves NO standing approval', async function () {
    const { ballista, a, b } = await deploy();

    // Live from block zero, as the bootstrap is meant to be.
    expect(await ballista.router()).to.equal(a);
    // But with no approval banked for later re-use.
    expect(await ballista.routerProposedAt(a)).to.equal(0n);

    await ballista.proposeRouter(b);
    await time.increase(DAY + 1);
    await ballista.activateRouter(b);
    expect(await ballista.router()).to.equal(b);

    // The bootstrap router cannot be flipped back to without a fresh proposal.
    await expect(ballista.activateRouter(a))
      .to.be.revertedWithCustomError(ballista, 'RouterNotProposed');
  });

  // R12b: activation consumes the approval.
  it('R12b: activation CONSUMES the approval -- no instant re-activation', async function () {
    const { ballista, b, c } = await deploy();

    await ballista.proposeRouter(b);
    await time.increase(DAY + 1);
    await ballista.activateRouter(b);
    expect(await ballista.routerProposedAt(b), 'approval must be spent').to.equal(0n);

    await ballista.proposeRouter(c);
    await time.increase(DAY + 1);
    await ballista.activateRouter(c);
    expect(await ballista.router()).to.equal(c);

    // Going back to B costs a fresh proposal and a fresh 24h, in the open.
    await expect(ballista.activateRouter(b))
      .to.be.revertedWithCustomError(ballista, 'RouterNotProposed');

    await ballista.proposeRouter(b);
    await expect(ballista.activateRouter(b))
      .to.be.revertedWithCustomError(ballista, 'RouterTimelockPending');
    await time.increase(DAY + 1);
    await ballista.activateRouter(b);
    expect(await ballista.router()).to.equal(b);
  });

  // The property the fix exists for, stated directly: every route to a live router now
  // passes through a RouterProposed event and a 24h wait. There is no path that reaches
  // activateRouter without one, so a monitor watching proposals cannot be stepped around.
  it('R12: no router can go live without a fresh RouterProposed and a full timelock', async function () {
    const { ballista, b } = await deploy();

    // No proposal at all.
    await expect(ballista.activateRouter(b))
      .to.be.revertedWithCustomError(ballista, 'RouterNotProposed');

    // Proposal, but early.
    await ballista.proposeRouter(b);
    await time.increase(DAY - 60);
    await expect(ballista.activateRouter(b))
      .to.be.revertedWithCustomError(ballista, 'RouterTimelockPending');

    // Only after the full wait.
    await time.increase(120);
    const rc = await (await ballista.activateRouter(b)).wait();
    expect(eventNames(rc, ballista)).to.include('RouterActivated');
    // And the approval is spent again, so this is not a one-off.
    expect(await ballista.routerProposedAt(b)).to.equal(0n);
  });

  // The lever that does close it, so the finding is actionable rather than abstract.
  it('revokeRouter DOES clear the standing approval -- re-activation then needs a fresh 24h', async function () {
    const { ballista, a, b } = await deploy();
    await ballista.proposeRouter(b);
    await time.increase(DAY + 1);
    await ballista.activateRouter(b);

    await ballista.revokeRouter(a);
    expect(await ballista.routerProposedAt(a)).to.equal(0n);
    await expect(ballista.activateRouter(a)).to.be.revertedWithCustomError(ballista, 'RouterNotProposed');
  });

  // FINDING R13. creationFeeUsdc is absent from currentEconomicsHash(), so the one fee
  // the creator pays directly is the one the pinning does not cover.
  it('creationFeeUsdc is NOT pinned by the economics hash -- it can change under a pinned launch', async function () {
    const { ballista, creator, usdc, treasury } = await deploy();

    // What the creator sees, and signs up to.
    const hash = await ballista.currentEconomicsHash();
    expect(await ballista.creationFeeUsdc()).to.equal(5n * 10n ** 5n); // 0.5 USDC

    // Owner raises it 1000x between quote and execution.
    await ballista.setCreationFee(500n * ONE);

    // The hash the creator pinned is UNCHANGED, so the guard cannot fire.
    expect(await ballista.currentEconomicsHash()).to.equal(hash);

    const before = await usdc.balanceOf(creator.address);
    await ballista.connect(creator).createToken('Pinned', 'PIN', '', hash, false);
    const paid = before - (await usdc.balanceOf(creator.address));

    expect(paid, 'creator paid the NEW fee despite pinning the OLD terms').to.equal(500n * ONE);
    expect(await ballista.treasuryFeesAccrued()).to.equal(500n * ONE);
  });

  // Bounds the finding: every OTHER economic term the creator is exposed to IS pinned.
  it('by contrast, a hashed term makes the same launch revert', async function () {
    const { ballista, creator } = await deploy();
    const hash = await ballista.currentEconomicsHash();
    await ballista.setDefaultGraduationThreshold(20_000n * ONE);
    await expect(
      ballista.connect(creator).createToken('Pinned', 'PIN2', '', hash, false)
    ).to.be.revertedWithCustomError(ballista, 'EconomicsChanged');
  });

  // R4's zero headroom, met by accident while writing the test above and worth keeping:
  // the base fee cannot be raised AT ALL under the opening table, and it fails at
  // createToken rather than at setDefaultFees -- so the misconfiguration is accepted
  // silently and only surfaces when the next launch is attempted.
  it('R4: raising the base fee at all bricks launches until a lower table is published', async function () {
    const { ballista, creator } = await deploy();
    await ballista.setDefaultFees(200, 200); // accepted without complaint
    const hash = await ballista.currentEconomicsHash();
    await expect(
      ballista.connect(creator).createToken('Ceil', 'CEIL', '', hash, false)
    ).to.be.revertedWithCustomError(ballista, 'BaseFeeCeilingExceeded');
  });
});

describe('Ballista — actor/phase pass: donations and direct transfers', function () {
  async function deployed() {
    const [owner, treasury, creator, donor] = await ethers.getSigners();
    const usdc = await (await ethers.getContractFactory('MockUSDC')).deploy();
    const router = await (await ethers.getContractFactory('MockRouter')).deploy();
    const ballista = await (await ethers.getContractFactory('LFX1')).deploy(
      await usdc.getAddress(), treasury.address, await router.getAddress()
    );
    for (const s of [creator, donor]) {
      await usdc.mint(s.address, 10_000n * ONE);
      await usdc.connect(s).approve(await ballista.getAddress(), ethers.MaxUint256);
    }
    const hash = await ballista.currentEconomicsHash();
    const tx = await ballista.connect(creator).createToken('Don', 'DON', '', hash, false);
    const rc = await tx.wait();
    const created = rc.logs
      .map((l) => { try { return ballista.interface.parseLog(l); } catch { return null; } })
      .filter(Boolean).find((l) => l.name === 'TokenCreated');
    return { ballista, usdc, creator, donor, treasury, token: created.args.token };
  }

  // FINDING R14. Donated USDC is credited to nobody and is unrecoverable: every payout
  // path is bounded by accounting, never by balance.
  it('USDC sent directly to the factory is stranded -- no path pays it out', async function () {
    const { ballista, usdc, donor, treasury } = await deployed();
    const factory = await ballista.getAddress();

    const accountedBefore = await ballista.treasuryFeesAccrued();
    await usdc.connect(donor).transfer(factory, 1_000n * ONE);

    // Accounting did not move; the balance did.
    expect(await ballista.treasuryFeesAccrued()).to.equal(accountedBefore);
    expect(await usdc.balanceOf(factory)).to.be.greaterThan(accountedBefore);

    // The only protocol withdrawal pays out the accrual, not the balance.
    const treasuryBefore = await usdc.balanceOf(treasury.address);
    await ballista.claimTreasuryFees();
    expect(await usdc.balanceOf(treasury.address) - treasuryBefore).to.equal(accountedBefore);

    // The donation is still sitting there, owned by no one.
    expect(await usdc.balanceOf(factory)).to.equal(1_000n * ONE);
  });

  // The same shape on the token side, and the reason it cannot corrupt graduation:
  // tokenLiquidity is computed from accounting, never from balanceOf.
  it('tokens sent directly to the factory are stranded and do not inflate graduation', async function () {
    const { ballista, usdc, creator, donor, token } = await deployed();
    const factory = await ballista.getAddress();
    const erc20 = await ethers.getContractAt('LFX1Token', token);

    await ethers.provider.send('evm_mine');
    await ballista.connect(creator).buy(token, 100n * ONE, 0);
    const held = await erc20.balanceOf(creator.address);
    await erc20.connect(creator).transfer(factory, held);

    const c = await ballista.curves(token);
    expect(
      await erc20.balanceOf(factory),
      'balance now exceeds accounted reserves'
    ).to.be.greaterThan(c.tokenReserves);
  });
});
