// Connect / disconnect / switch-chain.
//
// Chain state comes from the ChainProvider, which owns the single guard and the single
// switch mutation. See lib/arcGuard.ts for the fail-open bugs that shaped the guard.
//
// Rules:
//   - Browsing requires no wallet (FRONTEND_BUILD_V2 Part II). The bar is a control,
//     never a door.
//   - Wrong network is detected and offered a one-click switch (rule 8), raised
//     automatically once on connect so an accepting user never sees the error state.
//   - No rejected or abandoned prompt may leave the UI in a lying state
//     (REACT_REBUILD phase 6).

import { useAccount, useConnect, useDisconnect } from "wagmi";
import { arc } from "../chain";
import { useChain } from "../providers/ChainProvider";

function short(addr: string) {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

export function WalletBar() {
  const { address } = useAccount();
  const { guard, switchToArc, switching, stuck, inAutoPrompt, switchError } = useChain();
  const { connect, connectors, isPending: connecting, error: connectError } = useConnect();
  const { disconnect } = useDisconnect();

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

  return (
    <div className="wallet">
      {/* While the automatic prompt is open the wrong chain is not yet a problem the user
          needs to see -- accepting resolves it. Show a neutral, truthful progress line
          rather than an alarm they are already in the middle of fixing. */}
      {inAutoPrompt ? (
        <span className="wrong-net-label" role="status">
          Switching to {arc.name} — confirm in your wallet…
        </span>
      ) : (
        !guard.canTransact && (
          <div className="wrong-net">
            <span className="wrong-net-label">
              {guard.status === "wrong"
                ? `Wrong network (chain ${guard.chainId})`
                : "Network unconfirmed"}
            </span>
            <button className="btn btn-warn" disabled={switching && !stuck} onClick={switchToArc}>
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
        )
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
