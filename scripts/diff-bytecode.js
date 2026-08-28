// Byte-level diff of on-chain runtime code against the local artifact.
// A "does not match" result is meaningless without knowing WHERE it differs: an
// immutable substitution is benign, anything else is not.
// Run: npx hardhat run scripts/diff-bytecode.js --network arcTestnet
const hre = require("hardhat");
const { ethers } = hre;
const fs = require("fs");
const path = require("path");

async function main() {
  const rec = JSON.parse(fs.readFileSync(
    path.join(__dirname, "..", "deployments", `${hre.network.name}.json`), "utf8"));
  const artifact = JSON.parse(fs.readFileSync(
    path.join(__dirname, "..", "artifacts", "contracts/LFX1.sol/LFX1.json"), "utf8"));

  const local = artifact.deployedBytecode.slice(2).toLowerCase();
  const onchain = (await ethers.provider.getCode(rec.ballista)).slice(2).toLowerCase();

  console.log(`local   ${local.length / 2} bytes`);
  console.log(`onchain ${onchain.length / 2} bytes`);

  const diffs = [];
  for (let i = 0; i < Math.min(local.length, onchain.length); i += 2) {
    if (local.slice(i, i + 2) !== onchain.slice(i, i + 2)) diffs.push(i / 2);
  }
  console.log(`differing bytes: ${diffs.length}`);
  if (!diffs.length) return;

  const runs = [];
  let s = diffs[0], p = diffs[0];
  for (const d of diffs.slice(1)) {
    if (d === p + 1) { p = d; } else { runs.push([s, p]); s = d; p = d; }
  }
  runs.push([s, p]);
  console.log(`differing runs: ${runs.length}`);
  for (const [x, y] of runs) {
    const lo = local.slice(x * 2, (y + 1) * 2);
    const ch = onchain.slice(x * 2, (y + 1) * 2);
    console.log(`  offset ${x}..${y}  len ${y - x + 1}`);
    console.log(`    local ${lo}`);
    console.log(`    chain ${ch}`);
  }
  console.log(`\nusdc immutable expected on chain: ${rec.usdc.slice(2).toLowerCase()}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
