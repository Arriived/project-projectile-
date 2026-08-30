// Section 2 — your position.
//
// WHY THIS IS HIGH ON THE PAGE. MetaMask does not autodetect launched tokens, and Arc
// makes that worse than elsewhere: USDC is the gas token, so it IS the wallet's headline
// balance. After a buy the user watches that number go DOWN and sees nothing arrive. It
// does not read as "nothing happened", it reads as "my money left and I got nothing
// back". This section is the answer, and it is why it sits above price (rule 9 / trap 15).

import type { Address } from "viem";
import { useAccount } from "wagmi";
import type { TokenData } from "../../hooks/useCurve";
import { useBalances } from "../../hooks/useBalances";
import { useWatchAsset, symbolIsWatchable } from "../../hooks/useWatchAsset";
import { useChain } from "../../providers/ChainProvider";
import { safeText } from "../../lib/format";
import { useT } from "../../i18n";
import { arc } from "../../chain";
import { useFees } from "../../hooks/useFees";

export function YourPosition({ token, data }: { token: Address; data: TokenData }) {
  const { t, fmt } = useT();
  const { address, isConnected } = useAccount();
  const { guard } = useChain();
  const { maxFeePerGas } = useFees();
  const balances = useBalances(address, token, maxFeePerGas);
  const { watch, state } = useWatchAsset();

  const symbol = safeText(data.symbol, 24) || "tokens";

  if (!isConnected) {
    return (
      <section className="card position">
        <h2 className="card-title">{t("position.title")}</h2>
        <p className="hint">{t("position.connectPrompt")}</p>
      </section>
    );
  }

  const bal = balances.token18;

  return (
    <section className="card position">
      <h2 className="card-title">{t("position.title")}</h2>

      <div className="position-row">
        <div>
          <div className="position-balance">
            {bal === undefined ? "…" : fmt.token(bal)} <span className="position-sym">{symbol}</span>
          </div>
          <div className="hint">
            {balances.usdc6 === undefined
              ? ""
              : t("position.inWallet", { amount: fmt.usdc(balances.usdc6) })}
            {balances.availableToTrade6 !== undefined && (
              <>
                {" · "}
                {t("position.availableToTrade", {
                  amount: fmt.usdc(balances.availableToTrade6),
                })}
                <span className="hint"> ({t("position.gasReserveWithheld")})</span>
              </>
            )}
          </div>
        </div>

        <div className="position-actions">
          <button
            className="btn"
            disabled={state === "pending" || !symbolIsWatchable(data.symbol)}
            onClick={() => data.symbol && watch(token, data.symbol)}
            title={
              symbolIsWatchable(data.symbol)
                ? t("position.addToWalletHelp")
                : t("position.addToWalletTooLong")
            }
          >
            {state === "pending" ? t("common.checkYourWallet") : t("position.addToWallet")}
          </button>
          {/* A declined prompt is the user saying no to a convenience. It is NOT a
              failed trade and is never presented as an error. */}
          {state === "declined" && <span className="hint">{t("position.addDeclined")}</span>}
          {state === "added" && <span className="hint">{t("position.added")}</span>}
          {state === "unsupported" && (
            <span className="hint">{t("position.addUnsupported")}</span>
          )}
        </div>
      </div>

      {!guard.canTransact && (
        <p className="hint">{t("position.readFromChain", { chain: arc.name })}</p>
      )}
    </section>
  );
}
