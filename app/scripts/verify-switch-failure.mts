// Classifying a failed network switch.
//
// ⚠ THE DEFECT: wagmi's WalletConnect connector rethrows EVERY failure in the switch path
// as `UserRejectedRequestError` (@wagmi/connectors walletConnect.js:286-288). So a chain
// that was never in the approved session is reported as a user declining a prompt that was
// never shown. Measured on a real phone: the app read chain 1 and chain 84156418, the
// switch control did nothing, and the UI blamed the user.
//
// The error name therefore cannot discriminate — a genuine rejection and a namespace miss
// are the identical error type. Only the session's approved chains separate them, which is
// why `classifySwitchFailure` takes the namespace and checks it FIRST.

import {
  classifySwitchFailure,
  sessionChainIds,
  chainIdHex,
  type Eip155Namespace,
} from "../src/lib/switchFailure.ts";

let failures = 0;
const check = (label: string, pass: boolean, detail = "") => {
  if (!pass) failures++;
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${label}${detail ? `  — ${detail}` : ""}`);
};

const ARC = 5042002;
const ADDR = "0x64140EAa0a3B6E4682C98e440837bd3d5482B4cb";

// ── REAL-SHAPED FIXTURES ──────────────────────────────────────────────────────────────
// These are CAIP-25 `eip155` namespaces as a wallet actually returns them: `accounts` are
// CAIP-10 (`eip155:<chain>:<address>`), `methods` and `events` are the real wire strings.
// 84156418 is the value observed on the phone — it is `0x5042002`, i.e. Arc's DECIMAL
// digits parsed as hex, and it is what made this worth diagnosing rather than guessing.
const OBSERVED: Eip155Namespace = {
  chains: ["eip155:1", "eip155:84156418"],
  accounts: [`eip155:1:${ADDR}`, `eip155:84156418:${ADDR}`],
  methods: ["eth_sendTransaction", "personal_sign", "eth_signTypedData_v4", "wallet_switchEthereumChain"],
  events: ["chainChanged", "accountsChanged"],
};

// ⚠ `chains` ABSENT. This is not a defensive invention: CAIP-25 only guarantees
// `accounts`, and real wallets return namespaces with no `chains` key. A reader that
// trusts `chains` sees an empty list here and would wrongly conclude nothing is offered.
const ACCOUNTS_ONLY: Eip155Namespace = {
  accounts: [`eip155:1:${ADDR}`, `eip155:84156418:${ADDR}`],
  methods: ["eth_sendTransaction", "personal_sign"],
  events: ["chainChanged", "accountsChanged"],
};

// The session we WANT: Arc actually approved.
const WITH_ARC: Eip155Namespace = {
  chains: ["eip155:5042002"],
  accounts: [`eip155:5042002:${ADDR}`],
  methods: ["eth_sendTransaction", "personal_sign"],
  events: ["chainChanged", "accountsChanged"],
};

const REJECTED = { name: "UserRejectedRequestError", message: "User rejected the request." };

console.log("\nreading the approved chains out of a session namespace");
check("F1  chains are read when present", sessionChainIds(OBSERVED).join() === "1,84156418", sessionChainIds(OBSERVED).join());
check(
  "F2  ⚠ chains are DERIVED from accounts when the `chains` key is absent",
  sessionChainIds(ACCOUNTS_ONLY).join() === "1,84156418",
  sessionChainIds(ACCOUNTS_ONLY).join()
);
check("F3  an Arc session reads as Arc", sessionChainIds(WITH_ARC).join() === String(ARC));
check("F4  an absent namespace yields nothing rather than throwing", sessionChainIds(undefined).length === 0);
check("F5  a namespace with neither key yields nothing", sessionChainIds({}).length === 0);
check(
  "F6  non-eip155 namespaces are ignored",
  sessionChainIds({ accounts: ["solana:mainnet:abc", `eip155:1:${ADDR}`] }).join() === "1"
);
check(
  "F7  malformed segments are skipped, not coerced",
  // Number("") is 0 and Number("0x1") is 1; neither was given to us as a chain id.
  sessionChainIds({ chains: ["eip155:", "eip155:0x1", "eip155:abc", "eip155:1"] }).join() === "1",
  sessionChainIds({ chains: ["eip155:", "eip155:0x1", "eip155:abc", "eip155:1"] }).join()
);

console.log("\nclassifying the failure");
check(
  "F8  ⚠ the observed session -> NOT-IN-SESSION, despite the error saying 'user rejected'",
  classifySwitchFailure({ error: REJECTED, namespace: OBSERVED, targetChainId: ARC }).kind === "not-in-session",
  "this is the whole point: the name lies, the namespace does not"
);
const cls = classifySwitchFailure({ error: REJECTED, namespace: OBSERVED, targetChainId: ARC });
check(
  "F9  it reports WHAT was offered, so the message can name it",
  cls.kind === "not-in-session" && cls.offered.join() === "1,84156418" && cls.target === ARC,
  cls.kind === "not-in-session" ? `offered ${cls.offered.join(", ")} target ${cls.target}` : cls.kind
);
check(
  "F10 ⚠ the accounts-only session classifies identically",
  classifySwitchFailure({ error: REJECTED, namespace: ACCOUNTS_ONLY, targetChainId: ARC }).kind === "not-in-session"
);
check(
  "F11 ⚠ when Arc IS offered, a rejection is a REAL rejection",
  classifySwitchFailure({ error: REJECTED, namespace: WITH_ARC, targetChainId: ARC }).kind === "declined",
  "the existing copy is correct here and must not be replaced"
);
check(
  "F12 no session (injected wallet) -> falls back to the error name, unchanged behaviour",
  classifySwitchFailure({ error: REJECTED, namespace: undefined, targetChainId: ARC }).kind === "declined"
);
check(
  "F13 an unclassifiable error with no session is `unknown`, not a guess",
  classifySwitchFailure({ error: { name: "SomethingElse", message: "boom" }, namespace: undefined, targetChainId: ARC })
    .kind === "unknown"
);
check(
  "F14 no error at all is `unknown`",
  classifySwitchFailure({ error: null, namespace: OBSERVED, targetChainId: ARC }).kind === "unknown"
);
check(
  "F15 ⚠ a NON-rejection error still reports not-in-session when the namespace says so",
  classifySwitchFailure({ error: { name: "SwitchChainError", message: "x" }, namespace: OBSERVED, targetChainId: ARC })
    .kind === "not-in-session",
  "the namespace outranks the error name in both directions"
);

console.log("\nnaming the chain the way a wallet shows it");
check("F16 5042002 renders as 0x4cef52", chainIdHex(ARC) === "0x4cef52", chainIdHex(ARC));
check(
  "F17 ⚠ 84156418 renders as 0x5042002 — Arc's decimal digits read as hex, which is the bug",
  chainIdHex(84156418) === "0x5042002",
  chainIdHex(84156418)
);

console.log(failures === 0 ? `\n  all switch-failure checks passed\n` : `\n  ${failures} FAILED\n`);
// process.exitCode, not process.exit() — see the note in the other verify scripts.
process.exitCode = failures === 0 ? 0 : 1;
