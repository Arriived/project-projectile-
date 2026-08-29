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
import { fmtToken, fmtUsdc, safeText } from "../../lib/format";
import { useFees } from "../../hooks/useFees";

export function YourPosition({ token, data }: { token: Address; data: TokenData }) {
  const { address, isConnected } = useAccount();
  const { guard } = useChain();
  const { maxFeePerGas } = useFees();
  const balances = useBalances(address, token, maxFeePerGas);
  const { watch, state } = useWatchAsset();

  const symbol = safeText(data.symbol, 24) || "tokens";

  if (!isConnected) {
    return (
      <section className="card position">
        <h2 className="card-title">Your position</h2>
        <p className="hint">
          Connect a wallet to see your balance of this token. Browsing needs no wallet.
        </p>
      </section>
    );
  }

  const bal = balances.token18;

  return (
    <section className="card position">
      <h2 className="card-title">Your position</h2>

      <div className="position-row">
        <div>
          <div className="position-balance">
            {bal === undefined ? "…" : fmtToken(bal)} <span className="position-sym">{symbol}</span>
          </div>
          <div className="hint">
            {balances.usdc6 === undefined
              ? ""
              : `${fmtUsdc(balances.usdc6)} USDC in wallet`}
            {balances.availableToTrade6 !== undefined && (
              <>
                {" · "}
                {fmtUsdc(balances.availableToTrade6)} available to trade
                <span className="hint"> (gas reserve withheld)</span>
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
                ? "Adds this token to your wallet so the balance is visible there"
                : "This symbol is too long for wallets to add in one click"
            }
          >
            {state === "pending" ? "Check your wallet…" : "Add to wallet"}
          </button>
          {/* A declined prompt is the user saying no to a convenience. It is NOT a
              failed trade and is never presented as an error. */}
          {state === "declined" && <span className="hint">Not added — your balance is unaffected.</span>}
          {state === "added" && <span className="hint">Added.</span>}
          {state === "unsupported" && (
            <span className="hint">Your wallet doesn’t support one-click adding — use the address above.</span>
          )}
        </div>
      </div>

      {!guard.canTransact && (
        <p className="hint">
          Balances are read from Arc directly, so they are correct even while your wallet
          is on another network.
        </p>
      )}
    </section>
  );
}
