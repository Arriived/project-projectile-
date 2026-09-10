// Selftest for scripts/mine-hook-salt.js.
//
//   node scripts/mine-hook-salt.js --selftest
//
// ⚠ THE POINT OF THIS FILE IS THE NEGATIVE CASES, NOT THE POSITIVE ONE.
//
// A salt miner that reports success is worthless on its own: the whole failure mode it
// guards against is SILENT (PoolManager just never calls a callback whose flag is
// missing). So the decoder has to be shown REPORTING A WRONG ANSWER on deliberately
// wrong input before its "yes" means anything -- CLAUDE.md §5 "prove every test can go
// red", §12.6 "mutate the thing the check asserts about", and §16.4 "a mutation that
// survives means the test was never testing the thing it names".
//
// The CREATE prediction is likewise proved against REAL deployments -- three consecutive
// nonces from the deployer recorded in deployments/arcTestnet.json -- and then shown to
// produce a DIFFERENT address for a nonce off by one and for a deployer off by one
// character.
"use strict";

const fs = require("fs");
const path = require("path");
const { getAddress } = require("ethers");

let pass = 0;
let fail = 0;
function check(label, ok, detail) {
  if (ok) {
    pass++;
    console.log(`  PASS  ${label}${detail ? "  -- " + detail : ""}`);
  } else {
    fail++;
    console.log(`  FAIL  ${label}${detail ? "  -- " + detail : ""}`);
  }
}
function section(t) {
  console.log(`\n${t}`);
}

// Force the low 14 bits of an address to `low`, leaving the top bits alone.
function withLowBits(baseAddress, low) {
  const b = BigInt(getAddress(baseAddress));
  const cleared = b & ~BigInt((1 << 14) - 1);
  return getAddress("0x" + (cleared | BigInt(low)).toString(16).padStart(40, "0"));
}

