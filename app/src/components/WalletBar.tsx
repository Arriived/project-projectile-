// Connect / disconnect / switch-chain.
//
// Chain state comes from useArcGuard(), NOT from wagmi's useChainId(), and the guard
// polls rather than trusting an event. See lib/arcGuard.ts for the two fail-open bugs
// that shaped it.
//
// Rules:
//   - Browsing requires no wallet (FRONTEND_BUILD_V2 Part II). The bar is a control,
//     never a door.
//   - Wrong network is detected and offered a one-click switch (rule 8).
//   - No rejected or abandoned prompt may leave the UI in a lying state
//     (REACT_REBUILD phase 6).

import { useEffect, useRef, useState } from "react";
import { useAccount, useConnect, useDisconnect, useSwitchChain } from "wagmi";
import { arc } from "../chain";
import { useArcGuard } from "../hooks/useArcGuard";

/**
 * How long a switch may sit "pending" before the button is handed back to the user.
 *
 * wagmi's `switchChain` CAN HANG FOREVER. Its injected-connector implementation awaits a
 * `change` event alongside the RPC call, so a wallet that RESOLVES
 * `wallet_switchEthereumChain` without actually switching -- and therefore emits nothing
 * -- leaves the mutation permanently pending. Reproduced: the button stayed disabled on
 * "Check your wallet…" indefinitely, and only a page reload cleared it.
 *
 * The guard was never fooled (it kept reporting the real chain), so this is a dead end
 * rather than a safety hole. It is still a lie: there is no prompt to check.
 *
 * Trade-off: a user slower than this gets the button back while their prompt is still
 * open, and may fire a second one. Switching is idempotent, so a duplicate prompt is
 * untidy; a permanently dead button is worse.
 */
const SWITCH_STUCK_AFTER_MS = 20_000;

function short(addr: string) {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

export function WalletBar() {
  const { address } = useAccount();
  const guard = useArcGuard();
  const { connect, connectors, isPending: connecting, error: connectError } = useConnect();
  const { disconnect } = useDisconnect();
  const { switchChain, isPending: switching, error: switchError } = useSwitchChain();

  const startedAt = useRef<number | undefined>(undefined);
  const [, setTick] = useState(0);

  useEffect(() => {
    if (switching && startedAt.current === undefined) startedAt.current = Date.now();
    if (!switching) startedAt.current = undefined;
  }, [switching]);

  // Re-render while a switch is pending so the stuck threshold is actually reached
  // rather than waiting for some unrelated render.
  useEffect(() => {
    if (!switching) return;
    const t = setInterval(() => setTick((n) => n + 1), 1_000);
    return () => clearInterval(t);
  }, [switching]);

  const stuck =
    switching &&
    startedAt.current !== undefined &&
    Date.now() - startedAt.current > SWITCH_STUCK_AFTER_MS;

  const injectedConnector = connectors[0];

  if (guard.status === "disconnected") {
    return (
      <div className="wallet">
        <button
          className="btn"
          disabled={connecting || !injectedConnector}
          onClick={() => injectedConnector && connect({ connector: injectedConnector })}
        >
          {connecting ? "Check your wallet…" : "Connect wallet"}
        </button>
        {/* A rejected connection is a decision, not a fault. Say what happened and
            leave the button live. */}
        {connectError && (
          <span className="wallet-err" role="status">
            {connectError.name === "UserRejectedRequestError"
              ? "Connection declined."
              : connectError.message.split("\n")[0]}
          </span>
        )}
        {!injectedConnector && (
          <span className="wallet-err">No injected wallet detected.</span>
        )}
      </div>
    );
  }

  const doSwitch = () => {
    startedAt.current = Date.now();
    switchChain(
      { chainId: arc.id },
      {
        // Re-read the chain after the attempt, whichever way it reports. This is a
        // LATENCY optimisation, not the safety property: the handler cannot turn the UI
        // green by calling it. Only an observed, FRESH eth_chainId equal to Arc yields
        // `ok`, so a switch that claims success without happening stays refused -- and
        // if the mutation never settles, this callback never runs and the poller covers
        // it anyway.
        onSettled: () => guard.reverify(),
      }
    );
  };

  return (
    <div className="wallet">
      {!guard.canTransact && (
        <div className="wrong-net">
          <span className="wrong-net-label">
            {guard.status === "wrong"
              ? `Wrong network (chain ${guard.chainId})`
              : "Network unconfirmed"}
          </span>
          <button className="btn btn-warn" disabled={switching && !stuck} onClick={doSwitch}>
            {switching && !stuck ? "Check your wallet…" : `Switch to ${arc.name}`}
          </button>
          {stuck && (
            <span className="wallet-err" role="status">
              That didn’t complete — still on the wrong network. Try again.
            </span>
          )}
          {switchError && !stuck && (
            <span className="wallet-err" role="status">
              {switchError.name === "UserRejectedRequestError"
                ? "Network switch declined — still on the wrong network."
                : switchError.message.split("\n")[0]}
            </span>
          )}
        </div>
      )}

      <span className={`net-pill ${guard.canTransact ? "ok" : "bad"}`}>
        {guard.canTransact
          ? arc.name
          : guard.status === "wrong"
            ? `Chain ${guard.chainId}`
            : "Unconfirmed"}
      </span>
      <span className="addr" title={address}>
        {address ? short(address) : ""}
      </span>
      <button className="btn btn-ghost" onClick={() => disconnect()}>
        Disconnect
      </button>
    </div>
  );
}
