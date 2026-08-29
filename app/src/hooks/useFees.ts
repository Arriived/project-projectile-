// Live fee reading, refreshed, never cached into a constant.
//
// Rule 6: Arc's maximum base fee is 20,000 Gwei -- a THOUSAND times the 20 Gwei floor --
// so a reserve or a cost estimate computed from a quiet-period sample is wrong by up to
// 1000x exactly when the network is busy. The docs also say the parameters "may change
// before mainnet launch", so nothing here is hardcoded.
//
// The floor itself is applied at chain level (chain.ts `fees.estimateFeesPerGas`), so
// every write inherits it without each call site remembering.

import { useEstimateFeesPerGas } from "wagmi";
import { arc } from "../chain";

export function useFees() {
  const { data, isLoading } = useEstimateFeesPerGas({
    chainId: arc.id,
    query: { refetchInterval: 10_000 },
  });
  return {
    maxFeePerGas: data?.maxFeePerGas,
    maxPriorityFeePerGas: data?.maxPriorityFeePerGas,
    isLoading,
  };
}
