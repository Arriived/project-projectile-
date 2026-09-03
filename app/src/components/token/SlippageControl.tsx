// Slippage tolerance control.
//
// ⚠ THE SELECTED VALUE IS RENDERED ON THE PANEL ITSELF, NOT ONLY IN THIS CONTROL. See
// TradePanel's minimum-received line. A tolerance the user changed once and then forgot is
// exactly how someone takes a bad fill and blames the site, so the number follows the
// trade rather than hiding behind a disclosure triangle.

import { useId, useState } from "react";
import { useT } from "../../i18n";
import {
  SLIPPAGE_PRESETS_BPS,
  SLIPPAGE_MAX_BPS,
  bpsToPctLabel,
  parseSlippagePct,
  slippageBlocks,
  requiresAcknowledgement,
  type SlippageIssue,
} from "../../lib/slippage";

export function SlippageControl({
  bps,
  onChange,
  acknowledged,
  onAcknowledge,
}: {
  bps: bigint;
  onChange: (bps: bigint) => void;
  acknowledged: boolean;
  onAcknowledge: (v: boolean) => void;
}) {
  const { t } = useT();
  const inputId = useId();
  const isPreset = (SLIPPAGE_PRESETS_BPS as readonly bigint[]).includes(bps);
  // Seeded from the current value only when it is NOT a preset, so opening the control on
  // a preset does not prefill a custom box the user did not type in.
  const [custom, setCustom] = useState(isPreset ? "" : String(Number(bps) / 100));
  const [issue, setIssue] = useState<SlippageIssue | null>(null);

  function pickPreset(p: bigint) {
    setCustom("");
    setIssue(null);
    onChange(p);
  }

  function onCustom(raw: string) {
    setCustom(raw);
    const { bps: parsed, issue: nextIssue } = parseSlippagePct(raw);
    setIssue(nextIssue);
    // A refused value never reaches the trade, and the check is `parsed !== null` alone:
    // parseSlippagePct returns null for EVERY blocking issue, so a non-null bps is already
    // proof the value is usable. Testing `slippageBlocks` here as well would read as a
    // second gate while actually being unreachable — two conditions that must agree are a
    // place for them to disagree later.
    if (parsed !== null) onChange(parsed);
  }

  function issueText(i: SlippageIssue): string {
    switch (i.kind) {
      case "tooHigh":
        return t("trade.slippageRefused", { max: i.maxPct });
      case "high":
        return t("trade.slippageHigh", { pct: i.pct });
      case "negative":
        return t("trade.slippageNegative");
      case "notANumber":
        return t("trade.slippageNaN");
      case "empty":
        return "";
    }
  }

  // ⚠ PRESENTATION ONLY. lib/slippage.ts is untouched -- the refusal at and above 50%,
  // the warning at and above 5%, requiresAcknowledgement, the sessionStorage lifetime and
  // every threshold are exactly where they were. This moves WHERE the picker renders, not
  // WHAT it decides. verify:slippage passes unchanged.
  const [open, setOpen] = useState(false);
  const needsAck = requiresAcknowledgement(bps);

  return (
    <div className="slip">
      {/* ⚠ THE VALUE IS VISIBLE WITHOUT OPENING THE POPOVER. A tolerance the user forgot
          they changed is how people lose money and blame the site, so the number sits on
          the panel itself -- and it is ALSO on the minimum-received line above, which is
          the one a trader is actually reading when they press Buy. */}
      <div className="slip-compact">
        <span className="slip-label">{t("trade.slippageLabel")}</span>
        <button
          type="button"
          className={`slip-trigger${needsAck ? " slip-trigger-warn" : ""}`}
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-label={t("trade.slippageOpen", { pct: bpsToPctLabel(bps) })}
        >
          <span className="mono">{bpsToPctLabel(bps)}</span>
          <span aria-hidden="true">⚙</span>
        </button>
      </div>

      {/* The acknowledgement stays OUTSIDE the popover. It gates the trade button, so
          hiding it behind a click would leave the button disabled with the reason folded
          away -- a dead control and no explanation. */}
      {needsAck && (
        <label className="slip-ack">
          <input type="checkbox" checked={acknowledged} onChange={(e) => onAcknowledge(e.target.checked)} />
          <span>{t("trade.slippageAck", { pct: Number(bps) / 100 })}</span>
        </label>
      )}

      {open && (
      <div className="slip-pop">

      <div className="slip-options">
        {SLIPPAGE_PRESETS_BPS.map((p) => (
          <button
            key={String(p)}
            type="button"
            className={`slip-preset${bps === p && !custom ? " on" : ""}`}
            onClick={() => pickPreset(p)}
            aria-pressed={bps === p && !custom}
          >
            {bpsToPctLabel(p)}
          </button>
        ))}

        <span className="slip-custom">
          <input
            id={inputId}
            className="input slip-input"
            /* ⚠ inputMode=decimal, NOT type=number. type=number renders spinners, accepts
               "e" and "+", and on iOS gives a keypad without a decimal point in several
               locales. The 16px font size is set in CSS and is load-bearing: below 16px
               iOS Safari zooms the page on focus and does not zoom back out. */
            inputMode="decimal"
            autoComplete="off"
            value={custom}
            onChange={(e) => onCustom(e.target.value)}
            placeholder={t("trade.slippageCustom")}
            aria-label={t("trade.slippageCustomAria")}
            aria-invalid={slippageBlocks(issue) || undefined}
          />
          <span className="slip-pct" aria-hidden="true">
            %
          </span>
        </span>
      </div>

      {issue && issue.kind !== "empty" && (
        <p
          className={slippageBlocks(issue) ? "slip-msg slip-msg-bad" : "slip-msg slip-msg-warn"}
          role={slippageBlocks(issue) ? "alert" : "status"}
        >
          {issueText(issue)}
        </p>
      )}

      

      {/* Stated once, plainly, rather than only appearing at the moment of refusal. */}
      <p className="hint slip-bound">
        {t("trade.slippageBound", { max: Number(SLIPPAGE_MAX_BPS) / 100 })}
      </p>
      </div>
      )}
    </div>
  );
}
