// The v4 deployment sequence: predict, mine, deploy, and READ THE BINDING BACK.
//
//   node scripts/deploy-v4-stack.js --network arcTestnet            # PLAN ONLY, sends nothing
//   node scripts/deploy-v4-stack.js --network arcTestnet --execute   # sends transactions
//
// ⚠ IT PLANS BY DEFAULT AND SENDS NOTHING WITHOUT --execute. Every number below can be
// computed before a single transaction exists, and the whole point of this script is that
// the plan is checkable in advance rather than discovered halfway through.
//
// ─── WHY THE ORDER IS WHAT IT IS (CLAUDE.md 20.6, 20.7, 20.18) ──────────────────────
//
// Three contracts, one cycle, all immutable:
//   the adapter needs the HOOK (a PoolKey member) and LFX1 (its caller gate)
//   the hook    needs the ADAPTER (its gate) and LFX1 (to read the creator)
//   LFX1        takes the adapter as initialRouter_
//
// ⚠ TWO ADDRESSES MUST BE PREDICTED, NOT ONE. An earlier version deployed LFX1 FIRST with
// initialRouter_ = address(0), which needed only the adapter predicted. That is no longer
// the plan: initialRouter_ is the deployed adapter (CLAUDE.md 20.18), so LFX1 must come
// LAST -- and the hook, which is mined first, needs LFX1's address. Hence:
//
//   nonce n     CREATE2 the hook          (its initcode embeds predicted adapter + LFX1)
//   nonce n+1   deploy the adapter        (hook now real, LFX1 still predicted)
//   nonce n+2   deploy LFX1               (adapter now real -> initialRouter_)
//   then        READ THE BINDING BACK -- in both directions -- before anything else
//
// ⚠ THREE CONSECUTIVE NONCES, NO GAPS. Any unrelated transaction from this key between
// them shifts the rest and invalidates the mined salt. The runbook requires a DEDICATED
// deployment key that signs nothing else, ever -- not a test transaction, not an approval.
// The nonce is re-read and asserted immediately before every transaction in the sequence.
//
// ⚠ initialRouter_ IS BEHIND A DELIBERATE FLAG. Without --bootstrap-router it is
// address(0), createToken reverts RouterNotSet (LFX1.sol:310), and the only route to a
// live router is proposeRouter + 24h. With the flag, the adapter is live at block zero
// through the constructor's one untimelocked activation (LFX1.sol:216-221). That bypass
// exists once per factory and is spent the moment it is used, so it is never a default.
//
// ⚠ WHY THE READ-BACK IS THE MOST IMPORTANT STEP. Pons resolves this same cycle with an
// owner-gated one-time setter and can repair a wrong wiring with one transaction. We chose
// ownerlessness, so we cannot. A mis-bound pair DEPLOYS CLEANLY -- nothing reverts, nothing
// logs -- and the first symptom is every graduation reverting inside beforeInitialize with
// every token parked at GRADUATION_READY for ever. The adapter's constructor catches the
// common case (it asks the hook who its adapter is), but the read-back proves the pair in
// BOTH directions, while nothing is at risk.
//
// ⚠ CONSTRUCTOR ARGUMENT ORDER IS LOAD-BEARING. `adapter_` is LAST on the hook and `hook_`
// is LAST on the adapter; the miner appends the predicted adapter as the final argument by
// convention. Reordering either constructor changes the initcode and silently invalidates
// every mined salt.

"use strict";

const hre = require("hardhat");
const { ethers } = hre;
const {
  readFlagConstants,
  predictCreateAddress,
  decodeHookFlags,
  flagsMatchExactly,
  targetMask,
  mineSalt,
  REQUIRED_FLAGS,
  ARACHNID_CREATE2_DEPLOYER,
} = require("./mine-hook-salt.js");

const EXECUTE = process.argv.includes("--execute");

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
}

function say(label, value) {
  console.log(`  ${String(label).padEnd(34)} ${value}`);
}

