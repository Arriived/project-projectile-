# ARCHITECTURE — reasoning moved out of the deployed source

Every comment stripped from the contracts under the "deployed source says almost
nothing" policy is preserved here, grouped as it was written and anchored to the
declaration it documented. This file is published and verified NOWHERE.

**If you are about to change a constant, a modifier or a guard, read its entry
here first.** The reasoning is the most valuable thing in the project and this is
now the only copy of it.


---

## `contracts/Ballista.sol`  —  111 blocks

### `contract Ballista is Ownable, ReentrancyGuard, Pausable`
<sub>was line 13 of contracts/Ballista.sol</sub>

```solidity
/// @title Ballista
/// @notice Token launch + bonding curve trading + graduation, for a Pump.fun-style
///         launchpad on Arc, with two anti-spam / anti-rug features baked in from the
///         start rather than bolted on after a problem shows up:
///           1. Per-wallet launch cooldown + on-chain symbol uniqueness — this is the
///              direct fix for the failure mode that took down Noxa.fi on Robinhood
///              Chain (60k+ launches, bot spam, copycat tokens flooding the platform
///              faster than it could be moderated).
///           2. LP tokens sent to a burn address at graduation, permanently, by the
///              contract itself — not "the team promises to lock it," a guarantee
///              anyone can verify on-chain.
///
/// @dev PARAMETERS BELOW ARE ILLUSTRATIVE STARTING POINTS, not final business decisions.
///      The virtual-reserve and graduation-threshold constants are loosely modeled on
///      publicly documented Pump.fun curve parameters, translated to a USDC quote asset
///      (Arc uses USDC natively). Tune before any real deployment. This contract has NOT
///      been audited — do not point it at real funds until it has been.
```

### `uint256 public constant CURVE_TOKEN_SUPPLY = 807_000_000e18;`
<sub>was line 33 of contracts/Ballista.sol</sub>

```solidity
    // ── Token economics (per launched token) ──────────────────────────────
    /// @notice Tokens sold through the bonding curve. 807M of a 1B total supply.
    /// @dev Derived alongside the other curve constants for an $8,000 graduation, not
    ///      chosen independently -- see the block on INITIAL_VIRTUAL_USDC_RESERVES.
    ///
    ///      807M rather than the derivation's 806M is deliberate and load-bearing. At
    ///      806M the curve's DEPLETION CEILING -- the most realUsdcReserves can ever
    ///      reach, computed from the virtual reserves -- lands at $7,991, BELOW the
    ///      $8,000 threshold. The threshold would be structurally unreachable and every
    ///      token would graduate via the depletion fallback instead. Measured, not
    ///      assumed. 807M lifts the ceiling to $8,030.85, so the threshold is reachable
    ///      with $30.85 of headroom and depletion goes back to being a true fallback.
```

### `uint256 public constant LP_TOKEN_RESERVE = 193_000_000e18;`
<sub>was line 46 of contracts/Ballista.sol</sub>

```solidity
    /// @notice Tokens reserved for the DEX pool at graduation.
    /// @dev THE GAP DIAL. The pool receives `LP_TOKEN_RESERVE + tokenReserves` -- the
    ///      reserve plus whatever the curve never sold. A smaller reserve means a higher
    ///      opening pool price and a larger positive gap over the curve's close.
    ///
    ///      Sized for a +4% gap at the $8,000 threshold. Positive is the safe direction:
    ///      the pool opening ABOVE the curve's close means the last curve buyer is never
    ///      instantly underwater. It is not free, though -- a positive gap is exactly
    ///      what an arbitrageur extracts by buying the last curve tokens and selling
    ///      into the fresh pool, so it should stay small. Do not enlarge it: a big gap
    ///      is arbitraged away within minutes and hands whoever buys first on the DEX a
    ///      bad fill.
```

### `uint256 public constant INITIAL_VIRTUAL_TOKEN_RESERVES = 1_075_000_000e18;`
<sub>was line 61 of contracts/Ballista.sol</sub>

```solidity
    // ── Bonding curve starting parameters (USDC assumed 6 decimals) ───────
    /// @dev These four constants (with CURVE_TOKEN_SUPPLY and LP_TOKEN_RESERVE) are one
    ///      derivation, not six independent knobs. Changing any of them in isolation
    ///      breaks the relationships the graduation gap and price multiple depend on.
    ///
    ///      Solved for: $8,000 graduation, 16x launch-to-graduation price multiple, +4%
    ///      graduation gap, 1B total supply. With x = T / (vUSDC0 + T) as the fraction
    ///      of final virtual USDC that is real:
    ///        tokens sold at threshold = vTOKEN0 * x
    ///        multiple                 = 1 / (1 - x)^2      (depends ONLY on x)
    ///        gap                      = x * vTOKEN0 * (1-x) / LP - 1
    ///
    ///      Was 30,000 / 1,073M for a $67,000 threshold. The threshold dropped to $8,000
    ///      because we were asking 7-11x more than any competitor (pump.fun graduates at
    ///      ~$6,100-7,400, Pons at ~$9,700) while the real pump.fun graduation rate is
    ///      0.198% -- a high bar was a real problem, not a cosmetic one.
    ///
    ///      CONSEQUENCE WORTH KNOWING: at $2,667 the curve starts roughly 11x thinner
    ///      than before, so absolute trade sizes bite far harder. A $1,000 buy took 4.3%
    ///      of supply on the old curve; here it takes about 41%. Price impact has to be
    ///      a headline number in any UI, not fine print.
```

### `uint256 public defaultGraduationThresholdUsdc = 8_000e6;`
<sub>was line 85 of contracts/Ballista.sol</sub>

```solidity
    // ── Graduation ──────────────────────────────────────────────────────
    // DEFAULT applied to newly created tokens only. Existing tokens keep whatever value was
    // snapshotted into their Curve struct at launch — see the note on the struct above.
    // 67,000 rather than the Pump.fun-derived 69,000 — deliberate, ours.
```

### `address public router;`
<sub>was line 91 of contracts/Ballista.sol</sub>

```solidity
    /// @notice The DEX router graduation hands liquidity to.
    /// @dev TRUST NOTE. This is the highest-value lever in the contract. At graduation
    ///      the entire LP token allocation AND every USDC the curve accumulated (up to
    ///      ~67,000 per token) are approved to this address and sent in a single call,
    ///      and the only success check is that a non-zero liquidity figure comes back.
    ///      An address set here can therefore take everything a graduating token holds,
    ///      irreversibly, and nothing on-chain can claw it back.
    ///
    ///      That is why it cannot be set directly. proposeRouter() starts a 24-hour
    ///      timelock, activateRouter() finishes it, and revokeRouter() cancels or kills
    ///      a router with no delay at all. Granting trust is slow and visible; removing
    ///      it is instant.
```

### `uint256 public constant ROUTER_TIMELOCK = 24 hours;`
<sub>was line 105 of contracts/Ballista.sol</sub>

```solidity
    /// @notice Delay between proposing a router and being able to activate it.
    /// @dev Deliberately a constant and NOT owner-settable. An owner who can shorten
    ///      this to zero does not have a timelock, they have a formality -- the whole
    ///      protection is that a compromised key cannot compress the waiting period.
    ///      24 hours is long enough for anyone monitoring RouterProposed to react, and
    ///      short enough that replacing a broken router is not a multi-day outage.
```

### `mapping(address => uint256) public routerProposedAt;`
<sub>was line 113 of contracts/Ballista.sol</sub>

```solidity
    /// @notice When each address was proposed as a router. Zero means "not proposed",
    ///         which is also what revocation resets it to.
```

### `uint16 public defaultBuyFeeBps = 100; // 1%`
<sub>was line 117 of contracts/Ballista.sol</sub>

```solidity
    // ── Fees ────────────────────────────────────────────────────────────
    // Also defaults-for-new-tokens-only, same reasoning as above.
```

### `uint16 public maxCreatorLaunchBps = 250;`
<sub>was line 124 of contracts/Ballista.sol</sub>

