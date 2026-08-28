// Owner-only parameter changes on the live deployment. No redeploy, no bytecode change.
//   BALLISTA_ADDRESS=0x... npx hardhat run scripts/set-launch-params.js --network arcTestnet
//
// symbolLockDuration -> 0. Proven in test/SymbolLock.test.js to disable the check outright
// rather than merely shorten it: the write still happens, so the guard is still evaluated,
// but the stored value is a past-or-present timestamp and the comparison is `>=`, so it
// can never fire -- including for two launches inside one block, where unlocksAt == now.
//
// launchCooldown -> 5 seconds.
//
// ⚠ symbolLockDuration is INSIDE currentEconomicsHash(). Changing it moves the hash, so any
// createToken carrying a pre-change hash reverts EconomicsChanged. launchCooldown is NOT
// hashed, so changing that invalidates nothing.
const hre = require("hardhat");
const { ethers } = hre;

const BALLISTA = process.env.BALLISTA_ADDRESS;

async function main() {
  if (!BALLISTA) throw new Error("set BALLISTA_ADDRESS");
  const f = await ethers.getContractAt("LFX1", BALLISTA);
  const [signer] = await ethers.getSigners();
  const owner = await f.owner();
  if (owner.toLowerCase() !== signer.address.toLowerCase()) {
    throw new Error(`signer ${signer.address} is not owner ${owner}`);
  }

  const hashBefore = await f.currentEconomicsHash();
  console.log(`factory            ${BALLISTA}`);
  console.log(`symbolLockDuration ${await f.symbolLockDuration()}  ->  0`);
  console.log(`launchCooldown     ${await f.launchCooldown()}  ->  5`);
  console.log(`economics hash     ${hashBefore}`);

  await (await f.setSymbolLockDuration(0)).wait();
  await (await f.setLaunchCooldown(5)).wait();

  const hashAfter = await f.currentEconomicsHash();
  console.log(`\nafter:`);
  console.log(`  symbolLockDuration ${await f.symbolLockDuration()}`);
  console.log(`  launchCooldown     ${await f.launchCooldown()}`);
  console.log(`  isSymbolAvailable("CAT") ${await f.isSymbolAvailable("CAT")}`);
  console.log(`  economics hash     ${hashAfter}`);
  console.log(`  hash moved: ${hashBefore !== hashAfter} (expected true -- symbolLockDuration is hashed)`);
}

main().catch((e) => { console.error(e); process.exit(1); });
