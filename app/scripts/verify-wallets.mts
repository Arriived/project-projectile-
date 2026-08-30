// Which wallet connectors get offered, and whether the dangerous one can reappear.
//
// WHY THIS EXISTS. The app used wagmi's generic `injected()` connector, which binds to
// `window.ethereum`. With MetaMask and Phantom both installed that object is CONTESTED:
// measured on a real machine, two providers announced via EIP-6963, `window.ethereum`
// carried a contested `providers[]`, and the two answered `eth_chainId` DIFFERENTLY --
// Phantom 0x1, MetaMask 0x4cef52.
//
// So the chain guard read one wallet while the user watched another. The automatic prompt
// never fired and the switch button failed with `"Injected" does not support programmatic
// chain switching` -- the generic connector, named "Injected", being asked to switch.
//
// Three rounds of fixes before this one passed against an injected test double and failed
// against the real wallet, because the double presented ONE provider. The scenario below
// is the real machine's: two announcers plus the generic one.
//
// Run: npm run verify:wallets
//
// To prove it can go red: in lib/wallets.ts make selectWallets return `connectors.slice()`
// unconditionally -- i.e. offer the generic connector alongside named wallets, the exact
// original bug -- and W2, W3 and the invariant all fail.

import {
  selectWallets,
  walletLabel,
  isGenericInjected,
  GENERIC_INJECTED_ID,
  type WalletChoice,
} from "../src/lib/wallets.ts";

const generic: WalletChoice = { uid: "u0", id: GENERIC_INJECTED_ID, name: "Injected" };
const metamask: WalletChoice = { uid: "u1", id: "io.metamask", name: "MetaMask", rdns: "io.metamask" };
const phantom: WalletChoice = { uid: "u2", id: "app.phantom", name: "Phantom", rdns: "app.phantom" };

let failures = 0;
const check = (label: string, pass: boolean, detail = "") => {
  if (!pass) failures++;
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${label}${detail ? `  — ${detail}` : ""}`);
};

// W1 — the reported machine: MetaMask + Phantom + the generic connector.
{
  const offered = selectWallets([generic, metamask, phantom]);
  check(
    "W1  two wallets discovered -> the generic connector is NOT offered",
    !offered.some(isGenericInjected),
    `offered: ${offered.map((w) => w.name).join(", ")}`
  );
  check(
    "W2  both named wallets ARE offered (no picking a winner for the user)",
    offered.length === 2 && offered.some((w) => w.name === "MetaMask") && offered.some((w) => w.name === "Phantom"),
    `${offered.length} offered`
  );
}

// W3 — one wallet installed. Still specific, still never the generic one.
{
  const offered = selectWallets([generic, metamask]);
  check(
    "W3  one wallet discovered -> only that wallet, generic still dropped",
    offered.length === 1 && offered[0].name === "MetaMask",
    `offered: ${offered.map((w) => w.name).join(", ")}`
  );
}

// W4 — nothing announces. The generic connector is the ONLY way in, and here it is safe:
// window.ethereum cannot be contested if nothing else is there to contest it.
{
  const offered = selectWallets([generic]);
  check(
    "W4  nothing discovered -> generic is offered as the last resort",
    offered.length === 1 && isGenericInjected(offered[0]),
    "uncontested by definition when nothing announced"
  );
}

// W5 — no connectors at all.
{
  const offered = selectWallets([]);
  check("W5  no connectors at all -> offer nothing", offered.length === 0);
}

// W6 — the label must name the wallet, because with two extensions "connected" is not
// enough for a user to know which one the page is bound to.
{
  check("W6  label names a discovered wallet", walletLabel(metamask) === "MetaMask", walletLabel(metamask));
  check(
    "W7  label flags the generic connector as unidentified rather than pretending",
    walletLabel(generic).includes("unidentified"),
    walletLabel(generic)
  );
  // W8 changed shape when i18n landed. walletLabel no longer owns any user-facing English:
  // the "not connected" wording is the CALLER's, supplied from the locale catalogue, so
  // this module stays free of untranslated copy and remains testable without an i18n
  // runtime. Empty here means "nothing to label", which is the honest answer.
  check(
    "W8  no connector -> empty; the caller supplies the not-connected wording",
    walletLabel(undefined) === "",
    JSON.stringify(walletLabel(undefined))
  );
  // The generic-connector phrasing is injectable so it can be translated. Proving the
  // injection is used matters: a formatter that silently ignored its argument would leave
  // English in the UI for every locale, and nothing else would catch it.
  check(
    "W9  the unidentified phrasing is taken from the injected formatter",
    walletLabel(generic, (n) => `<<${n}>>`) === "<<Injected>>",
    walletLabel(generic, (n) => `<<${n}>>`)
  );
}

// The invariant that outranks the rows: the generic connector may only ever be offered
// when it is the ONLY thing available. If a future edit widens that, this fails even if
// the rows above were updated to match.
{
  const cases: WalletChoice[][] = [
    [generic, metamask, phantom],
    [generic, metamask],
    [generic, phantom],
    [generic],
    [metamask, phantom],
    [],
  ];
  const violations = cases.filter((input) => {
    const offered = selectWallets(input);
    return offered.some(isGenericInjected) && offered.length > 1;
  });
  check(
    "INVARIANT  the generic connector is never offered alongside a named wallet",
    violations.length === 0,
    `${violations.length} violation(s)`
  );
}

const total = 10;
console.log(`\n${total - failures}/${total} checks passed`);
if (failures) process.exit(1);
