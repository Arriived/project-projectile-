# Frontend rebuild — React, wagmi, viem

Read `CLAUDE.md` in full first, then `FRONTEND_BUILD_V2.md`. **The nine hard rules in that
file are the specification; this document is about how to build against them.**

Decision made: we are rebuilding the frontend in React with wagmi and viem. The plain-HTML
constraint in `CLAUDE.md` is revoked — updated there, with the reasoning recorded so no
future session tries to enforce it. **Do not re-argue this.**

The contract is frozen and deployed at `0xEDeed1F05D34421Add0F59b7340588ab2BbaC04b`.
**Nothing here may result in a contract change.** If the frontend needs something the
contract doesn't provide, design around it and say so.

Report before writing code. The structure and the Phase 0 answers come first.

---

## What this is and isn't

**A rebuild that reuses proven decisions, not a port.** Be honest with yourself about that
distinction — expecting a port and finding a rebuild is how estimates slip silently.

| | |
|---|---|
| **Transfers unchanged** (logic, not code) | the ABI, the quote approach, the revert-error map and its generator, the gas-reserve arithmetic, the price-impact probe method, the Supabase queries, fee and decimal handling |
| **Rewritten** | every contract call (ethers → viem is not drop-in), the wallet layer (hand-rolled → wagmi hooks), `withRetry` (viem has its own), all DOM code |
| **New** | Vite config, project structure, routing, the Arc custom chain definition |

**Kept and must still pass: `scripts/verify-frontend-txshapes.js`.** It proved the
transaction shapes against the live chain and it is the check that this rebuild lost
nothing. If it can't run unchanged, adapt it — don't delete it.

---

## Phase 0 — answer these before writing anything

### 0.1 The Arc chain definition is the highest-risk config in the build

viem chains carry `nativeCurrency: { name, symbol, decimals }`. **Arc's native currency is
USDC at 18 decimals, while the ERC-20 interface is 6.** Getting this wrong misprices gas by
a factor of 10¹² and **it will not throw** — it will render a confident wrong number.

Report the exact chain object intended, and say where each field came from. Check whether
viem already ships an Arc definition (`viem/chains`) rather than hand-rolling one; if it
does, verify its `nativeCurrency.decimals` against Arc's docs before trusting it. Query the
`arc-docs` MCP server rather than recalling.

### 0.2 Does wagmi/viem's fee estimation respect Arc's floor?

Rule 6: `maxFeePerGas` below 20 Gwei may pend indefinitely. wagmi's transaction hooks
estimate fees automatically. Find out what they produce on Arc and whether the estimate can
fall below the floor. If it can, we need an explicit floor applied to every write, and the
mechanism must be reported before it is built.

Arc's `eth_estimateGas` also returns no margin. Determine how wagmi/viem's gas estimation
interacts with that.

### 0.3 Custom error decoding

viem is supposed to decode custom errors properly, which ethers demonstrably did not do on
Arc — five sites showed "Unknown error" for every contract revert. **Verify this rather than
assume it.** Force a real revert against `0xEDeed1F0…` and inspect what viem returns.

If viem decodes correctly, the generated `revert-errors.js` map may become redundant — but
**keep the generator and the build check either way**, because it also guarantees every
error has human copy. Report which parts are still needed.

### 0.4 The 5792 / batching path

viem has `walletActions` for EIP-5792. Report what it exposes, whether it subsumes the
hand-rolled capability check, and confirm **`atomicRequired: true` is preservable** — a
partial batch would leave an allowance the user never knowingly granted.

### 0.5 Structure

Propose the file layout, routing, and how state is divided between wagmi hooks, React Query,
and local component state. **Keep it flat and obvious. Do not introduce a state management
library.**

---

## Known traps — every one of these has already bitten this project

Each is documented in `CLAUDE.md` or was found during frontend work. **They must survive the
rebuild.**

1. **Never re-derive curve math.** Use `quoteBuy`/`quoteSell` on the contract. The deleted JS
   re-implementation overstated output by **98.96× at t=0**, which put `minTokensOut` ~97×
   above anything achievable and would have reverted every buy in the opening seconds of a
   launch.
