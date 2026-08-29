// What did we INHERIT that is externally reachable, and did anyone write it down?
//
// R17 was found by auditing what we wrote. renounceOwnership() came from Ownable and was
// never mentioned anywhere, yet one call to it permanently freezes revokeRouter() -- the
// lever section 1.5 calls the only hard stop against a malicious router. This script asks
// the same question of every inherited function rather than of the ones we happened to
// think about.
//
//   node scripts/audit-inherited.js
const fs = require("fs");
const path = require("path");
const ROOT = path.join(__dirname, "..");

const TARGETS = [
  ["LFX1", "contracts/LFX1.sol", "artifacts/contracts/LFX1.sol/LFX1.json"],
  ["LFX1Token", "contracts/LFX1Token.sol", "artifacts/contracts/LFX1Token.sol/LFX1Token.json"],
  ["GraduationHelper", "contracts/GraduationHelper.sol",
    "artifacts/contracts/GraduationHelper.sol/GraduationHelper.json"],
];

const claude = fs.readFileSync(path.join(ROOT, "CLAUDE.md"), "utf8");
const inventory = fs.existsSync(path.join(ROOT, "CONTRACT_INVENTORY.md"))
  ? fs.readFileSync(path.join(ROOT, "CONTRACT_INVENTORY.md"), "utf8") : "";

let flagged = 0;
for (const [name, srcPath, artPath] of TARGETS) {
  const src = fs.readFileSync(path.join(ROOT, srcPath), "utf8");
  const abi = JSON.parse(fs.readFileSync(path.join(ROOT, artPath), "utf8")).abi;
  const fns = abi.filter((x) => x.type === "function");

  const declared = new Set(
    [...src.matchAll(/function\s+(\w+)\s*\(/g)].map((m) => m[1])
  );
  const inherited = fns.filter((f) => !declared.has(f.name));

  console.log(`\n=== ${name}: ${inherited.length} inherited external/public functions ===`);
  for (const f of inherited) {
    const mutating = f.stateMutability !== "view" && f.stateMutability !== "pure";
    const inClaude = claude.includes(f.name);
    const inInv = inventory.includes(f.name);
    const mark = mutating && !inClaude ? "  <-- MUTATING, not in CLAUDE.md" : "";
    if (mutating && !inClaude) flagged++;
    console.log(
      `  ${f.stateMutability.padEnd(11)}${f.name}(${(f.inputs || []).map((i) => i.type).join(",")})` +
      `  [CLAUDE.md: ${inClaude ? "yes" : "NO "}] [inventory: ${inInv ? "yes" : "NO "}]${mark}`
    );
  }
}
console.log(`\n${flagged} inherited MUTATING function(s) absent from CLAUDE.md.`);
console.log("A mutating inherited function nobody documented is the R17 shape.");
