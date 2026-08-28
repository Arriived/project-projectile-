// Set Blockscout's license_type to BUSL-1.1 on a verified contract.
//
// `hardhat verify` never sends a licence type, which is why every deployment so far shows
// license_type: none. Blockscout's own verification config confirms `bsl_1_1` is a
// supported value (enum 14) -- queried from the live instance, not remembered.
//
// This re-submits verification via the standard-input endpoint WITH the licence field.
// Dry-run by default: it prints exactly what it would send and stops. Pass --send to
// actually post.
//
//   node scripts/set-license.js                 # show the request, send nothing
//   node scripts/set-license.js --send          # ballista
//   node scripts/set-license.js --send --helper # GraduationHelper
//
// NOTE ON THE ENTITY NAME: this call does NOT need it. Blockscout's license_type is a tag
// on the verified contract and is independent of the `[LICENSOR]` placeholder in the
// source headers. Filling that placeholder is a SOURCE change, and the compiler embeds an
// IPFS metadata hash of the sources in the bytecode, so editing even a comment changes the
// deployed bytecode and would require a fresh deployment. The tag can be set now; the name
// in the published source cannot be, without redeploying.
const fs = require("fs");
const path = require("path");
const { AbiCoder } = require("ethers");

const BASE = "https://testnet.arcscan.app";
const LICENSE = "bsl_1_1";
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
