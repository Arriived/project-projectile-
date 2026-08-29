// React binding for the chain guard. The DECISION lives in lib/arcGuard.ts as a pure
// function; this file only gathers the two inputs it needs.
//
// Read lib/arcGuard.ts for why the guard exists at all -- short version: wagmi's
// `useChainId()` reads config state, not wallet state, and with a single-chain config the
// wrong-network branch was unreachable.
//
// Consumers must gate on `canTransact`, never on `isConnected`.

import { useEffect, useState } from "react";
import { useAccount } from "wagmi";
import { arc } from "../chain";
import { resolveArcGuard, type ArcGuard } from "../lib/arcGuard";

export type { ArcGuard };

type Eip1193 = {
  request: (a: { method: string }) => Promise<unknown>;
  on?: (e: string, f: (v: unknown) => void) => void;
  removeListener?: (e: string, f: (v: unknown) => void) => void;
};

export function useArcGuard(): ArcGuard {
  const { isConnected, chainId: accountChainId, connector } = useAccount();

  // Second, independent source: ask the provider itself. wagmi having surprised us once
  // about where chain state lives is reason enough not to trust a single reading of it.
  // This can only ever make the guard MORE restrictive.
  const [probed, setProbed] = useState<number | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    let provider: Eip1193 | undefined;

    const read = async () => {
      try {
        const hex = (await provider?.request({ method: "eth_chainId" })) as string | undefined;
        if (!cancelled) setProbed(hex ? Number.parseInt(hex, 16) : undefined);
      } catch {
        // A provider that will not answer is not a provider we can call Arc.
        if (!cancelled) setProbed(undefined);
      }
    };

    const onChainChanged = () => void read();

    (async () => {
      if (!isConnected || !connector) {
        if (!cancelled) setProbed(undefined);
        return;
      }
      try {
        provider = (await connector.getProvider()) as Eip1193 | undefined;
      } catch {
        if (!cancelled) setProbed(undefined);
        return;
      }
      await read();
      // Re-probe on chainChanged. wagmi listens too, but this hook must not depend on
      // wagmi's propagation being correct -- that assumption is exactly what broke.
      provider?.on?.("chainChanged", onChainChanged);
    })();

    return () => {
      cancelled = true;
      try {
        provider?.removeListener?.("chainChanged", onChainChanged);
      } catch {
        /* provider gone; nothing to detach */
      }
    };
  }, [isConnected, connector, accountChainId]);

  return resolveArcGuard({
    isConnected,
    accountChainId,
    probedChainId: probed,
    arcId: arc.id,
  });
}
