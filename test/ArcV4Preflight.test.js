const { expect } = require("chai");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const parser = require("@solidity-parser/parser");
const ethers = require("ethers");

const ROOT = path.resolve(__dirname, "..");
const PREFLIGHT = path.join(ROOT, "scripts/arc-v4-preflight.js");
const read = (file) => fs.readFileSync(path.join(ROOT, file), "utf8");
const ast = (file) => parser.parse(read(file));
const abi = (file) => new ethers.Interface(JSON.parse(read(file)).abi);

function calls(tree, receiver) {
  const found = [];
  parser.visit(tree, {
    FunctionCall(node) {
      const member = node.expression;
      if (member.type === "MemberAccess" &&
          member.expression.type === "Identifier" &&
          member.expression.name === receiver) {
        found.push({ name: member.memberName, args: node.arguments });
      }
    },
  });
  return found;
}

// Parse live executable source, not comments or every declaration in IV4Minimal.
// Artifacts supply canonical ABI signatures (including initialize's PoolKey tuple).
function requiredFromAdapter() {
  const adapter = ast("contracts/BallistaV4Adapter.sol");
  const interfaces = {
    permit2: abi("artifacts/contracts/interfaces/IV4Minimal.sol/IPermit2Allowance.json"),
    poolm: abi("artifacts/@uniswap/v4-core/src/interfaces/IPoolManager.sol/IPoolManager.json"),
    posm: abi("artifacts/contracts/interfaces/IV4Minimal.sol/IV4PositionManager.json"),
  };
  const result = {};
  for (const [key, receiver] of Object.entries({
    permit2: "permit2", poolm: "poolManager", posm: "positionManager",
  })) {
    const signatures = calls(adapter, receiver).map((call) => {
      if (key === "poolm" && call.name === "getSlot0") {
        const library = ast("node_modules/@uniswap/v4-core/src/libraries/StateLibrary.sol");
        const functions = [];
        parser.visit(library, {
          FunctionDefinition(node) { if (node.name === "getSlot0") functions.push(node); },
        });
        expect(functions, "one getSlot0 implementation").to.have.length(1);
        const external = calls(functions[0], "manager");
        expect(external, "getSlot0 has one external call").to.have.length(1);
        expect(external[0].name).to.equal("extsload");
        expect(external[0].args).to.have.length(1);
        const slot = external[0].args[0];
        expect(slot.type).to.equal("Identifier");
        const declarations = [];
        parser.visit(functions[0], {
          VariableDeclaration(node) { if (node.name === slot.name) declarations.push(node); },
        });
        expect(declarations, "extsload slot declaration").to.have.length(1);
        expect(declarations[0].typeName.name).to.equal("bytes32");
        return interfaces.poolm.getFunction("extsload(bytes32)").format("sighash");
      }
      const fragment = interfaces[key].getFunction(call.name);
      expect(fragment.inputs.length, receiver + "." + call.name + " argument count")
        .to.equal(call.args.length);
      return fragment.format("sighash");
    });
    result[key] = [...new Set(signatures)].sort().map((signature) => [
      ethers.id(signature).slice(0, 10), signature,
    ]);
    expect(result[key], receiver + " must have calls").not.to.be.empty;
  }
  return result;
}

function loadPreflight(expected, omit = {}) {
  const addresses = {
    permit2: "0x000000000022d473030f116ddee9f6b43ac78ba3",
    poolm: "0x8366a39cc670b4001a1121b8f6a443a643e40951",
    posm: "0x6049c9a0e26405c0985f9e3685c87d0ae917f82b",
  };
  const codes = new Map([
    ["0x3600000000000000000000000000000000000000", "0x6000"],
    ["0xedeed1f05d34421add0f59b7340588ab2bbac04b", "0x6000"],
    ["0xca11bde05977b3631167028862be2a173976ca11", "0x6000"],
  ]);
  for (const [key, address] of Object.entries(addresses)) {
    const selectors = expected[key].filter(([selector]) =>
      !(omit.target === key && omit.selector === selector));
    codes.set(address, omit.target === key && omit.noCode
      ? "0x" : "0x6000" + selectors.map(([selector]) => selector.slice(2)).join(""));
  }
  const logs = [];
  const provider = {
    getNetwork: async () => ({ chainId: 5042002n }),
    getBlockNumber: async () => 100,
    getCode: async (address) => codes.get(address.toLowerCase()) || "0x",
    getBlock: async (number) => ({ number, gasLimit: 30000000n, gasUsed: 0n }),
  };
  const runtime = {
    network: { name: "offline-testnet-fixture" },
    ethers: {
      ...ethers, provider,
      Contract: class { async allowance() { return [0n, 0n, 0n]; } },
    },
  };
  const sandbox = {
    module: { exports: {} },
    require: (name) => {
      if (name !== "hardhat") throw new Error("unexpected import " + name);
      return runtime;
    },
    console: { log: (line) => logs.push(String(line)), error: (line) => logs.push(String(line)) },
    process: { exit: () => { throw new Error("unexpected process.exit"); } },
  };
  vm.runInNewContext(fs.readFileSync(PREFLIGHT, "utf8"), sandbox, { filename: PREFLIGHT });
  return { ...sandbox.module.exports, logs };
}

describe("Arc v4 preflight", function () {
  this.timeout(20000);

  it("P1 required selectors exactly match the adapter's executable infrastructure calls", function () {
    const expected = requiredFromAdapter();
    const { SELECTORS } = loadPreflight(expected);
    const actual = Object.fromEntries(Object.entries(SELECTORS).map(([target, rows]) =>
      [target, JSON.parse(JSON.stringify(rows)).sort((a, b) => a[1].localeCompare(b[1]))]));
    // Native sort on signatures avoids locale-dependent ordering in expected.
    for (const rows of Object.values(actual)) rows.sort((a, b) => a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0);
    expect(actual).to.deep.equal(expected);
  });

  it("P2 main probes every required selector against its actual target", async function () {
    const expected = requiredFromAdapter();
    const fixture = loadPreflight(expected);
    await fixture.main();
    const names = { permit2: "Permit2", poolm: "PoolManager", posm: "PositionManager" };
    for (const [target, rows] of Object.entries(expected)) {
      for (const [selector, signature] of rows) {
        const row = names[target].padEnd(16) + " " + selector + " PRESENT  " + signature;
        expect(fixture.logs.some((line) => line.includes(row)), row).to.equal(true);
      }
    }
  });

  it("P3 main aborts for each absent required selector and each codeless target", async function () {
    const expected = requiredFromAdapter();
    for (const [target, rows] of Object.entries(expected)) {
      const omissions = [...rows.map(([selector]) => ({ target, selector })), { target, noCode: true }];
      for (const omit of omissions) {
        const fixture = loadPreflight(expected, omit);
        let error;
        try { await fixture.main(); } catch (caught) { error = caught; }
        expect(error && error.message, JSON.stringify(omit)).to.include("required selector preflight FAILED");
      }
    }
  });
});
