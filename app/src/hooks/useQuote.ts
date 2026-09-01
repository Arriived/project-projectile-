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

/**
 * How long after creation the snipe tax is still decaying.
 *
 * The published table is `[9800, 9500, 9000, 8000, 6000, 4000, 2000, 0]`, indexed by
 * ELAPSED SECONDS. So the tax changes every second for seven seconds and is then flat
 * forever. `SNIPE_DECAY_SECONDS` is that table's length, plus a second of slack for
 * clock skew between the browser and the chain.
 */
export const SNIPE_DECAY_SECONDS = 9;

/** While the tax is decaying per second, a quote is stale in one second. */
export const QUOTE_POLL_HOT_MS = 1_000;

/**
 * Afterwards the curve only moves when someone trades, so there is nothing to poll FOR.
 * 30s is a liveness floor, not a freshness requirement -- the trade panel re-quotes
 * immediately before signing regardless (trap 6), so a slightly old displayed number can
 * never become a number the contract is asked to honour.
 */
export const QUOTE_POLL_COLD_MS = 30_000;

/**
 * The polling interval for a token created `ageSeconds` ago.
 *
 * ⚠ THE OLD FIXED 4s WAS WRONG IN BOTH DIRECTIONS AT ONCE, which is why this is a
 * function rather than a constant:
 *
 *   - TOO SLOW when it mattered. The tax decays every second for seven seconds; a 4s
 *     poll sampled that curve about twice and missed most of it -- during precisely the
 *     window the snipe tax exists to govern.
 *   - TOO FAST afterwards. A curve that nobody is trading does not change, so a quote
 *     every 4 seconds forever is ~15 RPC calls per minute per open page, bought for
 *     nothing.
 *
 * `undefined` age means "not known yet" and is treated as HOT: over-polling for one tick
 * is cheap, under-polling during the snipe window is the failure this exists to prevent.
 */
export function quotePollIntervalMs(ageSeconds: number | undefined): number {
  if (ageSeconds === undefined) return QUOTE_POLL_HOT_MS;
  return ageSeconds < SNIPE_DECAY_SECONDS ? QUOTE_POLL_HOT_MS : QUOTE_POLL_COLD_MS;
}

export function useQuote(
  token: Address | undefined,
  side: Side,
  amount: bigint,
  enabled = true,
  /** Seconds since this token was created. Drives the polling cadence; see above. */
  tokenAgeSeconds?: number
) {
  const client = usePublicClient({ chainId: arc.id });
  const interval = quotePollIntervalMs(tokenAgeSeconds);

  return useQuery({
    // The amount is IN THE KEY. That is what makes trap 7 structurally impossible rather
    // than merely unlikely.
    queryKey: ["quote", token, side, amount.toString()],
    enabled: enabled && !!token && !!client && amount > 0n,
    // Matches the poll: during the decay a quote is stale in a second; afterwards it is
    // only as stale as the last trade, and nothing here is ever signed without a fresh
    // re-quote (trap 6).
    staleTime: interval,
    refetchInterval: interval,
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
