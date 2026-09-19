require("@nomicfoundation/hardhat-ethers");
require("@nomicfoundation/hardhat-chai-matchers");
require("@nomicfoundation/hardhat-verify");
require("solidity-coverage");
require("dotenv").config();

// rpc.testnet.arc.io is the host Arc documents (/integrate/infrastructure, /arc-chain).
// rpc.testnet.arc.network also works -- every deployment through 0xEDeed1F0 used it -- and
// is kept here as a known-good alias, but it is undocumented and carries no guarantee.
// Both were tested against the live factory before switching: same chainId, same reads.
const ARC_TESTNET_RPC_URL = process.env.ARC_TESTNET_RPC_URL || "https://rpc.testnet.arc.io";
const ARC_TESTNET_RPC_ALIAS = "https://rpc.testnet.arc.network"; // working, undocumented

// ⚠ NAMED BLANKS FOR ARC MAINNET. Both are intentionally undefined until supplied.
//
// ARC_MAINNET_RPC_URL   -- from Circle directly (docs.arc.io / developers.circle.com) or a
//                          Circle-NAMED provider. Never from a search result.
// MAINNET_DEPLOYER_PRIVATE_KEY
//                       -- a DEDICATED key that signs nothing else, ever. The v4 stack
//                          deploys across three CONSECUTIVE nonces and the hook's mined
//                          salt embeds addresses predicted from them, so a single stray
//                          transaction from this key invalidates the salt and produces a
//                          stack that deploys cleanly and can never graduate. The existing
//                          testnet deployer is at nonce 237 and cannot be used.
const ARC_MAINNET_RPC_URL = process.env.ARC_MAINNET_RPC_URL || "";
const MAINNET_DEPLOYER_PRIVATE_KEY = process.env.MAINNET_DEPLOYER_PRIVATE_KEY || "";
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

// A SECOND fork, of Base, for exercising graduation against the REAL Uniswap V4.
// Opt-in via FORK_BASE=1, deliberately a DIFFERENT variable from FORK rather than a
// mode of it: the two fork suites want different chains, and each gates on its own
// variable, so FORK=1 still selects Ethereum + Fork.v2 and FORK_BASE=1 selects Base +
// Fork.v4 with neither able to run against the other's chain. Sharing one variable
// would have Fork.v2 look for Ethereum's V2 router on Base and report "fork did not
// take" -- a confusing failure that says nothing about what actually went wrong.
//
// Base rather than Arc because Arc mainnet does not exist yet (16 September) and v4 is
// live on Base today. Base also matches Arc's decimal ratio exactly -- 6dp USDC against
// an 18dp token -- so the 1e12 scale factor under test here is the real one.
//
// PINNED for the same reasons as FORK_BLOCK above. Verified at this height, live:
//   PoolManager     0x498581ff718922c3f8e6a244956af099b2652b2b   24,009 bytes
//   PositionManager 0x7c5f5a4bbd8fd63184577525326123b519429bdc   23,877 bytes
//   Permit2         0x000000000022D473030F116dDEE9F6B43aC78BA3    9,152 bytes
//   USDC            0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913    1,852 bytes, 6dp
//
// The default host is Base's own public endpoint, which does serve archive state at
// this height (measured). It rate-limits, so the FIRST run is slow while Hardhat fills
// its cache; set BASE_RPC_URL to a dedicated provider to avoid that. Note that an
// Alchemy key for eth-mainnet does NOT automatically cover Base -- the network has to
// be enabled on the app, and it is not by default.
const BASE_FORK_BLOCK = 50900000;
const BASE_RPC_URL = process.env.BASE_RPC_URL || "https://mainnet.base.org";

