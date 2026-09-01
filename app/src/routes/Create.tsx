// Phase 4 — the create flow.
//
// The rules that cost money live in lib/create.ts, red-proved in verify:create. This file
// is the form and the two transactions.
//
// ── THE TWO THINGS THAT MUST NOT BE "TIDIED" ─────────────────────────────────
//
// 1. R13. The creation fee is approved for an EXACT amount, via
//    creationFeeApprovalAmount(). `creationFeeUsdc` is one of only two values NOT in
//    currentEconomicsHash(), so the pinning guard cannot fire on a change to it and the
//    approval is the only bound on the exposure. A creator who pinned the old terms has
//    already paid a 1000x fee in precisely that scenario. An unlimited approve here is a
//    real, demonstrated loss, not a theoretical one.
//
// 2. The economics hash is fetched INSIDE the submit handler, in the same action that
//    sends the transaction. Never from a hook, never cached. A hash read at page load is
//    stale by definition; submitting it either reverts EconomicsChanged (the good case)
//    or pins terms the creator never actually saw.

import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAccount, usePublicClient, useWalletClient, useReadContract } from "wagmi";
import { decodeEventLog, erc20Abi, type Address } from "viem";
import { useT } from "../i18n";
import { arc } from "../chain";
import { lfx1Abi } from "../abi/lfx1";
import { FACTORY_ADDRESS, USDC_ADDRESS } from "../config";
import { useChain } from "../providers/ChainProvider";
import { gasLimitFor, GAS_RESERVE_UNITS } from "../lib/gas";
import {
  validateDraft,
  blocksSubmission,
  launchBlocker,
  creationFeeApprovalAmount,
  type Issue,
} from "../lib/create";

type Phase = "idle" | "approving" | "launching" | "done" | "error";

