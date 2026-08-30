// English — the SOURCE OF TRUTH for keys.
//
// Every other locale is typed against `typeof en`, so a missing or misspelled key is a
// compile error rather than a runtime fallback nobody notices. Adding a key here and
// nowhere else is caught by tsc; adding one and forgetting a SHIPPED locale is caught by
// the build check.
//
// Conventions:
//   - Keys are dotted paths grouped by surface. Never build a key by concatenation --
//     `t("errors." + name)` defeats the type system and the parity check both.
//   - `{placeholders}` are interpolated. Numbers are NOT interpolated pre-formatted;
//     pass the raw value and let the formatting layer handle it, so a locale that groups
//     differently (万/亿) gets its own rendering rather than English digits.
//   - Copy is written for the person who hit it: what happened, and what to do next.

export const en = {
  // Transitional copy for surfaces that do not exist yet. Keyed rather than hardcoded so
  // the no-hardcoded-strings check stays honest -- exempting "temporary" text is how a
  // check starts accumulating exceptions and stops meaning anything.
  dev: {
    phase2Title: "Phase 2.",
    phase2Body:
      "The token page is built and live at /t/:address. The list page is Phase 3 and is not built yet — open a token by address to see the page.",
  },

  common: {
    connectWallet: "Connect wallet",
    disconnect: "Disconnect",
    checkYourWallet: "Check your wallet…",
    copy: "Copy",
    copied: "Copied",
    loading: "Loading…",
    retry: "Retry",
    cancel: "Cancel",
    back: "Back to all tokens",
    unavailable: "unavailable",
    explore: "Explore",
  },

  wallet: {
    noWalletDetected: "No wallet extension detected.",
    connectionDeclined: "Connection declined.",
    unidentifiedWallet: "{name} (unidentified wallet)",
    notConnected: "Not connected",
    boundTo: "The wallet this page is bound to",
    connectsTo: "Connects specifically to {name}",
    genericWarning: "No wallet announced itself; this connects to window.ethereum",
  },

  chain: {
    wrongNetwork: "Wrong network (chain {chainId})",
    unconfirmed: "Network unconfirmed",
    pillWrong: "Chain {chainId}",
    pillUnconfirmed: "Unconfirmed",
    switchTo: "Switch to {chain}",
    switching: "Switching to {chain} — confirm in {wallet}…",
    switchDeclined: "Network switch declined — still on the wrong network.",
    switchStuck: "That didn’t complete — still on the wrong network. Try again.",
    bannerWrong: "Your wallet is on chain {chainId}, not {chain}.",
    bannerUnknown: "Your wallet’s network could not be confirmed.",
    bannerBody:
      "Nothing can be signed until it is switched. Everything on the page is read from {chain} directly and is unaffected.",
    // Wallets scope networks PER SITE; the main selector can disagree with the per-site
    // one, and the per-site one is what governs signing. This cost a full debugging round.
    bannerPerSite:
      "Seeing a different network in your wallet? Check the network it lists for this site, not the main selector — wallets can scope networks per site, and the per-site one is what counts here.",
  },

  token: {
    notFoundTitle: "No curve found for this address.",
    notFoundBody: "It was not launched by this factory, or the network is unreachable.",
    invalidAddress: "Not a valid token address.",
    loadingToken: "Loading token…",
    unnamed: "(unnamed)",
    noSymbol: "(no symbol)",
    verifiedContract: "Verified contract ↗",
    symbolTooLong:
      "This symbol is {length} characters. Wallets cap one-click adding at {max}, so holders may have to add it by hand using the address above.",
  },

  position: {
    title: "Your position",
    connectPrompt: "Connect a wallet to see your balance of this token. Browsing needs no wallet.",
    inWallet: "{amount} USDC in wallet",
    availableToTrade: "{amount} available to trade",
    gasReserveWithheld: "gas reserve withheld",
    addToWallet: "Add to wallet",
    addToWalletHelp: "Adds this token to your wallet so the balance is visible there",
    addToWalletTooLong: "This symbol is too long for wallets to add in one click",
    addDeclined: "Not added — your balance is unaffected.",
    added: "Added.",
    addUnsupported: "Your wallet doesn’t support one-click adding — use the address above.",
    readFromChain:
      "Balances are read from {chain} directly, so they are correct even while your wallet is on another network.",
  },

  price: {
    marketCap: "Market cap",
    inTheCurve: "In the curve",
    threshold: "Threshold",
    graduated: "Graduated.",
    graduatedBody: "Trading has moved to the DEX pool.",
    viewOnExplorer: "View the token on the explorer ↗",
    poolBoost:
      "Pool boost: {amount} USDC will be added to the pool at graduation. It does not count toward the threshold above, and no holder receives it — it makes the pool deeper.",
  },

  trade: {
    buy: "Buy",
    sell: "Sell",
    amountUsdc: "Amount in USDC",
    amountToken: "Amount in {symbol}",
    max: "Max",
    estimatedReceive: "Estimated receive",
    priceImpact: "Price impact",
    minimumReceived: "Minimum received",
    atSlippage: "at {pct} slippage",
    gasReserve: "Gas reserve",
    gasReserveHeld: "{amount} USDC held back",
    gasReserveWhy: "so you can always sell",
    availableToTrade: "Available to trade",
    partiallyFilled: "partially filled; the curve cannot take the full amount",
    approveAnd: "Approve and {side}",
    working: "Working…",
    closedTitle: "Trading closed",
    switchToTrade: "Switch your wallet to {chain} to trade.",

    snipeActive: "Snipe tax {pct} right now, decaying every second since launch.",
    snipeNone: "No snipe tax — the launch window has passed.",
    snipeExplain:
      "It decays every second since launch. Your quote is re-taken immediately before you sign, so what you confirm is what settles.",

    approvingUsdc: "Approving USDC — confirm in your wallet…",
    approvingToken: "Approving {symbol} — confirm in your wallet…",
    requoting: "Re-quoting…",
    confirmInWallet: "Confirm in your wallet…",
    submitted: "Submitted. Waiting for confirmation…",
    cancelled: "Cancelled — nothing was sent.",
    cannotFill: "The curve cannot fill this trade right now. Try a smaller amount.",
    wouldFail: "This trade would fail on chain right now. The curve may have moved.",
    settledBuy: "Settled. Your balance is now {amount} {symbol}.",
    settledSell: "Settled. Your USDC balance is now {amount}.",
    settledUnknown: "Settled. Refresh to see your updated balance.",

    affordDust: "Your balance is too small to cover gas for a single transaction.",
    affordBalance: "That is more USDC than you hold.",
    affordGas:
      "That would leave you unable to cover gas. On Arc, gas comes out of this same USDC balance — including the gas you will need to sell.",
  },

  curveState: {
    graduationReady:
      "This curve has hit its graduation threshold and is awaiting graduation. Buying and selling are both closed until it completes — reserves are intact and the move to the pool is permissionless, so anyone can trigger it.",
    graduated: "This token has graduated. Trading has moved to the DEX pool.",
    unrecognised: "Unrecognised curve state ({state}). Trading is disabled as a precaution.",
  },

  trust: {
    title: "What the contract guarantees",
    buyFee: "Buy fee",
    sellFee: "Sell fee",
    ofItToCreator: "({pct} of it to the creator)",
    creatorBought: "Creator bought at launch",
    creatorBoughtNone: "Nothing — the creator did not use their launch allocation.",
    creatorBoughtPct: "{pct} of curve supply",
    // The cap limits only the PRIVILEGED path; nothing stops a second address. Disclosure
    // is the protection, not the cap.
    creatorBoughtNote:
      "This covers only the creator’s privileged untaxed buy. It is not a cap on what they hold — nothing stops anyone buying more from another address.",
    lpAtGraduation: "LP at graduation",
    lpBurned: "Auto-burned",
    lpBurnedNote: "sent to {address}, unrecoverable",
    lpSentTo: "Sent to {address}",
    lpSentNote:
      "Not burned. This LP is held by an address, not destroyed — a different claim, and a different trust assumption.",
    creator: "Creator",
    mint: "Mint",
    mintNone: "None. Supply is fixed at creation; the token has no mint function.",
  },

  trades: {
    title: "Recent trades",
    none: "No trades yet.",
    loading: "Loading trades…",
    indexerDown:
      "Trade history is unavailable — the indexer is unreachable. Everything above is read from {chain} directly and is unaffected.",
  },

  // Custom-error copy. One key per error NAME in the ABI. The build check refuses to
  // generate if any ABI error is missing from any SHIPPED locale, so a new error cannot
  // ship with copy in English and nothing in the others.
  errors: {
    unrecognised:
      "The contract rejected this for a reason this page does not recognise ({selector}). Nothing was charged.",
    noReason: "Something went wrong and no reason was returned.",

    BaseFeeCeilingExceeded:
      "The launchpad’s fee settings are inconsistent and launching is blocked until an operator fixes them.",
    BpsExceedsDenominator: "A fee setting is out of range. This is a configuration problem, not something you did.",
    ClampCostExceededOffer:
      "The partial-fill calculation exceeded what you offered and the trade was refused. Please report this.",
    ClampInputExceededOffer:
      "The partial-fill calculation exceeded what you offered and the trade was refused. Please report this.",
    CreatorAllocationUsed: "The creator’s launch allocation for this token is already used up.",
    CreatorBuyShareExceedsFee: "A creator fee setting is inconsistent. This is a configuration problem.",
    CreatorSellShareExceedsFee: "A creator fee setting is inconsistent. This is a configuration problem.",
    CurveMathError: "The curve maths produced an impossible result and the trade was refused. Please report this.",
    CurveNotActive:
      "This token is no longer trading on its bonding curve — it has finished and is moving to the DEX. Buying and selling here are both closed.",
    EconomicsChanged:
      "The launch terms changed while you were filling this in. Nothing was charged. Reload and check the fee and settings before launching again.",
    EnforcedPause: "The launchpad is paused right now. Trading and launching are temporarily closed.",
    ExpectedPause: "That action is only available while the launchpad is paused.",
    FeeBelowCreatorShare:
      "A fee setting would pay the creator more than the fee itself collects. This is a configuration problem, not something you did.",
    FeeExceedsCeiling: "A fee setting is above the contract’s hard ceiling and was refused.",
    GraduationFailed: "Graduation could not complete. The curve keeps its funds and stays retryable — nothing is lost.",
    LaunchCooldownActive:
      "You launched a token very recently. There is a short cooldown per wallet — wait a few seconds.",
    LaunchWindowClosed: "The creator’s early-buy window for this token has closed.",
    NotCreator: "Only the token’s creator can do this.",
    NotReadyToGraduate: "This token has not finished its bonding curve yet, so it cannot graduate.",
    NothingToClaim: "There is nothing to claim right now.",
    OwnableInvalidOwner: "That owner address is not valid.",
    OwnableUnauthorizedAccount: "That action is restricted to the launchpad owner.",
    // R17. Overridden to revert so ownership can never be renounced -- renouncing would
    // permanently freeze every setter INCLUDING revokeRouter(), the only hard stop
    // against a malicious router.
    OwnershipCannotBeRenounced:
      "Ownership of this launchpad cannot be renounced. That is deliberate: renouncing would permanently disable the emergency controls, including the ability to revoke a malicious DEX router.",
    ReentrancyGuardReentrantCall: "The contract blocked a re-entrant call. Nothing was charged.",
    RouterNotProposed: "That router was never proposed, so it cannot be activated.",
    RouterNotSet: "The launchpad has no DEX router configured, so this cannot complete yet.",
    RouterTimelockPending: "That router is still inside its 24-hour timelock.",
    SafeERC20FailedOperation: "A token transfer failed, so the transaction was cancelled. Nothing was charged.",
    SnipeTaxCeilingExceeded:
      "The snipe tax schedule would exceed the contract's maximum total fee and was refused. This is a configuration problem.",
    SlippageExceeded:
      "The price moved more than your slippage allowance before this went through, so it was cancelled rather than filled at a worse rate. Try again.",
    SymbolLocked: "That symbol was used very recently and is briefly reserved. Try again shortly or pick another.",
    TradingNotOpenYet: "Trading opens one block after a token is created. Wait a moment and try again.",
    UnknownToken: "That token was not created by this launchpad, so it cannot be traded here.",
    UsdcTransferMismatch:
      "The USDC transfer did not deliver the expected amount, so the trade was cancelled to protect the pool.",
    ZeroAddress: "That address is not valid.",
    ZeroAmount: "Enter an amount greater than zero.",
  },
} as const;

/**
 * The shape every other locale is typed against.
 *
 * `en` is `as const` so the KEY structure is exact and `Paths<>` can derive dotted keys
 * from it. But that also makes every VALUE a string literal type, which would make
 * "지갑 연결" not assignable to "Connect wallet" -- i.e. no translation could ever
 * typecheck. Widen<> keeps the keys exact and relaxes the leaves to `string`.
 */
type Widen<T> = { [K in keyof T]: T[K] extends string ? string : Widen<T[K]> };

export type Messages = Widen<typeof en>;
