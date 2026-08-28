// Set Blockscout's license_type on a verified contract.
//
// ⚠ YOU ALMOST CERTAINLY DO NOT NEED TO RUN THIS. The project is UNLICENSED, and the
// correct Blockscout value for that is `none`, which is what `hardhat verify` already
// leaves behind. This script is kept so the mapping is written down rather than
// re-derived, and so the trap below is recorded where someone would meet it.
//
// THE TRAP. Blockscout's list is fixed and has no "UNLICENSED" entry:
//
//     none        no licence stated  <-- CORRECT for UNLICENSED, and already set
//     unlicense   The Unlicense: a PUBLIC DOMAIN DEDICATION. The exact opposite.
//
// Selecting `unlicense` because the word looks right would publicly waive every right the
// project is trying to keep. It is a one-click, hard-to-notice giveaway of the entire
// codebase. Do not.
//
// The full list was queried from the live instance rather than remembered:
// GET /api/v2/smart-contracts/verification/config -> license_types.
//
// Dry-run by default; pass --send to actually post. LICENSE_TYPE overrides the value.
//
//   node scripts/set-license.js                 # show the request, send nothing
//   node scripts/set-license.js --send          # ballista
//   node scripts/set-license.js --send --helper # GraduationHelper
const fs = require("fs");
const path = require("path");
const { AbiCoder } = require("ethers");

const BASE = "https://testnet.arcscan.app";
const LICENSE = process.env.LICENSE_TYPE || "none";  // UNLICENSED maps to none; NEVER "unlicense" (public domain)
const COMPILER = "v0.8.24+commit.e11b9ed9";

function buildInputFor(sourcePath) {
  const dir = path.join(__dirname, "..", "artifacts", "build-info");
  for (const f of fs.readdirSync(dir)) {
    const j = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
    if (Object.keys(j.input.sources).includes(sourcePath)) return j.input;
  }
  throw new Error(`no build-info contains ${sourcePath}`);
}

async function main() {
  const send = process.argv.includes("--send");
  const helper = process.argv.includes("--helper");
  const rec = JSON.parse(fs.readFileSync(
    path.join(__dirname, "..", "deployments", "arcTestnet.json"), "utf8"));

  const target = helper
    ? { address: rec.graduationHelper, name: "GraduationHelper",
        source: "contracts/GraduationHelper.sol", args: rec.graduationHelperArgs }
    : { address: rec.ballista, name: "LFX1",
        source: "contracts/LFX1.sol", args: rec.constructorArgs };

  const encoded = AbiCoder.defaultAbiCoder()
    .encode(["address", "address", "address"], target.args).slice(2);

  const form = new FormData();
  form.append("compiler_version", COMPILER);
  form.append("contract_name", `${target.source}:${target.name}`);
  form.append("autodetect_constructor_args", "false");
  form.append("constructor_args", encoded);
  form.append("license_type", LICENSE);
  form.append("files[0]", new Blob([JSON.stringify(buildInputFor(target.source))],
    { type: "application/json" }), "standard-input.json");

  const url = `${BASE}/api/v2/smart-contracts/${target.address}/verification/via/standard-input`;
  console.log(`contract      ${target.name}  ${target.address}`);
  console.log(`license_type  ${LICENSE}`);
  console.log(`compiler      ${COMPILER}`);
  console.log(`endpoint      POST ${url}`);
  console.log(`constructor   0x${encoded}`);

  if (!send) {
    console.log(`\nDRY RUN -- nothing sent. Re-run with --send to submit.`);
    console.log(`If Blockscout refuses because the contract is already verified, use the`);
    console.log(`explorer UI instead: the contract's code tab has a licence selector, and`);
    console.log(`CLAUDE.md records the UI as the confirmed route.`);
    return;
  }

  const r = await fetch(url, { method: "POST", body: form });
  console.log(`\nHTTP ${r.status}`);
  console.log((await r.text()).slice(0, 600));
  console.log(`\nRe-check with:  node -e "fetch('${BASE}/api/v2/smart-contracts/${target.address}').then(r=>r.json()).then(j=>console.log(j.license_type))"`);
}

main().catch((e) => { console.error(e); process.exit(1); });
