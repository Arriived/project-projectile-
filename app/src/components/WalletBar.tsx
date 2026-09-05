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

import { useEffect, useState } from "react";
import { useAccount, useConnect, useConnectors, useDisconnect } from "wagmi";
import type { Connector } from "wagmi";
import { arc } from "../chain";
import { useChain } from "../providers/ChainProvider";
import {
  selectWallets,
  walletLabel,
  isGenericInjected,
  walletBadge,
  walletInitials,
  type WalletChoice,
} from "../lib/wallets";
import { classifySwitchFailure, chainIdHex } from "../lib/switchFailure";
import { useT } from "../i18n";

function short(addr: string) {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

/**
 * The wallet list, in a dialog rather than inline in the header.
 *
 * ⚠ THIS COMPONENT DOES NOT DECIDE WHAT IS OFFERED. It renders whatever `selectWallets`
 * returned. That separation is deliberate: the selection rule is the one that took four
 * rounds against a real wallet to get right, it is red-proved in verify:wallets, and it
 * must not acquire a second implementation here. If this list looks wrong, the bug is in
 * lib/wallets.ts, not in this file.
 */
function WalletPicker({
  wallets,
  allConnectors,
  connecting,
  pendingConnector,
  onPick,
  onClose,
}: {
  wallets: WalletChoice[];
  allConnectors: readonly Connector[];
  connecting: boolean;
  pendingConnector: Connector | undefined;
  onPick: (c: Connector) => void;
  onClose: () => void;
}) {
  const { t } = useT();

  // Escape closes. A modal that can only be dismissed by hitting a small × is a trap on
  // a phone, which is where this picker matters most (Part C).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal wallet-modal"
        role="dialog"
        aria-modal="true"
        aria-label={t("wallet.pickerTitle")}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-head">
          <h2 className="modal-title">{t("wallet.pickerTitle")}</h2>
          <button className="btn btn-ghost btn-tiny" onClick={onClose} aria-label={t("wallet.pickerClose")}>
            ✕
          </button>
        </div>

        <div className="wallet-list">
          {wallets.length === 0 && <p className="hint">{t("wallet.noWalletDetected")}</p>}
          {wallets.map((w) => {
            const live = allConnectors.find((c) => c.uid === w.uid);
            const pending = connecting && pendingConnector === live;
            return (
              <button
                key={w.uid}
                className="btn btn-wallet"
                disabled={connecting || !live}
                onClick={() => live && onPick(live)}
                title={
                  isGenericInjected(w)
                    ? t("wallet.genericWarning")
                    : t("wallet.connectsTo", { name: w.name })
                }
              >
                {/* An icon is wallet-supplied. EIP-6963 icons are data: URIs by spec, but
                    the field is only a string from an extension, so it is rendered through
                    <img src> and never injected as markup; a wallet with no usable icon
                    falls back to initials rather than to a broken image. */}
                {w.icon ? (
                  <img src={w.icon} alt="" className="wallet-icon" />
                ) : (
                  <span className="wallet-icon wallet-icon-fallback" aria-hidden>
                    {walletInitials(w.name)}
                  </span>
                )}
                <span className="wallet-name">
                  {pending ? t("common.checkYourWallet") : w.name}
                </span>
                {/* ⚠ DERIVED FROM EIP-6963 DISCOVERY, NEVER FROM THE NAME. "Installed"
                    means the extension announced itself and we hold ITS provider object.
                    The generic entry gets no such badge on purpose: something is at
                    window.ethereum but we cannot say WHICH wallet, and on a two-extension
                    machine Phantom usually wins that race. */}
                {!pending && (
                  <span className={`wallet-badge wallet-badge-${walletBadge(w)}`}>
                    {walletBadge(w) === "installed"
                      ? t("wallet.badgeInstalled")
                      : walletBadge(w) === "qr"
                        ? t("wallet.badgeQr")
                        : t("wallet.badgeUnknown")}
                  </span>
                )}
              </button>
            );
          })}
        </div>

        {/* Browsing needs no wallet. Saying so in the one place a user is most likely to
            think otherwise. */}
        <p className="hint modal-foot">{t("wallet.pickerHint")}</p>
      </div>
    </div>
  );
}

