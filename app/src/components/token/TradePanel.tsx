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
import { parseUnits, formatUnits, decodeEventLog, maxUint256, type Address, type Log } from "viem";
import { erc20Abi } from "viem";
import { lfx1Abi } from "../../abi/lfx1";
import { lfx1TokenAbi } from "../../abi/lfx1Token";
import { FACTORY_ADDRESS, USDC_ADDRESS } from "../../config";
import { arc, LAUNCH_TOKEN_DECIMALS, USDC_ERC20_DECIMALS, writeFees } from "../../chain";
import type { TokenData } from "../../hooks/useCurve";
import { useQuote, type Side } from "../../hooks/useQuote";
import { useBalances } from "../../hooks/useBalances";
import { useFees } from "../../hooks/useFees";
import { useChain } from "../../providers/ChainProvider";
import {
  minOutFromQuote,
  sellAmountForPercent,
  SELL_PERCENTS,
  curveQuoteFingerprint,
} from "../../lib/quotes";
import { loadSlippageBps, saveSlippageBps, bpsToPctLabel, requiresAcknowledgement } from "../../lib/slippage";
import { SlippageControl } from "./SlippageControl";
import { checkAffordability, gasLimitFor, GAS_LIMIT_UNITS_FOR_PRECHECK } from "../../lib/gas";
import { tradeGate } from "../../lib/curve";
import { safeText } from "../../lib/format";
import { useT } from "../../i18n";
import { useToast } from "../../providers/ToastProvider";
import { Figure } from "../Figure";

// Was a hardcoded `SLIPPAGE_BPS = 100n`. Now user-selectable; the 1% default lives in
// lib/slippage.ts. Every use below reads the STATE, and `minOutFromQuote` is called
// exactly as before -- no quote math changed.
const BUY_PRESETS = ["1", "5", "25", "100"];

/**
 * Whether a trade must approve first. ⚠ UNREADABLE MEANS APPROVE.
 *
 * `allowance` is undefined while it loads or when the read fails. That used to count as "no
 * approval needed", so the trade went straight to a gas estimate that reverted on the
 * missing allowance and told the user the trade "would fail" -- a false reason. An
 * unneeded approve costs one prompt; a skipped one costs a wrong answer.
 */
function tradeNeedsApproval(allowance: bigint | undefined, amount: bigint): boolean {
  return amount > 0n && (allowance === undefined || allowance < amount);
}

