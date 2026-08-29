// The Arc chain definition.
//
// FRONTEND_BUILD_V2 rule 8 and REACT_REBUILD 0.1 both single this file out as the
// highest-risk config in the build, for one reason: getting `nativeCurrency.decimals`
// wrong misprices gas by 10^12 and DOES NOT THROW. It renders a confident wrong number.
//
// Every field below is sourced. Verified 29 August 2026.

import { arcTestnet as viemArcTestnet } from "viem/chains";
import { getBlock } from "viem/actions";
import type { Chain } from "viem";

/**
 * Arc's protocol-enforced minimum base fee.
 *
 * Source: docs.arc.io /arc/references/gas-and-fees --
 *   "Set `maxFeePerGas` to at least 20 Gwei. Transactions submitted below this floor
 *    may remain pending indefinitely or fail outright."
 *
 * Pending indefinitely is the bad outcome, not failing: a transaction that fails tells
 * the user something. One that hangs forever does not.
 */
export const MIN_BASE_FEE_WEI = 20_000_000_000n; // 20 Gwei

/**
 * The ceiling, kept here because it is the number that makes a gas reserve hard.
 * Source: same page -- "Maximum base fee: 20,000 Gwei ... Hard ceiling that bounds
 * worst-case cost". That is 1000x the floor, so a reserve sized from the floor is wrong
 * by up to 1000x exactly when the network is busy (rule 6).
 */
export const MAX_BASE_FEE_WEI = 20_000_000_000_000n; // 20,000 Gwei

/**
 * Priority tip. Source: same page -- "A value of 0 Gwei is accepted, but a small tip
 * (for example, 1 Gwei) can improve inclusion time during high-utilization periods."
 */
export const PRIORITY_FEE_WEI = 1_000_000_000n; // 1 Gwei

/**
 * viem ships `arcTestnet` and it is correct on the field that matters --
 * `nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 }`, which matches Arc's
 * own EIP-3085 parameters at /integrate/wallets/add-arc-to-a-wallet verbatim.
 *
 * Its `contracts.multicall3` claim was verified rather than trusted: the canonical
 * address holds 3808 bytes of code on Arc testnet, so wagmi's batched reads work.
 *
 * Two things are overridden, and nothing else.
 */
export const arc: Chain = {
  ...viemArcTestnet,

  // 1. RPC host. viem ships `rpc.testnet.arc.network`, which works but is undocumented.
  //    Arc documents `rpc.testnet.arc.io` (/integrate/infrastructure, /arc-chain, and the
  //    gas-and-fees code samples). Both answer eth_chainId with 0x4cef52; prefer the
  //    documented one, because an undocumented alias carries no compatibility promise.
  rpcUrls: {
    default: {
      http: ["https://rpc.testnet.arc.io"],
      webSocket: ["wss://rpc.testnet.arc.io"],
    },
  },

  // 2. Fee estimation, floored.
  //
  //    Measured 29 August 2026: viem's default returns maxFeePerGas 29 Gwei against a
  //    chain base fee sitting at exactly 20 Gwei -- above the floor, and above it
  //    STRUCTURALLY, because Arc enforces the floor on the base fee itself and viem's
  //    default multiplier (1.2) is >= 1, so the product cannot sink below it.
  //
  //    The floor is pinned anyway, for two reasons. Arc's docs say the parameters
  //    "reflect the current Arc Testnet configuration" and "may change before mainnet
  //    launch" -- so the structural argument rests on a value that is documented as
  //    movable. And pinning it here applies it ONCE, to every write in the app, rather
  //    than at each call site where one omission is silent.
  fees: {
    async estimateFeesPerGas({ block, client, multiply }) {
      const b = block ?? (await getBlock(client));
      const base = b.baseFeePerGas ?? 0n;

      // multiply() applies the chain's baseFeeMultiplier (1.2 by default).
      const estimated = multiply(base) + PRIORITY_FEE_WEI;
      const floor = MIN_BASE_FEE_WEI + PRIORITY_FEE_WEI;

      return {
        maxFeePerGas: estimated < floor ? floor : estimated,
        maxPriorityFeePerGas: PRIORITY_FEE_WEI,
      };
    },
  },
};

/**
 * Chain id as hex, for `wallet_addEthereumChain`.
 *
 * DERIVED, never transcribed. FRONTEND_BUILD_V2 rule 8 carried `0x4CEDB2` as a literal
 * for an unknown length of time -- that is 5041586, which is 416 chains away from Arc,
 * and it sat in the one code path that value is used for. A hex literal in a source file
 * is a number nothing checks; this expression cannot disagree with `arc.id`.
 */
export const ARC_CHAIN_ID_HEX = `0x${arc.id.toString(16)}` as const;

/**
 * USDC's two faces, which are ONE balance.
 *
 * Native (gas) accounting is 18 decimals; the ERC-20 interface at 0x3600...0000 reports
 * 6. Source: /arc/references/contract-addresses -- "the native USDC gas token uses 18
 * decimals of precision, while the USDC ERC-20 interface uses 6 decimals. Avoid mixing
 * these values directly."
 *
 * Note Arc's docs contradict themselves on the native figure: /integrate/on-off-ramps
 * says 6 where four other pages say 18. Filed with the docs team 29 August 2026. We use
 * 18, matching the EIP-3085 sample and viem.
 */
export const USDC_NATIVE_DECIMALS = 18;
export const USDC_ERC20_DECIMALS = 6;

/**
 * Launch tokens are plain OpenZeppelin ERC20 with no decimals() override, so 18.
 * Read off two live tokens on chain, not inferred from the source.
 *
 * This constant exists to be imported rather than typed. "USDC is 6 decimals" is a
 * standing rule in CLAUDE.md and `6` is scattered through the old frontend; passing 6
 * where 18 belongs renders a balance a trillion times too large (rule 9, trap 4).
 */
export const LAUNCH_TOKEN_DECIMALS = 18;
