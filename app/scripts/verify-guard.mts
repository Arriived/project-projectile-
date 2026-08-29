// Walks the fail-closed truth table for resolveArcGuard().
//
// WHY THIS EXISTS. WalletBar used wagmi's `useChainId()`, which returns the CONFIG's
// chain rather than the WALLET's, and wagmi deliberately refuses to move config state to
// an unconfigured chain (@wagmi/core createConfig.js: "If chain is not configured, then
// don't switch over to it"). With a single-chain config that made `chainId === arc.id`
// structurally always true and the wrong-network branch unreachable. Connecting a wallet
// on Ethereum Mainnet showed a green "Arc Testnet" pill.
//
// The browser reproduction that caught it was a one-off with an injected provider. This
// is the version that runs every time.
//
// Run: npm run verify:guard
//
// To prove it can go red: in lib/arcGuard.ts, change the `probedChainId === undefined`
// branch to return `{ status: "ok", canTransact: true, ... }` -- i.e. treat "unconfirmed"
// as usable, the exact fail-OPEN mistake -- and row 6 fails.

import { resolveArcGuard } from "../src/lib/arcGuard.ts";

const ARC = 5042002;
const MAINNET = 1;

type Row = {
  name: string;
  input: Parameters<typeof resolveArcGuard>[0];
  expectStatus: string;
  expectCanTransact: boolean;
};

const rows: Row[] = [
  {
    name: "not connected",
    input: { isConnected: false, accountChainId: undefined, probedChainId: undefined, arcId: ARC },
    expectStatus: "disconnected",
    expectCanTransact: false,
  },
  {
    name: "not connected, but a stale chain id lingers -> still disconnected",
    input: { isConnected: false, accountChainId: ARC, probedChainId: ARC, arcId: ARC },
    expectStatus: "disconnected",
    expectCanTransact: false,
  },
  {
    name: "THE ORIGINAL BUG: connected on Ethereum Mainnet",
    input: { isConnected: true, accountChainId: MAINNET, probedChainId: MAINNET, arcId: ARC },
    expectStatus: "wrong",
    expectCanTransact: false,
  },
  {
    name: "connected, wagmi reports no chain at all -> fail closed",
    input: { isConnected: true, accountChainId: undefined, probedChainId: undefined, arcId: ARC },
    expectStatus: "unknown",
    expectCanTransact: false,
  },
  {
    name: "connected, wagmi says Arc but the probe says mainnet -> the probe wins",
    input: { isConnected: true, accountChainId: ARC, probedChainId: MAINNET, arcId: ARC },
    expectStatus: "wrong",
    expectCanTransact: false,
  },
  {
    name: "connected, wagmi says Arc, probe refused to answer -> fail closed",
    input: { isConnected: true, accountChainId: ARC, probedChainId: undefined, arcId: ARC },
    expectStatus: "unknown",
    expectCanTransact: false,
  },
  {
    name: "connected, wagmi says mainnet, probe says Arc -> still not usable",
    input: { isConnected: true, accountChainId: MAINNET, probedChainId: ARC, arcId: ARC },
    expectStatus: "wrong",
    expectCanTransact: false,
  },
  {
    name: "BOTH sources positively agree on Arc -- the only transactable row",
    input: { isConnected: true, accountChainId: ARC, probedChainId: ARC, arcId: ARC },
    expectStatus: "ok",
    expectCanTransact: true,
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

// The invariant that matters more than any single row: exactly one input shape may be
// transactable. If a future edit widens that, this fails even if every row above was
// updated to match the new behaviour.
const transactable = rows.filter((r) => resolveArcGuard(r.input).canTransact);
const onlyRowIsBothAgree =
  transactable.length === 1 &&
  transactable[0].input.accountChainId === ARC &&
  transactable[0].input.probedChainId === ARC;
if (!onlyRowIsBothAgree) failures++;
console.log(
  `  ${onlyRowIsBothAgree ? "PASS" : "FAIL"}  exactly one row is transactable, and it is the both-agree row` +
    `  — ${transactable.length} transactable`
);

console.log(`\n${rows.length + 1 - failures}/${rows.length + 1} checks passed`);
if (failures) process.exit(1);
