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
import { ImageUpload } from "../components/create/ImageUpload";
import { useAccount, usePublicClient, useWalletClient, useReadContract } from "wagmi";
import { decodeEventLog, erc20Abi, type Address } from "viem";
import { useT } from "../i18n";
import { useToast } from "../providers/ToastProvider";
import { arc } from "../chain";
import { lfx1Abi } from "../abi/lfx1";
import { FACTORY_ADDRESS, USDC_ADDRESS } from "../config";
import { useChain } from "../providers/ChainProvider";
import { PreviewCard } from "../components/create/PreviewCard";
import { getContractAddress } from "viem";
import { gasLimitFor, GAS_RESERVE_UNITS } from "../lib/gas";
import { useCapabilities, useSendCalls } from "wagmi";
import {
  DEFAULT_MAX_CREATOR_LAUNCH_BPS,
  parseLaunchBuyUsdc,
  canBatchLaunchBuy,
  supportsAtomicBatch,
} from "../lib/launchBuy";
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
  // Split from a single "metadata URI" box. A creator has a picture, a sentence and two
  // links -- not a JSON document -- and asking for the document was asking them to be a
  // developer. These are assembled into the metadataURI the contract stores.
  const [imageUri, setImageUri] = useState("");
  const [description, setDescription] = useState("");
  const [xHandle, setXHandle] = useState("");
  const [telegram, setTelegram] = useState("");
  const [poolBoost, setPoolBoost] = useState(false);
  // The creator's launch-buy spend, in USDC. Empty means none, which is the default and
  // what every token launched so far has done -- because it was the only option.
  const [launchBuyRaw, setLaunchBuyRaw] = useState("");

  // ⚠ CAPABILITY-GATED. A wallet without atomic batching still launches tokens; it just
  // cannot take the allocation. Creation must never depend on this.
  const { data: capabilities } = useCapabilities({ account: address });
  const { sendCallsAsync } = useSendCalls();
  const canBatch = supportsAtomicBatch(capabilities, arc.id);
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();

  const factory = { address: FACTORY_ADDRESS, abi: lfx1Abi, chainId: arc.id } as const;

  // These are cheap, immutable-ish reads used only to explain the button. The hash is
  // deliberately NOT among them -- see the header.
  const { data: creationFee } = useReadContract({ ...factory, functionName: "creationFeeUsdc" });
  const { data: cooldown } = useReadContract({ ...factory, functionName: "launchCooldown" });
  // Shown in the preview. Read, never hardcoded -- both are owner-settable and
  // snapshotted per token, so a constant here would be a promise the page cannot keep.
  const { data: threshold } = useReadContract({
    ...factory,
    functionName: "defaultGraduationThresholdUsdc",
  });
  const { data: tableVersion } = useReadContract({
    ...factory,
    functionName: "activeSnipeTaxTableVersion",
  });
  const { data: snipeTable } = useReadContract({
    ...factory,
    functionName: "snipeTaxTable",
    args: tableVersion !== undefined ? [tableVersion] : undefined,
    query: { enabled: tableVersion !== undefined },
  });
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
    () => validateDraft({ name, symbol, metadataUri: imageUri }),
    [name, symbol, imageUri]
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
    // Re-entrancy guard. Two launches would mean two creation fees, and the second would
    // revert on the cooldown -- after the fee had already left.
    if (phase === "approving" || phase === "launching") return;
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

      const { usdc6: launchBuy6 } = parseLaunchBuyUsdc(launchBuyRaw, usdcBalance as bigint | undefined);
      const batching = canBatchLaunchBuy({ supportsAtomicBatch: canBatch, launchBuyUsdc6: launchBuy6 });

      // ⚠ THE APPROVAL IS SKIPPED HERE WHEN BATCHING, because the batch carries its own.
      // Approving separately first would land in an earlier block, which is harmless, but
      // it would also mean two prompts -- and the entire point of the batch is one.
      if (!batching && allowance < fee) {
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

      // The contract stores ONE string. The form collects four fields, so they are
      // assembled here into a JSON document -- the shape the token page and the indexer
      // already read (description, image, and socials).
      //
      // A bare image URL is passed through UNWRAPPED when nothing else is filled in, so a
      // creator who only has a picture still gets a URI that any other explorer can
      // render without understanding our JSON.
      const hasExtras = description.trim() || xHandle.trim() || telegram.trim();
      const metadataURI = hasExtras
        ? JSON.stringify({
            image: imageUri.trim() || undefined,
            description: description.trim() || undefined,
            x: xHandle.trim() || undefined,
            telegram: telegram.trim() || undefined,
          })
        : imageUri.trim();

      const args = [
        name.trim(),
        symbol.trim(),
        metadataURI,
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

      // ⚠ THE TOKEN ADDRESS MUST BE PREDICTED, because creatorLaunchBuy takes it as an
      // argument and EIP-5792 has no way to pass a value from one call in a batch to the
      // next. The factory deploys with plain CREATE (`new LFX1Token(...)`, LFX1.sol:330 --
      // no salt, no CREATE2), so the address is keccak(rlp([factory, nonce])). Verified
      // exact against two live tokens: nonce 10 -> 0x7605bf0e… (dog), nonce 9 -> 0x14616E27… .
      //
      // ⚠ THE NONCE IS A RACE, AND THE CONSEQUENCE IS BOUNDED RATHER THAN ABSENT. Another
      // creator launching between this read and our transaction landing shifts the nonce,
      // so the predicted address is their token, `creatorLaunchBuy` reverts `NotCreator`,
      // and because the batch is ATOMIC the whole thing reverts -- including createToken.
      // The creator pays gas and retries. No token is created at a wrong address, no funds
      // move, and no partial state is left behind.
      //
      // That bound is exactly why `supportsAtomicBatch` requires the wallet to report
      // atomic execution before this path is taken at all: a wallet that runs the calls
      // sequentially would create the token, then fail the launch buy, and leave the
      // creator with a token whose allocation is gone and no way to retry.
      const predictedToken = batching
        ? getContractAddress({
            from: FACTORY_ADDRESS,
            nonce: BigInt(await client.getTransactionCount({ address: FACTORY_ADDRESS })),
          })
        : ("0x" as `0x${string}`);

      let hash: `0x${string}`;

      if (batching && launchBuy6 !== null && launchBuy6 > 0n) {
        // ── ONE PROMPT, ONE TRANSACTION, ONE block.timestamp ──────────────────
        //
        // approve -> createToken -> creatorLaunchBuy, executed atomically. Because all
        // three share a timestamp, `block.timestamp <= creationTimestamp + 3` holds with
        // the whole window still open, and creatorLaunchBuy has no block-0 restriction to
        // trip over. See lib/launchBuy.ts for the contract lines.
        //
        // ⚠ minTokensOut is 0 HERE AND ONLY HERE, and it is not the trap it looks like.
        // The launch buy is UNTAXED and the creator is the only possible caller inside the
        // window, so there is no sandwich to protect against -- the price cannot move
        // between createToken and creatorLaunchBuy because they are the same transaction.
        // The contract clamps to the remaining allowance and partial-fills rather than
        // reverting, so a floor here would only convert a valid partial fill into a
        // failure that also loses the token.
        setPhase("launching");
        const result = await sendCallsAsync({
          calls: [
            {
              to: USDC_ADDRESS,
              abi: erc20Abi,
              functionName: "approve",
              // Covers the creation fee AND the launch buy in one allowance. Still an
              // exact amount, never MaxUint256 -- R13's exposure is unchanged by batching.
              args: [FACTORY_ADDRESS, fee + launchBuy6],
            },
            { to: FACTORY_ADDRESS, abi: lfx1Abi, functionName: "createToken", args },
            {
              to: FACTORY_ADDRESS,
              abi: lfx1Abi,
              functionName: "creatorLaunchBuy",
              // The token address is not known until createToken executes. It is derived
              // deterministically by the factory, so it cannot be supplied here -- which is
              // why this call targets the token by the SAME args the factory used.
              args: [predictedToken, launchBuy6, 0n],
            },
          ],
        });
        hash = (result as unknown as { id: `0x${string}` }).id;
      } else {
        hash = await wallet.writeContract({
          ...factory,
          functionName: "createToken",
          args,
          gas: gasLimitFor(estimate),
        });
      }

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
      toast.ok(t("toast.launched"), `${name.trim()} ($${symbol.trim()})`);
      if (launched) nav(`/t/${launched}`);
    } catch (e) {
      setPhase("error");
      const err = e as { name?: string; message?: string };
      const msg = (err.message ?? String(e)).split("\n")[0];
      setError(msg);
      // A rejected signature is a decision, not a failure, and gets no error toast.
      if (err.name !== "UserRejectedRequestError") toast.bad(t("toast.launchFailed"), msg);
    }
  }

  const busy = phase === "approving" || phase === "launching";

  return (
    <main className="main create">
      <div className="create-form">
      <h1 className="create-h">{t("create.heading")}</h1>

      <label className="field">
        <span className="field-label">{t("create.name")}</span>
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={64} />
      </label>

      <label className="field">
        <span className="field-label">{t("create.symbol")}</span>
        <input className="input" value={symbol} onChange={(e) => setSymbol(e.target.value)} maxLength={32} />
      </label>

      <ImageUpload value={imageUri} onChange={setImageUri} />

      <label className="field">
        <span className="field-label">{t("create.description")}</span>
        <textarea
          className="input"
          rows={3}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder={t("create.descriptionPlaceholder")}
          maxLength={280}
        />
      </label>

      <div className="field-row">
        <label className="field">
          <span className="field-label">{t("create.xHandle")}</span>
          <input className="input" value={xHandle} onChange={(e) => setXHandle(e.target.value)} />
        </label>
        <label className="field">
          <span className="field-label">{t("create.telegram")}</span>
          <input className="input" value={telegram} onChange={(e) => setTelegram(e.target.value)} />
        </label>
      </div>

      {/* ⚠ THE ALLOCATION CONTROL. Shown only when the wallet can execute the batch
          atomically -- offering it otherwise would take money for something that cannot
          happen inside the 3-second window.

          ⚠ THE DISCLOSURE IS UNCHANGED AND MUST STAY THAT WAY. The 2.5% is a cap on the
          PRIVILEGED untaxed path only. It is not a cap on what a creator can hold: nothing
          stops them buying more from a second address at the ordinary price, and the copy
          below says exactly that rather than implying a limit that does not exist. */}
      {canBatch && (
        <label className="field">
          <span className="field-label">{t("create.launchBuy")}</span>
          <input
            className="input"
            inputMode="decimal"
            autoComplete="off"
            value={launchBuyRaw}
            onChange={(e) => setLaunchBuyRaw(e.target.value)}
            placeholder={t("create.launchBuyPlaceholder")}
          />
          <span className="hint">
            {t("create.launchBuyHint", { pct: Number(DEFAULT_MAX_CREATOR_LAUNCH_BPS) / 100 })}
          </span>
        </label>
      )}

      <label className="field field-check">
        <input type="checkbox" checked={poolBoost} onChange={(e) => setPoolBoost(e.target.checked)} />
        <span>
          {t("create.poolBoost")}
          {/* Pool boost is a trust signal, not an economic mechanism. The full
              "nobody receives a payout" wording moved to the tooltip -- as body copy
              it read as the product apologising for itself. */}
          <span className="hint" title={t("create.poolBoostTip")}>
            {" "}
            {t("create.poolBoostNote")}
          </span>
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
        className={`btn btn-primary btn-lg ${busy ? "btn-busy" : ""}`}
        aria-busy={busy || undefined}
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
      </div>

      <PreviewCard
        name={name}
        symbol={symbol}
        imageUri={imageUri}
        description={description}
        creationFee={creationFee as bigint | undefined}
        graduationThreshold={threshold as bigint | undefined}
        snipeWindowSeconds={
          Array.isArray(snipeTable) ? (snipeTable as readonly number[]).length : undefined
        }
      />
    </main>
  );
}