2. **`quoteSell` returns gross and fee separately; `sell()` compares `minUsdcOut` against
   net.** Quoting gross sets an unreachable floor and reverts every sell.
3. **`currentPrice()` is unusable for price impact** — it evaluates to the integer `2` at
   launch scale, so impact renders 0.00% and silently lies. Use the probe-quote method:
   compare the trade's rate against a 0.01 USDC quote.
4. **Decimals: launch tokens are 18, USDC is 6.** "USDC is 6 decimals" is a standing rule and
   `6` appears throughout the old code. Pass 6 where 18 belongs and a balance renders a
   trillion times too large.
5. **`minTokensOut`/`minUsdcOut` must never be zero**, and must be sized from the rate quoted,
   not the total, so a clamped fill still settles.
6. **Quotes go stale within a second during the snipe window.** Re-quote immediately before
   signing. The received amount can also differ from the quote because the tax decays and the
   clamp can bind — **read the actual amount from the receipt, never display the quote as the
   outcome.**
7. **Async quote races.** A slow response for a superseded amount must not overwrite a newer
   one. React Query should handle this; verify it does.
8. **Sells are closed in `GRADUATION_READY`, not just `GRADUATED`.** Gate on the state enum,
   not on `graduated`.
9. **Gas reserve.** USDC is both gas and settlement. A user who spends 100% cannot sell — R15
   proved it live: 471 trillion tokens held, 0.0016 USDC, unable to exit. Show "available to
   trade" as balance minus reserve, sized from a live fee reading with headroom. Live testnet
   fees measured **41 Gwei against a 20 Gwei floor**.
10. **Never parse revert strings to detect insufficient gas.** Compare balance against an
    estimate before submitting. Zero8 changed those strings on 3 September and Arc's docs say
    they are not a stable contract.
11. **Approve exactly the creation fee, never `MaxUint256`** — `creationFeeUsdc` is not in
    `currentEconomicsHash()`, so an unlimited approval is a drain vector. Trading approvals are
    not subject to this.
12. **Fetch `expectedEconomicsHash` in the same action that sends the transaction.** Never
    cache it. A stale pin reverts `EconomicsChanged` (`0x444df1ec`).
13. **Order by `blockNumber` then `logIndex`, never `block.timestamp`.** Sub-second blocks
    share timestamps. Fails silently as out-of-order trades.
14. **`tokens_with_volume` under SECURITY INVOKER returns zero rows with no error** if RLS
    policies are missing. An empty token list looks like "no launches yet."
15. **MetaMask does not autodetect launched tokens**, and because USDC is the native balance
    the user watches their headline number drop with nothing arriving. Show the wallet's
    balance of the viewed token prominently and offer `wallet_watchAsset` — **with 18
    decimals**.
16. **Symbols over 11 characters cannot be one-click-added** and `createToken` validates
    nothing. Warn in the create form; do not block what the contract accepts.
17. **WalletConnect** — Arc isn't in its chain registry, so it issues `wallet_addEthereumChain`
    per user. Confirm how wagmi's connector handles this and that the chain params are right,
    including 18-decimal native USDC.
18. **Read fees per-token from `curves()`.** Never assume a flat rate.
19. **The indexer is a speed layer, not a trust layer.** If Supabase is unreachable, read the
    contract directly and show degraded-but-correct data rather than nothing. The project has
    already paused on us once.
20. **The anon key is public by design, but the service-role key must never reach the browser**
    in any form, including via a bundler env var. Verify what Vite inlines — `VITE_`-prefixed
    variables end up in the client bundle.
21. **Indexer reserves arrive as JSON numbers past `MAX_SAFE_INTEGER` and are silently
    truncated.** PostgREST serialises `uint256` columns as JSON numbers, so a reserve value
    crosses the wire having already lost its low digits. Measured against the live chain for
    `0x2b4a6568…`:

    ```
    chain    tokenReserves = 806923426733348829188192159
    indexer (JSON number)  = 806923426733348800000000000
    difference             = 30,224,021,407 wei
    ```

    **`BigInt()` accepts the truncated value without throwing** — it is already a whole
    number by the time JavaScript sees it, so there is nothing left for a guard to catch. The
    existing `safeBigInt` helper passes it straight through. This is the silent-failure shape,
    not the loud one.

    **Therefore: indexer reserve fields are named `approx*` (`approxTokenReserves`,
    `approxVirtualUsdcReserves`, …) and are display-only.** Anything the user acts on — every
    quote, every `minOut`, every affordability check — comes from the chain. This is a second,
    independent reason for trap 1 beyond staleness: the deleted JS curve math was reading
    exactly these fields, so even correct arithmetic on them would have been wrong.

    A field named `tokenReserves` invites `BigInt(row.tokenReserves)`. The naming is the
    guard, because no runtime check can be.

