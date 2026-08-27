require("@nomicfoundation/hardhat-ethers");
require("@nomicfoundation/hardhat-chai-matchers");
require("@nomicfoundation/hardhat-verify");
require("solidity-coverage");
require("dotenv").config();

const ARC_TESTNET_RPC_URL = process.env.ARC_TESTNET_RPC_URL || "https://rpc.testnet.arc.network";
const DEPLOYER_PRIVATE_KEY = process.env.DEPLOYER_PRIVATE_KEY;
const MAINNET_RPC_URL = process.env.MAINNET_RPC_URL;

// Ethereum-mainnet fork, for exercising graduation against the REAL Uniswap V2 router.
// Opt-in via FORK=1 so ordinary runs stay local and fast -- forking every test would be
// slow and would pull Arc-specific settings (allowBlocksWithSameTimestamp) into a
// context where they mean nothing.
//
// PINNED, not `latest`: a moving head makes runs irreproducible and defeats Hardhat's
// state cache, which is what stops the suite hammering the endpoint.
//
// ⚠ A mainnet fork validates real Uniswap V2 and NOTHING about Arc. Arc's own docs say
// local EVM simulators "run a standard EVM, not Arc's" -- blocklist enforcement,
// EIP-7708 Transfer logs and the truncating 6dp balanceOf surface only on Arc RPC.
const FORK_BLOCK = 25846000;

module.exports = {
  solidity: {
    version: "0.8.24",
    settings: { optimizer: { enabled: true, runs: 200 } },
  },
  networks: {
    hardhat: {
      forking: process.env.FORK
        ? { url: MAINNET_RPC_URL, blockNumber: FORK_BLOCK }
        : undefined,
      // Arc targets 500ms blocks, so two consecutive blocks genuinely can carry the
      // same whole-second block.timestamp. The snipe tax decays in whole seconds, so
      // the tests have to be able to put several blocks inside one second the way the
      // real chain does -- and to exercise t=0 at all, which is the highest-tax case.
      allowBlocksWithSameTimestamp: true,
    },
    arcTestnet: {
      url: ARC_TESTNET_RPC_URL,
      chainId: 5042002,
      accounts: DEPLOYER_PRIVATE_KEY ? [DEPLOYER_PRIVATE_KEY] : [],
    },
  },
  etherscan: {
    apiKey: {
      arcTestnet: "empty", // Blockscout doesn't require a real key, but the field must be non-empty
    },
    customChains: [
      {
        network: "arcTestnet",
        chainId: 5042002,
        urls: {
          apiURL: "https://testnet.arcscan.app/api",
          browserURL: "https://testnet.arcscan.app",
        },
      },
    ],
  },
};