export function TradePanel({ token, data }: { token: Address; data: TokenData }) {
  const { t, fmt } = useT();
  const { address, isConnected } = useAccount();
  const { guard } = useChain();
  const { maxFeePerGas } = useFees();
  const balances = useBalances(address, token, maxFeePerGas);
  const client = usePublicClient({ chainId: arc.id });

  const [side, setSide] = useState<Side>("buy");
  const [input, setInput] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [settled, setSettled] = useState<string | null>(null);
  // ⚠ COVERS THE WHOLE PATH, not just the write.
  //
  // useWriteContract().isPending only goes true once writeContractAsync is CALLED, and
  // submit() does a re-quote, an affordability check and a gas estimate before that. That
  // gap was a live, enabled Buy button doing invisible work -- the dead interval between
  // clicking and MetaMask appearing, and the double-click window Phase 6 lists as an
  // attack.
  const [submitting, setSubmitting] = useState(false);
  // Seeded from sessionStorage: the choice follows the user across token pages within a
  // session and is gone when the tab closes. See lib/slippage.ts for why not localStorage.
  const [slippageBps, setSlippageBps] = useState<bigint>(() => loadSlippageBps());
  // ⚠ NOT persisted, and reset whenever the tolerance changes. An acknowledgement carried
  // across a session (or across a change from 8% to 40%) would acknowledge a number the
  // user never saw, which is the failure it exists to prevent.
  const [slippageAck, setSlippageAck] = useState(false);
  const toast = useToast();

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

  // Age drives the quote polling cadence: 1s while the snipe tax is still decaying per
  // second, 30s once the curve only moves on trades. From the CONTRACT's own
  // creationTimestamp, not a local clock, so a skewed browser cannot decide we are
  // outside the window while the chain says otherwise.
  const tokenAgeSeconds = data.curve
    ? Math.max(0, Math.floor(Date.now() / 1000) - Number(data.curve.creationTimestamp))
    : undefined;

  // ⚠ EVERY INPUT A QUOTE DEPENDS ON, AS ONE STRING. When this changes the curve has
  // moved and any figure on screen is superseded -- see lib/quotes.ts and CLAUDE.md §12.2.
  //
  // It costs NOTHING to compute: useCurve already reads all of it every 6 seconds for the
  // stat strip. That is why this is derived from the curve rather than from a
  // `watchContractEvent` on `Trade` -- see the report. It also catches a move the Trade
  // event would not, such as a graduation closing both sides.
  const curveFingerprint = curveQuoteFingerprint(data.curve, data.snipeTaxBps);

  const { data: quote, isFetching: quoting } = useQuote(
    token,
    side,
    amount,
    true,
    tokenAgeSeconds,
    curveFingerprint
  );

  const { writeContractAsync, isPending: writing } = useWriteContract();
  const [txHash, setTxHash] = useState<`0x${string}` | undefined>();
  const { data: receipt, isLoading: confirming } = useWaitForTransactionReceipt({
    hash: txHash,
    chainId: arc.id,
  });

  // TRAP 6 + A4: read the settled amount from the RECEIPT'S OWN EVENT.
  //
  // Never echo the quote -- the snipe tax decays per second and the clamp can bind between
  // quote and execution, so the two genuinely differ, and the quote is the number the user
  // was shown, which makes presenting it as the outcome the most misleading option.
  //
  // But the first version read a fresh BALANCE after the receipt, and a balance delta is
  // only correct if nothing else moved the balance in between. It can be raced by a second
  // tab, another trade landing, or -- on Arc specifically -- by gas being deducted from the
  // same USDC balance the sell pays into. Decoding `Trade(token, trader, isBuy, usdcAmount,
  // tokenAmount)` out of this transaction's own logs is exact and cannot be raced: the
  // amounts are the ones this transaction actually moved.
  useEffect(() => {
    if (!receipt || !address) return;

    let settledUsdc: bigint | undefined;
    let settledTokens: bigint | undefined;

    for (const log of receipt.logs as Log[]) {
      // Only this factory's logs, and only this trader's -- a block can contain other
      // people's trades on the same token.
      if (log.address.toLowerCase() !== FACTORY_ADDRESS.toLowerCase()) continue;
      try {
        const ev = decodeEventLog({ abi: lfx1Abi, data: log.data, topics: log.topics });
        if (ev.eventName !== "Trade") continue;
        const a = ev.args as unknown as {
          token: Address;
          trader: Address;
          isBuy: boolean;
          usdcAmount: bigint;
          tokenAmount: bigint;
        };
        if (a.trader.toLowerCase() !== address.toLowerCase()) continue;
        if (a.token.toLowerCase() !== token.toLowerCase()) continue;
        settledUsdc = a.usdcAmount;
        settledTokens = a.tokenAmount;
      } catch {
        // A log this ABI cannot decode is someone else's event. Not an error.
      }
    }

    if (settledTokens !== undefined && settledUsdc !== undefined) {
      setSettled(
        side === "buy"
          ? t("trade.settledBuyExact", {
              tokens: fmt.tokenExact(settledTokens),
              symbol,
              usdc: fmt.usdcExact(settledUsdc),
            })
          : t("trade.settledSellExact", {
              tokens: fmt.tokenExact(settledTokens),
              symbol,
              usdc: fmt.usdcExact(settledUsdc),
            })
      );
      // ⚠ THE TOAST CARRIES THE RECEIPT'S NUMBER, NOT THE QUOTE. Same string that was
      // just decoded from this transaction's own Trade event. Echoing the quote here
      // would present the figure the user was SHOWN as the figure they GOT, and those
      // genuinely differ when the snipe tax decays or the clamp binds between quote and
      // execution.
      toast.ok(
        side === "buy" ? t("toast.boughtTitle") : t("toast.soldTitle"),
        side === "buy"
          ? t("trade.settledBuyExact", {
              tokens: fmt.tokenExact(settledTokens),
              symbol,
              usdc: fmt.usdcExact(settledUsdc),
            })
          : t("trade.settledSellExact", {
              tokens: fmt.tokenExact(settledTokens),
              symbol,
              usdc: fmt.usdcExact(settledUsdc),
            })
      );
    } else {
      // No Trade event from us in this receipt. Say that rather than inventing a figure
      // from a balance read that may have been raced.
      setSettled(t("trade.settledUnknown"));
      toast.ok(t("toast.confirmedTitle"), t("trade.settledUnknown"));
    }

    balances.refetch();
    data.refetch();

    // ⚠ CLEAR THE BOX. This is the other half of §12.2 and it is the half that produced
    // the screenshot.
    //
    // The amount the user typed described a trade that has now HAPPENED. Left in place it
    // keeps a live quote query running for a position they may no longer hold, and that
    // quote is re-read against the post-trade curve -- so the panel sat there showing
    // "Estimated receive 0.000001 USDC, partially filled" directly beneath "Settled ...
    // 6.08 USDC". Both numbers were correct. Only their juxtaposition was a lie, and it
    // read as a quote wrong by six orders of magnitude.
    //
    // Measured, not inferred: quoteSell at block 60466934 (immediately BEFORE that sell)
    // returns 6.083285 for the submitted amount, and 0.000001 only at 60466935, the
    // trade's own block. A stale quote could not have produced the figure shown; a
    // freshly re-read orphan is the only thing that could.
    //
    // Clearing also removes a real hazard beyond display: a second click would have
    // re-sent the same size against reserves that just moved.
    setInput("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [receipt]);

  const gasCostWei = useMemo(() => {
    // A3: the pre-submit affordability check must price the SAME limit the transaction
    // will carry. The wallet itself refuses to sign unless
    // `balance >= gasLimit * maxFeePerGas`, so a check using a smaller figure would pass a
    // trade the wallet then rejects -- the UI saying yes and the wallet saying no.
    //
    // Unused gas is refunded, so this is a bar to clear, not a cost to pay.
    return GAS_LIMIT_UNITS_FOR_PRECHECK * (maxFeePerGas ?? 0n);
  }, [maxFeePerGas]);

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

  const minOut = quote ? minOutFromQuote(quote.out, slippageBps) : 0n;

  // For the button LABEL only -- submit() decides from a fresh read. Unreadable counts as
  // "approve" here too, so the label matches what submit() will actually do.
  const needsUsdcApproval = side === "buy" && tradeNeedsApproval(balances.usdcAllowance6, amount);
  const needsTokenApproval =
    side === "sell" && tradeNeedsApproval(balances.tokenAllowance18, amount);

  const submit = async () => {
    // Re-entrancy guard. A disabled button can still be activated by keyboard in some
    // browsers, and a second submit would send a SECOND transaction.
    if (submitting) return;
    // ⚠ ABOVE setSubmitting(true), not below it. This return used to follow it, outside
    // the try/finally, so taking it would have stranded the button disabled for good.
    // `address` joined it for the fresh allowance read below.
    if (!data.curve || !client || !address) return;
    setSubmitting(true);
    setStatus(null);
    setSettled(null);

    try {
      // ── Approval, decided from a FRESH read ───────────────────────────────────────
      //
      // Not from useBalances' 8-second poll, which now drives only the button label. A
      // launch resets the USDC allowance to exactly its fee and spends it (Create.tsx), so
      // the poll can still be showing an unlimited allowance that is already zero.
      // Unreadable counts as "approve" -- see tradeNeedsApproval.
      const allowance = await client
        .readContract({
          address: side === "buy" ? USDC_ADDRESS : token,
          abi: erc20Abi,
          functionName: "allowance",
          args: [address, FACTORY_ADDRESS],
        })
        .catch(() => undefined);

      if (tradeNeedsApproval(allowance, amount)) {
        if (side === "buy") {
          // ⚠ CORRECTED, 10 September 2026. This comment said the USDC approval "is a
          // TRADING approval and may be budgeted", the creation fee being "a different
          // hazard", and a standing trading approval "bounded by terms that cannot move
          // underneath it". True of what each function PULLS. False of the ALLOWANCE, which
          // is one number per (owner, spender): this approve and the creation-fee approve
          // are USDC to the same spender, and createToken pulls an owner-settable, unhashed
          // fee against whatever is standing. Even with exact approvals, R13's bound was
          // whatever trade approval had been left unspent -- not the fee.
          //
          // ⚠ UNLIMITED IS SAFE HERE ONLY BECAUSE Create.tsx RE-APPROVES EXACTLY THE FEE
          // before every launch (creationFeeNeedsApproval: `!==`, never `<`), and approve()
          // overwrites. The two ship together or not at all. CLAUDE.md §22.
          setStatus(t("trade.approvingUsdc"));
          const h = await writeContractAsync({
            address: USDC_ADDRESS,
            abi: erc20Abi,
            functionName: "approve",
            args: [FACTORY_ADDRESS, maxUint256],
            chainId: arc.id,
            // ⚠ The 20 Gwei floor has to travel with the call. chain.ts's
            // fees.estimateFeesPerGas never runs for a wallet write -- see writeFees().
            ...writeFees(maxFeePerGas),
          });
          await client.waitForTransactionReceipt({ hash: h });
        } else {
          // Unlimited, once per token. The factory spends this allowance in exactly one
          // place, sell() (LFX1.sol:577), for at most the tokensIn its caller passes, and no
          // owner-settable amount reaches it -- the exposure the USDC side has, it does not.
          setStatus(t("trade.approvingToken", { symbol }));
          const h = await writeContractAsync({
            address: token,
            abi: lfx1TokenAbi,
            functionName: "approve",
            args: [FACTORY_ADDRESS, maxUint256],
            chainId: arc.id,
            ...writeFees(maxFeePerGas),
          });
          await client.waitForTransactionReceipt({ hash: h });
        }
        // So the label stops offering an approval that just landed if the trade below
        // bails; otherwise it lags by up to one poll.
        balances.refetch();
      }

      // TRAP 6: RE-QUOTE immediately before signing. The quote on screen may be a second
      // old, and a second is the entire difference between a 98% and a 95% snipe tax.
      setStatus(t("trade.requoting"));
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

      const freshMinOut = minOutFromQuote(freshOut, slippageBps);
      if (freshMinOut <= 0n) {
        setStatus(t("trade.cannotFill"));
        return;
      }

      // Gas limit from a live estimate x3.0 (gasLimitFor). This comment said "x 1.5" for
      // weeks, one line above a call that applies x3.0 -- Create.tsx:190 was correct all
      // along. Arc's eth_estimateGas historically returned no margin and
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
        setStatus(t("trade.wouldFail"));
        return;
      }

      setStatus(t("trade.confirmInWallet"));
      const h = await writeContractAsync({
        address: FACTORY_ADDRESS,
        abi: lfx1Abi,
        functionName: side === "buy" ? "buy" : "sell",
        args: [token, amount, freshMinOut],
        chainId: arc.id,
        gas,
        ...writeFees(maxFeePerGas),
      });
      setTxHash(h);
      setStatus(t("trade.submitted"));
    } catch (e) {
      const err = e as { name?: string; message?: string };
      const rejected = err.name === "UserRejectedRequestError";
      // A provider message is raw text from the node, not ours to translate. It is shown
      // verbatim rather than mapped, because guessing at which of the node's wordings it
      // is would be exactly the revert-string parsing rule 4 forbids. viem decodes our
      // custom errors by name before this point, so where one exists it is already in the
      // message rather than reconstructed here.
      const reason = (err.message ?? t("errors.noReason")).split("\n")[0];
      setStatus(rejected ? t("trade.cancelled") : reason);
      // A rejection is a decision, not a failure. It gets no error toast.
      if (!rejected) toast.bad(t("toast.tradeFailed"), reason);
    } finally {
      // In `finally` so a throw anywhere above cannot strand the button disabled forever.
      setSubmitting(false);
    }
  };

  // ⚠ `quoting` IS DELIBERATELY NOT HERE. It used to be, which disabled the button every
  // time a quote refreshed -- once per SECOND during the snipe window. A control that
  // flickers unusable while the user is trying to press it is worse than a stale number,
  // and the two states are unrelated: one is "we are re-reading a price", the other is
  // "a transaction is in flight". Refreshing is surfaced on the FIGURES instead.
  const busy = submitting || writing || confirming;
  const blocked =
    !isConnected ||
    !guard.canTransact ||
    amount === 0n ||
    (afford !== null && !afford.ok) ||
    (side === "buy" ? !gate.canBuy : !gate.canSell);

  return (
    <section className="card trade">
      {/* ⚠ role="tablist" + aria-selected carries "which side is active" to assistive
          tech, so the green/red distinction is never the only way to know. Sighted
          users get three colour-independent cues too -- see the note in styles.css. */}
      <div className="trade-tabs" role="tablist" aria-label={t("trade.buy") + " / " + t("trade.sell")}>
        <button
          role="tab"
          aria-selected={side === "buy"}
          className={`tab tab-buy ${side === "buy" ? "on" : ""}`}
          onClick={() => { setSide("buy"); setInput(""); setSettled(null); }}
          disabled={!gate.canBuy}
        >
          {t("trade.buy")}
        </button>
        <button
          role="tab"
          aria-selected={side === "sell"}
          className={`tab tab-sell ${side === "sell" ? "on" : ""}`}
          onClick={() => { setSide("sell"); setInput(""); setSettled(null); }}
          disabled={!gate.canSell}
        >
          {t("trade.sell")}
        </button>
      </div>

      {side === "buy" && (
        <div className="presets presets-buy">
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
            {t("trade.max")}
          </button>
        </div>
      )}

      {/* ⚠ THE SELL SIDE IS SIZED IN PERCENT, NOT TOKENS.

          Reported from a real session: a holder with ~2,000,000 tokens typed "4" into a
          raw token box, sold four tokens, and got 0.00 USDC back. A buy is priced in
          dollars because you are spending dollars. A sell is priced in percent because
          you are disposing of a position, and nobody holds a position in units.

          100% uses the EXACT balance -- see sellAmountForPercent. There is no
          available-to-trade cap here as there is on buy: the gas reserve exists so a
          holder can always afford to SELL, so capping the sell with it would withhold
          the position from the very action the reserve protects. */}
      {side === "sell" && (
        <div className="presets presets-sell">
          {SELL_PERCENTS.map((pc) => (
            <button
              key={pc}
              className="btn btn-tiny"
              disabled={!balances.token18}
              onClick={() =>
                balances.token18 !== undefined &&
                setInput(
                  formatUnits(
                    sellAmountForPercent(balances.token18, pc),
                    LAUNCH_TOKEN_DECIMALS
                  )
                )
              }
            >
              {pc}%
            </button>
          ))}
        </div>
      )}

      <input
        className="trade-input"
        inputMode="decimal"
        placeholder={side === "buy" ? t("trade.amountUsdc") : t("trade.amountToken", { symbol })}
        value={input}
        onChange={(e) => setInput(e.target.value.replace(/[^0-9.]/g, ""))}
      />

      {/* The snipe tax, explicit and prominent while active. In the opening seconds it
          is most of what a buyer pays; hiding it and settling at a different number is
          the worst thing this page can do. */}
      {side === "buy" && data.snipeTaxBps !== undefined && data.snipeTaxBps > 0 && (
        <div className="snipe-banner">
          <strong>{t("trade.snipeActive", { pct: fmt.bps(data.snipeTaxBps) })}</strong>
          <div className="hint">{t("trade.snipeExplain")}</div>
        </div>
      )}

      <dl className="quote-lines">
        <dt>{t("trade.estimatedReceive")}</dt>
        <dd>
          {/* Dimmed with a pulsing dot while a new quote is in flight. The previous
              number stays on screen (placeholderData) so the panel does not flash empty,
              but it is marked as being re-read rather than presented as current -- during
              the snipe window it can be a full second and one tax step out of date. */}
          <Figure
            refreshing={quoting}
            value={
              !quote || amount === 0n
                ? "—"
                : side === "buy"
                  ? `${fmt.tokenCompact(quote.out)} ${symbol}`
                  : `${fmt.usdcExact(quote.out)} USDC`
            }
          />
          {quote?.clamped && (
            <span className="hint"> — {t("trade.partiallyFilled")}</span>
          )}
        </dd>

        {/* HEADLINE, not a footnote. */}
        <dt>
          {t("trade.priceImpact")}
          <div className="hint">{t("trade.priceImpactNote")}</div>
        </dt>
        <dd className={quote?.impact !== null && (quote?.impact ?? 0) > 10 ? "impact-high" : ""}>
          {/* The sell side computes impact too now -- it used to hardcode null, so a
              seller never saw a figure at any size even though selling moves the price
              down against them by the same mechanism. */}
          {quote?.impact === null || quote?.impact === undefined
              ? t("common.unavailable")
              : fmt.pct(quote.impact)}
        </dd>

        <dt>{t("trade.minimumReceived")}</dt>
        <dd>
          {minOut === 0n
            ? "—"
            : side === "buy"
              ? `${fmt.tokenExact(minOut)} ${symbol}`
              : `${fmt.usdcExact(minOut)} USDC`}
          <span className="hint"> {t("trade.atSlippage", { pct: bpsToPctLabel(slippageBps) })}</span>
        </dd>

        <dt>{t("trade.gasReserve")}</dt>
        <dd>
          {maxFeePerGas
            ? t("trade.gasReserveHeld", {
                amount: fmt.usdcExact((balances.reserveWei + 999_999_999_999n) / 1_000_000_000_000n, 4),
              })
            : "…"}
          <span className="hint"> {t("trade.gasReserveWhy")}</span>
        </dd>

        <dt>{t("trade.availableToTrade")}</dt>
        <dd>
          {balances.availableToTrade6 === undefined
            ? "…"
            : `${fmt.usdcExact(balances.availableToTrade6)} USDC`}
        </dd>
      </dl>

      <SlippageControl
        bps={slippageBps}
        onChange={(v) => {
          setSlippageBps(v);
          saveSlippageBps(v);
          setSlippageAck(false);
        }}
        acknowledged={slippageAck}
        onAcknowledge={setSlippageAck}
      />

      {/* Affordability by ARITHMETIC, before submitting. Never by parsing a revert
          string -- Zero8 changed those on 3 September and a parser fails silently. */}
      {afford && !afford.ok && amount > 0n && (
        <p className="trade-warn">
          {afford.reason === "dust" && t("trade.affordDust")}
          {afford.reason === "balance" && t("trade.affordBalance")}
          {afford.reason === "gas" && t("trade.affordGas")}
        </p>
      )}

      {!guard.canTransact && isConnected && (
        <p className="trade-warn">{t("trade.switchToTrade", { chain: arc.name })}</p>
      )}

      <button
        /* The primary action takes the active side's colour. It is the same control
           either way, so the class is appended rather than replacing btn-primary --
           padding, block width and the busy treatment all still apply. */
        className={`btn btn-primary btn-block ${side === "buy" ? "btn-buy" : "btn-sell"} ${busy ? "btn-busy" : ""}`}
        /* ⚠ A wide tolerance must be acknowledged before it can be sent. The warning
           alone left the button live, which is advice next to a loaded trigger. */
        disabled={blocked || busy || (requiresAcknowledgement(slippageBps) && !slippageAck)}
        aria-busy={busy || undefined}
        onClick={submit}
      >
        {!isConnected
          ? t("common.connectWallet")
          : busy
            ? t("trade.working")
            : needsUsdcApproval || needsTokenApproval
              ? t("trade.approveAnd", { side: side === "buy" ? t("trade.buy") : t("trade.sell") })
              : side === "buy"
                ? t("trade.buy")
                : t("trade.sell")}
      </button>

      {status && <p className="trade-status">{status}</p>}
      {settled && <p className="trade-settled">{settled}</p>}
    </section>
  );
}
