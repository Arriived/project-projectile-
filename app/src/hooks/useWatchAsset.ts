// "Add to wallet" — rule 9 / trap 15.
//
// MetaMask autodetection covers a fixed list of networks and Arc is not on it, so a token
// launched thirty seconds ago never appears by itself. On Arc that is worse than
// elsewhere: USDC is the gas token, so it IS the wallet's headline balance. After a buy
// the user watches that number go DOWN and sees nothing arrive. It does not read as
// "nothing happened", it reads as "my money left and I got nothing back".
//
// DECIMALS ARE 18, not 6. Read off two live launch tokens; LFX1Token is OpenZeppelin
// ERC20 with no override. The trap is that this codebase drills the opposite number --
// pass 6 and MetaMask renders the balance a trillion times too large.

import { useCallback, useState } from "react";
import { useAccount } from "wagmi";
import type { Address } from "viem";
import { LAUNCH_TOKEN_DECIMALS } from "../chain";

/** MetaMask's enforced maximum (MetaMask/core PR #433, raised from 6). */
export const MAX_WATCHABLE_SYMBOL_LENGTH = 11;

export type WatchState = "idle" | "pending" | "added" | "declined" | "unsupported";

export function useWatchAsset() {
  const { connector } = useAccount();
  const [state, setState] = useState<WatchState>("idle");

  const watch = useCallback(
    async (token: Address, symbol: string) => {
      setState("pending");
      try {
        const provider = (await connector?.getProvider()) as
          | { request: (a: { method: string; params: unknown }) => Promise<unknown> }
          | undefined;
        if (!provider) {
          setState("unsupported");
          return;
        }
        const added = await provider.request({
          method: "wallet_watchAsset",
          params: {
            type: "ERC20",
            options: {
              address: token,
              symbol: symbol.slice(0, MAX_WATCHABLE_SYMBOL_LENGTH),
              decimals: LAUNCH_TOKEN_DECIMALS,
            },
          },
        });
        // The return value is NOT a source of truth (MetaMask/core #880 -- its behaviour
        // when the token is already tracked is unspecified). Treated as a hint for the
        // label only; nothing is gated on it.
        setState(added === false ? "declined" : "added");
      } catch {
        // A rejection is the user declining a convenience. It is NOT a failed trade and
        // must never be surfaced as one -- their tokens are unaffected either way.
        setState("declined");
      }
    },
    [connector]
  );

  return { watch, state };
}

/**
 * Can this symbol be one-click-added at all?
 *
 * `createToken` validates nothing -- no length check, no emptiness check -- so a creator
 * can launch a symbol no buyer can add. Every testnet symbol so far is 7 characters, so
 * this will not surface in testing; the first failure will be a real creator with a long
 * ticker.
 */
export function symbolIsWatchable(symbol: string | undefined): boolean {
  return !!symbol && symbol.length > 0 && symbol.length <= MAX_WATCHABLE_SYMBOL_LENGTH;
}
