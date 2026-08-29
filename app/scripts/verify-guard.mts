// Walks the fail-closed truth table for resolveArcGuard().
//
// WHY THIS EXISTS -- two bugs, both fail-open, both found on a real wallet.
//
// 1. WalletBar used wagmi's `useChainId()`, which returns the CONFIG's chain rather than
//    the WALLET's, and wagmi refuses to move config state to an unconfigured chain
//    (@wagmi/core createConfig.js: "If chain is not configured, then don't switch over to
//    it"). With a single-chain config that made the wrong-network branch unreachable.
//    A wallet on Ethereum Mainnet showed a green "Arc Testnet" pill.
//
// 2. The first fix probed once and then waited for `chainChanged`. Reproduced with an
//    injected provider: change the chain WITHOUT emitting the event and the app made ZERO
//    further reads -- green and transactable indefinitely on the wrong chain. The same
//    defect is why clicking "switch" could turn the UI green without the switch
//    completing: any path that concludes "on Arc" from something other than a
//    present-tense reading is fail-open.
//
// Run: npm run verify:guard
//
// To prove it can go red, three independent mutations, each hitting a different row:
//   a) in lib/arcGuard.ts make `probedChainId === undefined` return ok  -> row 6 fails
//   b) delete the staleness check                                       -> rows 9, 10 fail
//   c) delete the `accountChainId !== arcId` check                      -> row 7 fails
// Each is also caught by the final invariant, which is the check that survives someone
// updating row expectations to match broken behaviour.

import { resolveArcGuard, shouldAutoPromptSwitch, MAX_PROBE_AGE_MS } from "../src/lib/arcGuard.ts";

const ARC = 5042002;
const MAINNET = 1;
const NOW = 1_000_000_000;
const FRESH = NOW - 1_000;
const STALE = NOW - (MAX_PROBE_AGE_MS + 5_000);

type Input = Parameters<typeof resolveArcGuard>[0];
type Row = { name: string; input: Input; expectStatus: string; expectCanTransact: boolean };

const base = { now: NOW, arcId: ARC };

const rows: Row[] = [
  {
    name: "not connected",
    input: { ...base, isConnected: false, accountChainId: undefined, probedChainId: undefined, probedAt: undefined },
    expectStatus: "disconnected",
    expectCanTransact: false,
  },
  {
    name: "not connected, but a stale chain id lingers -> still disconnected",
    input: { ...base, isConnected: false, accountChainId: ARC, probedChainId: ARC, probedAt: FRESH },
    expectStatus: "disconnected",
    expectCanTransact: false,
  },
  {
    name: "BUG 1: connected on Ethereum Mainnet",
    input: { ...base, isConnected: true, accountChainId: MAINNET, probedChainId: MAINNET, probedAt: FRESH },
    expectStatus: "wrong",
    expectCanTransact: false,
  },
  {
    name: "connected, wagmi reports no chain at all -> fail closed",
    input: { ...base, isConnected: true, accountChainId: undefined, probedChainId: undefined, probedAt: undefined },
    expectStatus: "unknown",
    expectCanTransact: false,
  },
  {
    name: "connected, wagmi says Arc but the probe says mainnet -> the probe wins",
    input: { ...base, isConnected: true, accountChainId: ARC, probedChainId: MAINNET, probedAt: FRESH },
    expectStatus: "wrong",
    expectCanTransact: false,
  },
  {
    name: "connected, wagmi says Arc, probe refused to answer -> fail closed",
    input: { ...base, isConnected: true, accountChainId: ARC, probedChainId: undefined, probedAt: undefined },
    expectStatus: "unknown",
    expectCanTransact: false,
  },
  {
    name: "connected, wagmi says mainnet, probe says Arc -> still not usable",
    input: { ...base, isConnected: true, accountChainId: MAINNET, probedChainId: ARC, probedAt: FRESH },
    expectStatus: "wrong",
    expectCanTransact: false,
  },
  {
    name: "BOTH sources agree on Arc and the reading is FRESH -- the only transactable row",
    input: { ...base, isConnected: true, accountChainId: ARC, probedChainId: ARC, probedAt: FRESH },
    expectStatus: "ok",
    expectCanTransact: true,
  },

  // ── the two rows the real-wallet session demanded ────────────────────────────

  {
    // BUG 2a. The user clicks "Switch to Arc", the wallet reports success, but the switch
    // never completed. Nothing may conclude "Arc" from the ATTEMPT -- only from a reading.
    // Here the attempt has happened and the freshest reading still says mainnet.
    name: "SWITCH ATTEMPTED BUT NOT COMPLETED: attempt reported ok, probe still says mainnet",
    input: { ...base, isConnected: true, accountChainId: ARC, probedChainId: MAINNET, probedAt: FRESH },
    expectStatus: "wrong",
    expectCanTransact: false,
  },
  {
    // BUG 2b. The check passed, then the wallet moved and emitted no event. The last
    // reading agrees with Arc but is old. Agreement is not enough; it must be CURRENT.
    name: "CHAIN CHANGED AFTER A SUCCESSFUL CHECK: last reading said Arc but has gone stale",
    input: { ...base, isConnected: true, accountChainId: ARC, probedChainId: ARC, probedAt: STALE },
    expectStatus: "unknown",
    expectCanTransact: false,
  },
  {
    // The boundary, so the staleness bound is a real number rather than a vibe.
    name: "reading exactly at the age limit is still usable",
    input: { ...base, isConnected: true, accountChainId: ARC, probedChainId: ARC, probedAt: NOW - MAX_PROBE_AGE_MS },
    expectStatus: "ok",
    expectCanTransact: true,
  },
  {
    name: "one millisecond past the limit is not",
    input: { ...base, isConnected: true, accountChainId: ARC, probedChainId: ARC, probedAt: NOW - MAX_PROBE_AGE_MS - 1 },
    expectStatus: "unknown",
    expectCanTransact: false,
  },
  {
    // Staleness must not launder a DISAGREEMENT into a mere "unknown": a stale reading
    // of mainnet is still positive evidence of mainnet, and must keep offering the switch.
    name: "stale AND disagreeing -> wrong, not unknown (disagreement outranks staleness)",
    input: { ...base, isConnected: true, accountChainId: ARC, probedChainId: MAINNET, probedAt: STALE },
    expectStatus: "wrong",
    expectCanTransact: false,
  },
];

