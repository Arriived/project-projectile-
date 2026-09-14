const { expect } = require("chai");
const fs = require("fs");
const path = require("path");

const DEPLOY = path.resolve(__dirname, "..", "scripts", "deploy-v4-stack.js");

// These checks inspect executable text only. Deployment-script comments explain the same
// invariants and must never be able to satisfy a guard check by themselves.
function executableSource() {
  return fs.readFileSync(DEPLOY, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");
}

describe("deploy-v4-stack hard stops", function () {
  it("D1 aborts when the provider chain differs from the selected Hardhat network", function () {
    const source = executableSource();
    const guard = source.match(
      /if\s*\(\s*net\.chainId\s*!==\s*BigInt\(configuredChainId\)\s*\)\s*\{\s*throw new Error\(/
    );
    expect(guard, "a mismatch must enter a throwing branch").not.to.equal(null);
    expect(source).to.include("const configuredChainId = hre.network.config && hre.network.config.chainId");
    expect(guard.index, "the chain guard must run before the first possible transaction")
      .to.be.lessThan(source.indexOf("deployer.sendTransaction"));
  });

  it("D2 re-reads and requires the predicted hook nonce immediately before CREATE2", function () {
    const source = executableSource();
    expect(source).to.match(
      /await requireNonce\(deployer, hookNonce, "hook CREATE2"\);\s*await \(await deployer\.sendTransaction\(\{/
    );
  });
});
