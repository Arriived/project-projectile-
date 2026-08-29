// Section 4 — the trade panel. Traps 1-10 all live here.
//
// The rules this enforces, each with its reason:
//   1  quotes come from quoteBuy/quoteSell. No curve math in this file, ever.
//   2  a sell quote is NET (gross - fee); minUsdcOut compares against net.
//   3  price impact from the probe quote, as a HEADLINE number, never currentPrice().
//   5  minOut is never zero and comes from the quote's own output.
//   6  re-quote immediately before signing; report the RECEIPT, not the quote.
//   8  gated on the curve state enum, not a boolean.
//   9  gas reserve visible; "available to trade" is balance minus reserve.
//  10  affordability by arithmetic, never by parsing a revert.

import { useEffect, useMemo, useState } from "react";
import { useAccount, useWriteContract, useWaitForTransactionReceipt, usePublicClient } from "wagmi";
import { parseUnits, type Address } from "viem";
import { erc20Abi } from "viem";
import { lfx1Abi } from "../../abi/lfx1";
import { lfx1TokenAbi } from "../../abi/lfx1Token";
import { FACTORY_ADDRESS, USDC_ADDRESS } from "../../config";
import { arc, LAUNCH_TOKEN_DECIMALS, USDC_ERC20_DECIMALS } from "../../chain";
import type { TokenData } from "../../hooks/useCurve";
import { useQuote, type Side } from "../../hooks/useQuote";
import { useBalances } from "../../hooks/useBalances";
import { useFees } from "../../hooks/useFees";
import { useChain } from "../../providers/ChainProvider";
import { minOutFromQuote } from "../../lib/quotes";
import { checkAffordability, gasLimitFor } from "../../lib/gas";
import { tradeGate } from "../../lib/curve";
import { describeSnipeTax } from "../../lib/snipe";
import { fmtToken, fmtUsdc, fmtPct, fmtBps, safeText } from "../../lib/format";

const SLIPPAGE_BPS = 100n; // 1%
const BUY_PRESETS = ["1", "5", "25", "100"];