```solidity
    /// @notice Share of each trade routed to the token's creator, in bps, ASYMMETRIC
    ///         between buy and sell. Carved OUT OF the existing buy/sell fee, never
    ///         added on top — a trader pays exactly the same total either way, and the
    ///         treasury's share is what shrinks.
    ///
    /// @dev At the 100 bps default fee these are 90% of the fee on a buy and 50% on a
    ///      sell. Over a 50:50 buy/sell mix that blends to 70% creator / 30% protocol,
    ///      which is the market-leading rate; a buy-heavy 70:30 mix blends to 78%.
    ///
    ///      IMPORTANT, for anyone writing copy against these numbers: the headline rate
    ///      is the BLENDED one. "90% to creators" describes the buy side only and is not
    ///      the rate a creator earns over a token's life. Both splits are public on a
    ///      verified contract and anyone can read them in thirty seconds.
    ///
    ///      Defaults-for-new-tokens-only, like the fees above. Each is capped at the
    ///      fee on its own side so the creator's slice can never exceed the fee it is
    ///      carved out of; see setDefaultCreatorFees and the guard in setDefaultFees.
    /// @notice Cap on the creator's privileged block-0 buy, in bps of CURVE_TOKEN_SUPPLY.
    /// @dev 2.5%, and settable rather than constant on purpose: starting conservative
    ///      and loosening later reads as a gift, while tightening later breaks the terms
    ///      people launched under. Snapshotted per token, so a change never moves the
    ///      deal for anything already live.
    ///
    ///      WHY 2.5% AND NOT 5% OR 10%. Dump impact is close to linear. On this curve a
    ///      creator who buys the cap and exits after $2,000 of follow-on buying extracts
    ///      roughly 4.7% of inflows at 2.5%, 9.1% at 5%, and 17.4% at 10%. The usual
    ///      argument for a larger allocation is creator alignment, and it does not apply
    ///      here: this cap limits only the PRIVILEGED, UNTAXED slot, and a creator who
    ///      wants a bigger position can buy at block 1 like anyone else. So the number
    ///      should be set purely by tolerable rug damage, and lower wins.
    ///
    ///      WHAT THIS DOES NOT DO. It does not cap total creator holdings. Nothing stops
    ///      a creator buying more from another address, and no contract-level rule can
    ///      detect that. NOBODY SHOULD DESCRIBE THIS AS "creators are capped at 2.5%" --
    ///      it is a cap on one privileged path, and disclosure is the actual protection.
```

### `mapping(address => uint256) public creatorFeesAccrued;`
<sub>was line 166 of contracts/Ballista.sol</sub>

```solidity
    /// @notice Creator fees waiting to be claimed, by creator address.
    /// @dev Accrue-and-claim, never push. Transferring to the creator inside
    ///      buy()/sell() would mean a creator address that reverts on receipt --
    ///      a contract without a payable fallback, a blocklisted address -- breaks
    ///      EVERY trade on that token, permanently, for everyone. The creator is an
    ///      arbitrary address chosen by an untrusted party, so it must never sit on
    ///      the critical path of somebody else's trade.
    ///
    ///      Keyed by creator rather than by (creator, token): one claim collects
    ///      everything a creator is owed across all their launches instead of one
    ///      claim per token, and it is one storage slot per creator rather than one
    ///      per pair. Per-token attribution is not lost -- CreatorFeeAccrued carries
    ///      the token address on every accrual, which is where the indexer reads it
    ///      from anyway.
```

### `uint16 public constant MAX_TOTAL_FEE_BPS = 9900;`
<sub>was line 182 of contracts/Ballista.sol</sub>

```solidity
    // ── Snipe tax ───────────────────────────────────────────────────────
```

### `uint16 public constant MAX_TOTAL_FEE_BPS = 9900;`
<sub>was line 184 of contracts/Ballista.sol</sub>

```solidity
    /// @notice Hard ceiling on base fee PLUS snipe tax combined, in bps.
    /// @dev Strictly below BPS_DENOMINATOR, and that is a correctness requirement, not
    ///      a policy preference. The clamp branch of _quoteBuy inverts the fee with
    ///      `_ceilDiv(x * BPS_DENOMINATOR, BPS_DENOMINATOR - feeBps)`. At feeBps ==
    ///      BPS_DENOMINATOR that divides by zero; above it, the subtraction underflows.
    ///      Either way EVERY clamped buy during the snipe window reverts -- exactly the
    ///      buys that finish a launch, at exactly the moment the tax is highest.
    ///
    ///      99% was the intended opening rate, but 9900 tax + a 100 bps base fee is
    ///      10000 on the nose. 9900 as the combined ceiling leaves 98% available at
    ///      t=0 under the default 1% fee, and 89% if the base fee were ever raised to
    ///      MAX_FEE_BPS. The deterrent is unchanged in any way that matters.
```

### `mapping(uint32 => uint16[]) private _snipeTaxTables;`
<sub>was line 198 of contracts/Ballista.sol</sub>

```solidity
    /// @notice Buy-side tax during the first seconds after launch, in bps, indexed by
    ///         whole seconds elapsed since the token was created. Past the end of the
    ///         table the tax is zero, so the table's length IS the window length.
    /// @dev Published as immutable versions rather than mutated in place. A token
    ///      snapshots only the version number it launched under (one slot), and reads
    ///      that version forever -- so the owner can retune the table for new launches
    ///      without ever changing the terms of a token already trading, and without
    ///      paying to copy the whole array into every Curve.
    ///
    ///      A table, not exponential math: the window is a handful of seconds, so there
    ///      are only a few discrete points. A table is cheaper, exact, and cannot be
    ///      subtly wrong the way a fixed-point decay curve can.
    ///
    ///      Arc targets 500ms blocks, so a 5-second window is roughly ten blocks --
    ///      enough for per-second granularity to be meaningful, and confirmation that
    ///      the block-0 restriction alone only delays a sniper by half a second.
```

### `mapping(uint32 => uint16) public snipeTaxTableMaxBps;`
<sub>was line 216 of contracts/Ballista.sol</sub>

```solidity
    /// @notice Highest entry in a published table, cached so createToken can check the
    ///         combined-fee ceiling without walking the array on every launch.
```

### `uint32 public activeSnipeTaxTableVersion;`
<sub>was line 220 of contracts/Ballista.sol</sub>

```solidity
    /// @notice Version new launches snapshot. Existing tokens keep their own.
```

### `uint16 public defaultSnipeTaxTreasuryBps = 7000; // 70% treasury / 30% curve`
<sub>was line 224 of contracts/Ballista.sol</sub>

```solidity
    /// @notice Share of collected snipe tax sent to treasury, in bps. The remainder goes
    ///         into the curve's realUsdcReserves without releasing any tokens.
    /// @dev Deliberately never routed to the creator: a creator sniping their own launch
    ///      would recover part of their own tax, weakening the deterrent for precisely
    ///      the person with the most advance knowledge of the launch.
```

### `uint256 public creationFeeUsdc = 5e5;`
<sub>was line 230 of contracts/Ballista.sol</sub>

```solidity
    /// @notice Charged to the creator at launch. Live/global rather than snapshotted:
    ///         it is paid once at creation, so no existing holder is ever exposed to a
    ///         change in it.
    /// @dev 0.5 USDC, down from 5. We were the most expensive launchpad to launch on;
    ///      every competitor is at or near free. Deliberately NOT 0.1: createToken costs
    ///      ~0.023 USDC of gas, so at 0.1 the fee is barely above cost, and one wallet
    ///      running the 10s cooldown flat out could push 8,640 launches/day for roughly
    ///      $1,060 -- affordable for anyone motivated. Noxa earned $12M in fees and
    ///      still had to stop accepting launches because the feed became unnavigable;
    ///      revenue from spam does not offset an unusable discovery feed. 0.5 keeps this
    ///      ~10x cheaper than before while staying meaningfully costly to abuse.
```

### `uint256 public launchCooldown = 10; // minimum gap between two launches from the same wallet — adjust via setLaunchCoold`
<sub>was line 244 of contracts/Ballista.sol</sub>

```solidity
    // ── Anti-spam ───────────────────────────────────────────────────────
```

### `uint256 public symbolLockDuration = 5 minutes;`
<sub>was line 248 of contracts/Ballista.sol</sub>

```solidity
    /// @notice How long a symbol stays exclusively locked to its first claimant, at the
    ///         time it's claimed. After symbolUnlocksAt[hash] has passed, anyone can
    ///         launch that exact symbol again — including reusing one that was already
    ///         used. This is deliberately NOT a permanent lock: the bet is that
    ///         narrative-driven attention resolves in minutes, so whichever token was
    ///         first to market has already become "the" token for that name well before
    ///         the window closes, and a permanent on-chain reservation would mostly just
    ///         let one early, possibly abandoned launch squat a word forever. The token's
    ///         contract ADDRESS remains the actual canonical identity regardless of symbol
    ///         reuse — see the note on fuzzy-duplicate detection belonging off-chain, below.
```

### `mapping(bytes32 => uint256) public symbolUnlocksAt; // 0 = never claimed`
<sub>was line 259 of contracts/Ballista.sol</sub>

```solidity
    // The unlock time is computed and stored ONCE, at claim time — not read live off
    // symbolLockDuration on every check. Same reasoning as the per-token fee/threshold
    // snapshot below: without this, changing symbolLockDuration would retroactively
    // shift the unlock time for every symbol already claimed, including ones mid-window
    // right now, not just symbols claimed after the change.
```

### `bool public caseSensitiveSymbols = true;`
<sub>was line 265 of contracts/Ballista.sol</sub>

