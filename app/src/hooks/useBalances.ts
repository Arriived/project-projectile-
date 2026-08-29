// Wallet balances and the gas reserve.
//
// USDC is read through the ERC-20 interface at 0x3600...0000, 6 decimals -- NOT via
// wagmi's useBalance, which would report the 18-decimal native view of the same balance.
// They are one balance with two views (rule 3), and mixing them is trap 4 by another
// route: the same number rendered a trillion times too large.
//
// Balances are read, never inferred from events. Gas is deducted natively with no
// Transfer log, so any UI reconciling a balance from events drifts.

import { useReadContracts } from "wagmi";
import type { Address } from "viem";
import { erc20Abi } from "viem";
import { lfx1TokenAbi } from "../abi/lfx1Token";
import { USDC_ADDRESS, FACTORY_ADDRESS } from "../config";
import { arc } from "../chain";
import { availableToTrade6, GAS_RESERVE_UNITS, reserveCostWei } from "../lib/gas";

export type Balances = {
  /** USDC, 6dp, the tradable view. */
  usdc6: bigint | undefined;
  /** This launch token, 18dp. */
  token18: bigint | undefined;
  /** Allowance of the launch token to the factory -- the sell prerequisite. */
  tokenAllowance18: bigint | undefined;
  /** Allowance of USDC to the factory -- the buy prerequisite. */
  usdcAllowance6: bigint | undefined;
  /** Balance minus the gas reserve, floored at zero. */
  availableToTrade6: bigint | undefined;
  /** What the reserve costs right now, 18dp native. */
  reserveWei: bigint;
  reserveUnits: bigint;
  isLoading: boolean;
  refetch: () => void;
};

export function useBalances(
  account: Address | undefined,
  token: Address | undefined,
  maxFeePerGas: bigint | undefined
): Balances {
  const { data, isLoading, refetch } = useReadContracts({
    query: { enabled: !!account, refetchInterval: 8_000 },
    contracts: [
      {
        address: USDC_ADDRESS,
        abi: erc20Abi,
        chainId: arc.id,
        functionName: "balanceOf",
        args: [account as Address],
      },
      {
        address: USDC_ADDRESS,
        abi: erc20Abi,
        chainId: arc.id,
        functionName: "allowance",
        args: [account as Address, FACTORY_ADDRESS],
      },
      {
        address: token as Address,
        abi: lfx1TokenAbi,
        chainId: arc.id,
        functionName: "balanceOf",
        args: [account as Address],
      },
      {
        address: token as Address,
        abi: lfx1TokenAbi,
        chainId: arc.id,
        functionName: "allowance",
        args: [account as Address, FACTORY_ADDRESS],
      },
    ],
  });

  const ok = <T,>(i: number): T | undefined =>
    data?.[i]?.status === "success" ? (data[i].result as T) : undefined;

  const usdc6 = ok<bigint>(0);
  const fee = maxFeePerGas ?? 0n;

  return {
    usdc6,
    usdcAllowance6: ok<bigint>(1),
    token18: ok<bigint>(2),
    tokenAllowance18: ok<bigint>(3),
    availableToTrade6: usdc6 !== undefined && fee > 0n ? availableToTrade6(usdc6, fee) : undefined,
    reserveWei: reserveCostWei(fee),
    reserveUnits: GAS_RESERVE_UNITS,
    isLoading,
    refetch,
  };
}
