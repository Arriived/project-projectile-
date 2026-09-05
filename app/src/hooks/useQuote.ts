// Live quotes from the contract, plus the price-impact probe.
//
// TRAP 1: there is no curve math here. `quoteBuy`/`quoteSell` are view functions on the
// contract; they apply the live snipe tax, the partial-fill clamp and current reserves,
// and cannot drift because they ARE the contract.
//
// TRAP 7 (async races): the query key includes the amount, the side AND the curve
// fingerprint, so a slow response for a superseded amount -- or for a curve that has
// since moved -- lands in a DIFFERENT cache entry from the one the component reads. It
// cannot overwrite a newer answer; the stale result is simply never looked at.
//
// ⚠ `placeholderData` is CONDITIONAL, and the condition is the point (CLAUDE.md §12.2).
// It carries the previous figure forward while the amount changes, so the panel does not
// flash empty on every keystroke or poll -- but it DROPS that figure the moment the
// fingerprint changes, because at that point the number is not merely old, it is wrong.
// A figure that is known-wrong is never shown; a figure with no reason to be doubted is.

import { useQuery } from "@tanstack/react-query";
import { usePublicClient } from "wagmi";
import type { Address } from "viem";
import { lfx1Abi } from "../abi/lfx1";
import { FACTORY_ADDRESS } from "../config";
import { arc } from "../chain";
import {
  IMPACT_PROBE_USDC6,
  IMPACT_PROBE_TOKENS18,
  impactPct,
  sellNetOut,
  quoteQueryKey,
  carryForwardQuote,
  quotePollIntervalMs,
  type BuyQuote,
  type SellQuote,
  type Side,
} from "../lib/quotes";

// ⚠ THE CACHE-KEY AND CARRY-FORWARD LOGIC LIVES IN lib/quotes.ts, NOT HERE.
//
// It is the decision CLAUDE.md §12.2 turns on, so it has to be reachable by a check --
// and this file imports the ABI, wagmi and viem, none of which resolve under
// `node --experimental-strip-types`. Every verify script in this project imports from
// lib/ for exactly that reason. Pure logic that must be proved goes in lib/; hooks stay
// thin enough to be obviously correct by inspection.
export {
  quoteQueryKey,
  carryForwardQuote,
  QUOTE_KEY_FINGERPRINT_INDEX,
  curveQuoteFingerprint,
  quotePollIntervalMs,
  SNIPE_DECAY_SECONDS,
  QUOTE_POLL_HOT_MS,
  QUOTE_POLL_COLD_MS,
} from "../lib/quotes";
export type { Side } from "../lib/quotes";

export type Quote = {
  side: Side;
  /** Tokens out for a buy (18dp); USDC NET out for a sell (6dp). */
  out: bigint;
  /** USDC actually taken for a buy (6dp); tokens actually taken for a sell (18dp). */
  actualIn: bigint;
  fee: bigint;
  /** True when the contract will take LESS than offered -- the partial-fill clamp. */
  clamped: boolean;
  /** Both sides. Null when it cannot be computed honestly -- never silently 0. */
  impact: number | null;
};

export function useQuote(
  token: Address | undefined,
  side: Side,
  amount: bigint,
  enabled = true,
  /** Seconds since this token was created. Drives the polling cadence; see above. */
  tokenAgeSeconds?: number,
  /**
   * `curveQuoteFingerprint(...)` for the curve being quoted. See lib/quotes.ts.
   *
   * ⚠ IT IS IN THE QUERY KEY ON PURPOSE. That is what makes a superseded quote
   * unreachable rather than merely unlikely: when the curve moves, the key moves with
   * it, so the old answer is in a DIFFERENT cache entry and the component reading the
   * new key cannot see it. Same structural trick trap 7 already uses for the amount.
   *
   * Defaulted so an omitted argument degrades to the old always-one-key behaviour
   * rather than to a key of `undefined` that silently collides across curves.
   */
  curveFingerprint = "curve:unpinned"
) {
  const client = usePublicClient({ chainId: arc.id });
  const interval = quotePollIntervalMs(tokenAgeSeconds);

  return useQuery({
    // The amount is IN THE KEY. That is what makes trap 7 structurally impossible rather
    // than merely unlikely. The curve fingerprint is in it for the same reason -- see the
    // parameter doc above and CLAUDE.md §12.2.
    queryKey: quoteQueryKey(token, side, amount, curveFingerprint),
    enabled: enabled && !!token && !!client && amount > 0n,
    // Matches the poll: during the decay a quote is stale in a second; afterwards it is
    // only as stale as the last trade, and nothing here is ever signed without a fresh
    // re-quote (trap 6).
    staleTime: interval,
    refetchInterval: interval,
    // ⚠ THE WHOLE POINT: carry a figure forward only while it is merely OLD, never once
    // it is known WRONG.
    //
    // Two different in-flight states used to be one:
    //
    //   UNKNOWN-STALE   the amount changed, or the poll ticked, but nothing says the
    //                   curve moved. The previous number is probably still right. Keep
    //                   it, dimmed and marked (see Figure), because blanking to "—" on
    //                   every refresh flickers the panel once a second during the snipe
    //                   window and teaches people to ignore it.
    //
    //   KNOWN-STALE     the fingerprint changed, so the reserves, state or tax that
    //                   produced that number are gone. The figure is not old, it is
    //                   WRONG. Drop it and show "—" until the real answer lands.
    //
    // Returning `undefined` is what produces the dash: the component renders "—" when
    // there is no quote. This is the fix for the confident-wrong-number half of §12.2.
    placeholderData: (prev, prevQuery) =>
      carryForwardQuote(prev, prevQuery?.queryKey, curveFingerprint),
    // Superseded entries are dead the moment the curve moves; on a busy curve a new key
    // is minted per trade. Collect them promptly rather than holding five minutes of
    // them (TanStack's default) for figures nothing can ever render again.
    gcTime: 60_000,
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

      // ⚠ THE SELL SIDE COMPUTES IMPACT TOO. It used to hardcode `impact: null`, so a
      // seller saw no impact figure at any size -- and selling moves the price DOWN
      // against them by exactly the same mechanism a buy moves it up. A large sell into a
      // thin curve is precisely when someone needs the warning, and it was the one case
      // that never got it.
      //
      // Same probe method as the buy (CLAUDE.md §1.3): compare this trade's rate against
      // a negligible trade's rate. Rates are USDC-per-token here rather than
      // tokens-per-USDC, so the arguments mirror the buy call -- output first, input
      // second -- and impactPct's PRICE MOVE convention is unchanged.
      let impact: number | null = null;
      try {
        const probe = (await client!.readContract({
          ...factory,
          functionName: "quoteSell",
          args: [token as Address, IMPACT_PROBE_TOKENS18],
        })) as unknown as SellQuote;
        if (probe.actualTokensIn > 0n && q.actualTokensIn > 0n) {
          impact = impactPct(
            sellNetOut(q),
            q.actualTokensIn,
            sellNetOut(probe),
            probe.actualTokensIn
          );
        }
      } catch {
        // A failed probe means we do not KNOW the impact. Null, never 0 -- a confident
        // zero on a trade that moves the price 20% is the worst available answer.
        impact = null;
      }

      return {
        side,
        // TRAP 2: sell() compares minUsdcOut against NET. Quoting gross would set an
        // unreachable floor and revert every sell.
        out: sellNetOut(q),
        actualIn: q.actualTokensIn,
        fee: q.fee,
        clamped: q.actualTokensIn < amount,
        impact,
      };
    },
  });
}