```solidity
    // detection belongs in the off-chain indexer that feeds the discovery feed, not on-chain —
    // string-similarity checks are expensive and easy to route around on their own.
```

### `bool public caseSensitiveSymbols = true;`
<sub>was line 268 of contracts/Ballista.sol</sub>

```solidity
    /// @notice When true (the launch default), symbol uniqueness is checked on the exact
    ///         string as typed — "Cat" and "cat" are different symbols. When false, symbols
    ///         are case-normalized before comparison, so "Cat" and "cat" collide as the same
    ///         symbol and only one can ever launch.
    /// @dev Deliberately lenient at launch: early on, blocking a dev from launching "Cat"
    ///      because someone already took "cat" costs more in missed narrative windows than
    ///      it prevents in spam — narrative-driven launches move in minutes, not the weeks
    ///      an on-chain policy takes to update. Meant to be tightened to false (strict) via
    ///      setCaseSensitiveSymbols() once there's enough launch volume to see whether
    ///      case-only duplicates actually become a spam vector in practice, rather than
    ///      assumed in advance.
```

### `enum CurveState { ACTIVE, GRADUATION_READY, GRADUATED }`
<sub>was line 281 of contracts/Ballista.sol</sub>

```solidity
    // ── Curve state ─────────────────────────────────────────────────────
    /// @notice ACTIVE: normal curve trading. GRADUATION_READY: threshold crossed, curve
    ///         trading closed, DEX liquidity not yet successfully created — a transient
    ///         state, not a dead end. GRADUATED: DEX liquidity created, permanent.
    ///         One-way only: ACTIVE -> GRADUATION_READY -> GRADUATED. Nothing ever moves
    ///         backwards.
```

### `uint16 buyFeeBps;`
<sub>was line 297 of contracts/Ballista.sol</sub>

```solidity
        // Snapshotted at creation, NOT read live from storage on every trade. Without this,
        // an admin fee/threshold change instantly applies to every token already trading —
        // including ones whose holders bought in under a different, advertised deal. Every
        // token now trades under the terms it launched with, permanently, regardless of what
        // the global defaults change to afterwards.
```

### `uint16 creatorBuyFeeBps;`
<sub>was line 304 of contracts/Ballista.sol</sub>

```solidity
        // Carved out of buyFeeBps/sellFeeBps above, never added to them. Snapshotted
        // for the same reason they are: a creator who launched on a promised split
        // keeps it even if the global default later changes. That is the whole point --
        // the plan is to run a generous launch promotion and move toward the market
        // rate later WITHOUT altering the deal for anyone already launched.
```

### `uint256 creationBlock;`
<sub>was line 312 of contracts/Ballista.sol</sub>

```solidity
        // The block createToken() executed in. Trading opens the NEXT block — see the
        // require() in buy()/sell(). This does not stop a sniper with a bot watching the
        // mempool for the creation tx and firing in the very next block; it only removes
        // the specific unfairness of someone buying and selling inside the same block the
        // token was created in, before anyone else could possibly have seen it exists.
```

### `uint256 creationTimestamp;`
<sub>was line 318 of contracts/Ballista.sol</sub>

```solidity
        /// The snipe tax decays in SECONDS, which creationBlock cannot express.
```

### `uint16 maxCreatorLaunchBps;`
<sub>was line 322 of contracts/Ballista.sol</sub>

```solidity
        /// Cap on the creator's block-0 buy, snapshotted at launch.
```

### `bool poolBoostEnabled;`
<sub>was line 325 of contracts/Ballista.sol</sub>

```solidity
        /// Chosen by the creator at createToken, immutable thereafter. When true the
        /// creator's fee share is diverted into poolBoost instead of accruing to them.
```

### `uint256 poolBoost;`
<sub>was line 328 of contracts/Ballista.sol</sub>

```solidity
        /// Accumulated creator fees destined for the USDC side of the pool.
        ///
        /// MUST stay separate from realUsdcReserves. If it were folded in, the
        /// graduation threshold would be reached before tokenReserves depletes,
        /// graduation would fire with leftover tokens, and those leftovers would dilute
        /// the pool -- undoing the flat hand-off the curve constants were derived for.
        /// It is added to usdcLiquidity at graduation and nowhere else.
```

### `uint256 creatorLaunchPurchased;`
<sub>was line 336 of contracts/Ballista.sol</sub>

```solidity
        /// Tokens the creator has taken through the block-0 path so far.
        /// CUMULATIVE, and counted as tokens PURCHASED rather than tokens held: a
        /// balance check is defeated by transferring out and buying again, and a
        /// per-transaction cap is defeated by simply sending several transactions in
        /// the same block.
```

### `mapping(address => Curve) private _curves;`
<sub>was line 344 of contracts/Ballista.sol</sub>

```solidity
    /// @dev Private with an explicit struct getter below, rather than a public mapping.
    ///      Solidity's auto-generated getter returns the struct as a flat 14-value
    ///      tuple, which overflows the stack in the ABI encoder and fails to compile.
    ///      Returning `Curve memory` is one value instead of fourteen, which sidesteps
    ///      it without turning on viaIR -- and gives callers named fields rather than a
    ///      positional tuple they have to keep in sync by hand.
```

### `function curves(address token) external view returns (Curve memory)`
<sub>was line 352 of contracts/Ballista.sol</sub>

```solidity
    /// @notice Full curve state for a token. Reverts nothing for an unknown token --
    ///         callers should check `token` on the result, as the internal code does.
```

### `struct BuyQuote`
<sub>was line 359 of contracts/Ballista.sol</sub>

```solidity
    /// @dev Return value of _quoteBuy. Pulling this computation into its own struct +
    ///      pure function (rather than inline in buy()) isn't just tidiness — buy() with
    ///      the clamp-on-insufficient-supply logic inlined hits Solidity's 16-local-slot
    ///      stack limit and fails to compile. This also happens to be exactly the shape
    ///      a future public quoteBuy() view would need, if one gets added later.
```

### `struct FeeSplit`
<sub>was line 372 of contracts/Ballista.sol</sub>

```solidity
    /// @dev How a fee already charged is divided up. Computed in its own function for
    ///      the same reason BuyQuote exists: buy() with this inlined exceeds Solidity's
    ///      local-slot limit and fails to compile.
```

### `struct SellQuote`
<sub>was line 382 of contracts/Ballista.sol</sub>

```solidity
    /// @dev Mirror of BuyQuote for sell() — same stack-depth reasoning.
```

### `event CreatorLaunchBuy(`
<sub>was line 397 of contracts/Ballista.sol</sub>

```solidity
    /// @dev These three events ARE the early-warning system. Anyone watching the chain
    ///      should alert on RouterProposed: it is the only advance notice that the most
    ///      dangerous address in the contract is about to change.
    /// @dev The frontend must surface this on every token page. Disclosure is the
    ///      protection here, not the cap.
```

### `event MetadataURIUpdated(`
<sub>was line 410 of contracts/Ballista.sol</sub>

```solidity
    /// @dev Carries BOTH values so a swap is auditable after the fact, not just the
    ///      current state. This is the whole protection against launch-clean-then-swap.
```

### `constructor(address usdc_, address treasury_, address initialRouter_) Ownable(msg.sender)`
<sub>was line 430 of contracts/Ballista.sol</sub>

```solidity
    /// @param initialRouter_ Optional. Pass address(0) to deploy with no router, which
    ///        leaves createToken() gated until one clears the timelock. Pass a real
    ///        address to have it live from block zero.
    ///
    /// @dev THE ONE TIMELOCK BYPASS, and it is deliberate. Arc mainnet does not exist
    ///      until launch day, so a deployment that must then wait 24 hours for a router
    ///      spends the busiest day of a new chain rejecting every createToken call.
    ///
    ///      This does not weaken the router timelock. What the timelock defends against
    ///      is an owner SWAPPING the router later to drain a graduation -- it buys time
    ///      for someone watching RouterProposed to react. A constructor-set router is
    ///      baked into the deployment transaction itself, sits in the constructor
    ///      arguments on the verified explorer page, and offers no window to attack
    ///      because there is nothing to change. A malicious one would mean the contract
    ///      was compromised from block zero, which no delay can help with.
    ///
    ///      Every SUBSEQUENT change goes through propose -> ROUTER_TIMELOCK -> activate
    ///      unchanged. This is the only assignment that skips it, and it can only ever
    ///      happen once, because a constructor runs once.
```

### `routerProposedAt[initialRouter_] = block.timestamp;`
<sub>was line 455 of contracts/Ballista.sol</sub>

```solidity
            // Emit the SAME pair of events the propose/activate path would, so anyone
            // reconstructing router history from logs sees no hole -- the activatableAt
            // is simply now. Recording routerProposedAt keeps the ledger consistent
            // with a router that is genuinely approved.
```

### `uint16[] memory opening = new uint16[](8);`
<sub>was line 465 of contracts/Ballista.sol</sub>

