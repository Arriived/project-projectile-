// Generates the indexer's ABI from the Hardhat build artifact.
//
// Replaces a hand-maintained `indexer/src/factoryAbi.js`. That file listed the Curve
// tuple as 16 fields while the struct had grown to 22, and ethers decoded it WITHOUT
// error -- the struct is all-static, so the offsets still line up and the extra fields
// are simply dropped. Silent truncation, exactly the failure the file's own comment
// warned about. Regenerating that tuple by hand fixes it until the next struct change
// and then breaks the same way again.
//
// Emitting the full ABI removes the class of bug: there is no curated subset to fall
// behind. Run after `hardhat compile`; the output is committed so the indexer runs
// standalone, and a test fails if the committed copy drifts from the artifact.
const fs = require("fs");
const path = require("path");

const ARTIFACT = path.join(__dirname, "..", "artifacts", "contracts", "LFX1.sol", "LFX1.json");
const OUT_DIR = path.join(__dirname, "..", "indexer", "src", "generated");
const OUT = path.join(OUT_DIR, "lfx1Abi.json");

function build() {
  if (!fs.existsSync(ARTIFACT)) {
    throw new Error(
      `artifact not found at ${ARTIFACT} -- run \`npx hardhat compile\` first`
    );
  }
  const { abi } = JSON.parse(fs.readFileSync(ARTIFACT, "utf8"));
  if (!Array.isArray(abi) || abi.length === 0) {
    throw new Error("artifact contains no ABI");
  }
  // Stable, deterministic output so a drift check is a plain string comparison and a
  // reordering by the compiler does not read as a change.
  return JSON.stringify(abi, null, 2) + "\n";
}

function main() {
  const content = build();
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const existing = fs.existsSync(OUT) ? fs.readFileSync(OUT, "utf8") : null;
  fs.writeFileSync(OUT, content);
  const n = JSON.parse(content).length;
  console.log(
    `${existing === content ? "unchanged" : "WROTE"}  ${path.relative(process.cwd(), OUT)}  (${n} ABI entries)`
  );
}

module.exports = { build, OUT };
if (require.main === module) main();
