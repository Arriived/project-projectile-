// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";

import "./ArcLaunchToken.sol";
import "./interfaces/IDEXRouter.sol";

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
contract Ballista is Ownable, ReentrancyGuard, Pausable {
    using SafeERC20 for IERC20;

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
    uint256 public constant CURVE_TOKEN_SUPPLY = 807_000_000e18;
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
    uint256 public constant LP_TOKEN_RESERVE = 193_000_000e18;
    uint256 public constant TOTAL_TOKEN_SUPPLY = CURVE_TOKEN_SUPPLY + LP_TOKEN_RESERVE;

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
    uint256 public constant INITIAL_VIRTUAL_TOKEN_RESERVES = 1_075_000_000e18;
    uint256 public constant INITIAL_VIRTUAL_USDC_RESERVES = 2_667e6;

    // ── Graduation ──────────────────────────────────────────────────────
    // DEFAULT applied to newly created tokens only. Existing tokens keep whatever value was
    // snapshotted into their Curve struct at launch — see the note on the struct above.
    // 67,000 rather than the Pump.fun-derived 69,000 — deliberate, ours.
    uint256 public defaultGraduationThresholdUsdc = 8_000e6;
    address public constant BURN_ADDRESS = 0x000000000000000000000000000000000000dEaD;
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
    address public router;

    /// @notice Delay between proposing a router and being able to activate it.
    /// @dev Deliberately a constant and NOT owner-settable. An owner who can shorten
    ///      this to zero does not have a timelock, they have a formality -- the whole
    ///      protection is that a compromised key cannot compress the waiting period.
    ///      24 hours is long enough for anyone monitoring RouterProposed to react, and
    ///      short enough that replacing a broken router is not a multi-day outage.
    uint256 public constant ROUTER_TIMELOCK = 24 hours;

    /// @notice When each address was proposed as a router. Zero means "not proposed",
    ///         which is also what revocation resets it to.
    mapping(address => uint256) public routerProposedAt;

    // ── Fees ────────────────────────────────────────────────────────────
    // Also defaults-for-new-tokens-only, same reasoning as above.
    uint16 public defaultBuyFeeBps = 100; // 1%
    uint16 public defaultSellFeeBps = 100; // 1%
    uint16 public constant MAX_FEE_BPS = 1000; // hard ceiling (10%) — enforced per-token at creation, cannot be exceeded by any future admin action on that token
    uint256 public constant BPS_DENOMINATOR = 10_000;

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
    uint16 public maxCreatorLaunchBps = 250;

    uint16 public defaultCreatorBuyFeeBps = 90;  // 0.90% of a buy  = 90% of a 1% fee
    uint16 public defaultCreatorSellFeeBps = 50; // 0.50% of a sell = 50% of a 1% fee

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
    mapping(address => uint256) public creatorFeesAccrued;

    // ── Snipe tax ───────────────────────────────────────────────────────

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
    uint16 public constant MAX_TOTAL_FEE_BPS = 9900;

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
    mapping(uint32 => uint16[]) private _snipeTaxTables;

    /// @notice Highest entry in a published table, cached so createToken can check the
    ///         combined-fee ceiling without walking the array on every launch.
    mapping(uint32 => uint16) public snipeTaxTableMaxBps;

    /// @notice Version new launches snapshot. Existing tokens keep their own.
    uint32 public activeSnipeTaxTableVersion;
    uint32 private _nextSnipeTaxTableVersion;

    /// @notice Share of collected snipe tax sent to treasury, in bps. The remainder goes
    ///         into the curve's realUsdcReserves without releasing any tokens.
    /// @dev Deliberately never routed to the creator: a creator sniping their own launch
    ///      would recover part of their own tax, weakening the deterrent for precisely
    ///      the person with the most advance knowledge of the launch.
    uint16 public defaultSnipeTaxTreasuryBps = 7000; // 70% treasury / 30% curve
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
    uint256 public creationFeeUsdc = 5e5;
    address public treasury;

    // ── Anti-spam ───────────────────────────────────────────────────────
    uint256 public launchCooldown = 10; // minimum gap between two launches from the same wallet — adjust via setLaunchCooldown(), no redeploy needed
    mapping(address => uint256) public lastLaunchTimestamp;

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
    uint256 public symbolLockDuration = 5 minutes;
    // The unlock time is computed and stored ONCE, at claim time — not read live off
    // symbolLockDuration on every check. Same reasoning as the per-token fee/threshold
    // snapshot below: without this, changing symbolLockDuration would retroactively
    // shift the unlock time for every symbol already claimed, including ones mid-window
    // right now, not just symbols claimed after the change.
    mapping(bytes32 => uint256) public symbolUnlocksAt; // 0 = never claimed
    // detection belongs in the off-chain indexer that feeds the discovery feed, not on-chain —
    // string-similarity checks are expensive and easy to route around on their own.

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
    bool public caseSensitiveSymbols = true;

    // ── Curve state ─────────────────────────────────────────────────────
    /// @notice ACTIVE: normal curve trading. GRADUATION_READY: threshold crossed, curve
    ///         trading closed, DEX liquidity not yet successfully created — a transient
    ///         state, not a dead end. GRADUATED: DEX liquidity created, permanent.
    ///         One-way only: ACTIVE -> GRADUATION_READY -> GRADUATED. Nothing ever moves
    ///         backwards.
    enum CurveState { ACTIVE, GRADUATION_READY, GRADUATED }

    struct Curve {
        address token;
        address creator;
        uint256 virtualTokenReserves;
        uint256 virtualUsdcReserves;
        uint256 realUsdcReserves;
        uint256 tokenReserves; // tokens still held by the curve, available to sell
        CurveState state;
        // Snapshotted at creation, NOT read live from storage on every trade. Without this,
        // an admin fee/threshold change instantly applies to every token already trading —
        // including ones whose holders bought in under a different, advertised deal. Every
        // token now trades under the terms it launched with, permanently, regardless of what
        // the global defaults change to afterwards.
        uint16 buyFeeBps;
        uint16 sellFeeBps;
        // Carved out of buyFeeBps/sellFeeBps above, never added to them. Snapshotted
        // for the same reason they are: a creator who launched on a promised split
        // keeps it even if the global default later changes. That is the whole point --
        // the plan is to run a generous launch promotion and move toward the market
        // rate later WITHOUT altering the deal for anyone already launched.
        uint16 creatorBuyFeeBps;
        uint16 creatorSellFeeBps;
        uint256 graduationThresholdUsdc;
        // The block createToken() executed in. Trading opens the NEXT block — see the
        // require() in buy()/sell(). This does not stop a sniper with a bot watching the
        // mempool for the creation tx and firing in the very next block; it only removes
        // the specific unfairness of someone buying and selling inside the same block the
        // token was created in, before anyone else could possibly have seen it exists.
        uint256 creationBlock;
        /// The snipe tax decays in SECONDS, which creationBlock cannot express.
        uint256 creationTimestamp;
        uint32 snipeTaxTableVersion;
        uint16 snipeTaxTreasuryBps;
        /// Cap on the creator's block-0 buy, snapshotted at launch.
        uint16 maxCreatorLaunchBps;
        /// Tokens the creator has taken through the block-0 path so far.
        /// CUMULATIVE, and counted as tokens PURCHASED rather than tokens held: a
        /// balance check is defeated by transferring out and buying again, and a
        /// per-transaction cap is defeated by simply sending several transactions in
        /// the same block.
        uint256 creatorLaunchPurchased;
    }

    /// @dev Private with an explicit struct getter below, rather than a public mapping.
    ///      Solidity's auto-generated getter returns the struct as a flat 14-value
    ///      tuple, which overflows the stack in the ABI encoder and fails to compile.
    ///      Returning `Curve memory` is one value instead of fourteen, which sidesteps
    ///      it without turning on viaIR -- and gives callers named fields rather than a
    ///      positional tuple they have to keep in sync by hand.
    mapping(address => Curve) private _curves;

    /// @notice Full curve state for a token. Reverts nothing for an unknown token --
    ///         callers should check `token` on the result, as the internal code does.
    function curves(address token) external view returns (Curve memory) {
        return _curves[token];
    }
    IERC20 public immutable usdc;

    /// @dev Return value of _quoteBuy. Pulling this computation into its own struct +
    ///      pure function (rather than inline in buy()) isn't just tidiness — buy() with
    ///      the clamp-on-insufficient-supply logic inlined hits Solidity's 16-local-slot
    ///      stack limit and fails to compile. This also happens to be exactly the shape
    ///      a future public quoteBuy() view would need, if one gets added later.
    struct BuyQuote {
        uint256 tokensOut;
        uint256 newVirtualUsdc;
        uint256 newVirtualToken;
        uint256 actualUsdcIn; // may be less than the usdcIn requested, if clamped
        uint256 actualFee;
    }

    /// @dev How a fee already charged is divided up. Computed in its own function for
    ///      the same reason BuyQuote exists: buy() with this inlined exceeds Solidity's
    ///      local-slot limit and fails to compile.
    struct FeeSplit {
        uint256 creatorCut;      // accrued to the creator, carved out of the base fee
        uint256 treasuryCut;     // total actually transferred out to treasury
        uint256 curveCut;        // snipe tax share retained in the curve
        uint256 snipeToTreasury; // snipe tax share within treasuryCut, for the event
    }

    /// @dev Mirror of BuyQuote for sell() — same stack-depth reasoning.
    struct SellQuote {
        uint256 actualTokensIn; // may be less than the tokensIn requested, if clamped
        uint256 newVirtualUsdc;
        uint256 newVirtualToken;
        uint256 usdcOutGross;
        uint256 fee;
    }

    event TokenCreated(address indexed token, address indexed creator, string name, string symbol, string metadataURI);
    event Trade(address indexed token, address indexed trader, bool isBuy, uint256 usdcAmount, uint256 tokenAmount);
    event Graduated(address indexed token, uint256 tokenLiquidity, uint256 usdcLiquidity, uint256 lpTokensBurned);
    event GraduationReady(address indexed token);
    event GraduationAttemptFailed(address indexed token);
    event CaseSensitiveSymbolsSet(bool caseSensitive);
    /// @dev These three events ARE the early-warning system. Anyone watching the chain
    ///      should alert on RouterProposed: it is the only advance notice that the most
    ///      dangerous address in the contract is about to change.
    /// @dev The frontend must surface this on every token page. Disclosure is the
    ///      protection here, not the cap.
    event CreatorLaunchBuy(
        address indexed token,
        address indexed creator,
        uint256 usdcSpent,
        uint256 tokensReceived,
        uint256 bpsOfCurveSupply
    );
    event RouterProposed(address indexed router, uint256 activatableAt);
    event RouterActivated(address indexed router);
    event MaxCreatorLaunchBpsSet(uint16 maxCreatorLaunchBps);
    event RouterRevoked(address indexed router, bool wasLive);
    event CreatorFeeAccrued(address indexed token, address indexed creator, uint256 amount);
    event CreatorFeesClaimed(address indexed creator, uint256 amount);
    event DefaultCreatorFeesSet(uint16 creatorBuyFeeBps, uint16 creatorSellFeeBps);
    event SnipeTaxTablePublished(uint32 indexed version, uint16[] table, uint16 maxBps);
    event DefaultSnipeTaxTreasuryBpsSet(uint16 treasuryBps);
    event SnipeTaxCollected(address indexed token, address indexed buyer, uint256 toTreasury, uint256 toCurve);

    constructor(address usdc_, address treasury_) Ownable(msg.sender) {
        require(usdc_ != address(0) && treasury_ != address(0), "zero address");
        usdc = IERC20(usdc_);
        treasury = treasury_;

        // Opening table: ~98% at t=0 decaying to nothing by t=5. Modelled on Pons V2,
        // with t=0 capped by MAX_TOTAL_FEE_BPS. Tunable via publishSnipeTaxTable().
        uint16[] memory opening = new uint16[](5);
        opening[0] = 9800; // 98%
        opening[1] = 2500; // 25%
        opening[2] = 300;  // 3%
        opening[3] = 100;  // 1%
        opening[4] = 0;
        _publishSnipeTaxTable(opening);
    }

    // ── Snipe tax ───────────────────────────────────────────────────────

    /// @notice Publishes a new snipe tax table and makes it active for FUTURE launches.
    ///         Tokens already trading keep the version they launched under.
    /// @param table Tax in bps indexed by whole seconds since launch; length sets the
    ///        window. An empty table disables the tax entirely for new launches.
    function publishSnipeTaxTable(uint16[] calldata table)
        external
        onlyOwner
        returns (uint32 version)
    {
        uint16[] memory copied = new uint16[](table.length);
        for (uint256 i = 0; i < table.length; i++) {
            copied[i] = table[i];
        }
        return _publishSnipeTaxTable(copied);
    }

    function _publishSnipeTaxTable(uint16[] memory table) internal returns (uint32 version) {
        uint16 maxBps = 0;
        for (uint256 i = 0; i < table.length; i++) {
            if (table[i] > maxBps) maxBps = table[i];
        }
        // Checked here as well as at creation so a table that could never be launched
        // under is rejected at publish time, where the mistake is visible, rather than
        // silently bricking every subsequent createToken call.
        require(
            uint256(maxBps) + uint256(MAX_FEE_BPS) <= uint256(MAX_TOTAL_FEE_BPS) ||
                uint256(maxBps) + uint256(defaultBuyFeeBps) <= uint256(MAX_TOTAL_FEE_BPS),
            "snipe tax plus base fee would exceed the combined ceiling"
        );

        version = _nextSnipeTaxTableVersion++;
        _snipeTaxTables[version] = table;
        snipeTaxTableMaxBps[version] = maxBps;
        activeSnipeTaxTableVersion = version;
        emit SnipeTaxTablePublished(version, table, maxBps);
    }

    /// @notice The full tax table for a published version.
    function snipeTaxTable(uint32 version) external view returns (uint16[] memory) {
        return _snipeTaxTables[version];
    }

    /// @notice Snipe tax in bps that a buy on this token would pay right now.
    function currentSnipeTaxBps(address token) external view returns (uint16) {
        Curve storage c = _curves[token];
        require(c.token == token, "unknown token");
        return _snipeTaxBps(c);
    }

    function _snipeTaxBps(Curve storage c) internal view returns (uint16) {
        uint16[] storage table = _snipeTaxTables[c.snipeTaxTableVersion];
        uint256 elapsed = block.timestamp - c.creationTimestamp;
        if (elapsed >= table.length) return 0;
        return table[elapsed];
    }

    function setDefaultSnipeTaxTreasuryBps(uint16 treasuryBps_) external onlyOwner {
        require(treasuryBps_ <= BPS_DENOMINATOR, "split cannot exceed 100%");
        defaultSnipeTaxTreasuryBps = treasuryBps_;
        emit DefaultSnipeTaxTreasuryBpsSet(treasuryBps_);
    }

    // ── Launch ──────────────────────────────────────────────────────────

    /// @notice Hash of every parameter createToken() reads from global defaults right
    ///         now. A frontend fetches this immediately before showing the "create"
    ///         button, then passes it back as expectedEconomicsHash — if any of these
    ///         values change between when the creator saw the terms and when their
    ///         transaction actually mines, createToken() reverts rather than silently
    ///         launching under different terms than what was shown. This does not
    ///         protect against changes to launchCooldown or creationFeeUsdc — those
    ///         affect eligibility to launch at all, not the economics of the token
    ///         once launched, so a mismatch there isn't the same kind of surprise.
    function currentEconomicsHash() public view returns (bytes32) {
        return keccak256(abi.encode(
            defaultBuyFeeBps,
            defaultSellFeeBps,
            defaultGraduationThresholdUsdc,
            defaultCreatorBuyFeeBps,
            defaultCreatorSellFeeBps,
            maxCreatorLaunchBps,
            activeSnipeTaxTableVersion,
            defaultSnipeTaxTreasuryBps,
            caseSensitiveSymbols,
            symbolLockDuration
        ));
    }

    function createToken(
        string calldata name,
        string calldata symbol,
        string calldata metadataURI,
        bytes32 expectedEconomicsHash
    ) external nonReentrant whenNotPaused returns (address token) {
        // No router means nothing to graduate into. Without this check a token can be
        // launched, trade all the way to its threshold, flip to GRADUATION_READY --
        // where buy() and sell() are both closed -- and then sit there frozen, with
        // holders unable to exit, until an owner configures a router. Refusing the
        // launch outright costs nothing: it surfaces at the moment a creator tries,
        // when no one has any money in the curve, instead of at 67,000 USDC with
        // holders trapped. Paired with setRouter()'s zero-address rejection, so a
        // router that exists at launch cannot later be taken away.
        require(
            router != address(0),
            "router not set: launches are closed until a DEX is configured"
        );
        // The snapshotted base fee and tax table must together stay inside the range
        // the clamp path can invert, for the whole life of this token.
        require(
            uint256(defaultBuyFeeBps) + uint256(snipeTaxTableMaxBps[activeSnipeTaxTableVersion])
                <= uint256(MAX_TOTAL_FEE_BPS),
            "base fee plus snipe tax would exceed the combined ceiling"
        );
        require(
            expectedEconomicsHash == currentEconomicsHash(),
            "economics changed since you last checked -- refresh and confirm the new terms"
        );
        require(
            block.timestamp >= lastLaunchTimestamp[msg.sender] + launchCooldown,
            "cooldown: wait before launching again"
        );
        // caseSensitiveSymbols controls whether "CAT", "cat", and "Cat" are treated as the
        // same symbol (false) or as distinct symbols (true, the launch default) — see the
        // NatSpec on the flag above for why this starts lenient.
        bytes32 symbolHash = caseSensitiveSymbols
            ? keccak256(bytes(symbol))
            : keccak256(bytes(_toUpperAscii(symbol)));
        uint256 unlocksAt = symbolUnlocksAt[symbolHash];
        require(
            unlocksAt == 0 || block.timestamp >= unlocksAt,
            "symbol locked: still within another launch's protection window"
        );

        if (creationFeeUsdc > 0) {
            usdc.safeTransferFrom(msg.sender, treasury, creationFeeUsdc);
        }

        lastLaunchTimestamp[msg.sender] = block.timestamp;
        symbolUnlocksAt[symbolHash] = block.timestamp + symbolLockDuration;

        ArcLaunchToken newToken = new ArcLaunchToken(
            name,
            symbol,
            TOTAL_TOKEN_SUPPLY,
            msg.sender,
            address(this),
            metadataURI
        );
        token = address(newToken);

        _curves[token] = Curve({
            token: token,
            creator: msg.sender,
            virtualTokenReserves: INITIAL_VIRTUAL_TOKEN_RESERVES,
            virtualUsdcReserves: INITIAL_VIRTUAL_USDC_RESERVES,
            realUsdcReserves: 0,
            tokenReserves: CURVE_TOKEN_SUPPLY,
            state: CurveState.ACTIVE,
            buyFeeBps: defaultBuyFeeBps,
            sellFeeBps: defaultSellFeeBps,
            creatorBuyFeeBps: defaultCreatorBuyFeeBps,
            creatorSellFeeBps: defaultCreatorSellFeeBps,
            graduationThresholdUsdc: defaultGraduationThresholdUsdc,
            creationBlock: block.number,
            creationTimestamp: block.timestamp,
            snipeTaxTableVersion: activeSnipeTaxTableVersion,
            snipeTaxTreasuryBps: defaultSnipeTaxTreasuryBps,
            maxCreatorLaunchBps: maxCreatorLaunchBps,
            creatorLaunchPurchased: 0
        });

        emit TokenCreated(token, msg.sender, name, symbol, metadataURI);
    }

    /// @dev Uppercases ASCII a–z only. Symbols are expected to be plain ASCII tickers;
    ///      this is a spam-cost deterrent, not a cryptographic guarantee, by design.
    ///      Only used when caseSensitiveSymbols is false.
    function _toUpperAscii(string memory str) internal pure returns (string memory) {
        bytes memory b = bytes(str);
        for (uint256 i = 0; i < b.length; i++) {
            if (b[i] >= 0x61 && b[i] <= 0x7A) {
                b[i] = bytes1(uint8(b[i]) - 32);
            }
        }
        return string(b);
    }

    // ── Trading ─────────────────────────────────────────────────────────

    /// @dev Pure curve math for a buy, including the clamp-to-remaining-supply case.
    ///      Takes only primitive values (no storage access) so it's cheap to reason
    ///      about and safe to eventually expose as a public quoteBuy() view.
    function _quoteBuy(
        uint256 usdcIn,
        uint16 buyFeeBps,
        uint256 virtualUsdcReserves,
        uint256 virtualTokenReserves,
        uint256 tokenReservesAvailable
    ) internal pure returns (BuyQuote memory q) {
        uint256 k = virtualUsdcReserves * virtualTokenReserves;
        uint256 fee = (usdcIn * buyFeeBps) / BPS_DENOMINATOR;
        uint256 usdcInAfterFee = usdcIn - fee;
        uint256 newVirtualUsdc = virtualUsdcReserves + usdcInAfterFee;
        // Rounded UP (ceiling), not down. Rounding newVirtualToken down — the naive
        // approach — meant tokensOut came out slightly too HIGH on every single trade,
        // i.e. the curve was quietly bleeding value to traders, trade after trade,
        // forever. Rounding up here means any residual dust favors the curve, not the
        // trader — the standard direction used by production AMMs (Uniswap included)
        // for exactly this reason.
        uint256 newVirtualToken = _ceilDiv(k, newVirtualUsdc);
        require(newVirtualToken <= virtualTokenReserves, "curve math error");
        uint256 tokensOut = virtualTokenReserves - newVirtualToken;

        if (tokensOut <= tokenReservesAvailable) {
            // Common case: enough supply remains to fill the full request.
            q.tokensOut = tokensOut;
            q.newVirtualUsdc = newVirtualUsdc;
            q.newVirtualToken = newVirtualToken;
            q.actualUsdcIn = usdcIn;
            q.actualFee = fee;
            return q;
        }

        // Not enough supply left to fill the full request. Clamp to exactly what
        // remains rather than reverting the whole trade — this is what stops the buy
        // that finishes a launch from being griefable by anyone slipping a smaller
        // purchase in first. The true cost is recomputed DETERMINISTICALLY from the
        // clamped, known token amount, rather than by inverting the ceil-divided
        // formula above — that inversion has its own rounding edge cases, and
        // duplicating it as a second math path is a second place for a bug to hide.
        // Deriving directly from tokenReservesAvailable (a known, exact stored value)
        // avoids that entirely.
        q.tokensOut = tokenReservesAvailable;
        q.newVirtualToken = virtualTokenReserves - q.tokensOut;
        // Ceiling, same reasoning as above: rounding dust favors the curve, so the
        // trade that empties it doesn't leak value on the way out.
        q.newVirtualUsdc = _ceilDiv(k, q.newVirtualToken);
        uint256 clampedUsdcInAfterFee = q.newVirtualUsdc - virtualUsdcReserves;
        // Invert the fee formula the same direction: round the required gross amount
        // UP, so the fee actually charged is never less than buyFeeBps of what was
        // actually spent.
        q.actualUsdcIn = _ceilDiv(clampedUsdcInAfterFee * BPS_DENOMINATOR, BPS_DENOMINATOR - buyFeeBps);
        q.actualFee = q.actualUsdcIn - clampedUsdcInAfterFee;

        // Buying fewer tokens should never cost more than buying the originally
        // requested, larger amount would have. This should be true by construction
        // given monotonic curve pricing — this is a defensive backstop, not a case
        // expected to ever actually fire. If it does, something upstream is wrong,
        // and reverting is far safer than silently overcharging.
        require(q.actualUsdcIn <= usdcIn, "clamp computed a higher cost than offered");
    }

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
    function creatorLaunchBuy(address token, uint256 usdcIn, uint256 minTokensOut)
        external
        nonReentrant
        whenNotPaused
    {
        Curve storage c = _curves[token];
        require(c.token == token, "unknown token");
        require(msg.sender == c.creator, "only the token's creator may buy at launch");
        require(
            block.number == c.creationBlock,
            "creator launch buy is block 0 only -- use buy() from the next block"
        );
        require(c.state == CurveState.ACTIVE, "curve not open for trading: check DEX or wait for graduation");
        require(usdcIn > 0, "zero amount");

        uint256 cap = (CURVE_TOKEN_SUPPLY * uint256(c.maxCreatorLaunchBps)) / BPS_DENOMINATOR;
        require(c.creatorLaunchPurchased < cap, "creator launch allocation already used");
        uint256 remainingAllowance = cap - c.creatorLaunchPurchased;

        // Bound by BOTH the remaining allowance and the curve's actual supply, so the
        // clamp cannot hand out more than either permits.
        uint256 available =
            c.tokenReserves < remainingAllowance ? c.tokenReserves : remainingAllowance;

        // NOTE the fee argument: c.buyFeeBps ALONE, with no snipe tax added. That also
        // changes the denominator in the clamp path's fee inversion,
        // _ceilDiv(x * BPS, BPS - feeBps), which is why the clamp is exercised
        // explicitly at this fee in the tests rather than assumed.
        BuyQuote memory q = _quoteBuy(
            usdcIn, c.buyFeeBps, c.virtualUsdcReserves, c.virtualTokenReserves, available
        );
        require(q.tokensOut >= minTokensOut, "slippage exceeded");

        FeeSplit memory f = _splitBuyFee(c, q.actualUsdcIn, q.actualFee);

        c.virtualUsdcReserves = q.newVirtualUsdc;
        c.virtualTokenReserves = q.newVirtualToken;
        c.realUsdcReserves += (q.actualUsdcIn - q.actualFee) + f.curveCut;
        c.tokenReserves -= q.tokensOut;
        c.creatorLaunchPurchased += q.tokensOut;
        bool crossedThreshold =
            c.realUsdcReserves >= c.graduationThresholdUsdc || c.tokenReserves == 0;

        if (f.creatorCut > 0) {
            creatorFeesAccrued[c.creator] += f.creatorCut;
            emit CreatorFeeAccrued(token, c.creator, f.creatorCut);
        }

        usdc.safeTransferFrom(msg.sender, address(this), q.actualUsdcIn);
        if (f.treasuryCut > 0) usdc.safeTransfer(treasury, f.treasuryCut);
        IERC20(token).safeTransfer(msg.sender, q.tokensOut);

        emit Trade(token, msg.sender, true, q.actualUsdcIn, q.tokensOut);
        emit CreatorLaunchBuy(
            token,
            msg.sender,
            q.actualUsdcIn,
            q.tokensOut,
            (c.creatorLaunchPurchased * BPS_DENOMINATOR) / CURVE_TOKEN_SUPPLY
        );

        // Kept for consistency with buy() rather than assumed unreachable. At the 2.5%
        // default a launch buy cannot get near either arm, but maxCreatorLaunchBps is
        // settable and this should not become a special case that quietly skips it.
        if (crossedThreshold) {
            c.state = CurveState.GRADUATION_READY;
            emit GraduationReady(token);
            if (!_performGraduation(token)) emit GraduationAttemptFailed(token);
        }
    }

    function buy(address token, uint256 usdcIn, uint256 minTokensOut) external nonReentrant whenNotPaused {
        Curve storage c = _curves[token];
        require(c.token == token, "unknown token");
        require(c.state == CurveState.ACTIVE, "curve not open for trading: check DEX or wait for graduation");
        require(block.number > c.creationBlock, "trading opens next block");
        require(usdcIn > 0, "zero amount");

        // Snipe tax rides on top of the base fee for the purposes of the curve math:
        // the trader pays it, and the curve releases tokens only for what is left after
        // BOTH. MAX_TOTAL_FEE_BPS, enforced at creation, is what keeps this sum inside
        // the range the clamp path can invert.
        uint16 taxBps = _snipeTaxBps(c);
        BuyQuote memory q = _quoteBuy(usdcIn, c.buyFeeBps + taxBps, c.virtualUsdcReserves, c.virtualTokenReserves, c.tokenReserves);

        require(q.tokensOut >= minTokensOut, "slippage exceeded");

        FeeSplit memory f = _splitBuyFee(c, q.actualUsdcIn, q.actualFee);

        // Effects before interactions: all state finalized before any external call fires.
        c.virtualUsdcReserves = q.newVirtualUsdc;
        c.virtualTokenReserves = q.newVirtualToken;
        // The curve keeps the post-fee amount PLUS its share of the snipe tax. That
        // share adds USDC without releasing any tokens and without moving the virtual
        // reserves, so it raises the floor under holders rather than buying anything.
        // It counts toward graduation, which is intended.
        c.realUsdcReserves += (q.actualUsdcIn - q.actualFee) + f.curveCut;
        c.tokenReserves -= q.tokensOut;
        // DUAL GRADUATION TRIGGER. Either condition graduates the curve.
        //
        // The depletion arm is not decoration. The curve's ceiling -- the most
        // realUsdcReserves can ever reach, fixed by the virtual reserves -- sits only
        // $30.85 above the threshold at the current constants. Round CURVE_TOKEN_SUPPLY
        // down by a single million and the ceiling drops BELOW the threshold, at which
        // point a threshold-only check would leave every token permanently stuck: no
        // tokens left to sell, threshold unreachable, holders trapped. Not an edge
        // case, a 100% failure rate. The depletion arm makes that class of mistake
        // survivable rather than fatal.
        //
        // sell() needs no equivalent check: tokenReserves only ever reaches zero via a
        // buy, and that buy graduates the curve in the same transaction, closing sell()
        // along with it. A sell can never observe a depleted curve in ACTIVE state.
        bool crossedThreshold =
            c.realUsdcReserves >= c.graduationThresholdUsdc || c.tokenReserves == 0;

        // Creator share is only ACCRUED here -- never transferred to the creator inside
        // a trade. Still an effect, so it lands with the other effects.
        if (f.creatorCut > 0) {
            creatorFeesAccrued[c.creator] += f.creatorCut;
            emit CreatorFeeAccrued(token, c.creator, f.creatorCut);
        }
        if (taxBps > 0) {
            emit SnipeTaxCollected(token, msg.sender, f.snipeToTreasury, f.curveCut);
        }

        // Interactions. Only q.actualUsdcIn is ever pulled from the buyer — if the
        // request was clamped, the excess is simply never taken in the first place,
        // rather than taken and refunded in a separate transfer. One fewer external
        // call, one fewer way for a "refund" step to fail or be forgotten.
        usdc.safeTransferFrom(msg.sender, address(this), q.actualUsdcIn);
        // Only treasury's share leaves the contract. The creator's stays until claimed
        // and the curve's stays as reserves; all three sum to exactly q.actualFee.
        if (f.treasuryCut > 0) usdc.safeTransfer(treasury, f.treasuryCut);
        IERC20(token).safeTransfer(msg.sender, q.tokensOut);
        emit Trade(token, msg.sender, true, q.actualUsdcIn, q.tokensOut);

        if (crossedThreshold) {
            // The trade above has ALREADY happened and succeeded, regardless of
            // whatever happens next. Curve trading closes here, permanently, whether
            // or not the DEX side manages to complete in this same transaction.
            c.state = CurveState.GRADUATION_READY;
            emit GraduationReady(token);

            // Best-effort automatic graduation. _performGraduation isolates the one
            // external call that can actually fail (the router) behind its own
            // try/catch, so a router hiccup — near the block gas limit is the common
            // real-world case — cannot unwind the buy that already succeeded above.
            // If it fails, state simply stays GRADUATION_READY: no funds are stuck,
            // no state is inconsistent, and anyone at all can retry later via
            // graduate() — this contract does not depend on its own frontend or
            // backend being up for a token to eventually reach the DEX.
            if (!_performGraduation(token)) {
                emit GraduationAttemptFailed(token);
            }
        }
    }

    /// @dev Pure curve math for a sell, mirroring _quoteBuy — same stack-depth and
    ///      future-quoteSell()-view reasoning.
    function _quoteSell(
        uint256 tokensIn,
        uint16 sellFeeBps,
        uint256 virtualUsdcReserves,
        uint256 virtualTokenReserves,
        uint256 realUsdcReservesAvailable
    ) internal pure returns (SellQuote memory q) {
        uint256 k = virtualUsdcReserves * virtualTokenReserves;
        uint256 newVirtualToken = virtualTokenReserves + tokensIn;
        // Same rounding fix as _quoteBuy, mirrored: round newVirtualUsdc UP so
        // usdcOutGross comes out slightly LOW rather than slightly high — again, dust
        // favors the curve, not the trader.
        uint256 newVirtualUsdc = _ceilDiv(k, newVirtualToken);
        require(newVirtualUsdc <= virtualUsdcReserves, "curve math error");
        uint256 usdcOutGross = virtualUsdcReserves - newVirtualUsdc;

        if (usdcOutGross <= realUsdcReservesAvailable) {
            // Common case: the curve holds enough real USDC to pay out the full
            // requested sell.
            q.actualTokensIn = tokensIn;
            q.newVirtualToken = newVirtualToken;
            q.newVirtualUsdc = newVirtualUsdc;
            q.usdcOutGross = usdcOutGross;
            q.fee = (usdcOutGross * sellFeeBps) / BPS_DENOMINATOR;
            return q;
        }

        // The curve can't pay out the full request. Clamp to exactly what it holds,
        // and recompute the true tokensIn needed DETERMINISTICALLY from that clamped,
        // known output — same reasoning as _quoteBuy: deriving from a known stored
        // value avoids duplicating the ceil-divided forward formula's own rounding
        // edge cases in a second, error-prone inversion.
        q.usdcOutGross = realUsdcReservesAvailable;
        q.newVirtualUsdc = virtualUsdcReserves - q.usdcOutGross;
        // Ceiling here too: dust favors the curve, meaning the seller must provide at
        // least enough tokens for the clamped payout, never fractionally short.
        q.newVirtualToken = _ceilDiv(k, q.newVirtualUsdc);
        q.actualTokensIn = q.newVirtualToken - virtualTokenReserves;
        q.fee = (q.usdcOutGross * sellFeeBps) / BPS_DENOMINATOR;

        // Selling for a smaller payout should never require MORE tokens than selling
        // for the originally requested, larger payout would have. Same defensive
        // backstop as _quoteBuy's equivalent check.
        require(q.actualTokensIn <= tokensIn, "clamp computed a higher input than offered");
    }

    function sell(address token, uint256 tokensIn, uint256 minUsdcOut) external nonReentrant whenNotPaused {
        Curve storage c = _curves[token];
        require(c.token == token, "unknown token");
        require(c.state == CurveState.ACTIVE, "curve not open for trading: check DEX or wait for graduation");
        require(block.number > c.creationBlock, "trading opens next block");
        require(tokensIn > 0, "zero amount");

        SellQuote memory q = _quoteSell(tokensIn, c.sellFeeBps, c.virtualUsdcReserves, c.virtualTokenReserves, c.realUsdcReserves);

        uint256 usdcOut = q.usdcOutGross - q.fee;
        require(usdcOut >= minUsdcOut, "slippage exceeded");

        // Effects before interactions.
        c.virtualTokenReserves = q.newVirtualToken;
        c.virtualUsdcReserves = q.newVirtualUsdc;
        c.realUsdcReserves -= q.usdcOutGross;
        c.tokenReserves += q.actualTokensIn;

        uint256 creatorCut = _creatorCut(q.usdcOutGross, c.creatorSellFeeBps, q.fee);
        if (creatorCut > 0) {
            creatorFeesAccrued[c.creator] += creatorCut;
            emit CreatorFeeAccrued(token, c.creator, creatorCut);
        }

        // Interactions. Only q.actualTokensIn is ever pulled from the seller — same
        // "never take the excess in the first place" approach as buy().
        IERC20(token).safeTransferFrom(msg.sender, address(this), q.actualTokensIn);
        uint256 treasuryCut = q.fee - creatorCut;
        if (treasuryCut > 0) usdc.safeTransfer(treasury, treasuryCut);
        usdc.safeTransfer(msg.sender, usdcOut);

        emit Trade(token, msg.sender, false, usdcOut, q.actualTokensIn);
    }

    function _ceilDiv(uint256 a, uint256 b) internal pure returns (uint256) {
        return (a + b - 1) / b;
    }

    /// @dev The creator's slice of a fee that has ALREADY been charged to the trader.
    ///      Carved out of feeCharged, never added to it, so the trader-facing cost of a
    ///      trade is identical whether or not a creator share exists.
    ///
    ///      Capped at feeCharged so creator + treasury always sum to exactly the fee.
    ///      That cap should be unreachable -- creatorFeeBps <= buyFeeBps/sellFeeBps is
    ///      enforced at creation and both are snapshotted -- but reaching it would
    ///      otherwise underflow and revert, and a reverting buy() is a far worse
    ///      outcome than a creator being paid a rounding unit less on one trade.
    function _creatorCut(uint256 tradeAmount, uint16 creatorFeeBps, uint256 feeCharged)
        internal
        pure
        returns (uint256 cut)
    {
        if (creatorFeeBps == 0) return 0;
        cut = (tradeAmount * creatorFeeBps) / BPS_DENOMINATOR;
        if (cut > feeCharged) cut = feeCharged;
    }

    /// @dev Divides a buy's total fee into creator / treasury / curve shares.
    ///
    ///      The base fee is what the token launched with; everything above it inside
    ///      actualFee is snipe tax. Deriving the tax as a REMAINDER rather than
    ///      recomputing it from actualUsdcIn is what guarantees the three shares sum to
    ///      exactly actualFee -- computing both independently would let a rounding unit
    ///      escape, and on the clamp path actualFee is an inverted, ceiling-rounded
    ///      figure that does not match a naive recomputation anyway.
    function _splitBuyFee(
        Curve storage c,
        uint256 actualUsdcIn,
        uint256 actualFee
    ) internal view returns (FeeSplit memory f) {
        uint256 baseFee = (actualUsdcIn * c.buyFeeBps) / BPS_DENOMINATOR;
        if (baseFee > actualFee) baseFee = actualFee;
        uint256 snipeTax = actualFee - baseFee;

        // Creator is paid out of the BASE fee only. Routing any snipe tax to the creator
        // would refund part of their own tax when they snipe their own launch.
        f.creatorCut = _creatorCut(actualUsdcIn, c.creatorBuyFeeBps, baseFee);

        if (snipeTax > 0) {
            f.snipeToTreasury = (snipeTax * c.snipeTaxTreasuryBps) / BPS_DENOMINATOR;
            f.curveCut = snipeTax - f.snipeToTreasury;
        }
        f.treasuryCut = (baseFee - f.creatorCut) + f.snipeToTreasury;
    }

    /// @notice Withdraw everything you have accrued as a token creator, across all of
    ///         your launches.
    /// @dev Pull, not push -- see the note on creatorFeesAccrued. Zeroes before
    ///      transferring, and nonReentrant on top, so a creator that is a contract
    ///      cannot re-enter and drain more than it is owed.
    function claimCreatorFees() external nonReentrant returns (uint256 amount) {
        amount = creatorFeesAccrued[msg.sender];
        require(amount > 0, "nothing to claim");
        creatorFeesAccrued[msg.sender] = 0;
        usdc.safeTransfer(msg.sender, amount);
        emit CreatorFeesClaimed(msg.sender, amount);
    }

    // ── Graduation ──────────────────────────────────────────────────────
    //
    // State only ever moves ACTIVE -> GRADUATION_READY -> GRADUATED, one-way, no
    // exceptions. Reaching GRADUATION_READY is decoupled from the DEX call actually
    // succeeding: the buy that crosses the threshold always closes curve trading in
    // the same transaction, permanently, whether or not the DEX side manages to
    // complete right then. A curve sitting in GRADUATION_READY is not stuck — anyone
    // can call graduate() to retry, and reserves are untouched until the DEX call
    // genuinely succeeds, so there is nothing to roll back if it doesn't.

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
    function _performGraduation(address token) internal returns (bool success) {
        if (router == address(0)) return false;
        Curve storage c = _curves[token];

        uint256 tokenLiquidity = LP_TOKEN_RESERVE + c.tokenReserves; // reserve + any curve dust
        uint256 usdcLiquidity = c.realUsdcReserves;

        IERC20(token).forceApprove(router, tokenLiquidity);
        usdc.forceApprove(router, usdcLiquidity);

        try IDEXRouter(router).addLiquidity(
            token,
            address(usdc),
            tokenLiquidity,
            usdcLiquidity,
            0, // zero-slippage is deliberate here: this is the FIRST liquidity ever added
            0, // for this pair, so there's no existing pool price to be sandwiched against —
            BURN_ADDRESS, // this only stays safe as long as it's genuinely a first deposit,
            block.timestamp + 15 minutes // not a top-up of an existing pool. Recheck this
        ) returns (uint256, uint256, uint256 liquidity) { // assumption if the router logic ever changes.
            if (liquidity == 0) {
                // Router "succeeded" but silently did nothing. Don't leave a stale
                // approval sitting around from the attempt.
                IERC20(token).forceApprove(router, 0);
                usdc.forceApprove(router, 0);
                return false;
            }

            // Effects only happen on CONFIRMED success — reserves were never touched
            // by the failed-attempt path above, so there is no rollback to write.
            c.state = CurveState.GRADUATED;
            c.tokenReserves = 0;
            c.realUsdcReserves = 0;
            emit Graduated(token, tokenLiquidity, usdcLiquidity, liquidity);
            return true;
        } catch {
            IERC20(token).forceApprove(router, 0);
            usdc.forceApprove(router, 0);
            return false;
        }
    }

    /// @notice Permissionless retry for a curve sitting in GRADUATION_READY — most
    ///         commonly because the automatic attempt inside buy() failed, e.g. from
    ///         running near the block gas limit alongside the triggering trade.
    ///         Anyone can call this. Ballista's own frontend, backend, or indexer
    ///         being down does not block a token from eventually reaching the DEX.
    function graduate(address token) external nonReentrant {
        Curve storage c = _curves[token];
        require(c.token == token, "unknown token");
        require(c.state == CurveState.GRADUATION_READY, "not ready to graduate");
        require(router != address(0), "router not set: no confirmed Arc DEX yet");
        require(_performGraduation(token), "graduation attempt failed -- check router and liquidity conditions");
    }

    // ── Views ───────────────────────────────────────────────────────────

    /// @notice Read-only preview of exactly what buy(token, usdcIn, ...) would do
    ///         right now — including correct clamp-to-remaining-supply behavior if
    ///         usdcIn exceeds what's left on the curve. Calls the exact same pure
    ///         function buy() itself uses, so a frontend price preview and the actual
    ///         execution can never silently diverge into two different math paths.
    function quoteBuy(address token, uint256 usdcIn) external view returns (BuyQuote memory) {
        Curve storage c = _curves[token];
        require(c.token == token, "unknown token");
        require(c.state == CurveState.ACTIVE, "curve not open for trading: check DEX or wait for graduation");
        // Includes the snipe tax, or a preview shown during the window would promise
        // far more tokens than the trade actually delivers.
        return _quoteBuy(usdcIn, c.buyFeeBps + _snipeTaxBps(c), c.virtualUsdcReserves, c.virtualTokenReserves, c.tokenReserves);
    }

    /// @notice Mirror of quoteBuy for sell() — same "exact same math as execution"
    ///         guarantee.
    function quoteSell(address token, uint256 tokensIn) external view returns (SellQuote memory) {
        Curve storage c = _curves[token];
        require(c.token == token, "unknown token");
        require(c.state == CurveState.ACTIVE, "curve not open for trading: check DEX or wait for graduation");
        return _quoteSell(tokensIn, c.sellFeeBps, c.virtualUsdcReserves, c.virtualTokenReserves, c.realUsdcReserves);
    }

    /// @notice Current spot price of `token`, in USDC (6 decimals) per whole token.
    function currentPrice(address token) external view returns (uint256) {
        Curve storage c = _curves[token];
        require(c.token == token, "unknown token");
        return (c.virtualUsdcReserves * 1e18) / c.virtualTokenReserves;
    }

    function graduationProgressBps(address token) external view returns (uint256) {
        Curve storage c = _curves[token];
        require(c.token == token, "unknown token");
        // Graduation fires on EITHER arm of the dual trigger, so progress has to be
        // whichever is closer -- reporting only threshold progress would leave a curve
        // that is about to deplete showing well under 100% right up to the moment it
        // graduates, which reads as a bug to anyone watching a progress bar.
        if (c.state != CurveState.ACTIVE) return BPS_DENOMINATOR;
        if (c.realUsdcReserves >= c.graduationThresholdUsdc || c.tokenReserves == 0) {
            return BPS_DENOMINATOR;
        }
        uint256 byThreshold =
            (c.realUsdcReserves * BPS_DENOMINATOR) / c.graduationThresholdUsdc;
        uint256 bySupply =
            ((CURVE_TOKEN_SUPPLY - c.tokenReserves) * BPS_DENOMINATOR) / CURVE_TOKEN_SUPPLY;
        return byThreshold >= bySupply ? byThreshold : bySupply;
    }

    /// @notice Whether `symbol` could be used in createToken() right now, under the
    ///         CURRENT caseSensitiveSymbols mode. Saves the frontend from reimplementing
    ///         the hashing/case-normalization/timing logic itself just to grey out a
    ///         taken symbol in the launch form.
    function isSymbolAvailable(string calldata symbol) external view returns (bool) {
        bytes32 symbolHash = caseSensitiveSymbols
            ? keccak256(bytes(symbol))
            : keccak256(bytes(_toUpperAscii(symbol)));
        uint256 unlocksAt = symbolUnlocksAt[symbolHash];
        return unlocksAt == 0 || block.timestamp >= unlocksAt;
    }

    // ── Admin (should be a multisig, not an EOA, before real funds are involved) ──

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
    function proposeRouter(address router_) external onlyOwner {
        require(router_ != address(0), "router cannot be the zero address");
        routerProposedAt[router_] = block.timestamp;
        emit RouterProposed(router_, block.timestamp + ROUTER_TIMELOCK);
    }

    /// @notice Step 2 of 3. Makes a previously proposed router live, once its timelock
    ///         has elapsed.
    /// @dev Reverts if the address was never proposed, if the delay has not passed, or
    ///      if the proposal was revoked in the meantime -- revocation zeroes the
    ///      timestamp, so a revoked address is indistinguishable from one never proposed
    ///      and must go through the full delay again.
    function activateRouter(address router_) external onlyOwner {
        require(router_ != address(0), "router cannot be the zero address");
        uint256 proposedAt = routerProposedAt[router_];
        require(proposedAt != 0, "router was never proposed, or was revoked");
        require(
            block.timestamp >= proposedAt + ROUTER_TIMELOCK,
            "router timelock has not elapsed yet"
        );
        router = router_;
        emit RouterActivated(router_);
    }

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
    function revokeRouter(address router_) external onlyOwner {
        require(router_ != address(0), "router cannot be the zero address");
        routerProposedAt[router_] = 0;
        bool wasLive = (router == router_);
        if (wasLive) router = address(0);
        emit RouterRevoked(router_, wasLive);
    }

    /// @notice Sets the fee that will apply to tokens created AFTER this call. Every token
    ///         already live keeps the fee it launched with — see the Curve struct note.
    function setDefaultFees(uint16 buyFeeBps_, uint16 sellFeeBps_) external onlyOwner {
        require(buyFeeBps_ <= MAX_FEE_BPS && sellFeeBps_ <= MAX_FEE_BPS, "fee exceeds hard ceiling");
        // Each creator share is carved out of the fee on its own side, so dropping a
        // fee below its share would invert the relationship. Lower the share first,
        // deliberately.
        require(
            defaultCreatorBuyFeeBps <= buyFeeBps_ && defaultCreatorSellFeeBps <= sellFeeBps_,
            "fee would fall below the creator share -- lower the creator share first"
        );
        defaultBuyFeeBps = buyFeeBps_;
        defaultSellFeeBps = sellFeeBps_;
    }

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
    function setDefaultCreatorFees(uint16 creatorBuyFeeBps_, uint16 creatorSellFeeBps_)
        external
        onlyOwner
    {
        require(
            creatorBuyFeeBps_ <= defaultBuyFeeBps,
            "creator buy share cannot exceed the buy fee it is carved from"
        );
        require(
            creatorSellFeeBps_ <= defaultSellFeeBps,
            "creator sell share cannot exceed the sell fee it is carved from"
        );
        defaultCreatorBuyFeeBps = creatorBuyFeeBps_;
        defaultCreatorSellFeeBps = creatorSellFeeBps_;
        emit DefaultCreatorFeesSet(creatorBuyFeeBps_, creatorSellFeeBps_);
    }

    /// @notice Sets the block-0 creator buy cap for tokens created AFTER this call.
    /// @dev Capped at BPS_DENOMINATOR only; the real limit is judgement, and the
    ///      reasoning for 2.5% is on maxCreatorLaunchBps above. Raising this is a gift
    ///      to future creators; it can never change the deal for a live token.
    function setMaxCreatorLaunchBps(uint16 maxCreatorLaunchBps_) external onlyOwner {
        require(maxCreatorLaunchBps_ <= BPS_DENOMINATOR, "cap cannot exceed 100% of curve supply");
        maxCreatorLaunchBps = maxCreatorLaunchBps_;
        emit MaxCreatorLaunchBpsSet(maxCreatorLaunchBps_);
    }

    function setCreationFee(uint256 creationFeeUsdc_) external onlyOwner {
        creationFeeUsdc = creationFeeUsdc_;
    }

    function setLaunchCooldown(uint256 launchCooldown_) external onlyOwner {
        launchCooldown = launchCooldown_;
    }

    /// @notice How long a claimed symbol stays locked before anyone can reuse it.
    ///         Does not retroactively change when already-claimed symbols unlock —
    ///         each symbol's own claimedAt timestamp plus this duration is what's
    ///         checked at the time of a NEW createToken() call, so changing this
    ///         immediately shifts the unlock time for every symbol already claimed,
    ///         not just future ones. Worth knowing before tuning this live.
    function setSymbolLockDuration(uint256 symbolLockDuration_) external onlyOwner {
        symbolLockDuration = symbolLockDuration_;
    }

    /// @notice Sets the graduation threshold that will apply to tokens created AFTER this
    ///         call. Existing tokens keep the threshold they launched under.
    function setDefaultGraduationThreshold(uint256 thresholdUsdc_) external onlyOwner {
        defaultGraduationThresholdUsdc = thresholdUsdc_;
    }

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
    function setCaseSensitiveSymbols(bool caseSensitive_) external onlyOwner {
        caseSensitiveSymbols = caseSensitive_;
        emit CaseSensitiveSymbolsSet(caseSensitive_);
    }

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
    function setTreasury(address treasury_) external onlyOwner {
        require(treasury_ != address(0), "zero address");
        treasury = treasury_;
    }

    /// @notice Emergency stop for createToken/buy/sell. Does NOT affect currently-held
    ///         balances — it only blocks new actions. Meant for "we found a bug, freeze
    ///         while we fix it," not day-to-day use. Once real funds are involved this
    ///         should require the multisig, same as every other admin function here.
    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }
}
