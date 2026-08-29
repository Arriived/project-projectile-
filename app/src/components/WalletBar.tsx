// Connect / disconnect / switch-chain.
//
// Chain state comes from useArcGuard(), NOT from wagmi's useChainId(). See the header of
// hooks/useArcGuard.ts for why -- useChainId() reads config state, which wagmi refuses to
// move to an unconfigured chain, making the wrong-network branch unreachable.
//
// Rules shaping this component:
//   - Browsing requires no wallet (FRONTEND_BUILD_V2 Part II). Nothing here gates the
//     page; the bar is a control, never a door.
//   - Wrong network is detected and offered a one-click switch (rule 8).
//   - A rejected prompt must never leave the UI in a lying state (REACT_REBUILD phase 6).

import { useAccount, useConnect, useDisconnect, useSwitchChain } from "wagmi";
import { arc } from "../chain";
import { useArcGuard } from "../hooks/useArcGuard";

function short(addr: string) {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

export function WalletBar() {
  const { address } = useAccount();
  const guard = useArcGuard();
  const { connect, connectors, isPending: connecting, error: connectError } = useConnect();
  const { disconnect } = useDisconnect();
  const { switchChain, isPending: switching, error: switchError } = useSwitchChain();

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

  const unusable = !guard.canTransact;

  return (
    <div className="wallet">
      {unusable && (
        <div className="wrong-net">
          <span className="wrong-net-label">
            {guard.status === "wrong"
              ? `Wrong network (chain ${guard.chainId})`
              : "Network unconfirmed"}
          </span>
          <button
            className="btn btn-warn"
            disabled={switching}
            onClick={() => switchChain({ chainId: arc.id })}
          >
            {switching ? "Check your wallet…" : `Switch to ${arc.name}`}
          </button>
          {switchError && (
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