```solidity
        // Opening table, RETUNED for the $8,000 curve. The previous
        // [9800, 2500, 300, 100, 0] was inherited from the $67,000 curve and stopped
        // deterring once the virtual reserve fell from $30,000 to $2,667: the same
        // dollar now buys ~11x more, so a $1,000 sniper took 0.49% of supply at t=0 but
        // 28.93% at t=1 and 35% by t=2. Measured, not modelled. Real testnet racing
        // lands snipers at t=1-2, which was exactly the useless band.
        //
        // This table holds that same $1,000 sniper to 1.0% / 2.4% / 4.8% / 9.2% across
        // t=0..3. It decays slower and runs to t=7 rather than t=4 for that reason.
        //
        // A QUANTITY CAP would be more robust than a tax -- a max buy size during the
        // window does not degrade as the curve thins, which is what Pons actually does.
        // Logged as the better long-term answer; it needs a library extraction first,
        // given how little bytecode headroom is left.
```

### `function publishSnipeTaxTable(uint16[] calldata table)`
<sub>was line 491 of contracts/Ballista.sol</sub>

```solidity
    // ── Snipe tax ───────────────────────────────────────────────────────
```

### `function publishSnipeTaxTable(uint16[] calldata table)`
<sub>was line 493 of contracts/Ballista.sol</sub>

```solidity
    /// @notice Publishes a new snipe tax table and makes it active for FUTURE launches.
    ///         Tokens already trading keep the version they launched under.
    /// @param table Tax in bps indexed by whole seconds since launch; length sets the
    ///        window. An empty table disables the tax entirely for new launches.
```

### `require(`
<sub>was line 514 of contracts/Ballista.sol</sub>

```solidity
        // Checked here as well as at creation so a table that could never be launched
        // under is rejected at publish time, where the mistake is visible, rather than
        // silently bricking every subsequent createToken call.
```

### `function snipeTaxTable(uint32 version) external view returns (uint16[] memory)`
<sub>was line 530 of contracts/Ballista.sol</sub>

```solidity
    /// @notice The full tax table for a published version.
```

### `function currentSnipeTaxBps(address token) external view returns (uint16)`
<sub>was line 535 of contracts/Ballista.sol</sub>

```solidity
    /// @notice Snipe tax in bps that a buy on this token would pay right now.
```

### `function currentEconomicsHash() public view returns (bytes32)`
<sub>was line 555 of contracts/Ballista.sol</sub>

```solidity
    // ── Launch ──────────────────────────────────────────────────────────
```

### `function currentEconomicsHash() public view returns (bytes32)`
<sub>was line 557 of contracts/Ballista.sol</sub>

```solidity
    /// @notice Hash of every parameter createToken() reads from global defaults right
    ///         now. A frontend fetches this immediately before showing the "create"
    ///         button, then passes it back as expectedEconomicsHash — if any of these
    ///         values change between when the creator saw the terms and when their
    ///         transaction actually mines, createToken() reverts rather than silently
    ///         launching under different terms than what was shown. This does not
    ///         protect against changes to launchCooldown or creationFeeUsdc — those
    ///         affect eligibility to launch at all, not the economics of the token
    ///         once launched, so a mismatch there isn't the same kind of surprise.
```

### `require(`
<sub>was line 589 of contracts/Ballista.sol</sub>

```solidity
        // No router means nothing to graduate into. Without this check a token can be
        // launched, trade all the way to its threshold, flip to GRADUATION_READY --
        // where buy() and sell() are both closed -- and then sit there frozen, with
        // holders unable to exit, until an owner configures a router. Refusing the
        // launch outright costs nothing: it surfaces at the moment a creator tries,
        // when no one has any money in the curve, instead of at 67,000 USDC with
        // holders trapped. Paired with setRouter()'s zero-address rejection, so a
        // router that exists at launch cannot later be taken away.
```

### `require(`
<sub>was line 601 of contracts/Ballista.sol</sub>

```solidity
        // The snapshotted base fee and tax table must together stay inside the range
        // the clamp path can invert, for the whole life of this token.
```

### `bytes32 symbolHash = caseSensitiveSymbols`
<sub>was line 616 of contracts/Ballista.sol</sub>

```solidity
        // caseSensitiveSymbols controls whether "CAT", "cat", and "Cat" are treated as the
        // same symbol (false) or as distinct symbols (true, the launch default) — see the
        // NatSpec on the flag above for why this starts lenient.
```

### `function _toUpperAscii(string memory str) internal pure returns (string memory)`
<sub>was line 672 of contracts/Ballista.sol</sub>

```solidity
    /// @dev Uppercases ASCII a–z only. Symbols are expected to be plain ASCII tickers;
    ///      this is a spam-cost deterrent, not a cryptographic guarantee, by design.
    ///      Only used when caseSensitiveSymbols is false.
```

### `function _quoteBuy(`
<sub>was line 685 of contracts/Ballista.sol</sub>

```solidity
    // ── Trading ─────────────────────────────────────────────────────────
```

### `function _quoteBuy(`
<sub>was line 687 of contracts/Ballista.sol</sub>

```solidity
    /// @dev Pure curve math for a buy, including the clamp-to-remaining-supply case.
    ///      Takes only primitive values (no storage access) so it's cheap to reason
    ///      about and safe to eventually expose as a public quoteBuy() view.
```

### `uint256 newVirtualToken = _ceilDiv(k, newVirtualUsdc);`
<sub>was line 701 of contracts/Ballista.sol</sub>

```solidity
        // Rounded UP (ceiling), not down. Rounding newVirtualToken down — the naive
        // approach — meant tokensOut came out slightly too HIGH on every single trade,
        // i.e. the curve was quietly bleeding value to traders, trade after trade,
        // forever. Rounding up here means any residual dust favors the curve, not the
        // trader — the standard direction used by production AMMs (Uniswap included)
        // for exactly this reason.
```

### `q.tokensOut = tokensOut;`
<sub>was line 712 of contracts/Ballista.sol</sub>

```solidity
            // Common case: enough supply remains to fill the full request.
```

### `q.tokensOut = tokenReservesAvailable;`
<sub>was line 721 of contracts/Ballista.sol</sub>

```solidity
        // Not enough supply left to fill the full request. Clamp to exactly what
        // remains rather than reverting the whole trade — this is what stops the buy
        // that finishes a launch from being griefable by anyone slipping a smaller
        // purchase in first. The true cost is recomputed DETERMINISTICALLY from the
        // clamped, known token amount, rather than by inverting the ceil-divided
        // formula above — that inversion has its own rounding edge cases, and
        // duplicating it as a second math path is a second place for a bug to hide.
        // Deriving directly from tokenReservesAvailable (a known, exact stored value)
        // avoids that entirely.
```

### `q.newVirtualUsdc = _ceilDiv(k, q.newVirtualToken);`
<sub>was line 732 of contracts/Ballista.sol</sub>

```solidity
        // Ceiling, same reasoning as above: rounding dust favors the curve, so the
        // trade that empties it doesn't leak value on the way out.
```

### `q.actualUsdcIn = _ceilDiv(clampedUsdcInAfterFee * BPS_DENOMINATOR, BPS_DENOMINATOR - buyFeeBps);`
<sub>was line 736 of contracts/Ballista.sol</sub>

```solidity
        // Invert the fee formula the same direction: round the required gross amount
        // UP, so the fee actually charged is never less than buyFeeBps of what was
        // actually spent.
```

### `require(q.actualUsdcIn <= usdcIn, "clamp computed a higher cost than offered");`
<sub>was line 742 of contracts/Ballista.sol</sub>

```solidity
        // Buying fewer tokens should never cost more than buying the originally
        // requested, larger amount would have. This should be true by construction
        // given monotonic curve pricing — this is a defensive backstop, not a case
        // expected to ever actually fire. If it does, something upstream is wrong,
        // and reverting is far safer than silently overcharging.
```

### `function updateMetadataURI(address token, string calldata newURI) external`
<sub>was line 750 of contracts/Ballista.sol</sub>

```solidity
    /// @notice Lets a token's creator update its off-chain metadata pointer after launch.
    /// @dev Real product lever rather than a nicety: pump.fun launches advertising a
    ///      Telegram graduate at 1.485% against 0.166% without, and all three social
    ///      channels gives 1.919% against 0.110%. Socials are normally added after a
    ///      launch, so immutable metadata pushes creators into relaunching to add one.
    ///
    ///      No restriction on how often, or on the content. The abuse case -- launch
    ///      with clean links, attract buyers, then swap them -- cannot be prevented
    ///      on-chain, so it is surfaced instead: MetadataURIUpdated carries the old and
    ///      the new value, and the frontend is expected to show how recently a token's
    ///      links changed.
```

### `function _settleBuy(`
<sub>was line 771 of contracts/Ballista.sol</sub>

