// Single owner of chain state and the chain-switch action.
//
// WHY A PROVIDER RATHER THAN A HOOK PER COMPONENT. useArcGuard polls the wallet, and
// useSwitchChain owns a mutation. Calling either from two components gives two pollers
// and two independent mutations -- which for the automatic prompt would mean two wallet
// popups for one connect. Everything that needs chain state reads it from here, so there
// is exactly one poller and exactly one in-flight switch.
//
// Consumers gate on `guard.canTransact`, never on `isConnected`.

import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { useAccount, useSwitchChain } from "wagmi";
import type { Eip155Namespace } from "../lib/switchFailure";
import { arc } from "../chain";
import { useArcGuard, type ArcGuard } from "../hooks/useArcGuard";
import { shouldAutoPromptSwitch } from "../lib/arcGuard";

/**
 * How long a switch may sit "pending" before the UI is handed back to the user.
 *
 * wagmi's `switchChain` CAN HANG FOREVER: its injected-connector implementation awaits a
 * `change` event alongside the RPC call, so a wallet that RESOLVES
 * `wallet_switchEthereumChain` without actually switching -- and therefore emits nothing
 * -- leaves the mutation permanently pending. Reproduced: the button stayed disabled on
 * "Check your wallet…" until a page reload.
 *
 * The guard is never fooled by this (it keeps reporting the real chain), so it is a dead
 * end rather than a safety hole. It is still a lie: there is no prompt to check.
 *
 * Trade-off: a user slower than this gets the button back while their prompt is still
 * open and may fire a second one. Switching is idempotent, so a duplicate prompt is
 * untidy; a permanently dead button is worse.
 */
const SWITCH_STUCK_AFTER_MS = 20_000;

type ChainState = {
  guard: ArcGuard;
  switchToArc: () => void;
  switching: boolean;
  /** The pending switch has outlived SWITCH_STUCK_AFTER_MS and is presumed abandoned. */
  stuck: boolean;
  /** An automatic on-connect prompt is open. Callers should stay quiet, not alarm. */
  inAutoPrompt: boolean;
  switchError: Error | null;
  /**
   * The `eip155` namespace of the WalletConnect session, when there is one.
   *
   * ⚠ Read so a failed switch can be classified honestly. wagmi rethrows a namespace miss
   * as `UserRejectedRequestError`, so the error alone cannot tell "the user said no" from
   * "the wallet never offered this chain" -- only the approved chain list can. `undefined`
   * for injected wallets, which keeps them on the pre-existing behaviour.
   */
  sessionNamespace: Eip155Namespace | undefined;
};

const Ctx = createContext<ChainState | null>(null);

export function ChainProvider({ children }: { children: ReactNode }) {
  const { address, connector } = useAccount();
  const guard = useArcGuard();
  const { switchChain, isPending: switching, error: switchError } = useSwitchChain();

  // ── The WalletConnect session's approved chains ───────────────────────────────
  //
  // Read once per connection, off the connector's own provider. Injected providers have no
  // `.session`, so this stays undefined for them and nothing downstream changes.
  const [sessionNamespace, setSessionNamespace] = useState<Eip155Namespace | undefined>(undefined);
  useEffect(() => {
    let alive = true;
    (async () => {
      if (!connector) {
        if (alive) setSessionNamespace(undefined);
        return;
      }
      try {
        const provider = (await connector.getProvider()) as {
          session?: { namespaces?: Record<string, Eip155Namespace> };
        } | undefined;
        if (!alive) return;
        setSessionNamespace(provider?.session?.namespaces?.eip155);
      } catch {
        // A provider that will not answer tells us nothing about the session. Undefined
        // means "cannot say", which falls back to the error name rather than guessing.
        if (alive) setSessionNamespace(undefined);
      }
    })();
    return () => {
      alive = false;
    };
  }, [connector, address]);

  const startedAt = useRef<number | undefined>(undefined);
  const [, setTick] = useState(0);

  // Identity of the current connection. The automatic prompt is once per connection, and
  // this is what "once" is measured against.
  const connectionKey = connector && address ? `${connector.uid}:${address}` : undefined;
  const promptedKey = useRef<string | null>(null);
  const [autoPrompting, setAutoPrompting] = useState(false);

  useEffect(() => {
    if (switching && startedAt.current === undefined) startedAt.current = Date.now();
    if (!switching) startedAt.current = undefined;
  }, [switching]);

  // Re-render while a switch is pending so the stuck threshold is actually reached rather
  // than waiting on some unrelated render.
  useEffect(() => {
    if (!switching) return;
    const t = setInterval(() => setTick((n) => n + 1), 1_000);
    return () => clearInterval(t);
  }, [switching]);

  const stuck =
    switching &&
    startedAt.current !== undefined &&
    Date.now() - startedAt.current > SWITCH_STUCK_AFTER_MS;

  const run = (auto: boolean) => {
    startedAt.current = Date.now();
    if (auto) setAutoPrompting(true);
    switchChain(
      { chainId: arc.id },
      {
        // Re-read after the attempt, whichever way it reports. A LATENCY optimisation,
        // not the safety property: this cannot turn the UI green. Only an observed,
        // FRESH eth_chainId equal to Arc yields `ok`, so a switch that claims success
        // without happening stays refused -- and if the mutation never settles, this
        // never runs and the poller covers it anyway.
        onSettled: () => {
          if (auto) setAutoPrompting(false);
          guard.reverify();
        },
      }
    );
  };

  // ── The automatic prompt on connect ─────────────────────────────────────────
  //
  // Fires only once the guard has POSITIVELY established the wrong chain -- never on
  // `unknown`, which is the ordinary state for a moment after connect while the first
  // probe is in flight. Prompting there would open a wallet popup because of our own
  // latency, at a user who may already be on Arc.
  //
  // The key is marked BEFORE calling, so neither a re-render nor StrictMode's
  // double-invoked effect can raise a second popup. After a rejection we do not try
  // again -- one prompt, then the user chooses.
  useEffect(() => {
    if (
      shouldAutoPromptSwitch({
        status: guard.status,
        connectionKey,
        lastPromptedKey: promptedKey.current,
        isSwitching: switching,
      })
    ) {
      promptedKey.current = connectionKey ?? null;
      run(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [guard.status, connectionKey, switching]);

  // Disconnecting ends the connection, so a later reconnect earns a fresh prompt. That is
  // the user initiating, not us retrying after a rejection.
  useEffect(() => {
    if (guard.status === "disconnected") {
      promptedKey.current = null;
      setAutoPrompting(false);
    }
  }, [guard.status]);

  // `stuck` bounds the quiet period: if the automatic prompt hangs, the alarm returns
  // rather than the neutral line standing forever.
  const inAutoPrompt = autoPrompting && switching && !stuck;

  return (
    <Ctx.Provider
      value={{
        guard,
        switchToArc: () => run(false),
        switching,
        stuck,
        inAutoPrompt,
        switchError: switchError ?? null,
        sessionNamespace,
      }}
    >
      {children}
    </Ctx.Provider>
  );
}

export function useChain(): ChainState {
  const v = useContext(Ctx);
  if (!v) throw new Error("useChain must be used inside <ChainProvider>");
  return v;
}