---

## Roadmap

**Report at the end of each phase. Do not start the next until told.**

| phase | scope |
|---|---|
| **1 — scaffold** | Vite, React, wagmi, viem, React Query. Arc chain definition. Wallet connect with chain switching. Nothing else. Prove a read against `0xEDeed1F0…` works |
| **2 — token page** | The unit of navigation. Price, price impact as the headline number, curve progress, creator launch purchase percentage, the connected wallet's balance of this token, socials, verified-contract link, buy and sell. Quotes from the contract. **Traps 1–10 all live here** |
| **3 — token list** | Reading `tokens_with_volume` through the anon key, with the RPC fallback from trap 19 |
| **4 — create flow** | Five-arg `createToken`, hash fetched in the same action, exact-fee approval, symbol-length warning |
| **5 — batching** | 5792 as progressive enhancement, behind a capability check, falling back silently |
| **6 — break it** | Adversarial pass. See below |

---

## Sources — verify, don't recall

- **Arc:** the `arc-docs` MCP server is connected. Use it in preference to the §9 cache in
  `CLAUDE.md`, which is a dated snapshot.
- **wagmi:** `wagmi.sh` — chain config, connectors, transaction hooks.
- **viem:** `viem.sh` — custom chains, error handling, EIP-5792 actions.
- **TanStack Query:** for the racing and caching behaviour in trap 7.
- **MetaMask:** `docs.metamask.io` for `wallet_watchAsset` and 5792 support.
- **Our own contract:** `CONTRACT_INVENTORY.md` is generated from source. Prefer it to prose,
  and prefer the ABI to both.

**Cite the source for every external claim. Where you can only find secondary sources, say
so** — that distinction has caught real errors here, most recently with Rabby's 7702 support.

---

## Phase 6 — break it

When phases 1–5 are done, **stop building and attack what you built.** Not a test pass — an
adversarial one. **Report findings before fixing.**

- **Every trap above.** For each, construct the input that would trigger it and show the code
  refuses. **A trap you can't trigger deserves suspicion, not confidence.**
- **Wrong network, mid-transaction.** Switch chains between quote and sign.
- **Reject every prompt.** Connection, chain switch, approval, transaction. No path may leave
  the UI in a lying state.
- **Empty and hostile data.** No tokens, a token with an empty symbol, a symbol with emoji or
  RTL characters, a 200-character name, a metadata URI that 404s or returns HTML.
- **Supabase down.** Block the domain and confirm the RPC fallback engages.
- **RPC down or rate-limited.** The public endpoint stalls for 150 seconds under backfill;
  simulate that during a trade.
- **A curve in every state** — active, `GRADUATION_READY`, graduated. Confirm sells are
  refused in the middle state with an explanation, not a revert.
- **The snipe window.** Launch a token and buy at t=0, t=1, t=2. Confirm the quote matches
  settlement and the tax is shown, not hidden.
- **Zero and dust balances.** A wallet with exactly the gas reserve; one with half of it; one
  with nothing.
- **Slow network.** Throttle to 3G and check for races, double-submits, and buttons that stay
  enabled through a pending transaction.
- **Double-click everything.** Especially buy, sell and create.

Then fix what you found, and **prove each fix by reproducing the failure first and showing it
stops. A fix you can't demonstrate breaking beforehand is a guess.**

---

## Ground rules

Report before building, and at each phase boundary. Prove any new test can go red. **Nothing
is done until it has been clicked through in a browser with a real wallet against
`0xEDeed1F0…`** — the operator does that part, so say when it's ready and what to click. Flag
anything where the interface would show a number the contract wouldn't honour; **that is the
class of bug that matters here.** Don't say it's bulletproof.