```solidity
    /// @dev Everything a buy does once its quote is known: fee split, reserve updates,
    ///      creator accrual, transfers, and the graduation check. Shared by buy() and
    ///      creatorLaunchBuy().
    ///
    ///      Extracted because the two paths had drifted into ~40 duplicated lines, and
    ///      that duplication pushed the deployed contract past EIP-170's 24,576-byte
    ///      limit. Restructuring rather than lowering optimizer runs was deliberate:
    ///      optimizing for size would have traded gas on every single trade, and
    ///      createToken already costs ~900k.
    ///
    ///      Effects before interactions throughout. `taxBps` is passed in only so the
    ///      SnipeTaxCollected event can be skipped on the exempt creator path -- the
    ///      tax itself is already baked into the quote by the caller.
```

### `c.realUsdcReserves += (q.actualUsdcIn - q.actualFee) + f.curveCut;`
<sub>was line 794 of contracts/Ballista.sol</sub>

```solidity
        // The curve keeps the post-fee amount PLUS its share of the snipe tax. That
        // share adds USDC without releasing tokens and without moving the virtual
        // reserves, so it raises the floor under holders rather than buying anything.
```

### `bool crossedThreshold =`
<sub>was line 800 of contracts/Ballista.sol</sub>

```solidity
        // DUAL GRADUATION TRIGGER. Either arm graduates the curve. The depletion arm is
        // load-bearing, not decoration: the ceiling sits only $30.85 above the threshold
        // at the current constants, and a threshold-only check would leave a token whose
        // ceiling fell below its threshold permanently stuck with holders trapped.
        //
        // sell() needs no equivalent: tokenReserves only reaches zero via a buy, and
        // that buy graduates the curve in the same transaction, closing sell() with it.
```

### `usdc.safeTransferFrom(msg.sender, address(this), q.actualUsdcIn);`
<sub>was line 815 of contracts/Ballista.sol</sub>

```solidity
        // Interactions. Only q.actualUsdcIn is ever pulled -- a clamped request simply
        // never takes the excess, rather than taking and refunding it.
```

### `c.state = CurveState.GRADUATION_READY;`
<sub>was line 823 of contracts/Ballista.sol</sub>

```solidity
            // The trade above has ALREADY succeeded regardless of what happens next.
            // Curve trading closes here permanently, whether or not the DEX side
            // completes in this same transaction.
```

### `function creatorLaunchBuy(address token, uint256 usdcIn, uint256 minTokensOut)`
<sub>was line 832 of contracts/Ballista.sol</sub>

```solidity
    /// @notice The creator's one privileged window: a capped, snipe-tax-exempt buy in
    ///         the same block the token was created. Everyone else starts at block 1,
    ///         into the decaying tax.
    ///
    /// @dev This makes the block-0 rule STRONGER, not weaker. Block 0 was closed to
    ///      everyone, which in practice meant a creator who wanted a position had to
    ///      race snipers from a second wallet at block 1 -- invisibly, and worse for
    ///      everyone. Block 0 is now creator-only and disclosed by event.
    ///
    ///      Exempt from the snipe tax deliberately: at 98% the feature would be
    ///      pointless. The base buy fee still applies.
    ///
    ///      THE CAP IS CUMULATIVE PER TOKEN, not per transaction. Several transactions
    ///      fit in one block, so a per-call cap is not a cap at all -- ten "2.5%" buys
    ///      would take roughly 37% of curve supply. creatorLaunchPurchased accumulates
    ///      across every call in the window.
    ///
    ///      Clamps rather than reverting when the creator asks for more than the cap
    ///      allows, matching how buy() already handles a request larger than supply.
    ///      The clamp is reused rather than reimplemented: passing the remaining
    ///      allowance as `tokenReservesAvailable` makes _quoteBuy's existing, audited
    ///      clamp path do the work.
```

### `uint256 available =`
<sub>was line 873 of contracts/Ballista.sol</sub>

```solidity
        // Bound by BOTH the remaining allowance and the curve's actual supply, so the
        // clamp cannot hand out more than either permits.
```

### `BuyQuote memory q = _quoteBuy(`
<sub>was line 878 of contracts/Ballista.sol</sub>

```solidity
        // NOTE the fee argument: c.buyFeeBps ALONE, with no snipe tax added. That also
        // changes the denominator in the clamp path's fee inversion,
        // _ceilDiv(x * BPS, BPS - feeBps), which is why the clamp is exercised
        // explicitly at this fee in the tests rather than assumed.
```

### `_settleBuy(token, c, q, 0);`
<sub>was line 896 of contracts/Ballista.sol</sub>

```solidity
        // taxBps 0: this path is exempt, which is the whole point of it existing.
```

### `uint16 taxBps = _snipeTaxBps(c);`
<sub>was line 907 of contracts/Ballista.sol</sub>

```solidity
        // Snipe tax rides on top of the base fee for the curve math: the trader pays it,
        // and the curve releases tokens only for what is left after BOTH.
        // MAX_TOTAL_FEE_BPS, enforced at creation, keeps this sum inside the range the
        // clamp path can invert.
```

### `function _quoteSell(`
<sub>was line 920 of contracts/Ballista.sol</sub>

```solidity
    /// @dev Pure curve math for a sell, mirroring _quoteBuy — same stack-depth and
    ///      future-quoteSell()-view reasoning.
```

### `uint256 newVirtualUsdc = _ceilDiv(k, newVirtualToken);`
<sub>was line 931 of contracts/Ballista.sol</sub>

```solidity
        // Same rounding fix as _quoteBuy, mirrored: round newVirtualUsdc UP so
        // usdcOutGross comes out slightly LOW rather than slightly high — again, dust
        // favors the curve, not the trader.
```

### `q.actualTokensIn = tokensIn;`
<sub>was line 939 of contracts/Ballista.sol</sub>

```solidity
            // Common case: the curve holds enough real USDC to pay out the full
            // requested sell.
```

### `q.usdcOutGross = realUsdcReservesAvailable;`
<sub>was line 949 of contracts/Ballista.sol</sub>

```solidity
        // The curve can't pay out the full request. Clamp to exactly what it holds,
        // and recompute the true tokensIn needed DETERMINISTICALLY from that clamped,
        // known output — same reasoning as _quoteBuy: deriving from a known stored
        // value avoids duplicating the ceil-divided forward formula's own rounding
        // edge cases in a second, error-prone inversion.
```

### `q.newVirtualToken = _ceilDiv(k, q.newVirtualUsdc);`
<sub>was line 956 of contracts/Ballista.sol</sub>

```solidity
        // Ceiling here too: dust favors the curve, meaning the seller must provide at
        // least enough tokens for the clamped payout, never fractionally short.
```

### `require(q.actualTokensIn <= tokensIn, "clamp computed a higher input than offered");`
<sub>was line 962 of contracts/Ballista.sol</sub>

```solidity
        // Selling for a smaller payout should never require MORE tokens than selling
        // for the originally requested, larger payout would have. Same defensive
        // backstop as _quoteBuy's equivalent check.
```

### `c.virtualTokenReserves = q.newVirtualToken;`
<sub>was line 980 of contracts/Ballista.sol</sub>

```solidity
        // Effects before interactions.
```

### `IERC20(token).safeTransferFrom(msg.sender, address(this), q.actualTokensIn);`
<sub>was line 989 of contracts/Ballista.sol</sub>

```solidity
        // Interactions. Only q.actualTokensIn is ever pulled from the seller — same
        // "never take the excess in the first place" approach as buy().
```

### `function _creatorCut(uint256 tradeAmount, uint16 creatorFeeBps, uint256 feeCharged)`
<sub>was line 1003 of contracts/Ballista.sol</sub>

```solidity
    /// @dev The creator's slice of a fee that has ALREADY been charged to the trader.
    ///      Carved out of feeCharged, never added to it, so the trader-facing cost of a
    ///      trade is identical whether or not a creator share exists.
    ///
    ///      Capped at feeCharged so creator + treasury always sum to exactly the fee.
    ///      That cap should be unreachable -- creatorFeeBps <= buyFeeBps/sellFeeBps is
    ///      enforced at creation and both are snapshotted -- but reaching it would
    ///      otherwise underflow and revert, and a reverting buy() is a far worse
    ///      outcome than a creator being paid a rounding unit less on one trade.
```

### `function _splitBuyFee(`
<sub>was line 1022 of contracts/Ballista.sol</sub>

```solidity
    /// @dev Divides a buy's total fee into creator / treasury / curve shares.
    ///
    ///      The base fee is what the token launched with; everything above it inside
    ///      actualFee is snipe tax. Deriving the tax as a REMAINDER rather than
    ///      recomputing it from actualUsdcIn is what guarantees the three shares sum to
    ///      exactly actualFee -- computing both independently would let a rounding unit
    ///      escape, and on the clamp path actualFee is an inverted, ceiling-rounded
    ///      figure that does not match a naive recomputation anyway.
```

