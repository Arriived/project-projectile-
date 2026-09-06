// Deploys GraduationHelper and appends it to the deployment record.
//
// ⚠ THE HELPER IS INERT ON ARC TESTNET. It needs a real Uniswap V2 factory to find the
// pair it corrects, and refreeze-preflight.js confirms the Arc mainnet V2 factory has NO
// CODE on testnet. Every call therefore reverts here: there are no pairs to skew, because
// the testnet router is MockRouter, which creates none. The problem the helper solves
// (section 1.1's adversarial pair, R6) does not exist on this chain.
//
// It is deployed with the MAINNET factory address so the constructor args are the ones it
// will carry in production and the source is verifiable now. Treat the testnet address as
// a reserved, verified artifact -- NOT as a working contract, and not as something to
// publish as functional.
//
// Run: npx hardhat run scripts/deploy-helper.js --network arcTestnet
const hre = require("hardhat");
const { ethers } = hre;
const fs = require("fs");
const path = require("path");

// github.com/Uniswap/sdks, sdks/sdk-core/src/addresses.ts, branch main, read 2026-09-05:
//   V2_FACTORY_ADDRESSES[ChainId.ARC] = 0x89e5db8b5aa49aa85ac63f691524311aeb649eba
//
// ⚠ V2 IS PUBLISHED FOR ARC -- a previous session concluded otherwise from Uniswap's chain
// playbook, which enumerates the ChainAddresses struct that V2 is not a member of. See
// CLAUDE.md §6 for the correction and for why "absent from that list" proved nothing.
//
// ⚠ PUBLISHED IS NOT DEPLOYED. Arc mainnet has not opened, so this may be a deterministic
// address registered ahead of deployment. eth_getCode it before anything depends on it --
// scripts/refreeze-preflight.js does that, with the probe validated first.
const ARC_MAINNET_V2_FACTORY = "0x89e5db8b5aa49aa85ac63f691524311aeb649eba";

async function main() {
  const net = await ethers.provider.getNetwork();
  if (net.chainId !== 5042002n) {
    throw new Error(`refusing to deploy: chainId ${net.chainId} is not Arc Testnet (5042002)`);
  }
  const recordPath = path.join(__dirname, "..", "deployments", `${hre.network.name}.json`);
  const rec = JSON.parse(fs.readFileSync(recordPath, "utf8"));
  if (!rec.ballista) throw new Error("no ballista address in the deployment record");

  const factoryCode = await ethers.provider.getCode(ARC_MAINNET_V2_FACTORY);
  console.log(`LFX1        ${rec.ballista}`);
  console.log(`usdc        ${rec.usdc}`);
  console.log(`v2 factory  ${ARC_MAINNET_V2_FACTORY}  ${factoryCode === "0x" ? "(NO CODE HERE -- helper is inert on testnet)" : "(code present)"}`);

  const H = await ethers.getContractFactory("GraduationHelper");
  const helper = await H.deploy(rec.ballista, ARC_MAINNET_V2_FACTORY, rec.usdc);
  const r = await helper.deploymentTransaction().wait();
  await helper.waitForDeployment();
  const addr = await helper.getAddress();

  console.log(`\nGraduationHelper  ${addr}   block ${r.blockNumber}`);
  console.log(`gas ${r.gasUsed}`);

  // Prove the no-privilege claim from chain state rather than from the source comment.
  const lfx1 = await ethers.getContractAt("LFX1", rec.ballista);
  const owner = await lfx1.owner();
  const router = await lfx1.router();
  console.log(`\n-- privilege check --`);
  console.log(`LFX1 owner   ${owner}   helper is owner: ${owner.toLowerCase() === addr.toLowerCase()}`);
  console.log(`LFX1 router  ${router}  helper is router: ${router.toLowerCase() === addr.toLowerCase()}`);

  rec.graduationHelper = addr;
  rec.graduationHelperBlock = r.blockNumber;
  rec.graduationHelperArgs = [rec.ballista, ARC_MAINNET_V2_FACTORY, rec.usdc];
  rec.graduationHelperNote =
    "INERT ON TESTNET: needs a real Uniswap V2 factory; the Arc mainnet factory has no " +
    "code on testnet and the testnet router is MockRouter, which creates no pairs. " +
    "Deployed for verified source and constructor-arg parity with mainnet. Holds no " +
    "privilege in LFX1: not owner, not router, calls only the public graduate().";
  rec.graduationHelperVerifyCommand =
    `npx hardhat verify --contract contracts/GraduationHelper.sol:GraduationHelper --network ${hre.network.name} ` +
    `${addr} ${rec.ballista} ${ARC_MAINNET_V2_FACTORY} ${rec.usdc}`;
  fs.writeFileSync(recordPath, JSON.stringify(rec, null, 2) + "\n");
  console.log(`\nrecord updated. Verify with:\n  ${rec.graduationHelperVerifyCommand}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
