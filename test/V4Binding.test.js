// The two invariants that hold the v4 deployment together, pinned by execution rather
// than by comment. Local -- no fork, no network.
//
//   npx hardhat test test/V4Binding.test.js
//
// Both of these are properties that were verified ONCE BY HAND during design and would
// otherwise stay verified only for as long as nobody edited the file. CLAUDE.md section
// 12.6: mutate the thing the check asserts about; section 5: a test that cannot go red is
// not a test. The red-proof for each is recorded in its own block below.
const { expect } = require('chai');
const { ethers } = require('hardhat');
const { deployBoundPair, ensureCreate2Deployer, ARACHNID_CREATE2_DEPLOYER } = require('./helpers/v4deploy');
const { mineSalt, readFlagConstants, targetMask, REQUIRED_FLAGS } = require('../scripts/mine-hook-salt.js');

const ZERO = '0x0000000000000000000000000000000000000000';

describe('v4 binding invariants (local)', function () {
  // ─────────────────────────────────────────────────────────────────────────────────
  // J. The adapter's caller gate.
  //
  // BallistaFeeHook.beforeInitialize admits only `sender == adapter`. That is worth
  // nothing on its own, because addLiquidity being callable by anyone would mean only
  // that SOMEONE routed through the adapter -- and an attacker who can do that can
  // initialise a launch token's pool at a price of their choosing for the entire ACTIVE
  // phase of its curve. The two halves are one gate and this is the outer half.
  //
  // ⚠ RED-PROOF: delete `if (msg.sender != lfx1) revert NotLfx1(msg.sender);` from
  // BallistaV4Adapter.addLiquidity. Test 1 then reaches DeadlineExpired instead of
  // NotLfx1 and fails. Nothing else in the suite notices, which is the entire reason
  // this test exists.
  // ─────────────────────────────────────────────────────────────────────────────────
  describe('J. addLiquidity is callable only by LFX1', function () {
    let adapter, lfx1Signer, stranger, deadline;

    before(async function () {
      const signers = await ethers.getSigners();
      [lfx1Signer, stranger] = signers;
      // The gate is the FIRST statement in addLiquidity, before any external call, so
      // poolManager/positionManager/permit2 are never reached and may be zero. `lfx1`
      // and `hook` may not: the constructor rejects a zero lfx1, and rejects a hook that
      // is zero, wrongly flagged, or not bound back to this adapter -- so even a gate
      // test has to go through the real predict/mine/deploy sequence.
      const pair = await deployBoundPair(
        lfx1Signer, 'MockHookBinding', [], 'BallistaV4Adapter',
        [ZERO, ZERO, ZERO, lfx1Signer.address]
      );
      adapter = pair.adapter;
    });

    beforeEach(async function () {
      deadline = (await ethers.provider.getBlock('latest')).timestamp + 3600;
    });

    it('1. rejects a caller that is not LFX1, by name', async function () {
      await expect(
        adapter.connect(stranger).addLiquidity(
          '0x0000000000000000000000000000000000000A11',
          '0x0000000000000000000000000000000000000B22',
          1n, 1n, 0n, 0n, stranger.address, deadline
        )
      ).to.be.revertedWithCustomError(adapter, 'NotLfx1').withArgs(stranger.address);
    });

    it('2. the gate is what rejected it -- LFX1 itself gets PAST the gate', async function () {
      // ⚠ THE CONTROL, AND THE TEST IS WORTHLESS WITHOUT IT. Test 1 alone passes just as
      // happily if addLiquidity reverts for every caller for some unrelated reason
      // (CLAUDE.md section 16.4: a check must name its guard). An EXPIRED deadline is
      // used because DeadlineExpired is the very next statement after the gate, so
      // reaching it proves the gate was passed and nothing further is exercised.
      const expired = (await ethers.provider.getBlock('latest')).timestamp - 1;
      await expect(
        adapter.connect(lfx1Signer).addLiquidity(
          '0x0000000000000000000000000000000000000A11',
          '0x0000000000000000000000000000000000000B22',
          1n, 1n, 0n, 0n, lfx1Signer.address, expired
        )
      ).to.be.revertedWithCustomError(adapter, 'DeadlineExpired');
    });

    it('3. the immutable is readable, so a deployment can be checked on chain', async function () {
      // CLAUDE.md section 20.7's post-deploy gate reads this. If it stops being public
      // the runbook's binding check silently has nothing to read.
      expect(await adapter.lfx1()).to.equal(lfx1Signer.address);
    });

    it('4. the constructor refuses a zero LFX1', async function () {
      const f = await ethers.getContractFactory('BallistaV4Adapter');
      await expect(f.deploy(ZERO, ZERO, ZERO, ZERO, await adapter.hook()))
        .to.be.revertedWithCustomError(f, 'ZeroAddress');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────────
  // The hook's constructor must never read msg.sender.
  //
  // WHY THIS MATTERS ENOUGH TO TEST. BallistaFeeHook is deployed through the
  // permissionless Arachnid CREATE2 deployer, whose address derivation excludes the
  // caller -- so anyone who learns the salt and the initcode can deploy it first, at our
  // exact address. That is harmless ONLY because the resulting contract is identical
  // whoever sends the transaction: every immutable comes from a constructor argument,
  // which is inside the hashed initcode. The moment the constructor derives anything
  // from msg.sender, a benign front-run becomes a theft.
  //
  // ⚠ THIS IS A BEHAVIOURAL TEST, NOT A GREP. Deploying from two different senders and
  // comparing what lands on chain catches the property itself rather than one spelling
  // of it -- `msg.sender`, `_msgSender()`, an inherited base that captures it, or a
  // delegate that reads tx.origin. A source scan would have to anticipate each.
  //
  // ⚠ RED-PROOF: add `address public immutable deployer;` to BallistaFeeHook and assign
  // `deployer = msg.sender;` in its constructor. Test 5 then fails -- an immutable is
  // baked into runtime code, so the two deployments differ. Assign it to storage instead
  // and test 6 fails on the slot comparison. Both were run; both went red.
  // ─────────────────────────────────────────────────────────────────────────────────
  describe('the hook constructor is sender-independent', function () {
    let codeA, codeB, hookA, hookB;

    before(async function () {
      const [a, b, lfx1, usdc, treasury, adapterAddr] = await ethers.getSigners();
      const f = await ethers.getContractFactory('BallistaFeeHookTestable');
      const args = [
        '0x0000000000000000000000000000000000000001', // poolManager -- never called here
        lfx1.address,
        usdc.address,
        treasury.address,
        adapterAddr.address,
      ];
      hookA = await f.connect(a).deploy(...args);
      hookB = await f.connect(b).deploy(...args);
      codeA = await ethers.provider.getCode(await hookA.getAddress());
      codeB = await ethers.provider.getCode(await hookB.getAddress());
    });

    it('5. two deployments from different senders have IDENTICAL runtime code', async function () {
      // Immutables are baked into runtime bytecode, so any msg.sender-derived immutable
      // shows up here as a difference.
      expect(codeA).to.equal(codeB);
      expect(codeA.length, 'code must actually be present, or this compares nothing')
        .to.be.greaterThan(2);
    });

    it('6. neither deployment wrote anything into storage', async function () {
      // Catches the other half: a constructor that writes msg.sender to a SLOT rather
      // than to an immutable, which leaves runtime code identical.
      for (let slot = 0; slot < 8; slot++) {
        const sA = await ethers.provider.getStorage(await hookA.getAddress(), slot);
        const sB = await ethers.provider.getStorage(await hookB.getAddress(), slot);
        expect(sA, `slot ${slot} of deployment A is not empty`).to.equal(ethers.ZeroHash);
        expect(sB, `slot ${slot} of deployment B is not empty`).to.equal(ethers.ZeroHash);
      }
    });

    it('7. every immutable came from an argument, and both agree', async function () {
      for (const name of ['lfx1', 'usdc', 'protocolRecipient', 'adapter', 'poolManager']) {
        expect(await hookA[name](), `${name} differs between deployments`)
          .to.equal(await hookB[name]());
      }
    });

    it('8. CONTROL: the comparison can distinguish two different deployments', async function () {
      // ⚠ Without this, tests 5 and 7 pass trivially if getCode ever returns the same
      // thing for everything, or if the harness silently deployed one contract twice.
      // A deployment with a DIFFERENT argument must compare unequal.
      const [a, , lfx1, usdc, treasury] = await ethers.getSigners();
      const f = await ethers.getContractFactory('BallistaFeeHookTestable');
      const different = await f.connect(a).deploy(
        '0x0000000000000000000000000000000000000001',
        lfx1.address,
        usdc.address,
        treasury.address,
        '0x000000000000000000000000000000000000dEaD' // a different adapter
      );
      expect(await ethers.provider.getCode(await different.getAddress()))
        .to.not.equal(codeA);
      expect(await different.adapter()).to.not.equal(await hookA.adapter());
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────────
  // The adapter's three hook checks.
  //
  // ⚠ A WRONG HOOK IS THE ONLY FAILURE IN THIS DEPLOYMENT THAT IS SILENT AT BOTH ENDS.
  // Hooks.isValidHookAddress(IHooks(0), fee) returns TRUE for a static fee, so an adapter
  // built with hooks: address(0) graduates SUCCESSFULLY, creates the pool, burns the LP,
  // and takes no fee for the rest of time. Nothing reverts and nothing logs. Because the
  // LP is burned it cannot migrate to a corrected pool either.
  //
  // ⚠ RED-PROOF: delete `if (address(hook_) == address(0)) revert ZeroHook();` from the
  // adapter's constructor. Test 9 then fails -- and NOTHING ELSE IN THE ENTIRE SUITE
  // NOTICES, because a hookless adapter is a perfectly functional hookless adapter. Run
  // and confirmed red.
  // ─────────────────────────────────────────────────────────────────────────────────
  describe('the adapter refuses a wrong hook at construction', function () {
    const ZERO_ADDR = '0x0000000000000000000000000000000000000000';
    let signer, adapterFactory, goodHook, goodAdapter;

    before(async function () {
      [signer] = await ethers.getSigners();
      adapterFactory = await ethers.getContractFactory('BallistaV4Adapter');
      await ensureCreate2Deployer();
      const pair = await deployBoundPair(signer, 'MockHookBinding', [], 'BallistaV4Adapter',
        [ZERO_ADDR, ZERO_ADDR, ZERO_ADDR, signer.address]);
      goodHook = pair.hookAddress;
      goodAdapter = pair.adapter;
    });

    it('9. a ZERO hook is refused -- the silent-at-both-ends case', async function () {
      await expect(
        adapterFactory.deploy(ZERO_ADDR, ZERO_ADDR, ZERO_ADDR, signer.address, ZERO_ADDR)
      ).to.be.revertedWithCustomError(adapterFactory, 'ZeroHook');
    });

    it('10. a non-zero hook with the WRONG FLAG BITS is refused', async function () {
      // Non-zero, so it passes the zero check, and its low 14 bits are not 0x2044. This
      // is the second silent route: PoolManager would simply never call afterSwap.
      const wrongFlags = '0x00000000000000000000000000000000000012ab'; // lowercase: getAddress enforces EIP-55
      await expect(
        adapterFactory.deploy(ZERO_ADDR, ZERO_ADDR, ZERO_ADDR, signer.address, wrongFlags)
      ).to.be.revertedWithCustomError(adapterFactory, 'HookFlagsWrong');
    });

    it('11/21. a correctly-flagged hook bound to SOMEONE ELSE is refused, NAMING the wrong address', async function () {
      // ⚠ THIS IS THE CHECK THAT MAKES THE NONCE PREDICTION SELF-VERIFYING.
      // The hook is mined and deployed FIRST, carrying the adapter's PREDICTED CREATE
      // address. If a stray transaction moved the deployer's nonce, the adapter lands
      // somewhere else and the hook names an address that will never hold it -- both
      // immutable, unfixable, and silent at deploy. Every graduation would then revert
      // inside beforeInitialize and every token would park at GRADUATION_READY for ever.
      //
      // The argument is asserted, not just the error: the revert has to REPORT who the
      // hook thinks its adapter is, or an operator seeing it has nothing to diagnose with.
      // Passes checks 1 and 2. This is what a mis-predicted deployment nonce produces,
      // and it is the reason the binding check exists rather than the flag check alone.
      const { flags } = readFlagConstants();
      const mask = targetMask(flags, REQUIRED_FLAGS);
      const mockFactory = await ethers.getContractFactory('MockHookBinding');
      const initCode = (await mockFactory.getDeployTransaction('0x000000000000000000000000000000000000dEaD')).data;
      const found = mineSalt(ARACHNID_CREATE2_DEPLOYER, ethers.keccak256(initCode), mask);
      await (await signer.sendTransaction({
        to: ARACHNID_CREATE2_DEPLOYER, data: ethers.concat([found.salt, initCode]),
      })).wait();

      await expect(
        adapterFactory.deploy(ZERO_ADDR, ZERO_ADDR, ZERO_ADDR, signer.address, found.address)
      ).to.be.revertedWithCustomError(adapterFactory, 'HookNotBoundToThis')
        .withArgs('0x000000000000000000000000000000000000dEaD');
    });

    it('12. CONTROL: a correctly-flagged, correctly-bound hook IS accepted', async function () {
      // ⚠ Without this, tests 9-11 pass just as happily if the constructor rejected every
      // hook for some unrelated reason (CLAUDE.md 16.4). The pair below was deployed
      // through the same predict/mine/deploy sequence production uses.
      expect(await goodAdapter.hook()).to.equal(goodHook);
      const low = BigInt(goodHook) & 0x3fffn;
      expect(low, 'the accepted hook must carry exactly BEFORE_INITIALIZE|AFTER_SWAP|AFTER_SWAP_RETURNS_DELTA')
        .to.equal(0x2044n);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────────
  // ROWS 13-21 -- the hook's registration gate, asserted BY NAME on a DIRECT call.
  //
  // ⚠ EVERY GATE ROW IS ASSERTED TWICE, AND THIS IS ONLY HALF. The other half lives in
  // Fork.v4.hook.test.js, where the same condition is driven THROUGH graduation and must
  // produce the parked-curve outcome. Neither half is sufficient on its own:
  //
  //   through graduation only -> cannot distinguish the guard under test from
  //                              amount0Max/amount1Max, the PoolPriceMismatch equality
  //                              check, or a pool that already existed. LFX1 swallows the
  //                              reason in its try/catch, so they all look identical.
  //                              CLAUDE.md 16.4: a check that cannot name its guard is
  //                              not testing it. This is the A1c pattern.
  //   direct only              -> proves the guard exists, not that it is on the real path.
  //
  // The hook here is BallistaFeeHookTestable with poolManager_ set to a SIGNER, so the
  // callbacks can be invoked exactly as PoolManager would invoke them -- unforked, fast,
  // and with the revert named.
  // ─────────────────────────────────────────────────────────────────────────────────
  describe('rows 13-21. the registration gate, named on a direct call', function () {
    const FEE = 0;
    const TS = 60;
    let pmSigner, adapterSigner, stranger, creator, hook, lfx1Mock, usdcAddr, token, key;

    beforeEach(async function () {
      [pmSigner, adapterSigner, stranger, creator] = await ethers.getSigners();
      lfx1Mock = await (await ethers.getContractFactory('MockLfx1Curves')).deploy();
      usdcAddr = '0x1111111111111111111111111111111111111111';
      token = '0x2222222222222222222222222222222222222222';
      hook = await (await ethers.getContractFactory('BallistaFeeHookTestable')).deploy(
        pmSigner.address, await lfx1Mock.getAddress(), usdcAddr, stranger.address, adapterSigner.address
      );
      await (await lfx1Mock.setCurve(token, token, creator.address)).wait();
      key = {
        currency0: usdcAddr, currency1: token,
        fee: FEE, tickSpacing: TS, hooks: await hook.getAddress(),
      };
    });

    it('CONTROL. the happy path registers, so every rejection below means something', async function () {
      await expect(hook.connect(pmSigner).beforeInitialize(adapterSigner.address, key, 1n))
        .to.emit(hook, 'PoolRegistered');
    });

    it('13. rejects a sender that is not the adapter', async function () {
      await expect(hook.connect(pmSigner).beforeInitialize(stranger.address, key, 1n))
        .to.be.revertedWithCustomError(hook, 'NotAdapter').withArgs(stranger.address);
    });

    it('14. rejects a wrong fee', async function () {
      await expect(hook.connect(pmSigner).beforeInitialize(adapterSigner.address, { ...key, fee: 3000 }, 1n))
        .to.be.revertedWithCustomError(hook, 'WrongFee').withArgs(3000);
    });

    it('15. rejects a wrong tickSpacing', async function () {
      await expect(hook.connect(pmSigner).beforeInitialize(adapterSigner.address, { ...key, tickSpacing: 10 }, 1n))
        .to.be.revertedWithCustomError(hook, 'WrongTickSpacing').withArgs(10);
    });

    it('16. rejects a key whose hooks field is not this hook', async function () {
      const other = '0x3333333333333333333333333333333333333333';
      await expect(hook.connect(pmSigner).beforeInitialize(adapterSigner.address, { ...key, hooks: other }, 1n))
        .to.be.revertedWithCustomError(hook, 'WrongHook').withArgs(other);
    });

    it('17. rejects a token with no curve record', async function () {
      // curves() does not revert for an unknown token -- it returns a zero-filled struct,
      // so identity is tested the way LFX1 tests it internally: c.token == token.
      const unknown = '0x4444444444444444444444444444444444444444';
      await expect(hook.connect(pmSigner).beforeInitialize(adapterSigner.address, { ...key, currency1: unknown }, 1n))
        .to.be.revertedWithCustomError(hook, 'UnknownCurve').withArgs(unknown);
    });

    it('18. rejects a curve whose creator is the zero address', async function () {
      // ⚠ UNREACHABLE THROUGH THE REAL LFX1, WHICH IS WHY IT NEEDS A MOCK. LFX1 writes
      // creator = msg.sender (LFX1.sol:342) and has no setter anywhere. The guard is kept
      // because the cost of being wrong is half of every fee on that pool accruing to
      // address(0) for ever, from which no claim() is possible.
      const orphan = '0x5555555555555555555555555555555555555555';
      await (await lfx1Mock.setCurve(orphan, orphan, ethers.ZeroAddress)).wait();
      await expect(hook.connect(pmSigner).beforeInitialize(adapterSigner.address, { ...key, currency1: orphan }, 1n))
        .to.be.revertedWithCustomError(hook, 'ZeroCreator').withArgs(orphan);
    });

    it('19. rejects a key with no USDC side', async function () {
      const a = '0x6666666666666666666666666666666666666666';
      await expect(hook.connect(pmSigner).beforeInitialize(adapterSigner.address, { ...key, currency0: a }, 1n))
        .to.be.revertedWithCustomError(hook, 'NoUsdcSide').withArgs(a, token);
    });

    it('20. every disabled callback reverts HookNotImplemented', async function () {
      const mp = { tickLower: 0, tickUpper: 0, liquidityDelta: 0, salt: ethers.ZeroHash };
      const sp = { zeroForOne: true, amountSpecified: 0, sqrtPriceLimitX96: 0 };
      const disabled = [
        ['afterInitialize', [adapterSigner.address, key, 1n, 0]],
        ['beforeAddLiquidity', [adapterSigner.address, key, mp, '0x']],
        ['afterAddLiquidity', [adapterSigner.address, key, mp, 0, 0, '0x']],
        ['beforeRemoveLiquidity', [adapterSigner.address, key, mp, '0x']],
        ['afterRemoveLiquidity', [adapterSigner.address, key, mp, 0, 0, '0x']],
        ['beforeSwap', [adapterSigner.address, key, sp, '0x']],
        ['beforeDonate', [adapterSigner.address, key, 0, 0, '0x']],
        ['afterDonate', [adapterSigner.address, key, 0, 0, '0x']],
      ];
      expect(disabled.length, 'the disabled set is not 8 -- a permission may have changed')
        .to.equal(8);
      for (const [name, args] of disabled) {
        await expect(hook.connect(pmSigner)[name](...args), name + ' did not revert')
          .to.be.revertedWithCustomError(hook, 'HookNotImplemented');
      }
    });

    it('20b. the revert above is HookNotImplemented, NOT a caller check', async function () {
      // ⚠ If a caller check fired first, row 20 would pass while proving only that
      // strangers are refused -- a different statement. This pins which one is which.
      await expect(hook.connect(stranger).beforeSwap(
        adapterSigner.address, key, { zeroForOne: true, amountSpecified: 0, sqrtPriceLimitX96: 0 }, '0x'
      )).to.be.revertedWithCustomError(hook, 'NotPoolManager');
    });

    it('21b. transferFeeRecipient rejects a caller that is not the current recipient', async function () {
      await (await hook.connect(pmSigner).beforeInitialize(adapterSigner.address, key, 1n)).wait();
      const poolId = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(
        ['address', 'address', 'uint24', 'int24', 'address'],
        [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks]
      ));
      await expect(hook.connect(stranger).transferFeeRecipient(poolId, stranger.address))
        .to.be.revertedWithCustomError(hook, 'NotFeeRecipient').withArgs(stranger.address);
      // CONTROL: the real recipient can, so the rejection above is the caller check and
      // not something about the pool or the argument.
      await expect(hook.connect(creator).transferFeeRecipient(poolId, stranger.address))
        .to.emit(hook, 'FeeRecipientTransferred');
    });
  });
});