### `f.creatorCut = _creatorCut(actualUsdcIn, c.creatorBuyFeeBps, baseFee);`
<sub>was line 1039 of contracts/Ballista.sol</sub>

```solidity
        // Creator is paid out of the BASE fee only. Routing any snipe tax to the creator
        // would refund part of their own tax when they snipe their own launch.
```

### `function _routeCreatorCut(address token, Curve storage c, uint256 cut) internal`
<sub>was line 1050 of contracts/Ballista.sol</sub>

```solidity
    /// @dev Sends the creator's slice of a fee either to their claimable balance or,
    ///      if the token opted in at launch, into the pool boost accumulator.
    ///
    ///      Be honest about the magnitude of the boost: measured, it is worth roughly a
    ///      1-4% deeper pool depending on churn. It is primarily a TRUST SIGNAL -- "the
    ///      creator put their fees into the liquidity" is worth more than the dollars
    ///      are -- and the UI should not imply otherwise.
```

### `function claimCreatorFees() external nonReentrant returns (uint256 amount)`
<sub>was line 1068 of contracts/Ballista.sol</sub>

```solidity
    /// @notice Withdraw everything you have accrued as a token creator, across all of
    ///         your launches.
    /// @dev Pull, not push -- see the note on creatorFeesAccrued. Zeroes before
    ///      transferring, and nonReentrant on top, so a creator that is a contract
    ///      cannot re-enter and drain more than it is owed.
```

### `function _performGraduation(address token) internal returns (bool success)`
<sub>was line 1081 of contracts/Ballista.sol</sub>

```solidity
    // ── Graduation ──────────────────────────────────────────────────────
    //
    // State only ever moves ACTIVE -> GRADUATION_READY -> GRADUATED, one-way, no
    // exceptions. Reaching GRADUATION_READY is decoupled from the DEX call actually
    // succeeding: the buy that crosses the threshold always closes curve trading in
    // the same transaction, permanently, whether or not the DEX side manages to
    // complete right then. A curve sitting in GRADUATION_READY is not stuck — anyone
    // can call graduate() to retry, and reserves are untouched until the DEX call
    // genuinely succeeds, so there is nothing to roll back if it doesn't.
```

### `function _performGraduation(address token) internal returns (bool success)`
<sub>was line 1091 of contracts/Ballista.sol</sub>

```solidity
    /// @dev The only place the router is actually called. Isolates that one external
    ///      call behind try/catch so a router failure never has to propagate up and
    ///      unwind whatever triggered this — the caller decides what "failure" means
    ///      for its own context (buy() logs and moves on; graduate() reverts, since
    ///      there's no trade to protect on that path).
    ///
    /// @dev REENTRANCY NOTE, do not remove the guards on the strength of ordering.
    ///      State here is written AFTER the external addLiquidity call, which is a
    ///      deliberate deviation from checks-effects-interactions: reserves must stay
    ///      intact until the DEX hand-off is CONFIRMED, or a failed graduation would
    ///      have nothing to roll back to. That is only safe because every external
    ///      entry point -- buy, sell, graduate, claimCreatorFees -- carries
    ///      nonReentrant, and OpenZeppelin's guard is a single shared lock, so a router
    ///      cannot re-enter any of them mid-call. Slither flags this ordering, correctly.
    ///      If anyone ever adds a state-changing external function WITHOUT nonReentrant,
    ///      or removes one of the existing guards, this becomes a live reentrancy bug.
```

### `uint256 usdcLiquidity = c.realUsdcReserves + c.poolBoost;`
<sub>was line 1112 of contracts/Ballista.sol</sub>

```solidity
        // The boost joins the pool HERE and only here -- never in realUsdcReserves,
        // which is what keeps it out of the graduation threshold.
```

### `IERC20(token).forceApprove(router, 0);`
<sub>was line 1130 of contracts/Ballista.sol</sub>

```solidity
                // Router "succeeded" but silently did nothing. Don't leave a stale
                // approval sitting around from the attempt.
```

### `c.state = CurveState.GRADUATED;`
<sub>was line 1137 of contracts/Ballista.sol</sub>

```solidity
            // Effects only happen on CONFIRMED success — reserves were never touched
            // by the failed-attempt path above, so there is no rollback to write.
```

### `function graduate(address token) external nonReentrant`
<sub>was line 1152 of contracts/Ballista.sol</sub>

```solidity
    /// @notice Permissionless retry for a curve sitting in GRADUATION_READY — most
    ///         commonly because the automatic attempt inside buy() failed, e.g. from
    ///         running near the block gas limit alongside the triggering trade.
    ///         Anyone can call this. Ballista's own frontend, backend, or indexer
    ///         being down does not block a token from eventually reaching the DEX.
```

### `function quoteBuy(address token, uint256 usdcIn) external view returns (BuyQuote memory)`
<sub>was line 1165 of contracts/Ballista.sol</sub>

```solidity
    // ── Views ───────────────────────────────────────────────────────────
```

### `function quoteBuy(address token, uint256 usdcIn) external view returns (BuyQuote memory)`
<sub>was line 1167 of contracts/Ballista.sol</sub>

```solidity
    /// @notice Read-only preview of exactly what buy(token, usdcIn, ...) would do
    ///         right now — including correct clamp-to-remaining-supply behavior if
    ///         usdcIn exceeds what's left on the curve. Calls the exact same pure
    ///         function buy() itself uses, so a frontend price preview and the actual
    ///         execution can never silently diverge into two different math paths.
```

### `return _quoteBuy(usdcIn, c.buyFeeBps + _snipeTaxBps(c), c.virtualUsdcReserves, c.virtualTokenReserves, c.tokenReserves);`
<sub>was line 1176 of contracts/Ballista.sol</sub>

```solidity
        // Includes the snipe tax, or a preview shown during the window would promise
        // far more tokens than the trade actually delivers.
```

### `function quoteSell(address token, uint256 tokensIn) external view returns (SellQuote memory)`
<sub>was line 1181 of contracts/Ballista.sol</sub>

```solidity
    /// @notice Mirror of quoteBuy for sell() — same "exact same math as execution"
    ///         guarantee.
```

### `function currentPrice(address token) external view returns (uint256)`
<sub>was line 1190 of contracts/Ballista.sol</sub>

```solidity
    /// @notice Current spot price of `token`, in USDC (6 decimals) per whole token.
```

### `if (c.state != CurveState.ACTIVE) return BPS_DENOMINATOR;`
<sub>was line 1200 of contracts/Ballista.sol</sub>

```solidity
        // Graduation fires on EITHER arm of the dual trigger, so progress has to be
        // whichever is closer -- reporting only threshold progress would leave a curve
        // that is about to deplete showing well under 100% right up to the moment it
        // graduates, which reads as a bug to anyone watching a progress bar.
```

### `function isSymbolAvailable(string calldata symbol) external view returns (bool)`
<sub>was line 1215 of contracts/Ballista.sol</sub>

```solidity
    /// @notice Whether `symbol` could be used in createToken() right now, under the
    ///         CURRENT caseSensitiveSymbols mode. Saves the frontend from reimplementing
    ///         the hashing/case-normalization/timing logic itself just to grey out a
    ///         taken symbol in the launch form.
```

### `function proposeRouter(address router_) external onlyOwner`
<sub>was line 1227 of contracts/Ballista.sol</sub>

```solidity
    // ── Admin (should be a multisig, not an EOA, before real funds are involved) ──
```

### `function proposeRouter(address router_) external onlyOwner`
<sub>was line 1229 of contracts/Ballista.sol</sub>

```solidity
    /// @notice Step 1 of 3. Announces the intent to make `router_` the graduation
    ///         router, and starts the timelock. Does NOT change anything live.
    /// @dev TRUST NOTE. See the note on `router`: whatever is eventually activated here
    ///      receives the entire LP allocation and all accumulated USDC of every token
    ///      that graduates afterwards. This function exists so that granting that power
    ///      is always visible on-chain for at least ROUTER_TIMELOCK before it can be
    ///      used, giving anyone watching time to react to a compromised owner key.
    ///
    ///      Re-proposing an address restarts its clock, which is intentional: it means
    ///      a proposal cannot be quietly parked and activated much later.
```

### `function activateRouter(address router_) external onlyOwner`
<sub>was line 1245 of contracts/Ballista.sol</sub>

```solidity
    /// @notice Step 2 of 3. Makes a previously proposed router live, once its timelock
    ///         has elapsed.
    /// @dev Reverts if the address was never proposed, if the delay has not passed, or
    ///      if the proposal was revoked in the meantime -- revocation zeroes the
    ///      timestamp, so a revoked address is indistinguishable from one never proposed
    ///      and must go through the full delay again.
```

### `function revokeRouter(address router_) external onlyOwner`
<sub>was line 1263 of contracts/Ballista.sol</sub>

