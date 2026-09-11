// React binding for the chain guard. The DECISION lives in lib/arcGuard.ts as a pure
// function; this file's only job is to keep a FRESH reading of the wallet's chain.
//
// Read lib/arcGuard.ts for both bugs this exists to prevent. The short version of the
// second one, which shapes this file: probing once and then waiting for a `chainChanged`
// event left the app green and transactable indefinitely after a chain change that
// emitted no event. So this hook does not rely on being told. It asks, repeatedly.
//
// Three triggers, deliberately overlapping:
//   - an interval, which is the one that is not allowed to fail
//   - `chainChanged`, kept only as a fast path so detection feels instant
//   - window focus, because switching networks means leaving and returning to the tab,
//     and background tabs get their timers throttled
//
// Consumers must gate on `canTransact`, never on `isConnected`.

import { useCallback, useEffect, useRef, useState } from "react";
import { useAccount } from "wagmi";
import { arc } from "../chain";
import { resolveArcGuard, normaliseChainId, MAX_PROBE_AGE_MS, type ArcGuard } from "../lib/arcGuard";

export type { ArcGuard };

/**
 * Well inside MAX_PROBE_AGE_MS, so a healthy poller never lets a reading go stale. This
 * is one `eth_chainId` to the injected provider -- an in-process call to the extension,
 * not a network round trip, and not our rate-limited RPC.
 */
const POLL_INTERVAL_MS = 3_000;

type Eip1193 = {
  request: (a: { method: string }) => Promise<unknown>;
  on?: (e: string, f: (v: unknown) => void) => void;
  removeListener?: (e: string, f: (v: unknown) => void) => void;
};

export function useArcGuard(): ArcGuard & { reverify: () => void } {
  const { isConnected, chainId: accountChainId, connector } = useAccount();

  const [probe, setProbe] = useState<{ chainId: number | undefined; at: number | undefined }>({
    chainId: undefined,
    at: undefined,
  });

  // Re-render on a timer so a reading going stale flips the UI even when nothing else
  // changes. Without this a stale probe would sit unnoticed until the next event.
  const [, setTick] = useState(0);

  const providerRef = useRef<Eip1193 | undefined>(undefined);
  const aliveRef = useRef(true);

  const readChain = useCallback(async () => {
    const provider = providerRef.current;
    if (!provider) {
      if (aliveRef.current) setProbe({ chainId: undefined, at: undefined });
      return;
    }
    try {
      // ⚠ `unknown`, deliberately, and NOT `string`. EIP-695 says this returns a hex
      // QUANTITY and injected wallets do; WalletConnect returns a NUMBER. Typing it as a
      // string is what let `Number.parseInt(hex, 16)` coerce 5042002 back to "5042002",
      // read it as hex, and produce 84156418 -- see BUG 3 in lib/arcGuard.ts. Every
      // interpretation of this value happens in normaliseChainId and nowhere else.
      const raw: unknown = await provider.request({ method: "eth_chainId" });
      if (!aliveRef.current) return;
      // A successful read is stamped even when it disagrees -- `at` records when we last
      // KNEW something, not when we last liked the answer. An UNREADABLE answer is not a
      // successful read: normaliseChainId returns undefined and the guard refuses.
      setProbe({ chainId: normaliseChainId(raw), at: Date.now() });
    } catch {
      // A provider that will not answer is not a provider we can call Arc. Clearing `at`
      // is what makes this fail closed rather than leaving the last good reading standing.
      if (aliveRef.current) setProbe({ chainId: undefined, at: undefined });
    }
  }, []);

  useEffect(() => {
    aliveRef.current = true;
    let interval: ReturnType<typeof setInterval> | undefined;
    let staleTicker: ReturnType<typeof setInterval> | undefined;
    let detach: (() => void) | undefined;

    const onChainChanged = () => void readChain();
    const onFocus = () => void readChain();

    (async () => {
      if (!isConnected || !connector) {
        providerRef.current = undefined;
        if (aliveRef.current) setProbe({ chainId: undefined, at: undefined });
        return;
      }
      try {
        providerRef.current = (await connector.getProvider()) as Eip1193 | undefined;
      } catch {
        providerRef.current = undefined;
        if (aliveRef.current) setProbe({ chainId: undefined, at: undefined });
        return;
      }
      // The effect may already have been torn down while getProvider() was in flight.
      if (!aliveRef.current) return;

      await readChain();

      const provider = providerRef.current;
      provider?.on?.("chainChanged", onChainChanged);
      window.addEventListener("focus", onFocus);
      detach = () => {
        try {
          provider?.removeListener?.("chainChanged", onChainChanged);
        } catch {
          /* provider gone */
        }
        window.removeEventListener("focus", onFocus);
      };

      interval = setInterval(() => void readChain(), POLL_INTERVAL_MS);
      // Independent of the poll: re-render so staleness itself is visible promptly.
      staleTicker = setInterval(() => setTick((t) => t + 1), 2_000);
    })();

    return () => {
      aliveRef.current = false;
      if (interval) clearInterval(interval);
      if (staleTicker) clearInterval(staleTicker);
      detach?.();
    };
  }, [isConnected, connector, accountChainId, readChain]);

  const guard = resolveArcGuard({
    isConnected,
    accountChainId,
    probedChainId: probe.chainId,
    probedAt: probe.at,
    now: Date.now(),
    arcId: arc.id,
    maxProbeAgeMs: MAX_PROBE_AGE_MS,
  });

  // Exposed so a switch attempt can ask for an immediate reading. It is a latency
  // optimisation ONLY -- the switch handler cannot make the UI usable by calling it,
  // because only an observed, fresh Arc reading yields `ok`.
  return { ...guard, reverify: () => void readChain() };
}