module.exports = {
  solidity: {
    version: "0.8.24",
    settings: { optimizer: { enabled: true, runs: 200 } },
  },
  networks: {
    hardhat: {
      forking: process.env.FORK_BASE
        ? { url: BASE_RPC_URL, blockNumber: BASE_FORK_BLOCK }
        : process.env.FORK
          ? { url: MAINNET_RPC_URL, blockNumber: FORK_BLOCK }
          : undefined,

      // Base fork only, and applied ONLY under FORK_BASE so that ordinary local runs
      // and the Ethereum fork keep the settings they were measured under.
      //
      // Two things are needed and neither is optional:
      //
      // hardfork: cancun -- v4-core keeps its lock, its currency deltas and its
      //   nonzero-delta count in TRANSIENT storage (Lock.sol, CurrencyDelta.sol,
      //   NonzeroDeltaCount.sol, CurrencyReserves.sol). tstore/tload do not exist
      //   before Cancun, so on an earlier hardfork every unlock reverts and the failure
      //   looks like an adapter bug rather than a node setting.
      //
      // chains.8453.hardforkHistory -- Hardhat ships activation histories for the
      //   chains it knows and refuses to execute at a historical block on one it does
      //   not ("No known hardfork for execution on historical block ... in chain with
      //   id 8453"). Base is post-Cancun well before the pinned block, so declaring
      //   cancun from 0 is accurate for every height this suite executes at.
      ...(process.env.FORK_BASE
        ? { hardfork: "cancun", chains: { 8453: { hardforkHistory: { cancun: 0 } } } }
        : {}),
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

    // ⚠ ARC MAINNET. THE CHAIN ID IS MEASURED; THE OTHER TWO VALUES ARE NAMED BLANKS.
    //
    // chainId 5042 is settled (CLAUDE.md 20.4): primary-sourced from circlefin/arc-node
    // and since MEASURED on the chain itself as 0x13b2. Three places in this file's
    // documentation still said UNSOURCED and are superseded there.
    //
    // ⚠ THE RPC URL MUST COME FROM CIRCLE DIRECTLY OR FROM A CIRCLE-NAMED PROVIDER.
    // Not from a search result, not from a chain-list aggregator, not from a model. That
    // is CLAUDE.md section 2's standing rule and it has already paid for itself: section
    // 9.5 found the documented testnet host is rpc.testnet.arc.io while an undocumented
    // .network alias also answers, and section 18.6 records Circle's own vendored skill
    // giving the alias. An RPC that answers is not evidence it is the right one.
    //
    // ⚠ AND THE EXPLORER TARGET IS UNSETTLED, NOT MERELY UNKNOWN. The etherscan block
    // below is configured for Blockscout because that is what Arc TESTNET runs. Uniswap's
    // own Arc playbook flags confirming whether Arcscan is Etherscan-compatible or
    // Blockscout BEFORE deploying, and Circle's contract-addresses page still says mainnet
    // addresses are not yet available. Treat the testnet shape as an assumption to be
    // checked, never as a mainnet fact -- a wrong verifier is discovered after the
    // bytecode is already immutable on chain.
    arcMainnet: {
      url: ARC_MAINNET_RPC_URL, // <-- BLANK. From Circle or a Circle-named provider only.
      chainId: 5042,
      accounts: MAINNET_DEPLOYER_PRIVATE_KEY ? [MAINNET_DEPLOYER_PRIVATE_KEY] : [],
    },
  },
  etherscan: {
    apiKey: {
      arcTestnet: "empty", // Blockscout doesn't require a real key, but the field must be non-empty
      // ⚠ UNSETTLED. If Arcscan turns out to be Etherscan-compatible rather than
      // Blockscout, this needs a real key and the urls below change shape. Confirm before
      // deploying, not after.
      arcMainnet: process.env.ARC_MAINNET_EXPLORER_KEY || "empty",
    },
    customChains: [
      {
        network: "arcTestnet",
        chainId: 5042002,
        urls: {
          // ⚠ testnet.arcscan.app now 301-redirects here (confirmed 19 September 2026);
          // hardhat-verify's POST doesn't follow that redirect and gets back an HTML
          // redirect page instead of JSON, so this points directly at the real host.
          apiURL: "https://explorer.testnet.arc.io/api",
          browserURL: "https://explorer.testnet.arc.io",
        },
      },
      // ⚠ ARC MAINNET VERIFICATION — SHAPE UNCONFIRMED, VALUES BLANK.
      //
      // The two URLs below mirror the TESTNET shape, which is Blockscout. That is an
      // ASSUMPTION carried across, not a mainnet fact:
      //   - Uniswap's own Arc playbook flags confirming whether Arcscan is
      //     Etherscan-compatible or Blockscout BEFORE deploying;
      //   - Circle's contract-addresses page still states mainnet addresses are not yet
      //     available, so there is no published mainnet explorer endpoint to copy.
      //
      // If it is Etherscan-compatible the apiURL shape and the key requirement both
      // change. Confirm from Circle or a Circle-named source and fill these in. Getting it
      // wrong is discovered only after the bytecode is immutable on chain, and an
      // unverified factory undermines the one thing this project sells.
      {
        network: "arcMainnet",
        chainId: 5042,
        urls: {
          apiURL: process.env.ARC_MAINNET_EXPLORER_API || "", // <-- BLANK
          browserURL: process.env.ARC_MAINNET_EXPLORER_URL || "", // <-- BLANK
        },
      },
    ],
  },
};