```solidity
    /// @notice Emergency stop for a router. IMMEDIATE, no delay, at any stage.
    /// @dev The asymmetry against proposeRouter is the entire point of this design:
    ///      granting trust takes 24 hours and is publicly visible the whole time,
    ///      withdrawing it takes one transaction. Cancels a pending proposal AND, if
    ///      the address is the one currently live, clears `router` outright -- clearing
    ///      only the proposal would leave the malicious router still collecting the
    ///      next graduation, which would make revocation useless.
    ///
    ///      ACCEPTED CONSEQUENCE: createToken() requires a live router, so revoking the
    ///      active one halts new launches until a replacement clears the timelock. That
    ///      is the correct response to discovering a hostile router. Tokens already at
    ///      GRADUATION_READY are delayed, not lost -- graduate() is permissionless and
    ///      retryable the moment a good router is live. Note this does weaken the
    ///      earlier guarantee that a launched token can ALWAYS reach a router: it can
    ///      now be stranded for at least ROUTER_TIMELOCK. Losing 24 hours of graduation
    ///      is strictly better than losing the pot.
    ///
    ///      Deliberately does not revert on an address that was never proposed and is
    ///      not live: this is the function reached for in an emergency, and it should
    ///      never fail on a technicality.
```

### `function setDefaultFees(uint16 buyFeeBps_, uint16 sellFeeBps_) external onlyOwner`
<sub>was line 1291 of contracts/Ballista.sol</sub>

```solidity
    /// @notice Sets the fee that will apply to tokens created AFTER this call. Every token
    ///         already live keeps the fee it launched with — see the Curve struct note.
```

### `require(`
<sub>was line 1295 of contracts/Ballista.sol</sub>

```solidity
        // Each creator share is carved out of the fee on its own side, so dropping a
        // fee below its share would invert the relationship. Lower the share first,
        // deliberately.
```

### `function setDefaultCreatorFees(uint16 creatorBuyFeeBps_, uint16 creatorSellFeeBps_)`
<sub>was line 1306 of contracts/Ballista.sol</sub>

```solidity
    /// @notice Sets the buy-side and sell-side creator shares for tokens created AFTER
    ///         this call. Tokens already live keep the shares they launched with.
    /// @dev Both move in one call rather than via two setters, so there is no
    ///      intermediate block where one side has been updated and the other has not --
    ///      a launch landing in that gap would snapshot a split nobody chose.
    ///
    ///      Each is capped at the fee on its own side: the creator slice is carved out
    ///      of the trade fee, so it can never exceed it. Trader-facing cost does not
    ///      move -- raising these shifts revenue from treasury to creators, it does not
    ///      add a fee.
```

### `function setMaxCreatorLaunchBps(uint16 maxCreatorLaunchBps_) external onlyOwner`
<sub>was line 1333 of contracts/Ballista.sol</sub>

```solidity
    /// @notice Sets the block-0 creator buy cap for tokens created AFTER this call.
    /// @dev Capped at BPS_DENOMINATOR only; the real limit is judgement, and the
    ///      reasoning for 2.5% is on maxCreatorLaunchBps above. Raising this is a gift
    ///      to future creators; it can never change the deal for a live token.
```

### `function setSymbolLockDuration(uint256 symbolLockDuration_) external onlyOwner`
<sub>was line 1356 of contracts/Ballista.sol</sub>

```solidity
    /// @notice How long a claimed symbol stays locked before anyone can reuse it.
    ///         Does not retroactively change when already-claimed symbols unlock —
    ///         each symbol's own claimedAt timestamp plus this duration is what's
    ///         checked at the time of a NEW createToken() call, so changing this
    ///         immediately shifts the unlock time for every symbol already claimed,
    ///         not just future ones. Worth knowing before tuning this live.
```

### `function setDefaultGraduationThreshold(uint256 thresholdUsdc_) external onlyOwner`
<sub>was line 1366 of contracts/Ballista.sol</sub>

```solidity
    /// @notice Sets the graduation threshold that will apply to tokens created AFTER this
    ///         call. Existing tokens keep the threshold they launched under.
```

### `function setCaseSensitiveSymbols(bool caseSensitive_) external onlyOwner`
<sub>was line 1372 of contracts/Ballista.sol</sub>

```solidity
    /// @notice Toggles whether symbol uniqueness is case-sensitive ("Cat" != "cat", the
    ///         launch default) or case-normalized ("Cat" == "cat"). See the NatSpec on
    ///         caseSensitiveSymbols above for the reasoning. Only affects tokens created
    ///         after this call — symbols already claimed keep whatever hash they were
    ///         claimed under.
    /// @dev SQUATTING NOTE, before anyone flips this to false. Case-sensitive (true,
    ///      the launch default) is LENIENT: "HOTCOIN" being taken still leaves "HotCoin"
    ///      available, so squatting a symbol only half-blocks a competitor. Setting this
    ///      to false makes matching strict, which also makes squatting materially
    ///      stronger -- an attacker holding "HOTCOIN" then blocks every case variant of
    ///      it, renewable indefinitely for the creation fee once per symbolLockDuration.
    ///      Measured at the current 0.5 USDC fee and 5 minute lock, that is roughly $144
    ///      per day to deny one symbol outright. Tightening this is a real trade, not a
    ///      free improvement.
```

### `function setTreasury(address treasury_) external onlyOwner`
<sub>was line 1391 of contracts/Ballista.sol</sub>

```solidity
    /// @notice Where creation fees and the protocol's share of trading fees are sent.
    /// @dev TRUST NOTE. A compromised owner key can redirect this to an address they
    ///      control and take every fee collected from that moment on. It is NOT
    ///      retroactive: USDC already sent to the old treasury is gone from this
    ///      contract's reach, curve reserves are untouched, and accrued creator fees
    ///      are unaffected because they are held per-creator and paid by claim, not
    ///      routed through treasury. The exposure is the fee flow going forward, which
    ///      is real but bounded -- unlike the router, which can take an entire
    ///      graduating token's balance in one call.
    ///
    ///      No timelock here on purpose: the loss rate is a fraction of trading volume
    ///      rather than a lump sum, and being able to move treasury quickly is itself
    ///      useful if the treasury address is the thing that gets compromised.
```

### `function pause() external onlyOwner`
<sub>was line 1409 of contracts/Ballista.sol</sub>

```solidity
    /// @notice Emergency stop for createToken/buy/sell. Does NOT affect currently-held
    ///         balances — it only blocks new actions. Meant for "we found a bug, freeze
    ///         while we fix it," not day-to-day use. Once real funds are involved this
    ///         should require the multisig, same as every other admin function here.
```


---

## `contracts/BallistaToken.sol`  —  5 blocks

### `contract BallistaToken is ERC20`
<sub>was line 6 of contracts/BallistaToken.sol</sub>

```solidity
/// @title BallistaToken
/// @notice Fixed-supply ERC20 deployed by Ballista for each new token launch.
/// @dev Entire supply is minted ONCE, in the constructor, to the factory. There is no
///      mint() function anywhere in this contract — this is deliberate. A mintable
///      post-launch token is the single most common rug-pull vector (creator quietly
///      inflates supply after people have bought in). Removing the capability entirely,
///      rather than just not calling it, means holders don't have to trust a promise —
///      they can verify it by reading the contract.
```

### `string public metadataURI;`
<sub>was line 15 of contracts/BallistaToken.sol</sub>

```solidity
    /// @notice Off-chain metadata pointer (e.g. IPFS/Arweave URI) holding image, description,
    ///         and social links. Kept as a simple string so the factory can index/display it
    ///         without needing a separate on-chain registry.
```

### `address public immutable creator;`
<sub>was line 20 of contracts/BallistaToken.sol</sub>

```solidity
    /// @notice The wallet that requested this token's creation. Recorded on-chain (not just
    ///         in a backend DB) so a creator's launch history can be reconstructed by anyone,
    ///         directly from the chain — this is the raw data the reputation/Launch Health
    ///         Score layer reads from.
```

### `address public immutable factory;`
<sub>was line 26 of contracts/BallistaToken.sol</sub>

```solidity
    /// @notice The Ballista factory that deployed this token.
    /// @dev The only address allowed to update metadataURI. Permissioning goes through
    ///      the factory rather than straight to the creator so the update EVENT lives on
    ///      one well-known address instead of being scattered across every token an
    ///      indexer would otherwise have to subscribe to individually.
```

### `function setMetadataURI(string calldata newURI) external`
<sub>was line 47 of contracts/BallistaToken.sol</sub>

