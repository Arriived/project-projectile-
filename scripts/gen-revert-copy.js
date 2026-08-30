// Generates frontend/revert-errors.js -- a selector -> human copy map for every custom
// error in the ABI, plus explainRevert().
//
// WHY THIS IS GENERATED. On Arc, ethers does NOT decode custom errors: a revert arrives as
// a raw provider error with code 3, e.revert and e.shortMessage both undefined, and the
// 4-byte selector in e.data. Verified against 0xEDeed1F0 -- EconomicsChanged() is
// 0x444df1ec. So every catch that showed `err.shortMessage || err.message` degraded to
// "Unknown error" for EVERY contract revert. Selectors are ABI data, stable across the
// node upgrades that move the message strings.
//
// Generating it means a new or renamed error cannot silently lose its copy: an error with
// no entry below is reported loudly at generation time, and an unrecognised selector at
// runtime degrades to an honest "unrecognised" message rather than silence.
//
//   node scripts/gen-revert-copy.js            # write the file
//   node scripts/gen-revert-copy.js --check    # exit 1 if stale or copy is missing
const fs = require("fs");
const path = require("path");
const { Interface } = require("ethers");

const ROOT = path.join(__dirname, "..");
const OUT = path.join(ROOT, "frontend", "revert-errors.js");
const abi = JSON.parse(fs.readFileSync(path.join(ROOT, "indexer/src/generated/lfx1Abi.json"), "utf8"));

// Copy is written for the PERSON who hit it: what happened, and what to do next.
// No jargon that only means something if you have read the contract.
const COPY = {
  EconomicsChanged: "The launch terms changed while you were filling this in. Nothing was charged. Reload and check the fee and settings before launching again.",
  SlippageExceeded: "The price moved more than your slippage allowance before this went through, so it was cancelled rather than filled at a worse rate. Try again.",
  CurveNotActive: "This token is no longer trading on its bonding curve — it has finished and is moving to the DEX. Buying and selling here are both closed.",
  NotReadyToGraduate: "This token has not finished its bonding curve yet, so it cannot graduate.",
  GraduationFailed: "Graduation could not complete. The curve keeps its funds and stays retryable — nothing is lost.",
  TradingNotOpenYet: "Trading opens one block after a token is created. Wait a moment and try again.",
  LaunchCooldownActive: "You launched a token very recently. There is a short cooldown per wallet — wait a few seconds.",
  LaunchWindowClosed: "The creator's early-buy window for this token has closed.",
  CreatorAllocationUsed: "The creator's launch allocation for this token is already used up.",
  NotCreator: "Only the token's creator can do this.",
  SymbolLocked: "That symbol was used very recently and is briefly reserved. Try again shortly or pick another.",
  UnknownToken: "That token was not created by this launchpad, so it cannot be traded here.",
  ZeroAmount: "Enter an amount greater than zero.",
  ZeroAddress: "That address is not valid.",
  NothingToClaim: "There is nothing to claim right now.",
  RouterNotSet: "The launchpad has no DEX router configured, so this cannot complete yet.",
  RouterNotProposed: "That router was never proposed, so it cannot be activated.",
  RouterTimelockPending: "That router is still inside its 24-hour timelock.",
  UsdcTransferMismatch: "The USDC transfer did not deliver the expected amount, so the trade was cancelled to protect the pool.",
  EnforcedPause: "The launchpad is paused right now. Trading and launching are temporarily closed.",
  ExpectedPause: "That action is only available while the launchpad is paused.",
  OwnableUnauthorizedAccount: "That action is restricted to the launchpad owner.",
  OwnableInvalidOwner: "That owner address is not valid.",
  OwnershipCannotBeRenounced: "Ownership of this contract cannot be renounced.",
  ReentrancyGuardReentrantCall: "That call re-entered the contract and was rejected.",
  SafeERC20FailedOperation: "A token transfer failed. If this is USDC, check that your wallet is not blocked and has enough balance.",
  // Configuration guards. A user should never see these; if one appears, it is a bug or a
  // misconfiguration, and saying so is more honest than inventing a user-facing cause.
  BaseFeeCeilingExceeded: "The launchpad's fee settings are inconsistent and launching is blocked until an operator fixes them.",
  BpsExceedsDenominator: "A fee setting is out of range. This is a configuration problem, not something you did.",
  FeeBelowCreatorShare: "A fee setting is inconsistent. This is a configuration problem, not something you did.",
  FeeExceedsCeiling: "A fee setting exceeds the allowed maximum. This is a configuration problem.",
  CreatorBuyShareExceedsFee: "A creator fee setting is inconsistent. This is a configuration problem.",
  CreatorSellShareExceedsFee: "A creator fee setting is inconsistent. This is a configuration problem.",
  SnipeTaxCeilingExceeded: "The snipe-tax table is inconsistent with the base fee. This is a configuration problem.",
  // Defensive assertions the arithmetic is supposed to make unreachable.
  CurveMathError: "The curve maths produced an impossible result and the trade was refused. Please report this.",
  ClampCostExceededOffer: "The partial-fill calculation exceeded what you offered and the trade was refused. Please report this.",
  ClampInputExceededOffer: "The partial-fill calculation exceeded what you offered and the trade was refused. Please report this.",
};

