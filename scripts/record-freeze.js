// Records the freeze: on-chain bytecode hash, a local-vs-chain comparison, and the
// explorer's verification flags. Adds them to deployments/<network>.json.
//
// The bytecode hash is the part that makes a deployment record falsifiable. A commit
// hash says what SHOULD have been deployed; hashing the code actually on chain and
// comparing it to the local artifact says what WAS.
//
// Run: npx hardhat run scripts/record-freeze.js --network arcTestnet
const hre = require("hardhat");
const { ethers } = hre;
const fs = require("fs");
const path = require("path");

const API = "https://testnet.arcscan.app/api/v2/smart-contracts";

async function flags(address) {
  try {
    const r = await fetch(`${API}/${address}`);
    if (!r.ok) return { error: `HTTP ${r.status}` };
    const j = await r.json();
    return {
      is_fully_verified: j.is_fully_verified ?? null,
      is_partially_verified: j.is_partially_verified ?? null,
      is_changed_bytecode: j.is_changed_bytecode ?? null,
      license_type: j.license_type ?? null,
      file_path: j.file_path ?? null,
      additional_sources: (j.additional_sources || []).map((s) => s.file_path),
    };
  } catch (e) {
    return { error: String(e.message).slice(0, 120) };
  }
}

async function main() {
  const recordPath = path.join(__dirname, "..", "deployments", `${hre.network.name}.json`);
  const rec = JSON.parse(fs.readFileSync(recordPath, "utf8"));

  const entries = [["ballista", rec.ballista, "contracts/LFX1.sol/LFX1.json"]];
  if (rec.graduationHelper) {
    entries.push(["graduationHelper", rec.graduationHelper,
      "contracts/GraduationHelper.sol/GraduationHelper.json"]);
  }

  rec.bytecode = rec.bytecode || {};
  for (const [key, addr, artifactPath] of entries) {
    const onChain = await ethers.provider.getCode(addr);
    const artifact = JSON.parse(
      fs.readFileSync(path.join(__dirname, "..", "artifacts", artifactPath), "utf8")
    );
    const local = artifact.deployedBytecode;
    const onChainHash = ethers.keccak256(onChain);
    const exact = onChain.toLowerCase() === local.toLowerCase();

    // A raw comparison ALWAYS fails for a contract with immutables: the artifact carries
    // a zero placeholder where the deployed code carries the value. So classify the
    // difference rather than just reporting it. Every differing byte must sit where the
    // artifact has 0x00; anything else is a real discrepancy and must not be waved past.
    const l = local.slice(2).toLowerCase();
    const c = onChain.slice(2).toLowerCase();
    const diffOffsets = [];
    for (let i = 0; i < Math.min(l.length, c.length); i += 2) {
      if (l.slice(i, i + 2) !== c.slice(i, i + 2)) diffOffsets.push(i / 2);
    }
    const allAtPlaceholders =
      l.length === c.length &&
      diffOffsets.every((o) => l.slice(o * 2, o * 2 + 2) === "00");

    rec.bytecode[key] = {
      address: addr,
      sizeBytes: (onChain.length - 2) / 2,
      onChainKeccak256: onChainHash,
      exactMatchToLocalArtifact: exact,
      differingByteCount: diffOffsets.length,
      // True when every difference is an immutable substitution: same length, and each
      // differing byte is a 0x00 placeholder in the artifact. For LFX1 this is the `usdc`
      // immutable -- 12 reference sites, and only its leading 0x36 shows, because the
      // other 19 bytes of 0x3600...00 are zeros that match the placeholder.
      differsOnlyAtImmutablePlaceholders: exact ? true : allAtPlaceholders,
    };
    console.log(`${key}`);
    console.log(`  address    ${addr}`);
    console.log(`  size       ${(onChain.length - 2) / 2} bytes`);
    console.log(`  keccak256  ${onChainHash}`);
    if (exact) {
      console.log(`  local artifact: EXACT match`);
    } else if (allAtPlaceholders) {
      console.log(`  local artifact: matches except ${diffOffsets.length} immutable ` +
                  `placeholder byte(s) -- expected, benign`);
    } else {
      console.log(`  local artifact: MISMATCH BEYOND IMMUTABLES -- INVESTIGATE`);
    }
    const f = await flags(addr);
    console.log(`  explorer   ${JSON.stringify(f)}`);
    rec.bytecode[key].explorer = f;
  }

  rec.frozenAt = new Date().toISOString();
  fs.writeFileSync(recordPath, JSON.stringify(rec, null, 2) + "\n");
  console.log(`\nrecord updated: deployments/${hre.network.name}.json`);
}

main().catch((e) => { console.error(e); process.exit(1); });