module.exports = function selftest(M, flags, hooksPath) {
  const { predictCreateAddress, predictCreate2Address, decodeHookFlags, flagsMatchExactly, targetMask, mineSalt, REQUIRED_FLAGS, ALL_HOOK_MASK, ARACHNID_CREATE2_DEPLOYER } = M;

  // -----------------------------------------------------------------------
  section("1. flag constants, parsed from the PINNED v4-core that hardhat compiles against");
  console.log(`     source: ${path.relative(path.join(__dirname, ".."), hooksPath)}`);
  const expectedBits = { BEFORE_INITIALIZE_FLAG: 13, AFTER_SWAP_FLAG: 6, AFTER_SWAP_RETURNS_DELTA_FLAG: 2 };
  for (const [name, bit] of Object.entries(expectedBits)) {
    const got = flags[name];
    check(
      `${name} is 1 << ${bit}`,
      got && got.bit === bit,
      got ? `Hooks.sol:${got.line}  bit ${got.bit}  mask 0x${(1 << got.bit).toString(16).padStart(4, "0")}` : "NOT FOUND"
    );
  }
  check("exactly 14 flags exist in Hooks.sol", Object.keys(flags).length === 14, `parsed ${Object.keys(flags).length}`);
  check("ALL_HOOK_MASK is 14 bits", ALL_HOOK_MASK === 0x3fff, `0x${ALL_HOOK_MASK.toString(16)}`);

  const MASK = targetMask(flags, REQUIRED_FLAGS);
  check("target mask is the OR of exactly those three", MASK === ((1 << 13) | (1 << 6) | (1 << 2)), `0x${MASK.toString(16).padStart(4, "0")}`);

  // v4-core refuses a delta flag without its action flag (Hooks.sol isValidHookAddress).
  check(
    "AFTER_SWAP_RETURNS_DELTA is accompanied by AFTER_SWAP",
    (MASK & (1 << flags.AFTER_SWAP_RETURNS_DELTA_FLAG.bit)) === 0 || (MASK & (1 << flags.AFTER_SWAP_FLAG.bit)) !== 0,
    "isValidHookAddress would reject the address otherwise"
  );

  // -----------------------------------------------------------------------
  section("2. CREATE prediction, proved against THREE real deployments");
  const dep = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "deployments", "arcTestnet.json"), "utf8"));
  const deployer = dep.deployer;
  const known = [
    [156, dep.router, "MockRouter"],
    [157, dep.ballista, "LFX1 factory"],
    [158, dep.graduationHelper, "GraduationHelper"],
  ];
  console.log(`     deployer: ${deployer}   (from deployments/arcTestnet.json)`);
  for (const [nonce, expected, label] of known) {
    const got = predictCreateAddress(deployer, nonce);
    check(`nonce ${nonce} predicts ${label}`, got.toLowerCase() === expected.toLowerCase(), got);
  }

  section("3. ⚠ CREATE prediction must go RED on wrong input");
  const target = dep.ballista.toLowerCase();
  check(
    "nonce 156 does NOT predict the LFX1 factory",
    predictCreateAddress(deployer, 156).toLowerCase() !== target,
    predictCreateAddress(deployer, 156)
  );
  check(
    "nonce 158 does NOT predict the LFX1 factory",
    predictCreateAddress(deployer, 158).toLowerCase() !== target,
    predictCreateAddress(deployer, 158)
  );
  // Lower-cased before mutating: ethers' getAddress enforces the EIP-55 checksum, so a
  // mixed-case address with one character changed is REJECTED rather than silently used.
  // That is a real safety property of the runbook (a mistyped checksummed address cannot
  // be fed to this script at all) -- but it is not the thing under test here, so the
  // mutation is applied to the all-lowercase form, which getAddress accepts.
  const lower = deployer.toLowerCase();
  const wrongDeployer = lower.slice(0, -1) + (lower.slice(-1) === "b" ? "c" : "b");
  check(
    "a deployer differing by one character does NOT predict it",
    predictCreateAddress(wrongDeployer, 157).toLowerCase() !== target,
    predictCreateAddress(wrongDeployer, 157)
  );
  let checksumRejected = false;
  try {
    predictCreateAddress(deployer.slice(0, -1) + "C", 157);
  } catch (e) {
    checksumRejected = /checksum/i.test(String(e && e.message));
  }
  check("a MIXED-CASE address with a broken checksum is refused outright", checksumRejected, "ethers getAddress enforces EIP-55");

  // -----------------------------------------------------------------------
  section("4. ⚠ the DECODER must be able to report a wrong answer");
  // A real-looking base address; only the low 14 bits matter to the decoder.
  const BASE = "0xba11157a0000000000000000000000000000c000"; // lowercase: getAddress enforces EIP-55

  const good = withLowBits(BASE, MASK);
  check("an address carrying exactly the three flags MATCHES", flagsMatchExactly(good, flags, REQUIRED_FLAGS), `${good}  ${decodeHookFlags(good, flags).lowHex}`);

  // One extra flag set -- this is the mutation that matters most. An address with an
  // EXTRA permission is a live callback nobody wrote (CLAUDE.md §18.4).
  const extra = withLowBits(BASE, MASK | (1 << flags.BEFORE_SWAP_FLAG.bit));
  check(
    "an address with ONE EXTRA flag (beforeSwap) does NOT match",
    !flagsMatchExactly(extra, flags, REQUIRED_FLAGS),
    `${extra}  ${decodeHookFlags(extra, flags).lowHex}  -> ${decodeHookFlags(extra, flags).set.join("+")}`
  );

  // One required flag missing -- the silent-failure case: deploys fine, never charges.
  const missing = withLowBits(BASE, MASK & ~(1 << flags.AFTER_SWAP_FLAG.bit));
  check(
    "an address MISSING afterSwap does NOT match",
    !flagsMatchExactly(missing, flags, REQUIRED_FLAGS),
    `${missing}  ${decodeHookFlags(missing, flags).lowHex}  -> ${decodeHookFlags(missing, flags).set.join("+") || "(none)"}`
  );

  const deltaOnly = withLowBits(BASE, MASK & ~(1 << flags.AFTER_SWAP_RETURNS_DELTA_FLAG.bit));
  check(
    "an address MISSING the delta flag does NOT match",
    !flagsMatchExactly(deltaOnly, flags, REQUIRED_FLAGS),
    `${deltaOnly}  ${decodeHookFlags(deltaOnly, flags).lowHex}`
  );

  const none = withLowBits(BASE, 0);
  check("an address with NO flags does NOT match", !flagsMatchExactly(none, flags, REQUIRED_FLAGS), `${none}  0x0000`);

  check(
    "a real non-hook address does NOT match",
    !flagsMatchExactly(dep.ballista, flags, REQUIRED_FLAGS),
    `${dep.ballista}  ${decodeHookFlags(dep.ballista, flags).lowHex}`
  );

  // -----------------------------------------------------------------------
  section("5. mining, end to end, against a stand-in initCodeHash");
  // ⚠ STAND-IN ON PURPOSE. The hook does not exist yet, so there is no real
  // initCodeHash to mine. What is proved here is the MACHINERY -- the CREATE2
  // derivation, the search, and the decode-back. Re-run with the real artifact
  // once the hook compiles; the mined salt is only valid for one exact initCodeHash.
  const standIn = "0x" + "ab".repeat(32);
  const found = mineSalt(ARACHNID_CREATE2_DEPLOYER, standIn, MASK, { maxTries: 2_000_000 });
  check("a salt was found", !!found, found ? `${found.tries} tries` : "none");
  if (found) {
    const d = decodeHookFlags(found.address, flags);
    check("mined address decodes to EXACTLY the three flags", flagsMatchExactly(found.address, flags, REQUIRED_FLAGS), `${found.address}  low14=${d.lowHex}  ${d.set.join(" + ")}`);
    check("salt reproduces the address", predictCreate2Address(ARACHNID_CREATE2_DEPLOYER, found.salt, standIn) === found.address, found.salt);
    // Changing the initCodeHash by one bit must invalidate the salt -- this is what
    // makes "re-mine after any source change" a rule rather than advice.
    const bumped = "0x" + "ab".repeat(31) + "aa";
    check(
      "the SAME salt against a different initCodeHash does NOT keep the flags",
      !flagsMatchExactly(predictCreate2Address(ARACHNID_CREATE2_DEPLOYER, found.salt, bumped), flags, REQUIRED_FLAGS),
      predictCreate2Address(ARACHNID_CREATE2_DEPLOYER, found.salt, bumped)
    );
  }

  console.log(`\n${"-".repeat(62)}`);
  console.log(`  CHECKS=${pass + fail}  PASSED=${pass}  FAILED=${fail}`);
  console.log(`${"-".repeat(62)}`);
  if (fail > 0) process.exit(1);
};
