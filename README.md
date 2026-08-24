# Ballista

A memecoin launchpad native to [Arc](https://docs.arc.io), Circle's stablecoin L1 where
USDC is the native gas token. Tokens launch on a bonding curve and graduate to a DEX
pool once the curve fills.

The contract is deployed and verified on Arc Testnet under the neutral name **`LFX1`**.
That is deliberate — see [Naming](#naming).

---

## Status

| | |
|---|---|
| Solidity | 0.8.24, optimizer on, 200 runs |
| Tests | 207 Hardhat, 6 Foundry (5 invariants + reachability) |
| Bytecode | 22,888 / 24,576 bytes (1,688 free) |
| Network | Arc Testnet, chainId 5042002 |
| Audit | **None.** No third-party audit has been done. |

---

## Curve parameters

These six values are one derivation, not six independent knobs — changing any in
isolation breaks the graduation gap and the price multiple.

```
INITIAL_VIRTUAL_USDC_RESERVES   2_667e6
INITIAL_VIRTUAL_TOKEN_RESERVES  1_075_000_000e18
CURVE_TOKEN_SUPPLY                807_000_000e18
LP_TOKEN_RESERVE                  193_000_000e18
TOTAL_TOKEN_SUPPLY              1_000_000_000e18
graduation threshold                    8_000e6   (8,000 USDC)
```

Measured on these constants: depletion ceiling **$8,030.85**, graduation gap **+4.16%**,
launch-to-graduation multiple **16.05x**, graduation market cap ~**$39,687**.

Graduation fires on either arm of a dual trigger — `realUsdcReserves >= threshold` **or**
`tokenReserves == 0`. The state machine is `ACTIVE → GRADUATION_READY → GRADUATED`,
one-way. `graduate()` is permissionless and retryable, so no backend of ours can block a
token reaching the DEX.

## Fees

- **1%** on buys and sells, snapshotted per token at creation.
- Creator share: **90%** of the buy-side fee, **50%** of the sell-side — blending to
  **70%** at an even mix.
- Creation fee: **0.5 USDC**.
- All fees **accrue and are claimed**. Nothing is pushed to a payee inside a trade, so a
  payee that cannot receive USDC can never break trading or launching.
- A decaying snipe tax applies to buys for the first seven seconds of a token's life:
  `[9800, 9500, 9000, 8000, 6000, 4000, 2000, 0]` bps by elapsed second. Tables are
  immutable per version; each token snapshots the version it launched under.

---

## Build and test

```bash
npm install
git submodule update --init      # forge-std, for the Foundry suite
npx hardhat compile
npx hardhat test                 # 207 passing
forge test                       # 6 passing
```

Guard coverage — disables each revert guard in turn and reports whether any test notices:

```bash
python scripts/guard-coverage.py
```

Copy `.env.example` to `.env` and fill it in before running anything against a network.
Use a wallet created for this purpose; never one holding real funds.

---

## Deployed

Arc Testnet. Both exact-match verified on Blockscout.

| | address |
|---|---|
| **LFX1** | `0x7072b0f726526B616101473aB6579A8F58fee1fb` (block 58301503) |
| MockRouter (**placeholder, not a real DEX**) | `0xe3287055068C662a4f03eA3Ae6ceF032C3A32F37` |
| USDC | `0x3600000000000000000000000000000000000000` |

Explorer: https://testnet.arcscan.app/address/0x7072b0f726526B616101473aB6579A8F58fee1fb

`deployments/arcTestnet.json` is the authoritative record, written by `scripts/deploy.js`
on every deploy. It records the commit the deployment was built from — the live
deployment predates later commits, so verifying from `HEAD` will not reproduce it.

---

## Naming

Everything outside `contracts/` says Ballista. Everything inside `contracts/` keeps the
neutral `LFX1` / `LFX1Token` naming, **filenames included**, and so do the
`getContractFactory('LFX1')` strings that tests and scripts use to reach them.

This is not half-finished work. Blockscout publishes the source *path*, not just the
contract name, so the verified deployment serves `contracts/LFX1.sol` to anyone browsing
the explorer. Renaming those files would publish the brand to every competitor scanning
ArcScan; renaming only the contract and not the file achieves nothing for the same
reason. The switch happens at mainnet.

## Layout

- `contracts/LFX1.sol` — token creation, the bonding curve, graduation, fees, the snipe
  tax, and the admin surface.
- `contracts/LFX1Token.sol` — the fixed-supply ERC20 minted once per launch. It has no
  `mint` function.
- `contracts/interfaces/IDEXRouter.sol` — the graduation interface.
- `contracts/mocks/` — test infrastructure only. Never deploy these.
- `test/` — Hardhat suites; Foundry invariants under `test/invariant/`.
- `scripts/` — deploy, preflight, smoke test, guard coverage.
- `indexer/` — event indexer writing into Supabase.
- `ARCHITECTURE.md` — the reasoning behind the code, kept out of the deployed source.

## Licence

**BUSL-1.1.** Source-available; commercial use restricted until the Change Date of
**2030-09-16**, when it converts to **GPL-2.0-or-later**. See [`LICENSE`](LICENSE).
OpenZeppelin's sources remain MIT and are unaffected.
