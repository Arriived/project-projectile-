// What IS the token at 0x3600...0000 on Arc, really?
// R15 turns on whether Arc testnet USDC behaves like the mainnet Ethereum USDC token or
// merely presents the same interface. Answered by probing, not by assuming.
// Run: npx hardhat run scripts/probe-arc-usdc.js --network arcTestnet
const hre = require("hardhat");
const { ethers } = hre;

const USDC = "0x3600000000000000000000000000000000000000";

// Selectors present on Ethereum-mainnet FiatTokenV2_2 (the real USDC implementation).
const PROBES = [
  ["symbol()", "string"],
  ["name()", "string"],
  ["decimals()", "uint8"],
  ["totalSupply()", "uint256"],
  ["version()", "string"],
  ["currency()", "string"],
  ["paused()", "bool"],
  ["blacklister()", "address"],
  ["masterMinter()", "address"],
  ["owner()", "address"],
  ["pauser()", "address"],
  ["rescuer()", "address"],
  ["DOMAIN_SEPARATOR()", "bytes32"],
];

async function main() {
  const p = ethers.provider;
  const code = await p.getCode(USDC);
  console.log(`address   ${USDC}`);
  console.log(`code size ${(code.length - 2) / 2} bytes  ${code === "0x" ? "<-- NO CODE: precompile / native-backed, not a deployed ERC-20" : ""}`);

  const iface = ethers.Interface.from(PROBES.map(([sig]) => `function ${sig} view returns (${PROBES.find(x => x[0] === sig)[1]})`));
  for (const [sig, type] of PROBES) {
    const data = iface.encodeFunctionData(sig.replace("()", ""), []);
    try {
      const raw = await p.call({ to: USDC, data });
      if (raw === "0x") { console.log(`  ${sig.padEnd(20)} -> empty return (absent)`); continue; }
      const [v] = ethers.AbiCoder.defaultAbiCoder().decode([type], raw);
      console.log(`  ${sig.padEnd(20)} -> ${v}`);
    } catch (e) {
      console.log(`  ${sig.padEnd(20)} -> REVERT/absent (${String(e.shortMessage || e.message).slice(0, 50)})`);
    }
  }

  // isBlacklisted(address) with a throwaway address.
  const bl = new ethers.Interface(["function isBlacklisted(address) view returns (bool)"]);
  try {
    const raw = await p.call({ to: USDC, data: bl.encodeFunctionData("isBlacklisted", [ethers.ZeroAddress]) });
    console.log(`  isBlacklisted(0)     -> ${raw === "0x" ? "empty return (absent)" : bl.decodeFunctionResult("isBlacklisted", raw)[0]}`);
  } catch (e) {
    console.log(`  isBlacklisted(0)     -> REVERT/absent`);
  }

  // The one-balance question: does the ERC-20 view equal the native balance / 1e12?
  const [signer] = await ethers.getSigners();
  const native = await p.getBalance(signer.address);
  const erc = new ethers.Interface(["function balanceOf(address) view returns (uint256)"]);
  const raw = await p.call({ to: USDC, data: erc.encodeFunctionData("balanceOf", [signer.address]) });
  const erc20bal = erc.decodeFunctionResult("balanceOf", raw)[0];
  console.log(`\n-- one-balance check --`);
  console.log(`  native (18dp)  ${native}`);
  console.log(`  erc20  ( 6dp)  ${erc20bal}`);
  console.log(`  native/1e12    ${native / 10n ** 12n}`);
  console.log(`  truncation matches: ${native / 10n ** 12n === erc20bal}`);
  console.log(`  sub-6dp dust carried: ${native % 10n ** 12n}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
