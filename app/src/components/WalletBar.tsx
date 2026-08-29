// Connect / disconnect / switch-chain, and WHICH wallet is connected.
//
// The wallet is named throughout, deliberately. With two extensions installed "connected"
// is not enough information: the address and chain a user sees in one extension may not
// be the ones this page is bound to, and that ambiguity is exactly what produced the
// contested-provider bug (lib/wallets.ts).
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

import { useAccount, useConnect, useConnectors, useDisconnect } from "wagmi";
import { arc } from "../chain";
import { useChain } from "../providers/ChainProvider";
import { selectWallets, walletLabel, isGenericInjected } from "../lib/wallets";

function short(addr: string) {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

export function WalletBar() {
  const { address, connector } = useAccount();
  const { guard, switchToArc, switching, stuck, inAutoPrompt, switchError } = useChain();
  const { connect, isPending: connecting, error: connectError, variables } = useConnect();
  const { disconnect } = useDisconnect();

  // useConnectors is the REACTIVE list: EIP-6963 wallets announce asynchronously after
  // page load, so a snapshot taken once would miss whichever extension is slower.
  const allConnectors = useConnectors();
  const wallets = selectWallets(
    allConnectors.map((c) => ({
      uid: c.uid,
      id: c.id,
      name: c.name,
      icon: c.icon,
      rdns: (c as { rdns?: string | readonly string[] }).rdns,
    }))
  );

  if (guard.status === "disconnected") {
    return (
      <div className="wallet">
        <div className="wallet-picker">
          {wallets.length === 0 && (
            <span className="wallet-err">No wallet extension detected.</span>
          )}
          {wallets.map((w) => {
            const live = allConnectors.find((c) => c.uid === w.uid);
            const pending = connecting && variables?.connector === live;
            return (
              <button
                key={w.uid}
                className="btn btn-wallet"
                disabled={connecting || !live}
                onClick={() => live && connect({ connector: live })}
                title={
                  isGenericInjected(w)
                    ? "No wallet announced itself; this connects to window.ethereum"
                    : `Connects specifically to ${w.name}`
                }
              >
                {w.icon && <img src={w.icon} alt="" className="wallet-icon" />}
                {pending ? "Check your wallet…" : w.name}
              </button>
            );
          })}
        </div>
        {/* A rejected connection is a decision, not a fault. Say what happened and
            leave the buttons live. */}
        {connectError && (
          <span className="wallet-err" role="status">
            {connectError.name === "UserRejectedRequestError"
              ? "Connection declined."
              : connectError.message.split("\n")[0]}
          </span>
        )}
      </div>
    );
  }

  const connectedWallet = connector
    ? walletLabel({
        uid: connector.uid,
        id: connector.id,
        name: connector.name,
        rdns: (connector as { rdns?: string | readonly string[] }).rdns,
      })
    : "Unknown wallet";

  return (
    <div className="wallet">
      {/* While the automatic prompt is open the wrong chain is not yet a problem the user
          needs to see -- accepting resolves it. Show a neutral, truthful progress line
          rather than an alarm they are already in the middle of fixing. */}
      {inAutoPrompt ? (
        <span className="wrong-net-label" role="status">
          Switching to {arc.name} — confirm in {connectedWallet}…
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

      {/* Naming the wallet is not decoration. It is how a user with two extensions knows
          which one this page is actually talking to. */}
      <span className="wallet-name" title="The wallet this page is bound to">
        {connector?.icon && <img src={connector.icon} alt="" className="wallet-icon" />}
        {connectedWallet}
      </span>

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
