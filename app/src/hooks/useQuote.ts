// Live quotes from the contract, plus the price-impact probe.
//
// TRAP 1: there is no curve math here. `quoteBuy`/`quoteSell` are view functions on the
// contract; they apply the live snipe tax, the partial-fill clamp and current reserves,
// and cannot drift because they ARE the contract.
//
// TRAP 7 (async races): the query key includes the amount and the side, so a slow
// response for a superseded amount lands in a DIFFERENT cache entry from the one the
// component reads. It cannot overwrite a newer answer -- the stale result is simply never
// looked at. `placeholderData` keeps the previous number on screen while a new one loads
// so the panel does not flash empty, which is a display concern and not a correctness
// one: the value rendered is always the one keyed to the amount currently in the box.

import { useQuery } from "@tanstack/react-query";
import { usePublicClient } from "wagmi";
import type { Address } from "viem";
import { lfx1Abi } from "../abi/lfx1";
import { FACTORY_ADDRESS } from "../config";
import { arc } from "../chain";
import { IMPACT_PROBE_USDC6, impactPct, sellNetOut, type BuyQuote, type SellQuote } from "../lib/quotes";

export type Side = "buy" | "sell";

export type Quote = {
  side: Side;
  /** Tokens out for a buy (18dp); USDC NET out for a sell (6dp). */
  out: bigint;
  /** USDC actually taken for a buy (6dp); tokens actually taken for a sell (18dp). */
  actualIn: bigint;
  fee: bigint;
  /** True when the contract will take LESS than offered -- the partial-fill clamp. */
  clamped: boolean;
  /** Buy only. Null when it cannot be computed honestly -- never silently 0. */
  impact: number | null;
};

export function useQuote(
  token: Address | undefined,
  side: Side,
  amount: bigint,
  enabled = true
) {
  const client = usePublicClient({ chainId: arc.id });

  return useQuery({
    // The amount is IN THE KEY. That is what makes trap 7 structurally impossible rather
    // than merely unlikely.
    queryKey: ["quote", token, side, amount.toString()],
    enabled: enabled && !!token && !!client && amount > 0n,
    // Quotes go stale within a SECOND during the snipe window, where the tax decays per
    // second. Nothing here is cached beyond a moment, and the panel re-quotes
    // immediately before signing regardless (trap 6).
    staleTime: 1_000,
    refetchInterval: 4_000,
    placeholderData: (prev) => prev,
    queryFn: async (): Promise<Quote> => {
      const factory = { address: FACTORY_ADDRESS, abi: lfx1Abi } as const;

      if (side === "buy") {
        const q = (await client!.readContract({
          ...factory,
          functionName: "quoteBuy",
          args: [token as Address, amount],
        })) as unknown as BuyQuote;

        // The probe: a negligible trade's rate is the marginal rate. Compared against
        // this trade's rate, that is the impact. Never currentPrice() -- it evaluates to
        // the integer 2 at launch scale and would render 0.00% on a ~20% move.
        let impact: number | null = null;
        try {
          const probe = (await client!.readContract({
            ...factory,
            functionName: "quoteBuy",
            args: [token as Address, IMPACT_PROBE_USDC6],
          })) as unknown as BuyQuote;
          impact = impactPct(q.tokensOut, q.actualUsdcIn, probe.tokensOut, probe.actualUsdcIn);
        } catch {
          // A failed probe means we do not know the impact. It must stay null so the UI
          // says "unavailable" rather than printing a confident 0.00%.
          impact = null;
        }

        return {
          side,
          out: q.tokensOut,
          actualIn: q.actualUsdcIn,
          fee: q.actualFee,
          clamped: q.actualUsdcIn < amount,
          impact,
        };
      }

      const q = (await client!.readContract({
        ...factory,
        functionName: "quoteSell",
        args: [token as Address, amount],
      })) as unknown as SellQuote;

      return {
        side,
        // TRAP 2: sell() compares minUsdcOut against NET. Quoting gross would set an
        // unreachable floor and revert every sell.
        out: sellNetOut(q),
        actualIn: q.actualTokensIn,
        fee: q.fee,
        clamped: q.actualTokensIn < amount,
        impact: null,
      };
    },
  });
}