```solidity
    /// @notice Replaces the off-chain metadata pointer. Factory-only; the factory
    ///         checks that the caller is this token's creator and emits the audit event.
    /// @dev Deliberately NOT restricted beyond that. Socials are usually added after a
    ///      launch rather than before, and the alternative -- immutable metadata --
    ///      pushes creators into relaunching just to add a Telegram link.
    ///
    ///      The obvious abuse is launching with clean links, attracting buyers, then
    ///      swapping them. That is not preventable on-chain, so it is made VISIBLE
    ///      instead: every update emits old and new on the factory, and the frontend is
    ///      expected to surface "socials updated N hours ago" from those events.
```


---

## `contracts/interfaces/IDEXRouter.sol`  —  1 blocks

### `interface IDEXRouter`
<sub>was line 4 of contracts/interfaces/IDEXRouter.sol</sub>

```solidity
/// @title IDEXRouter
/// @notice Minimal Uniswap-V2-style router interface, used only for the addLiquidity call
///         fired at graduation. Kept intentionally narrow (one function) rather than
///         importing a full router interface, since the only integration point this
///         contract needs is "take token + quote asset, create the pool, return LP tokens."
/// @dev IMPORTANT: No DEX has been publicly confirmed as a launch partner on Arc as of this
///      writing. Do not hardcode a router address until one is confirmed and verified on
///      the Arc block explorer — set it via the factory owner's setRouter() instead, and
///      treat that as a placeholder until then.
```


---

## `contracts/mocks/Attackers.sol`  —  14 blocks

### `contract MaliciousRouter is IDEXRouter`
<sub>was line 17 of contracts/mocks/Attackers.sol</sub>

```solidity
/// @notice TEST ONLY. A router that takes the approved token and USDC for itself and
///         reports a successful liquidity add. Models the worst case of a compromised
///         owner calling setRouter() with a hostile address.
```

### `IERC20(tokenA).transferFrom(msg.sender, thief, amountADesired);`
<sub>was line 35 of contracts/mocks/Attackers.sol</sub>

```solidity
        // Both were forceApprove'd to this contract before the call.
```

### `return (amountADesired, amountBDesired, 1);`
<sub>was line 38 of contracts/mocks/Attackers.sol</sub>

```solidity
        // Non-zero liquidity is all the caller checks.
```

### `contract ReentrantRouter is IDEXRouter`
<sub>was line 43 of contracts/mocks/Attackers.sol</sub>

```solidity
/// @notice TEST ONLY. Attempts cross-function reentrancy from inside the graduation
///         call, which is the deepest point Ballista reaches into an external contract.
```

### `try ballista.buy(token, 1e6, 0) { lastFailure = "BUY REENTERED"; }`
<sub>was line 58 of contracts/mocks/Attackers.sol</sub>

```solidity
        // Every one of these should be blocked by the shared nonReentrant guard.
```

### `contract GasGuzzlerRouter is IDEXRouter`
<sub>was line 71 of contracts/mocks/Attackers.sol</sub>

```solidity
/// @notice TEST ONLY. Burns every drop of gas it is given.
```

### `contract GarbageRouter is IDEXRouter`
<sub>was line 82 of contracts/mocks/Attackers.sol</sub>

```solidity
/// @notice TEST ONLY. Returns nonsense rather than reverting.
```

### `contract HostileCreator`
<sub>was line 91 of contracts/mocks/Attackers.sol</sub>

```solidity
/// @notice TEST ONLY. A creator that is a contract with no way to receive anything and
///         which reverts on every call, used to prove it cannot break other people's
///         trades on its token.
```

### `fallback() external payable { revert("HostileCreator: no"); }`
<sub>was line 102 of contracts/mocks/Attackers.sol</sub>

```solidity
    // Reverts on absolutely everything else.
```

### `contract MassLauncher`
<sub>was line 107 of contracts/mocks/Attackers.sol</sub>

```solidity
/// @notice TEST ONLY. Launches many tokens from one transaction, to measure whether the
///         per-wallet launch cooldown is meaningful against a contract-based spammer.
```

### `contract LauncherFactory`
<sub>was line 140 of contracts/mocks/Attackers.sol</sub>

```solidity
/// @notice TEST ONLY. One contract, many launcher children, to show the cooldown is
///         per-address and therefore trivially sidestepped.
```

### `contract PartialConsumeRouter is IDEXRouter`
<sub>was line 158 of contracts/mocks/Attackers.sol</sub>

```solidity
/// @notice TEST ONLY. A router that consumes only PART of what it was approved for and
///         still reports a successful liquidity add -- the shape of any router whose
///         ratio maths leaves a remainder, not necessarily a malicious one. Used to
///         show that the leftover allowance survives a SUCCESSFUL graduation.
```

### `IERC20(tokenA).transferFrom(msg.sender, to, amountADesired / 2);`
<sub>was line 170 of contracts/mocks/Attackers.sol</sub>

```solidity
        // Take only half of each, as a router with leftover ratio would.
```

### `function sweepResidualAllowance(address usdcAddr, address factory) external returns (uint256)`
<sub>was line 176 of contracts/mocks/Attackers.sol</sub>

```solidity
    /// @notice Later, unrelated transaction: drain whatever allowance was left behind.
```


---

## `contracts/mocks/CreatorLauncher.sol`  —  3 blocks

### `contract CreatorLauncher`
<sub>was line 13 of contracts/mocks/CreatorLauncher.sol</sub>

```solidity
/// @notice TEST ONLY. Creates a token and then hammers creatorLaunchBuy() many times
///         inside that SAME transaction -- and therefore the same block, which is the
///         entire window the privileged buy is open for.
///
///         This is the exploit the cumulative cap exists to stop. With a per-transaction
///         cap, ten "2.5%" buys would take ~37% of curve supply for a few hundred
///         dollars. The cap must be cumulative per token or it is not a cap.
```

### `function launchAndLoop(string calldata symbol, uint256 usdcEach, uint256 times)`
<sub>was line 34 of contracts/mocks/CreatorLauncher.sol</sub>

```solidity
    /// @notice Launch, then loop the privileged buy `times` times in one transaction.
```

### `try ballista.creatorLaunchBuy(token, usdcEach, 0) {} catch {}`
<sub>was line 41 of contracts/mocks/CreatorLauncher.sol</sub>

```solidity
            // Swallow the revert once the allowance is exhausted, so the loop measures
            // how much can actually be taken rather than just reverting the whole tx.
```


---

## `contracts/mocks/MockBlocklistUSDC.sol`  —  1 blocks

### `contract MockBlocklistUSDC is ERC20`
<sub>was line 6 of contracts/mocks/MockBlocklistUSDC.sol</sub>

```solidity
/// @notice Test-only USDC stand-in that can refuse transfers to specific addresses,
///         mirroring the blocklist real Circle USDC actually enforces.
/// @dev This is the realistic version of "the creator cannot receive funds". A plain
///      ERC20 has no recipient callback, so a creator contract cannot reject an
///      incoming transfer by reverting — but a blocklisted creator address makes the
///      transfer itself revert, which is exactly the case that would brick every trade
///      on a token if creator fees were pushed inside buy()/sell() instead of accrued.
///      Never deploy anything like this to a real network.
```


---

## `contracts/mocks/MockRouter.sol`  —  4 blocks

### `contract MockRouter is IDEXRouter`
<sub>was line 8 of contracts/mocks/MockRouter.sol</sub>

```solidity
/// @notice Test-only stand-in for a real Uniswap-V2-style router. Pulls the approved
///         tokens (proving the factory's forceApprove actually worked) and returns a
///         nonzero liquidity amount, simulating a successful pool creation.
```

### `to; // recipient acknowledged, no LP token minted in this mock`
<sub>was line 26 of contracts/mocks/MockRouter.sol</sub>

```solidity
        // Fake LP token accounting for the test — real router would mint an actual LP
        // token to `to`. What matters for our test is: did the factory approve and send
        // the right amounts, and did `to` (the burn address) end up recorded as the
        // recipient.
```

### `contract MockBrokenRouter is IDEXRouter`
<sub>was line 35 of contracts/mocks/MockRouter.sol</sub>

```solidity
/// @notice Simulates a router that "succeeds" (doesn't revert) but returns zero
///         liquidity — the exact case the `require(liquidity > 0)` check in
///         Ballista._graduate is there to catch.
```

### `contract MockRevertingRouter is IDEXRouter`
<sub>was line 57 of contracts/mocks/MockRouter.sol</sub>

```solidity
/// @notice Simulates a router that reverts outright — e.g. genuinely out of gas near
///         the block limit, or a real integration failure. This is the case
///         _performGraduation's try/catch exists for: unlike MockBrokenRouter (which
///         "succeeds" with zero liquidity), this never even returns.
```


---

## `contracts/mocks/MockUSDC.sol`  —  1 blocks

### `contract MockUSDC is ERC20`
<sub>was line 6 of contracts/mocks/MockUSDC.sol</sub>

```solidity
/// @notice Test-only stand-in for real USDC. 6 decimals, freely mintable — never deploy
///         anything like this to a real network.
```
