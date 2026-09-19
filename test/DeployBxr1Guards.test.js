const { expect } = require("chai");
const fs = require("fs");
const path = require("path");

const DEPLOY = path.resolve(__dirname, "..", "scripts", "deploy-bxr1.js");

// Same reasoning as test/DeployV4StackGuards.test.js: inspect executable text only.
// Deployment-script comments explain the same invariants and must never be able to
// satisfy a guard check by themselves.
function executableSource() {
  return fs.readFileSync(DEPLOY, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");
}

describe("deploy-bxr1 hard stops", function () {
  it("refuses to bootstrap a router when the chain is Arc mainnet (5042)", function () {
    const source = executableSource();

    // The guard must be a real throwing branch, gated on BOTH the bootstrap flag and
    // chainId === 5042n specifically -- not a warning, not a console.log, not a check
    // against some other chain id.
    const guard = source.match(
      /if\s*\(\s*BOOTSTRAP_ROUTER\s*&&\s*net\.chainId\s*===\s*5042n\s*\)\s*\{\s*throw new Error\(/
    );
    expect(guard, "BOOTSTRAP_ROUTER + chainId 5042 must enter a throwing branch").not.to.equal(null);

    // It must run before the first transaction this script can ever send (CurveMath's
    // deployment) -- a guard placed after any deploy step would let a mainnet
    // bootstrap attempt get partway through before refusing.
    const firstTx = source.indexOf("CurveMath.deploy()");
    expect(firstTx, "sanity: the script must still deploy CurveMath").to.be.greaterThan(-1);
    expect(guard.index, "the mainnet guard must run before the first possible transaction")
      .to.be.lessThan(firstTx);

    // The refusal must read the PROVIDER's own reported chainId (net.chainId), not
    // hre.network.name or the network config -- a --network flag whose name says
    // "arcTestnet" while actually pointed at a mainnet RPC must still be caught.
    expect(source).to.include("const net = await hre.ethers.provider.getNetwork();");
    expect(guard.index).to.be.greaterThan(source.indexOf("const net = await hre.ethers.provider.getNetwork();"));
  });

  it("the guard is unconditional on BOOTSTRAP_ROUTER being set -- unset, chainId 5042 alone does not matter to it", function () {
    // Negative control: prove the pattern above could NOT match a version of the
    // guard that fires regardless of BOOTSTRAP_ROUTER (which would incorrectly block
    // an ordinary, non-bootstrapping deploy to a chain that happens to report 5042).
    // If this pattern matched, the FIRST test's specific "&& net.chainId === 5042n"
    // match would be satisfied by a vacuous, over-broad guard instead of the real one.
    const source = executableSource();
    const overBroad = source.match(/if\s*\(\s*net\.chainId\s*===\s*5042n\s*\)\s*\{\s*throw new Error\(/);
    expect(overBroad, "the guard must not exist in a form unconditioned on BOOTSTRAP_ROUTER").to.equal(null);
  });

  it("BXR1_BOOTSTRAP_ROUTER is read once, feeds initialRouter, and is unset by default (address(0))", function () {
    const source = executableSource();
    expect(source).to.include('const BOOTSTRAP_ROUTER = process.env.BXR1_BOOTSTRAP_ROUTER;');
    expect(source).to.include("const initialRouter = BOOTSTRAP_ROUTER || ethers.ZeroAddress;");
    expect(source).to.include("BXR1.deploy(registryAddress, treasury, initialRouter)");
  });
});
