// Live fee reading, refreshed, never cached into a constant.
//
// Rule 6: Arc's maximum base fee is 20,000 Gwei -- a THOUSAND times the 20 Gwei floor --
// so a reserve or a cost estimate computed from a quiet-period sample is wrong by up to
// 1000x exactly when the network is busy. The docs also say the parameters "may change
// before mainnet launch", so nothing here is hardcoded.
//
// ⚠ WHAT THIS VALUE IS FOR, AND WHAT IT IS NOT. This comment used to say the floor "is
// applied at chain level (chain.ts `fees.estimateFeesPerGas`), so every write inherits
// it without each call site remembering." That was false: viem 2.56.0's sendTransaction
// takes the `account?.type === 'json-rpc'` branch for every injected and WalletConnect
// account and never calls prepareTransactionRequest, so the chain override never runs
// for a wallet write. See chain.ts for the traced call path.
//
// The value below IS floored, because it comes from a public-client read where the
// override does run -- which is why the affordability and gas-reserve math were always
// correct even while transactions were not. To floor a TRANSACTION, pass this through
// `writeFees()` at the call site; it is the only thing that puts the floor on the wire.

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
