const { expect } = require("chai");
const fs = require("fs");
const path = require("path");

const DEPLOY = path.resolve(__dirname, "..", "..", "scripts", "deploy-bxr1.js");

// Same reasoning as test/DeployV4StackGuards.test.js: inspect executable text only.
// Deployment-script comments explain the same invariants and must never be able to
// satisfy a guard check by themselves.
function executableSource() {
  return fs.readFileSync(DEPLOY, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");
}

describe("deploy-bxr1 hard stops", function () {
  it("BXR1_BOOTSTRAP_ROUTER is allowlisted to exactly {5042002, 31337}, refused everywhere else", function () {
    const source = executableSource();

    // The allowlist itself, as a real array literal the guard actually reads --
    // not a comment claiming two values while the code names different ones.
    expect(source).to.include("const BOOTSTRAP_ALLOWED_CHAIN_IDS = [5042002n, 31337n];");

    // The guard must be a real throwing branch, gated on BOTH the bootstrap flag and
    // NOT being in the allowlist -- not a warning, not a console.log, and not an
    // inverted/vacuous condition that would throw on every chain or none.
    const guard = source.match(
      /if\s*\(\s*BOOTSTRAP_ROUTER\s*&&\s*!BOOTSTRAP_ALLOWED_CHAIN_IDS\.includes\(net\.chainId\)\s*\)\s*\{\s*throw new Error\(/
    );
    expect(guard, "BOOTSTRAP_ROUTER + chainId not in the allowlist must enter a throwing branch")
      .not.to.equal(null);

    // It must run before the first transaction this script can ever send (CurveMath's
    // deployment) -- a guard placed after any deploy step would let a disallowed
    // bootstrap attempt get partway through before refusing.
    const firstTx = source.indexOf("CurveMath.deploy()");
    expect(firstTx, "sanity: the script must still deploy CurveMath").to.be.greaterThan(-1);
    expect(guard.index, "the allowlist guard must run before the first possible transaction")
      .to.be.lessThan(firstTx);

    // The refusal must read the PROVIDER's own reported chainId (net.chainId), not
    // hre.network.name or the network config -- a --network flag whose name says
    // "arcTestnet" while actually pointed at some other chain's RPC must still be
    // caught, in either direction (wrongly allowed OR wrongly refused).
    expect(source).to.include("const net = await hre.ethers.provider.getNetwork();");
    expect(guard.index).to.be.greaterThan(source.indexOf("const net = await hre.ethers.provider.getNetwork();"));
  });

  it("the guard is unconditional on BOOTSTRAP_ROUTER being set -- unset, no chainId matters to it", function () {
    // Negative control: prove the pattern above could NOT match a version of the
    // guard that fires regardless of BOOTSTRAP_ROUTER (which would incorrectly block
    // an ordinary, non-bootstrapping deploy on any chain not in the allowlist). If
    // this pattern matched, the first test's specific
    // "BOOTSTRAP_ROUTER && !...includes(...)" match would be satisfiable by a
    // vacuous, over-broad guard instead of the real one.
    const source = executableSource();
    const overBroad = source.match(
      /if\s*\(\s*!BOOTSTRAP_ALLOWED_CHAIN_IDS\.includes\(net\.chainId\)\s*\)\s*\{\s*throw new Error\(/
    );
    expect(overBroad, "the guard must not exist in a form unconditioned on BOOTSTRAP_ROUTER").to.equal(null);
  });

  // The four values the instruction named explicitly, checked by RUNNING the actual
  // allowlist array from the guard (parsed out of the real source, not retyped) --
  // so this fails if the array in the script ever drifts from what these rows claim,
  // rather than silently testing a copy of numbers that used to be true.
  describe("each named chainId, checked against the real allowlist in the script", function () {
    function realAllowedChainIds() {
      const source = executableSource();
      const match = source.match(/const BOOTSTRAP_ALLOWED_CHAIN_IDS = \[([^\]]+)\];/);
      expect(match, "BOOTSTRAP_ALLOWED_CHAIN_IDS array must exist as a real literal").not.to.equal(null);
      return match[1].split(",").map((s) => BigInt(s.trim().replace(/n$/, "")));
    }

    it("5042 (Arc mainnet) is refused", function () {
      expect(realAllowedChainIds().includes(5042n)).to.equal(false);
    });

    it("1 (Ethereum mainnet) is refused", function () {
      expect(realAllowedChainIds().includes(1n)).to.equal(false);
    });

    it("5042002 (Arc testnet) is allowed", function () {
      expect(realAllowedChainIds().includes(5042002n)).to.equal(true);
    });

    it("31337 (local Hardhat) is allowed", function () {
      expect(realAllowedChainIds().includes(31337n)).to.equal(true);
    });
  });

  it("BXR1_BOOTSTRAP_ROUTER is read once, feeds initialRouter, and is unset by default (address(0))", function () {
    const source = executableSource();
    expect(source).to.include('const BOOTSTRAP_ROUTER = process.env.BXR1_BOOTSTRAP_ROUTER;');
    expect(source).to.include("const initialRouter = BOOTSTRAP_ROUTER || ethers.ZeroAddress;");
    expect(source).to.include("BXR1.deploy(registryAddress, treasury, initialRouter)");
  });
});