let failures = 0;
for (const row of rows) {
  const got = resolveArcGuard(row.input);
  const ok = got.status === row.expectStatus && got.canTransact === row.expectCanTransact;
  if (!ok) failures++;
  console.log(
    `  ${ok ? "PASS" : "FAIL"}  ${row.name}\n` +
      `        expected ${row.expectStatus}/${row.expectCanTransact}, got ${got.status}/${got.canTransact}`
  );
}

// The invariant that outranks any single row: a transactable verdict requires a probe
// that is present, equal to Arc, AND fresh. If a future edit widens that, this fails even
// if every row above was updated to match the new behaviour.
const bad = rows
  .map((r) => ({ r, g: resolveArcGuard(r.input) }))
  .filter(
    ({ r, g }) =>
      g.canTransact &&
      !(
        r.input.isConnected &&
        r.input.accountChainId === ARC &&
        r.input.probedChainId === ARC &&
        r.input.probedAt !== undefined &&
        NOW - r.input.probedAt <= MAX_PROBE_AGE_MS
      )
  );
const invariantHolds = bad.length === 0;
if (!invariantHolds) failures++;
console.log(
  `  ${invariantHolds ? "PASS" : "FAIL"}  canTransact implies a present, matching, FRESH probe` +
    `  — ${bad.length} violation(s)`
);

// ── The automatic switch prompt on connect ────────────────────────────────────
//
// One prompt per connection, raised only once the wrong chain is POSITIVELY established,
// never while a switch is already in flight, and never again after a rejection.
//
// To prove these can go red: in lib/arcGuard.ts drop the `status !== "wrong"` guard and
// A2 fails (it would open a wallet popup on a chain we have not confirmed yet); drop the
// lastPromptedKey comparison and A4 fails (it would re-prompt after a rejection, forever).

const K1 = "connector-a:0xabc";
const K2 = "connector-b:0xdef";

type ARow = { name: string; input: Parameters<typeof shouldAutoPromptSwitch>[0]; expect: boolean };

const autoRows: ARow[] = [
  {
    name: "A1  wrong chain, never prompted -> PROMPT",
    input: { status: "wrong", connectionKey: K1, lastPromptedKey: null, isSwitching: false },
    expect: true,
  },
  {
    name: "A2  chain UNCONFIRMED -> do not prompt (would popup from our own latency)",
    input: { status: "unknown", connectionKey: K1, lastPromptedKey: null, isSwitching: false },
    expect: false,
  },
  {
    name: "A3  already on Arc -> do not prompt",
    input: { status: "ok", connectionKey: K1, lastPromptedKey: null, isSwitching: false },
    expect: false,
  },
  {
    name: "A4  REJECTED: already prompted this connection -> do NOT retry",
    input: { status: "wrong", connectionKey: K1, lastPromptedKey: K1, isSwitching: false },
    expect: false,
  },
  {
    name: "A5  a switch is already in flight -> do not stack a second popup",
    input: { status: "wrong", connectionKey: K1, lastPromptedKey: null, isSwitching: true },
    expect: false,
  },
  {
    name: "A6  a DIFFERENT connection -> earns its own single prompt",
    input: { status: "wrong", connectionKey: K2, lastPromptedKey: K1, isSwitching: false },
    expect: true,
  },
  {
    name: "A7  disconnected (no key) -> never prompt",
    input: { status: "wrong", connectionKey: undefined, lastPromptedKey: null, isSwitching: false },
    expect: false,
  },
];

for (const row of autoRows) {
  const got = shouldAutoPromptSwitch(row.input);
  const ok = got === row.expect;
  if (!ok) failures++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${row.name}\n        expected ${row.expect}, got ${got}`);
}

// Invariant: a prompt is only ever raised for a positively-wrong chain, on a connection
// not already prompted, with nothing in flight.
const badAuto = autoRows.filter(
  (r) =>
    shouldAutoPromptSwitch(r.input) &&
    !(
      r.input.status === "wrong" &&
      !!r.input.connectionKey &&
      r.input.lastPromptedKey !== r.input.connectionKey &&
      !r.input.isSwitching
    )
);
const autoInvariant = badAuto.length === 0;
if (!autoInvariant) failures++;
console.log(
  `  ${autoInvariant ? "PASS" : "FAIL"}  auto-prompt implies wrong chain + not yet prompted + not switching` +
    `  — ${badAuto.length} violation(s)`
);

const total = rows.length + autoRows.length + 2;
console.log(`\n${total - failures}/${total} checks passed`);
if (failures) process.exit(1);