export function Create() {
  const { t, fmt } = useT();
  const nav = useNavigate();
  const { address, isConnected } = useAccount();
  const { guard } = useChain();
  const client = usePublicClient({ chainId: arc.id });
  const { data: wallet } = useWalletClient();

  const [name, setName] = useState("");
  const [symbol, setSymbol] = useState("");
  const [metadataUri, setMetadataUri] = useState("");
  const [poolBoost, setPoolBoost] = useState(false);
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);

  const factory = { address: FACTORY_ADDRESS, abi: lfx1Abi, chainId: arc.id } as const;

  // These are cheap, immutable-ish reads used only to explain the button. The hash is
  // deliberately NOT among them -- see the header.
  const { data: creationFee } = useReadContract({ ...factory, functionName: "creationFeeUsdc" });
  const { data: cooldown } = useReadContract({ ...factory, functionName: "launchCooldown" });
  const { data: lastLaunch } = useReadContract({
    ...factory,
    functionName: "lastLaunchTimestamp",
    args: address ? [address] : undefined,
    query: { enabled: !!address },
  });
  const { data: usdcBalance } = useReadContract({
    address: USDC_ADDRESS,
    abi: erc20Abi,
    chainId: arc.id,
    functionName: "balanceOf",
    args: address ? [address] : undefined,
    query: { enabled: !!address, refetchInterval: 10_000 },
  });

  const issues: Issue[] = useMemo(
    () => validateDraft({ name, symbol, metadataUri }),
    [name, symbol, metadataUri]
  );

  const blocker = launchBlocker({
    isConnected,
    canTransact: guard.canTransact,
    issues,
    nowSeconds: Math.floor(Date.now() / 1000),
    lastLaunchTimestamp: lastLaunch as bigint | undefined,
    launchCooldown: cooldown as bigint | undefined,
    usdcBalance: usdcBalance as bigint | undefined,
    creationFee: creationFee as bigint | undefined,
    // USDC is the gas token, so the fee alone is not enough to SEND the fee.
    gasReserve: GAS_RESERVE_UNITS,
  });

  async function onLaunch() {
    if (!wallet || !client || !address) return;
    setError(null);

    try {
      // ── the fee, read fresh ────────────────────────────────────────────────
      const fee = (await client.readContract({
        ...factory,
        functionName: "creationFeeUsdc",
      })) as bigint;

      // ── R13: approve the EXACT fee ─────────────────────────────────────────
      const allowance = (await client.readContract({
        address: USDC_ADDRESS,
        abi: erc20Abi,
        functionName: "allowance",
        args: [address, FACTORY_ADDRESS],
      })) as bigint;

      if (allowance < fee) {
        setPhase("approving");
        const amount = creationFeeApprovalAmount(fee);
        const approveHash = await wallet.writeContract({
          address: USDC_ADDRESS,
          abi: erc20Abi,
          functionName: "approve",
          args: [FACTORY_ADDRESS, amount],
        });
        await client.waitForTransactionReceipt({ hash: approveHash });
      }

      // ── the economics hash, fetched HERE and nowhere else ──────────────────
      //
      // Same action as the send. A hash from page load could have moved by now, and
      // submitting a stale one pins terms the creator never saw.
      setPhase("launching");
      const expectedEconomicsHash = (await client.readContract({
        ...factory,
        functionName: "currentEconomicsHash",
      })) as `0x${string}`;

      const args = [
        name.trim(),
        symbol.trim(),
        metadataUri.trim(),
        expectedEconomicsHash,
        poolBoost,
      ] as const;

      // Arc's estimateGas returns no margin and was measured 26% BELOW actual, so the
      // same x3 multiplier the trade panel uses applies here.
      const estimate = await client.estimateContractGas({
        ...factory,
        functionName: "createToken",
        args,
        account: address,
      });

      const hash = await wallet.writeContract({
        ...factory,
        functionName: "createToken",
        args,
        gas: gasLimitFor(estimate),
      });

      const receipt = await client.waitForTransactionReceipt({ hash });

      // The launched address comes from the RECEIPT, not from a return value: a
      // transaction's return data is not available to a sender, so the TokenCreated event
      // is the only source.
      let launched: Address | null = null;
      for (const log of receipt.logs) {
        try {
          const parsed = decodeEventLog({ abi: lfx1Abi, data: log.data, topics: log.topics });
          if (parsed.eventName === "TokenCreated") {
            launched = (parsed.args as { token: Address }).token;
            break;
          }
        } catch {
          // Not one of ours; skip.
        }
      }

      setPhase("done");
      if (launched) nav(`/t/${launched}`);
    } catch (e) {
      setPhase("error");
      const msg = e instanceof Error ? e.message.split("\n")[0] : String(e);
      setError(msg);
    }
  }

  const busy = phase === "approving" || phase === "launching";

  return (
    <main className="main create">
      <h1 className="create-h">{t("create.heading")}</h1>

      <label className="field">
        <span className="field-label">{t("create.name")}</span>
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={64} />
      </label>

      <label className="field">
        <span className="field-label">{t("create.symbol")}</span>
        <input className="input" value={symbol} onChange={(e) => setSymbol(e.target.value)} maxLength={32} />
      </label>

      <label className="field">
        <span className="field-label">{t("create.metadataUri")}</span>
        <input
          className="input"
          value={metadataUri}
          onChange={(e) => setMetadataUri(e.target.value)}
          placeholder={t("create.uriPlaceholder")}
        />
      </label>

      <label className="field field-check">
        <input type="checkbox" checked={poolBoost} onChange={(e) => setPoolBoost(e.target.checked)} />
        <span>
          {t("create.poolBoost")}
          {/* Pool boost is a trust signal, not an economic mechanism, and must not be
              described as holder fee sharing -- nobody receives anything. */}
          <span className="hint"> {t("create.poolBoostNote")}</span>
        </span>
      </label>

      {/* Errors block; warnings do not. A warning the creator has read and accepted is a
          decision, not a fault. */}
      {issues.map((i, n) => (
        <p key={n} className={i.severity === "error" ? "wallet-err" : "hint create-warn"}>
          {t(i.key as never, i.params as never)}
        </p>
      ))}

      <div className="create-fee">
        {creationFee !== undefined && (
          <span>
            {t("create.feeLabel")} {fmt.usdcExact(creationFee as bigint)} USDC
          </span>
        )}
      </div>

      <button
        className="btn btn-primary btn-lg"
        disabled={!!blocker || busy || blocksSubmission(issues)}
        onClick={onLaunch}
      >
        {phase === "approving"
          ? t("create.approving")
          : phase === "launching"
            ? t("create.launching")
            : t("create.launch")}
      </button>

      {blocker && (
        <p className="hint create-blocker">
          {blocker.kind === "notConnected" && t("create.blockConnect")}
          {blocker.kind === "wrongChain" && t("create.blockChain", { chain: arc.name })}
          {blocker.kind === "cooldown" &&
            t("create.blockCooldown", { seconds: blocker.secondsRemaining })}
          {blocker.kind === "insufficientUsdc" &&
            t("create.blockFunds", { needed: fmt.usdcExact(blocker.needed) })}
        </p>
      )}

      {error && (
        <p className="wallet-err" role="status">
          {error}
        </p>
      )}
    </main>
  );
}