// ⚠ A probe that returns empty for everything proves nothing (CLAUDE.md 10, 12.8). Three
// known-good addresses are read first; if any of them comes back without code the run
// aborts rather than reporting a chain-wide absence that is really a broken RPC.
async function requireCode(addresses, controls) {
  console.log("\nPRE-FLIGHT — code presence");
  let controlsOk = 0;
  for (const [name, addr] of Object.entries(controls)) {
    const code = await ethers.provider.getCode(addr);
    const n = (code.length - 2) / 2;
    say(`control ${name}`, `${n} bytes`);
    if (n > 0) controlsOk++;
  }
  if (controlsOk < 3) {
    throw new Error(
      `only ${controlsOk} of ${Object.keys(controls).length} known-good controls returned code -- ` +
        "the probe is broken, not the chain. ABORT."
    );
  }
  for (const [name, addr] of Object.entries(addresses)) {
    const code = await ethers.provider.getCode(addr);
    const n = (code.length - 2) / 2;
    say(name, `${n} bytes`);
    if (n === 0) throw new Error(`${name} at ${addr} has NO CODE. ABORT.`);
  }
}

async function main() {
  const [deployer] = await ethers.getSigners();
  const net = await ethers.provider.getNetwork();
  const configuredChainId = hre.network.config && hre.network.config.chainId;
  if (!Number.isSafeInteger(configuredChainId)) {
    throw new Error("selected Hardhat network has no integer chainId. ABORT.");
  }
  if (net.chainId !== BigInt(configuredChainId)) {
    throw new Error(
      `CHAIN ID MISMATCH: selected network ${hre.network.name} expects ${configuredChainId}, ` +
      `provider returned ${net.chainId}. ABORT.`
    );
  }

  const POOL_MANAGER = arg("poolManager");
  const POSITION_MANAGER = arg("positionManager");
  const PERMIT2 = arg("permit2");
  const USDC = arg("usdc");
  const TREASURY = arg("treasury");
  const LFX1_ADDR = arg("lfx1"); // omit to plan a fresh LFX1 at initialRouter_ = 0
  if (!POOL_MANAGER || !POSITION_MANAGER || !PERMIT2 || !USDC || !TREASURY) {
    console.error(
      "usage: --poolManager 0x.. --positionManager 0x.. --permit2 0x.. --usdc 0x.. --treasury 0x.. [--lfx1 0x..] [--execute]"
    );
    process.exit(2);
  }

  console.log("=".repeat(74));
  console.log(`  BALLISTA v4 STACK — ${EXECUTE ? "EXECUTE" : "PLAN ONLY (nothing will be sent)"}`);
  console.log("=".repeat(74));
  say("chain id", net.chainId.toString());
  say("deployer", deployer.address);
  say("deployer nonce", await ethers.provider.getTransactionCount(deployer.address));

  // ⚠ A CONTROL MUST NOT BE A SUBJECT. The first version of this used PoolManager as one
  // of the three known-good controls AND as a thing to check -- so on a chain with no v4
  // it aborted saying "the probe is broken" when the probe was fine and the absence was
  // real. Controls are addresses whose code presence is established independently of
  // anything this deployment is testing.
  const MULTICALL3 = arg("multicall3", "0xcA11bde05977b3631167028862bE2a173976CA11");
  await requireCode(
    { PoolManager: POOL_MANAGER, PositionManager: POSITION_MANAGER, Permit2: PERMIT2 },
    { USDC, Create2Deployer: ARACHNID_CREATE2_DEPLOYER, Multicall3: MULTICALL3 }
  );

  // ── Steps 1-2: predict BOTH addresses ──────────────────────────────────────────
  console.log("\nSTEP 1 — predict the two addresses the mined initcode must embed");
  const BOOTSTRAP = process.argv.includes("--bootstrap-router");
  const n0 = await ethers.provider.getTransactionCount(deployer.address);
  const hookNonce = n0;      // the CREATE2 transaction
  const adapterNonce = n0 + 1;
  const lfx1Nonce = n0 + 2;
  const predictedAdapter = predictCreateAddress(deployer.address, adapterNonce);
  const predictedLfx1 = predictCreateAddress(deployer.address, lfx1Nonce);
  say("hook (CREATE2) uses nonce", hookNonce);
  say("adapter nonce", `${adapterNonce}  ->  ${predictedAdapter}`);
  say("LFX1 nonce", `${lfx1Nonce}  ->  ${predictedLfx1}`);
  say("initialRouter_", BOOTSTRAP
    ? `${predictedAdapter}  (--bootstrap-router: LIVE AT BLOCK ZERO, no timelock)`
    : "address(0)  (default: createToken inert until proposeRouter + 24h)");
  if (BOOTSTRAP) {
    console.log("");
    console.log("  ⚠ --bootstrap-router SPENDS THE CONSTRUCTOR'S ONE UNTIMELOCKED ROUTER");
    console.log("    ACTIVATION (LFX1.sol:216-221). It exists once per factory. Every later");
    console.log("    router must pass a public RouterProposed and a full 24 hours.");
  }

  // ── Step 3: mine against the REAL initcode ─────────────────────────────────────
  console.log("\nSTEP 2 — mine the hook salt against real initcode");
  const { flags } = readFlagConstants();
  const mask = targetMask(flags, REQUIRED_FLAGS);
  const HookF = await ethers.getContractFactory("BallistaFeeHook");
  const initCode = (
    await HookF.getDeployTransaction(POOL_MANAGER, predictedLfx1, USDC, TREASURY, predictedAdapter)
  ).data;
  const initCodeHash = ethers.keccak256(initCode);
  say("target mask", `0x${mask.toString(16).padStart(4, "0")}  (${REQUIRED_FLAGS.join(" + ")})`);
  say("initCodeHash", initCodeHash);

  const found = mineSalt(ARACHNID_CREATE2_DEPLOYER, initCodeHash, mask);
  if (!found) throw new Error("no salt found");
  const decoded = decodeHookFlags(found.address, flags);
  say("salt", `${found.salt}  (${found.tries} tries)`);
  say("hook address", found.address);
  say("low 14 bits", `${decoded.lowHex}  ${decoded.set.join(" + ")}`);
  if (!flagsMatchExactly(found.address, flags, REQUIRED_FLAGS)) {
    throw new Error("mined address does not carry EXACTLY the three flags. ABORT.");
  }
  say("⚠ salt validity", "this initCodeHash only — re-mine after ANY hook change");

  console.log("GAS — estimated against this chain, at the current base fee");
  {
    const gasPrice = (await ethers.provider.getFeeData()).gasPrice ?? 20000000000n;
    let total = 0n;
    // ⚠ ESTIMATED INDEPENDENTLY, because two of the three CANNOT be estimated in plan mode
    // and that is not a failure. The adapter's constructor reads hook.adapter() to verify
    // the binding, and LFX1 (with --bootstrap-router) takes an adapter that does not exist
    // yet -- calls to codeless addresses return empty and the decode reverts. That is the
    // binding check doing its job. Their gas is knowable only after the step before them.
    const jobs = [
      ["hook (via CREATE2)", async () => ethers.provider.estimateGas({
        from: deployer.address, to: ARACHNID_CREATE2_DEPLOYER,
        data: ethers.concat([found.salt, initCode]),
      })],
      ["adapter", async () => ethers.provider.estimateGas({
        from: deployer.address,
        data: (await (await ethers.getContractFactory("BallistaV4Adapter"))
          .getDeployTransaction(POOL_MANAGER, POSITION_MANAGER, PERMIT2, predictedLfx1, found.address)).data,
      })],
      ["LFX1", async () => ethers.provider.estimateGas({
        from: deployer.address,
        data: (await (await ethers.getContractFactory("LFX1"))
          .getDeployTransaction(USDC, TREASURY, BOOTSTRAP ? predictedAdapter : ethers.ZeroAddress)).data,
      })],
    ];
    for (const [label, fn] of jobs) {
      try {
        const g = await fn();
        total += g;
        const cost = (g * gasPrice) / 1000000000000n;
        say(label, g.toString().padStart(10) + " gas   " + (Number(cost) / 1e6).toFixed(6) + " USDC");
      } catch {
        say(label, "not estimable in plan mode — a contract it reads does not exist yet");
      }
    }
    const cost = (total * gasPrice) / 1000000000000n;
    say("TOTAL (estimable parts)", total.toString().padStart(10) + " gas   " + (Number(cost) / 1e6).toFixed(6) + " USDC");
  }

  if (!EXECUTE) {
    console.log("\nSTEPS 3-6 — not executed (plan only)");
    console.log("\n  Re-run with --execute to send. The nonce is re-read and asserted");
    console.log("  before EACH deployment, and the binding is read back in");
    console.log("  both directions before any next step is suggested.");
    console.log("");
    return;
  }

  // ── Step 3: the hook, via CREATE2 ──────────────────────────────────────────────
  console.log("\nSTEP 3 — deploy the hook (CREATE2)");
  await requireNonce(deployer, hookNonce, "hook CREATE2");
  await (await deployer.sendTransaction({
    to: ARACHNID_CREATE2_DEPLOYER,
    data: ethers.concat([found.salt, initCode]),
  })).wait();
  const hookCode = await ethers.provider.getCode(found.address);
  if (hookCode === "0x") throw new Error(`CREATE2 produced no code at ${found.address}. ABORT.`);
  say("hook deployed", `${found.address}  (${(hookCode.length - 2) / 2} bytes)`);

  // ── Step 4: nonce gate, then the adapter ───────────────────────────────────────
  console.log("\nSTEP 4 — nonce gate, then the adapter");
  await requireNonce(deployer, adapterNonce, "adapter");
  const AdapterF = await ethers.getContractFactory("BallistaV4Adapter");
  const adapter = await AdapterF.deploy(POOL_MANAGER, POSITION_MANAGER, PERMIT2, predictedLfx1, found.address);
  await adapter.waitForDeployment();
  const adapterAddr = await adapter.getAddress();
  say("adapter deployed", adapterAddr);
  if (adapterAddr.toLowerCase() !== predictedAdapter.toLowerCase()) {
    throw new Error(`adapter landed at ${adapterAddr}, predicted ${predictedAdapter}. ABORT.`);
  }

  // ── Step 5: nonce gate, then LFX1 ──────────────────────────────────────────────
  console.log("\nSTEP 5 — nonce gate, then LFX1");
  await requireNonce(deployer, lfx1Nonce, "LFX1");
  const initialRouter = BOOTSTRAP ? adapterAddr : ethers.ZeroAddress;
  const lfx1C = await (await ethers.getContractFactory("LFX1")).deploy(USDC, TREASURY, initialRouter);
  await lfx1C.waitForDeployment();
  const lfx1 = await lfx1C.getAddress();
  say("LFX1 deployed", lfx1);
  say("initialRouter_", initialRouter);
  if (lfx1.toLowerCase() !== predictedLfx1.toLowerCase()) {
    throw new Error(`LFX1 landed at ${lfx1}, predicted ${predictedLfx1}. The hook names the WRONG factory. ABORT.`);
  }

  // ── Step 6: the read-back gate ─────────────────────────────────────────────────
  console.log("\nSTEP 6 — READ THE BINDING BACK (hard stop, not a check)");
  const hook = await ethers.getContractAt("BallistaFeeHook", found.address);
  const checks = [
    ["hook.adapter()", await hook.adapter(), adapterAddr],
    ["hook.lfx1()", await hook.lfx1(), lfx1],
    ["hook.usdc()", await hook.usdc(), USDC],
    ["hook.protocolRecipient()", await hook.protocolRecipient(), TREASURY],
    ["adapter.hook()", await adapter.hook(), found.address],
    ["adapter.lfx1()", await adapter.lfx1(), lfx1],
    ["lfx1.router()", await lfx1C.router(), initialRouter],
  ];
  let bad = 0;
  for (const [label, got, want] of checks) {
    const ok = String(got).toLowerCase() === String(want).toLowerCase();
    if (!ok) bad++;
    say(label, `${got}  ${ok ? "OK" : "!! expected " + want}`);
  }
  if (bad > 0) throw new Error(`${bad} binding check(s) FAILED. STOP. Do not create a token, do not propose a router.`);
  console.log("\n  BINDING VERIFIED IN BOTH DIRECTIONS.");

  if (!BOOTSTRAP) {
    console.log("\n  Next, and not before:");
    console.log(`    lfx1.proposeRouter(${adapterAddr})`);
    console.log("    ... the full 24 hours, with RouterProposed publicly visible ...");
    console.log(`    lfx1.activateRouter(${adapterAddr})`);
  } else {
    console.log("\n  The router is LIVE. Run the post-deploy checks before any token is created.");
  }
  console.log("");
  console.log(JSON.stringify({
    chainId: Number(net.chainId), deployer: deployer.address,
    hook: found.address, salt: found.salt, initCodeHash,
    adapter: adapterAddr, lfx1, initialRouter,
    nonces: { hook: hookNonce, adapter: adapterNonce, lfx1: lfx1Nonce },
  }, null, 2));
}

// ⚠ A HARD STOP, NOT A WARNING. If the nonce has moved, the mined salt is already invalid
// and continuing produces a stack that deploys cleanly and can never graduate.
async function requireNonce(deployer, expected, what) {
  const now = await ethers.provider.getTransactionCount(deployer.address, "pending");
  say("pending nonce", `${now}  (need ${expected} for ${what})`);
  if (now !== expected) {
    throw new Error(
      `NONCE MISMATCH before ${what}: expected ${expected}, got ${now}. Something else sent ` +
      "a transaction from this key. The mined salt is now invalid -- re-predict and re-mine. ABORT."
    );
  }
}

main().catch((e) => {
  console.error("\n" + String(e.message || e) + "\n");
  process.exit(1);
});
