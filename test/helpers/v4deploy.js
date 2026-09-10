// Deploys a hook and its adapter as a correctly-bound pair, the way production will.
//
// ⚠ THIS EXISTS BECAUSE THE PAIR IS CIRCULAR AND BOTH SIDES ARE IMMUTABLE. The adapter
// needs the hook's address for the PoolKey; the hook needs the adapter's address for its
// beforeInitialize gate. Neither can be set afterwards, so one side has to be PREDICTED:
//
//   1. predict the adapter's CREATE address from the deployer's nonce
//   2. build the hook's initcode with that address baked in as a constructor argument
//   3. mine a CREATE2 salt so the hook lands at an address carrying exactly the three
//      permission flags -- a v4 hook's permissions ARE its address
//   4. deploy the hook through the canonical CREATE2 deployer (this consumes a nonce)
//   5. deploy the adapter at exactly the predicted nonce
//
// Tests run the same sequence so that a change which breaks the real deployment breaks
// them too. CLAUDE.md sections 20.6 and 20.7.
const { ethers } = require('hardhat');
const {
  mineSalt,
  targetMask,
  readFlagConstants,
  decodeHookFlags,
  flagsMatchExactly,
  REQUIRED_FLAGS,
  ARACHNID_CREATE2_DEPLOYER,
} = require('../../scripts/mine-hook-salt.js');

// The canonical Arachnid deterministic deployer's runtime code. Present on Base and on
// Arc; absent on a bare hardhat network, where it is etched in so that local tests, fork
// tests and production all resolve the hook to the same kind of address.
const ARACHNID_RUNTIME =
  '0x7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe03601600081' +
  '602082378035828234f58015156039578182fd5b8082525050506014600cf3';

// ⚠ ASSERTED, NOT TRUSTED. The first transcription of this constant carried one byte too
// many (70 instead of 69) and produced an `invalid opcode` from a contract that looked
// plausible. A hand-copied constant that is one byte wrong is exactly the class this repo
// keeps being bitten by, so the length is checked before anything depends on it.
const ARACHNID_RUNTIME_BYTES = 69;

async function ensureCreate2Deployer() {
  const code = await ethers.provider.getCode(ARACHNID_CREATE2_DEPLOYER);
  if (code === '0x') {
    await ethers.provider.send('hardhat_setCode', [ARACHNID_CREATE2_DEPLOYER, ARACHNID_RUNTIME]);
  }
  const after = await ethers.provider.getCode(ARACHNID_CREATE2_DEPLOYER);
  if (after === '0x') throw new Error('CREATE2 deployer is not available and could not be etched');
  const bytes = (after.length - 2) / 2;
  if (bytes !== ARACHNID_RUNTIME_BYTES) {
    throw new Error(`CREATE2 deployer is ${bytes} bytes, expected ${ARACHNID_RUNTIME_BYTES}`);
  }
  return after;
}

// Deploys `hookName(...hookArgs, <predicted adapter>)` at a mined address, then
// `adapterName(...adapterArgs, <hook>)` at the predicted nonce. Returns both.
async function deployBoundPair(signer, hookName, hookArgs, adapterName, adapterArgs) {
  await ensureCreate2Deployer();
  const { flags } = readFlagConstants();
  const mask = targetMask(flags, REQUIRED_FLAGS);

  // The CREATE2 deploy below is one transaction from `signer`, so the adapter lands one
  // nonce later. Getting this wrong is the exact failure the binding check catches.
  const n0 = await ethers.provider.getTransactionCount(signer.address);
  const predictedAdapter = ethers.getCreateAddress({ from: signer.address, nonce: n0 + 1 });

  const hookFactory = await ethers.getContractFactory(hookName, signer);
  const initCode = (await hookFactory.getDeployTransaction(...hookArgs, predictedAdapter)).data;
  const found = mineSalt(ARACHNID_CREATE2_DEPLOYER, ethers.keccak256(initCode), mask);
  if (!found) throw new Error(`no salt found for ${hookName}`);
  if (!flagsMatchExactly(found.address, flags, REQUIRED_FLAGS)) {
    throw new Error(`mined address does not carry exactly the three flags: ${found.address}`);
  }

  await (await signer.sendTransaction({
    to: ARACHNID_CREATE2_DEPLOYER,
    data: ethers.concat([found.salt, initCode]),
  })).wait();

  const deployedHookCode = await ethers.provider.getCode(found.address);
  if (deployedHookCode === '0x') throw new Error(`CREATE2 produced no code at ${found.address}`);

  const adapterFactory = await ethers.getContractFactory(adapterName, signer);
  const adapter = await adapterFactory.deploy(...adapterArgs, found.address);
  await adapter.waitForDeployment();

  const actual = await adapter.getAddress();
  if (actual.toLowerCase() !== predictedAdapter.toLowerCase()) {
    // Unreachable in practice -- the adapter's own constructor would have reverted
    // HookNotBoundToThis first -- but a clear message beats a confusing downstream one.
    throw new Error(`adapter landed at ${actual}, predicted ${predictedAdapter}`);
  }

  return {
    hookAddress: found.address,
    salt: found.salt,
    tries: found.tries,
    adapter,
    predictedAdapter,
    decoded: decodeHookFlags(found.address, flags),
  };
}

module.exports = { deployBoundPair, ensureCreate2Deployer, ARACHNID_CREATE2_DEPLOYER, ARACHNID_RUNTIME };