export function TradePanel({ token, data }: { token: Address; data: TokenData }) {
  const { address, isConnected } = useAccount();
  const { guard } = useChain();
  const { maxFeePerGas } = useFees();
  const balances = useBalances(address, token, maxFeePerGas);
  const client = usePublicClient({ chainId: arc.id });

  const [side, setSide] = useState<Side>("buy");
  const [input, setInput] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [settled, setSettled] = useState<string | null>(null);

  const symbol = safeText(data.symbol, 16) || "tokens";
  const gate = data.curve ? tradeGate(data.curve.state) : tradeGate(99);

  // Parse in the right decimals for the side. Trap 4: USDC is 6, launch tokens are 18.
  const amount = useMemo(() => {
    if (!input.trim()) return 0n;
    try {
      return parseUnits(input.trim(), side === "buy" ? USDC_ERC20_DECIMALS : LAUNCH_TOKEN_DECIMALS);
    } catch {
      return 0n;
    }
  }, [input, side]);

  const { data: quote, isFetching: quoting } = useQuote(token, side, amount);

  const { writeContractAsync, isPending: writing } = useWriteContract();
  const [txHash, setTxHash] = useState<`0x${string}` | undefined>();
  const { data: receipt, isLoading: confirming } = useWaitForTransactionReceipt({
    hash: txHash,
    chainId: arc.id,
  });

  // TRAP 6: report what the RECEIPT says, never the quote. The snipe tax decays per
  // second and the clamp can bind between quote and execution, so the two genuinely
  // differ -- and the quote is the number the user was shown, which makes presenting it
  // as the outcome the most misleading thing available.
  useEffect(() => {
    if (!receipt || !address) return;
    (async () => {
      try {
        const bal = (await client!.readContract({
          address: side === "buy" ? token : USDC_ADDRESS,
          abi: side === "buy" ? lfx1TokenAbi : erc20Abi,
          functionName: "balanceOf",
          args: [address],
        })) as bigint;
        setSettled(
          side === "buy"
            ? `Settled. Your balance is now ${fmtToken(bal)} ${symbol}.`
            : `Settled. Your USDC balance is now ${fmtUsdc(bal)}.`
        );
      } catch {
        setSettled("Settled. Refresh to see your updated balance.");
      }
      balances.refetch();
      data.refetch();
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [receipt]);

  const gasCostWei = useMemo(() => {
    // A realistic per-operation cost for the affordability check. Buys are the more
    // expensive path (measured max 194,372 against a sell's 119,254).
    const units = side === "buy" ? 200_000n : 130_000n;
    return units * (maxFeePerGas ?? 0n);
  }, [side, maxFeePerGas]);

  const afford =
    balances.usdc6 !== undefined && maxFeePerGas
      ? checkAffordability(
          balances.usdc6,
          side === "buy" ? amount : 0n,
          gasCostWei,
          balances.reserveUnits,
          maxFeePerGas
        )
      : null;

  const minOut = quote ? minOutFromQuote(quote.out, SLIPPAGE_BPS) : 0n;

  const needsUsdcApproval =
    side === "buy" && balances.usdcAllowance6 !== undefined && balances.usdcAllowance6 < amount;
  const needsTokenApproval =
    side === "sell" && balances.tokenAllowance18 !== undefined && balances.tokenAllowance18 < amount;

  const submit = async () => {
    setStatus(null);
    setSettled(null);
    if (!data.curve || !client) return;

    try {
      // Approvals first. The USDC approval is a TRADING approval and may be budgeted;
      // rule 1's exact-amount requirement is about the CREATION FEE, which is a different
      // hazard (R13: creationFeeUsdc is not covered by the economics hash). Trading fees
      // ARE hashed and snapshotted per curve, so a standing trading approval is bounded
      // by terms that cannot move underneath it.
      if (needsUsdcApproval) {
        setStatus("Approving USDC — confirm in your wallet…");
        const h = await writeContractAsync({
          address: USDC_ADDRESS,
          abi: erc20Abi,
          functionName: "approve",
          args: [FACTORY_ADDRESS, amount],
          chainId: arc.id,
        });
        await client.waitForTransactionReceipt({ hash: h });
      }
      if (needsTokenApproval) {
        setStatus(`Approving ${symbol} — confirm in your wallet…`);
        const h = await writeContractAsync({
          address: token,
          abi: lfx1TokenAbi,
          functionName: "approve",
          args: [FACTORY_ADDRESS, amount],
          chainId: arc.id,
        });
        await client.waitForTransactionReceipt({ hash: h });
      }

      // TRAP 6: RE-QUOTE immediately before signing. The quote on screen may be a second
      // old, and a second is the entire difference between a 98% and a 95% snipe tax.
      setStatus("Re-quoting…");
      const fresh = (await client.readContract({
        address: FACTORY_ADDRESS,
        abi: lfx1Abi,
        functionName: side === "buy" ? "quoteBuy" : "quoteSell",
        args: [token, amount],
      })) as never;

      const freshOut =
        side === "buy"
          ? (fresh as { tokensOut: bigint }).tokensOut
          : (fresh as { usdcOutGross: bigint; fee: bigint }).usdcOutGross -
            (fresh as { usdcOutGross: bigint; fee: bigint }).fee;

      const freshMinOut = minOutFromQuote(freshOut, SLIPPAGE_BPS);
      if (freshMinOut <= 0n) {
        setStatus("The curve cannot fill this trade right now. Try a smaller amount.");
        return;
      }

      // Gas limit from a live estimate x 1.5. Arc's eth_estimateGas returns no margin and
      // viem passes it through raw, so without this a trade whose state moves between
      // estimate and execution runs out of gas.
      let gas: bigint | undefined;
      try {
        const est = await client.estimateContractGas({
          address: FACTORY_ADDRESS,
          abi: lfx1Abi,
          functionName: side === "buy" ? "buy" : "sell",
          args: [token, amount, freshMinOut],
          account: address as Address,
        });
        gas = gasLimitFor(est);
      } catch {
        // If the estimate itself reverts, the trade would too. Say so rather than
        // sending something that will fail.
        setStatus("This trade would fail on chain right now. The curve may have moved.");
        return;
      }

      setStatus("Confirm in your wallet…");
      const h = await writeContractAsync({
        address: FACTORY_ADDRESS,
        abi: lfx1Abi,
        functionName: side === "buy" ? "buy" : "sell",
        args: [token, amount, freshMinOut],
        chainId: arc.id,
        gas,
      });
      setTxHash(h);
      setStatus("Submitted. Waiting for confirmation…");
    } catch (e) {
      const err = e as { name?: string; message?: string };
      setStatus(
        err.name === "UserRejectedRequestError"
          ? "Cancelled — nothing was sent."
          : (err.message ?? "Something went wrong.").split("\n")[0]
      );
    }
  };

  const busy = writing || confirming || quoting;
  const blocked =
    !isConnected ||
    !guard.canTransact ||
    amount === 0n ||
    (afford !== null && !afford.ok) ||
    (side === "buy" ? !gate.canBuy : !gate.canSell);

  return (
    <section className="card trade">
      <div className="trade-tabs">
        <button
          className={`tab ${side === "buy" ? "on" : ""}`}
          onClick={() => { setSide("buy"); setInput(""); setSettled(null); }}
          disabled={!gate.canBuy}
        >
          Buy
        </button>
        <button
          className={`tab ${side === "sell" ? "on" : ""}`}
          onClick={() => { setSide("sell"); setInput(""); setSettled(null); }}
          disabled={!gate.canSell}
        >
          Sell
        </button>
      </div>

      {side === "buy" && (
        <div className="presets">
          {BUY_PRESETS.map((p) => (
            <button key={p} className="btn btn-tiny" onClick={() => setInput(p)}>
              ${p}
            </button>
          ))}
          {/* "Max" is capped at available-to-trade, never at the raw balance. Rule 3:
              a max button that spends everything is exactly how a holder ends up unable
              to sell. */}
          <button
            className="btn btn-tiny"
            disabled={balances.availableToTrade6 === undefined}
            onClick={() =>
              balances.availableToTrade6 !== undefined &&
              setInput((Number(balances.availableToTrade6) / 1e6).toFixed(6))
            }
          >
            Max
          </button>
        </div>
      )}

      <input
        className="trade-input"
        inputMode="decimal"
        placeholder={side === "buy" ? "Amount in USDC" : `Amount in ${symbol}`}
        value={input}
        onChange={(e) => setInput(e.target.value.replace(/[^0-9.]/g, ""))}
      />

      {/* The snipe tax, explicit and prominent while active. In the opening seconds it
          is most of what a buyer pays; hiding it and settling at a different number is
          the worst thing this page can do. */}
      {side === "buy" && data.snipeTaxBps !== undefined && data.snipeTaxBps > 0 && (
        <div className="snipe-banner">
          <strong>{describeSnipeTax(data.snipeTaxBps)}</strong>
          <div className="hint">
            It decays every second since launch. Your quote is re-taken immediately before
            you sign, so what you confirm is what settles.
          </div>
        </div>
      )}

      <dl className="quote-lines">
        <dt>Estimated receive</dt>
        <dd>
          {!quote || amount === 0n
            ? "—"
            : side === "buy"
              ? `${fmtToken(quote.out)} ${symbol}`
              : `${fmtUsdc(quote.out)} USDC`}
          {quote?.clamped && (
            <span className="hint"> — partially filled; the curve cannot take the full amount</span>
          )}
        </dd>

        {/* HEADLINE, not a footnote. */}
        <dt>Price impact</dt>
        <dd className={quote?.impact !== null && (quote?.impact ?? 0) > 10 ? "impact-high" : ""}>
          {side === "sell"
            ? "—"
            : quote?.impact === null || quote?.impact === undefined
              ? "unavailable"
              : fmtPct(quote.impact)}
        </dd>

        <dt>Minimum received</dt>
        <dd>
          {minOut === 0n
            ? "—"
            : side === "buy"
              ? `${fmtToken(minOut)} ${symbol}`
              : `${fmtUsdc(minOut)} USDC`}
          <span className="hint"> at {fmtBps(Number(SLIPPAGE_BPS))} slippage</span>
        </dd>

        <dt>Gas reserve</dt>
        <dd>
          {maxFeePerGas
            ? `${fmtUsdc((balances.reserveWei + 999_999_999_999n) / 1_000_000_000_000n, 4)} USDC held back`
            : "…"}
          <span className="hint"> so you can always sell</span>
        </dd>

        <dt>Available to trade</dt>
        <dd>
          {balances.availableToTrade6 === undefined
            ? "…"
            : `${fmtUsdc(balances.availableToTrade6)} USDC`}
        </dd>
      </dl>

      {/* Affordability by ARITHMETIC, before submitting. Never by parsing a revert
          string -- Zero8 changed those on 3 September and a parser fails silently. */}
      {afford && !afford.ok && amount > 0n && (
        <p className="trade-warn">
          {afford.reason === "dust" &&
            "Your balance is too small to cover gas for a single transaction."}
          {afford.reason === "balance" && "That is more USDC than you hold."}
          {afford.reason === "gas" &&
            "That would leave you unable to cover gas. On Arc, gas comes out of this same USDC balance — including the gas you will need to sell."}
        </p>
      )}

      {!guard.canTransact && isConnected && (
        <p className="trade-warn">Switch your wallet to {arc.name} to trade.</p>
      )}

      <button className="btn btn-primary btn-block" disabled={blocked || busy} onClick={submit}>
        {!isConnected
          ? "Connect a wallet"
          : busy
            ? "Working…"
            : needsUsdcApproval || needsTokenApproval
              ? `Approve and ${side}`
              : side === "buy"
                ? "Buy"
                : "Sell"}
      </button>

      {status && <p className="trade-status">{status}</p>}
      {settled && <p className="trade-settled">{settled}</p>}
    </section>
  );
}
