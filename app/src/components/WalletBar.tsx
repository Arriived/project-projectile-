// Connect / disconnect / switch-chain.
//
// Two rules shape this component even at Phase 1:
//
//   - Browsing requires no wallet (FRONTEND_BUILD_V2 Part II). Nothing here gates the
//     page; the bar is a control, never a door.
//   - Wrong network must be detected and offered a one-click switch, with the chain
//     params prefilled (rule 8).
//
// Rejection handling is deliberate rather than incidental. REACT_REBUILD phase 6 says no
// path may leave the UI in a lying state when a prompt is rejected, and connect/switch
// are the two prompts that exist at this phase. A rejected switch must leave the UI
// saying "wrong network", not "switching...".

import { useAccount, useChainId, useConnect, useDisconnect, useSwitchChain } from "wagmi";
import { arc } from "../chain";

function short(addr: string) {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

export function WalletBar() {
  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  const { connect, connectors, isPending: connecting, error: connectError } = useConnect();
  const { disconnect } = useDisconnect();
  const {
    switchChain,
    isPending: switching,
    error: switchError,
  } = useSwitchChain();

  const onArc = chainId === arc.id;
  const injectedConnector = connectors[0];

  if (!isConnected) {
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

  return (
    <div className="wallet">
      {!onArc && (
        <div className="wrong-net">
          <span className="wrong-net-label">
            Wrong network (chain {chainId})
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

      <span className={`net-pill ${onArc ? "ok" : "bad"}`}>
        {onArc ? arc.name : `Chain ${chainId}`}
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