export function WalletBar() {
  const { t } = useT();
  const { address, connector } = useAccount();
  const { guard, switchToArc, switching, stuck, inAutoPrompt, switchError, sessionNamespace } =
    useChain();
  const { connect, isPending: connecting, error: connectError, variables } = useConnect();
  const { disconnect } = useDisconnect();
  const [pickerOpen, setPickerOpen] = useState(false);

  // Close on success. Without this the dialog stays over a now-connected header until the
  // user dismisses it, which reads as the connection not having worked -- the same class
  // of lying UI state the chain guard was fixed for.
  useEffect(() => {
    if (guard.status !== "disconnected") setPickerOpen(false);
  }, [guard.status]);

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
        {/* ONE button, opening a picker.

            Every discovered wallet used to render inline, which on a machine with two
            extensions put four buttons in the header -- Injected, WalletConnect, MetaMask,
            Phantom -- and made the count of installed extensions the width of the nav.
            That does not survive 390px (Part C) and it was never a deliberate design.

            THE SELECTION LOGIC IS UNCHANGED. `selectWallets` still decides what is
            offered, still keys suppression of the generic connector on `rdns`, and W10
            still holds: with nothing announced via EIP-6963 the generic connector is the
            only way in and must remain offered. This moved WHERE the list renders, not
            WHAT is in it. */}
        <button
          className="btn btn-primary"
          onClick={() => setPickerOpen(true)}
          disabled={connecting}
        >
          {connecting ? t("common.checkYourWallet") : t("wallet.connect")}
        </button>

        {pickerOpen && (
          <WalletPicker
            wallets={wallets}
            allConnectors={allConnectors}
            connecting={connecting}
            pendingConnector={
              typeof variables?.connector === "function" ? undefined : variables?.connector
            }
            onPick={(c) => connect({ connector: c })}
            onClose={() => setPickerOpen(false)}
          />
        )}

        {/* A rejected connection is a decision, not a fault. Say what happened and
            leave the button live. */}
        {connectError && (
          <span className="wallet-err" role="status">
            {connectError.name === "UserRejectedRequestError"
              ? t("wallet.connectionDeclined")
              : connectError.message.split("\n")[0]}
          </span>
        )}
      </div>
    );
  }

  const connectedWallet = connector
    ? walletLabel(
        {
          uid: connector.uid,
          id: connector.id,
          name: connector.name,
          rdns: (connector as { rdns?: string | readonly string[] }).rdns,
        },
        (name) => t("wallet.unidentifiedWallet", { name })
      )
    : t("wallet.notConnected");

  return (
    <div className="wallet">
      {/* While the automatic prompt is open the wrong chain is not yet a problem the user
          needs to see -- accepting resolves it. Show a neutral, truthful progress line
          rather than an alarm they are already in the middle of fixing. */}
      {inAutoPrompt ? (
        <span className="wrong-net-label" role="status">
          {t("chain.switching", { chain: arc.name, wallet: connectedWallet })}
        </span>
      ) : (
        !guard.canTransact && (
          <div className="wrong-net">
            <span className="wrong-net-label">
              {guard.status === "wrong"
                ? t("chain.wrongNetwork", { chainId: guard.chainId ?? "?" })
                : t("chain.unconfirmed")}
            </span>
            <button className="btn btn-warn" disabled={switching && !stuck} onClick={switchToArc}>
              {switching && !stuck ? t("common.checkYourWallet") : t("chain.switchTo", { chain: arc.name })}
            </button>
            {stuck && (
              <span className="wallet-err" role="status">
                {t("chain.switchStuck")}
              </span>
            )}
            {switchError && !stuck && (
              <span className="wallet-err" role="status">
                {/* ⚠ THE ERROR NAME IS NOT ENOUGH, AND TRUSTING IT COST A DEBUGGING
                    SESSION. wagmi rethrows every failure in the WalletConnect switch path
                    as UserRejectedRequestError, so a chain the wallet never offered was
                    reported as the user declining a prompt they never saw. The session's
                    approved chains are the only thing separating the two, which is why
                    classifySwitchFailure consults them FIRST. */}
                {(() => {
                  const why = classifySwitchFailure({
                    error: switchError,
                    namespace: sessionNamespace,
                    targetChainId: arc.id,
                  });
                  if (why.kind === "not-in-session") {
                    return t("chain.switchNotInSession", {
                      chain: arc.name,
                      target: String(why.target),
                      targetHex: chainIdHex(why.target),
                      offered: why.offered.join(", "),
                    });
                  }
                  if (why.kind === "declined") return t("chain.switchDeclined");
                  return switchError.message.split("\n")[0];
                })()}
              </span>
            )}
          </div>
        )
      )}

      {/* Naming the wallet is not decoration. It is how a user with two extensions knows
          which one this page is actually talking to. */}
      <span className="wallet-name" title={t("wallet.boundTo")}>
        {connector?.icon && <img src={connector.icon} alt="" className="wallet-icon" />}
        {connectedWallet}
      </span>

      <span className={`net-pill ${guard.canTransact ? "ok" : "bad"}`}>
        {guard.canTransact
          ? arc.name
          : guard.status === "wrong"
            ? t("chain.pillWrong", { chainId: guard.chainId ?? "?" })
            : t("chain.pillUnconfirmed")}
      </span>
      <span className="addr" title={address}>
        {address ? short(address) : ""}
      </span>
      <button className="btn btn-ghost" onClick={() => disconnect()}>
        {t("common.disconnect")}
      </button>
    </div>
  );
}
