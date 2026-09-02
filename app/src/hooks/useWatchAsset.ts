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

/**
 * ⚠ "failed" IS DISTINCT FROM "declined" AND THE DISTINCTION IS THE WHOLE POINT.
 *
 * declined = the user pressed reject (EIP-1193 code 4001). Their choice, no action needed.
 * failed   = MetaMask refused what WE sent, or the provider was unreachable. Our bug.
 *
 * Collapsing these is what hid a real failure on a real wallet: a token was bought, the
 * balance dropped, nothing arrived, and the UI said the same quiet thing it says when
 * someone simply clicks no.
 */
export type WatchState = "idle" | "pending" | "added" | "declined" | "failed" | "unsupported";

/**
 * What actually happened on the last attempt, for diagnosis.
 *
 * ⚠ THIS EXISTS BECAUSE THE ORIGINAL `catch {}` MADE THE BUG UNDIAGNOSABLE. It swallowed
 * every error and set "declined", so three completely different failures -- the user
 * saying no, MetaMask REFUSING the params, and the provider not being reachable at all --
 * all rendered as the same quiet grey line. Reported on a real wallet: a buy landed, the
 * USDC balance dropped, and the token never appeared, with nothing anywhere saying why.
 *
 * An error we swallow is a bug we cannot see.
 */
export type WatchAttempt = {
  /** Exactly what was sent, so it can be compared against MetaMask's requirements. */
  params: unknown;
  /** The provider actually used -- with two extensions installed this is the question. */
  providerInfo: string;
  /** Raw resolve value. MetaMask returns `true`/`false`; not a source of truth. */
  resolved?: unknown;
  /** Present only when the promise REJECTED. `code` distinguishes 4001 from the rest. */
  rejected?: { code?: number | string; message: string };
  outcome: WatchState;
};

export function useWatchAsset() {
  const { connector } = useAccount();
  const [state, setState] = useState<WatchState>("idle");
  const [attempt, setAttempt] = useState<WatchAttempt | null>(null);

  const watch = useCallback(
    async (token: Address, symbol: string) => {
      setState("pending");

      // Built before the try so it can be reported even when the request throws.
      const params = {
        type: "ERC20",
        options: {
          address: token,
          symbol: symbol.slice(0, MAX_WATCHABLE_SYMBOL_LENGTH),
          // 18, not 6. LFX1Token is stock OpenZeppelin ERC20. Passing 6 -- the USDC
          // number this codebase uses everywhere else -- renders the balance 1e12x too
          // large rather than failing, which is why it is pinned to a named constant.
          decimals: LAUNCH_TOKEN_DECIMALS,
        },
      };

      let providerInfo = "none";
      try {
        const provider = (await connector?.getProvider()) as
          | { request: (a: { method: string; params: unknown }) => Promise<unknown> }
          | undefined;

        providerInfo = provider
          ? `${connector?.name ?? "?"} (${connector?.id ?? "?"})`
          : `NO PROVIDER from connector ${connector?.id ?? "none"}`;

        if (!provider) {
          setState("unsupported");
          setAttempt({ params, providerInfo, outcome: "unsupported" });
          return;
        }

        const resolved = await provider.request({ method: "wallet_watchAsset", params });

        // The return value is NOT a source of truth (MetaMask/core #880 -- its behaviour
        // when the token is already tracked is unspecified). Treated as a hint for the
        // label only; nothing is gated on it.
        const outcome: WatchState = resolved === false ? "declined" : "added";
        setState(outcome);
        setAttempt({ params, providerInfo, resolved, outcome });
      } catch (e) {
        // 4001 is EIP-1193's "user rejected request" -- a genuine decline, and not an
        // error worth alarming about: their tokens are unaffected either way.
        //
        // ANYTHING ELSE IS OUR BUG, NOT THEIR CHOICE. -32602 (invalid params) in
        // particular means MetaMask refused what we sent, and reporting that as
        // "declined" is how this went unnoticed.
        const err = e as { code?: number | string; message?: string };
        const declined = err?.code === 4001;
        const outcome: WatchState = declined ? "declined" : "failed";
        setState(outcome);
        setAttempt({
          params,
          providerInfo,
          rejected: { code: err?.code, message: err?.message ?? String(e) },
          outcome,
        });
      }
    },
    [connector]
  );

  return { watch, state, attempt };
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