function build() {
  const iface = new Interface(abi);
  const errors = abi.filter((x) => x.type === "error");
  const missing = errors.map((e) => e.name).filter((n) => !COPY[n]);
  const extra = Object.keys(COPY).filter((n) => !errors.some((e) => e.name === n));

  const entries = errors.map((e) => {
    const f = iface.getError(e.name);
    return `  "${f.selector}": { name: ${JSON.stringify(e.name)}, sig: ${JSON.stringify(f.format("sighash"))}, message: ${JSON.stringify(COPY[e.name] || "")} },`;
  }).join("\n");

  const js = `// GENERATED by scripts/gen-revert-copy.js — DO NOT HAND-EDIT.
// Regenerate after any contract change: node scripts/gen-revert-copy.js
//
// On Arc, ethers does not decode custom errors. A revert arrives as a raw provider error
// with code 3, \`e.revert\` and \`e.shortMessage\` both undefined, and the 4-byte selector in
// \`e.data\`. Verified against 0xEDeed1F0: EconomicsChanged() is 0x444df1ec. Matching the
// selector is matching ABI data, which survives the node upgrades that reword messages —
// Zero8 changes those on 3 September.
//
// ${errors.length} custom errors, all with copy.
const REVERT_BY_SELECTOR = {
${entries}
};

// Pull the 4-byte selector out of whatever shape the provider handed us. Arc returns it on
// \`e.data\`; other providers nest it. Checked in order, most specific first.
function revertSelector(err) {
  const candidates = [
    err?.data,
    err?.error?.data,
    err?.info?.error?.data,
    err?.error?.error?.data,
    err?.transaction?.data && err?.revert === null ? null : undefined,
  ];
  for (const c of candidates) {
    if (typeof c === "string" && c.startsWith("0x") && c.length >= 10) return c.slice(0, 10);
    if (c && typeof c === "object" && typeof c.data === "string" && c.data.startsWith("0x")) {
      return c.data.slice(0, 10);
    }
  }
  return null;
}

// Human-readable copy for a revert. NEVER returns silence: an unrecognised selector says
// so and shows the selector, because "something went wrong" with no detail is what makes
// a stuck user unable to describe the problem or search for it.
function explainRevert(err, fallback) {
  const sel = revertSelector(err);
  if (sel && REVERT_BY_SELECTOR[sel]) {
    return { known: true, selector: sel, name: REVERT_BY_SELECTOR[sel].name, message: REVERT_BY_SELECTOR[sel].message };
  }
  if (sel) {
    return {
      known: false, selector: sel, name: null,
      message: "The contract rejected this for a reason this page does not recognise "
             + "(error " + sel + "). This is likely a version mismatch between the page and "
             + "the deployed contract — please report it with that code.",
    };
  }
  // No selector at all: a network/wallet-layer failure rather than a contract revert.
  const raw = err?.shortMessage || err?.reason || err?.message || "";
  return {
    known: false, selector: null, name: null,
    message: raw ? raw : (fallback || "Something went wrong and no reason was returned."),
  };
}

if (typeof window !== "undefined") {
  window.REVERT_BY_SELECTOR = REVERT_BY_SELECTOR;
  window.explainRevert = explainRevert;
  window.revertSelector = revertSelector;
}
if (typeof module !== "undefined") module.exports = { REVERT_BY_SELECTOR, explainRevert, revertSelector };
`;
  return { js, missing, extra, count: errors.length };
}

// ── i18n parity, delegated ─────────────────────────────────────────────────────
//
// The requirement: a custom error must not ship with copy in one language and missing in
// another. Enforcement lives in app/scripts/verify-i18n.mts, which owns the locale
// catalogues and knows which locales are SHIPPED (and must therefore be complete) versus
// PLANNED (reported only).
//
// This DELEGATES rather than duplicating the rule. Two implementations of "every error
// has copy" would eventually disagree, and the one that disagrees silently is the one
// that lets a gap through -- which is precisely the failure this check exists to prevent.
//
// Runs under --experimental-strip-types because the catalogues are TypeScript, and being
// typed is what makes a misspelled key a compile error rather than an invisible fallback
// to English.
function checkI18n() {
  const { spawnSync } = require("child_process");
  const script = path.join(ROOT, "app", "scripts", "verify-i18n.mts");
  if (!fs.existsSync(script)) {
    console.error(`i18n check missing at ${script}. Refusing to generate.`);
    process.exit(1);
  }
  const r = spawnSync(process.execPath, ["--experimental-strip-types", script], {
    encoding: "utf8",
    stdio: "pipe",
  });
  const out = `${r.stdout || ""}${r.stderr || ""}`;
  if (r.status !== 0) {
    console.error(out);
    console.error("");
    console.error("i18n parity check FAILED — refusing to generate revert copy.");
    console.error("Every custom error needs copy in every SHIPPED locale. See app/src/i18n/.");
    process.exit(1);
  }
  out
    .split("\n")
    .filter((l) => l.includes("custom error") || l.includes("every UI key") || l.includes("keys ("))
    .forEach((l) => console.log(l));
}

const { js, missing, extra, count } = build();

if (missing.length) {
  console.error(`MISSING COPY for ${missing.length} custom error(s): ${missing.join(", ")}`);
  console.error("Add an entry to COPY in scripts/gen-revert-copy.js. Refusing to generate.");
  process.exit(1);
}
if (extra.length) console.warn(`note: COPY has entries for errors not in the ABI: ${extra.join(", ")}`);

checkI18n();

if (process.argv.includes("--check")) {
  const cur = fs.existsSync(OUT) ? fs.readFileSync(OUT, "utf8") : "";
  if (cur !== js) { console.error("frontend/revert-errors.js is out of date. Run: node scripts/gen-revert-copy.js"); process.exit(1); }
  console.log(`frontend/revert-errors.js is up to date (${count} errors)`);
} else {
  fs.writeFileSync(OUT, js);
  console.log(`wrote frontend/revert-errors.js — ${count} custom errors, all with copy`);
}
