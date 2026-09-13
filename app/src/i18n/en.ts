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

  // /about — the landing page's content, ported from LANDING_PAGE_LIVE.html.
  //
  // Copy is the original's, with THREE CORRECTIONS. The Uniswap VERSION is removed from
  // every one of the five places it appeared: the meta description (index.html), the hero
  // copy, the section 04 body, the fourth graduation step, and the footer chips. Mainnet
  // ships the V2 router with LP burned to 0x...dEaD; V4 is post-launch via the 24h router
  // timelock (CLAUDE.md §6). scripts/verify-claims.mts fails the build on a versioned
  // mention, so this cannot silently come back.
  about: {
    heroIndex: "ARC / 001",
    heroLocation: "ARC MAINNET",
    heroLocation2: "COMING SOON",
    heroTitle: "BALLISTA",
    heroStatement: "THE ATTENTION MARKET",
    heroStatementMuted: "FOR ARC.",
    // Was "graduate into Uniswap v4 liquidity".
    heroCopy:
      "Launch tokens on Arc. Capture attention. Trade the market. Successful launches graduate into Uniswap liquidity.",
    enter: "Enter Ballista",

    countdownLabel: "MAINNET LAUNCH",
    countdownDate: "16 / 09 / 2026",
    // The original said "23:00" with no zone, and the timer parsed it as LOCAL time -- so
    // the same page counted to a different moment for every visitor. Circle has published
    // a DATE and no time, so an hour was invented precision. Pinned to 00:00 UTC and the
    // zone is stated rather than implied.
    countdownZone: "00:00 UTC",
    countdownNote: "Circle has published a date for Arc mainnet, not a time. This counts to midnight UTC.",
    // The original rendered 00:00:00:00 forever once it reached zero.
    launched: "Arc mainnet is live.",
    launchedCta: "Open the launchpad",
    days: "days",
    hours: "hrs",
    minutes: "min",
    seconds: "sec",

    s1Eyebrow: "THE LAUNCHPAD",
    s1Title: "Launch.",
    s1Body:
      "Create a token on Arc with a simple launch mechanism designed to turn attention into an open market.",
    s1Step1: "Create",
    s1Step1Detail: "Token",
    s1Step2: "Launch",
    s1Step2Detail: "Bonding curve",
    s1Step3: "Compete",
    s1Step3Detail: "Attention",

    s2Eyebrow: "THE ATTENTION MARKET",
    s2Title: "Get noticed.",
    s2Body:
      "Every launch competes for attention. The market decides what rises, what falls, and what earns liquidity.",
    s2LiveLaunches: "Live launches",
    s2Attention: "Attention",
    s2Demo: "DEMONSTRATION DATA",

    s3Eyebrow: "THE MARKET",
    s3Title: "Trade.",
    s3Body:
      "Attention becomes price. Buy into emerging launches and sell as the market changes. One launchpad. One market.",

    s4Eyebrow: "THE END OF THE CURVE",
    s4Title: "Graduate.",
    // Was "liquidity moves into a Uniswap v4 pool".
    s4Body:
      "When a launch reaches its graduation threshold, liquidity moves into a Uniswap pool and the LP tokens are burned.",
    s4Step1: "Launch",
    s4Step2: "Attention",
    s4Step3: "Threshold",
    // Was "Uniswap v4".
    s4Step4: "Uniswap",

    futureEyebrow: "WHAT COMES NEXT",
    futureTitle: "THE LAUNCHPAD BECOMES SOCIAL.",
    futureBody:
      "Ballista starts as an attention market for Arc. As the market grows, the interface evolves into a social layer built around launching, discovering and trading tokens.",

    // Was "ARC · USDC · UNISWAP V4".
    footerChips: "ARC · USDC · UNISWAP",
  },

  list: {
    searchPlaceholder: "Search by name, symbol or address",
    create: "Create",
    graduatedHeading: "Graduated",
    graduatedEmpty: "None yet — the first curve to reach its threshold appears here.",
    exploreHeading: "Explore",
    launched: "{count} launched",
    sortRecentBuys: "Recent buys",
    sortNewest: "Newest",
    sortOldest: "Oldest",
    sortMarketCap: "Market cap",
    sortVolume: "Volume",
    windowAll: "All",
    window24h: "24h",
    window7d: "7d",
    windowUnavailable:
      "The indexer only aggregates a 1-hour volume window today. Showing that under a {window} label would claim more than the data supports.",
    volumeIs1h: "volume is a 1-hour window",
    marketCap: "Market cap",
    lessThan: "<{value}",
    progressNoneYet: "No buys yet",
    approxTooltip:
      "Approximate. This figure comes from the indexer, which rounds large numbers before the browser sees them. The token page reads the chain directly.",
    fdv: "FDV",
    marketCapGraduated: "Price now comes from the pool",
    noTokens: "No tokens have been launched yet.",
    unavailableTitle: "Token list unavailable.",
    unavailableBody: "Neither the indexer nor the Arc RPC could be reached. Try again shortly.",
    noTokensCta: "Launch the first one",
    noMatches: "Nothing matches “{query}”.",
    clearSearch: "Clear search",
    duplicateSymbol: "Duplicate symbol",
    duplicateSymbolNote:
      "Another live token uses this symbol. Nothing on chain prevents that — check the address.",
    page: "Page {n}",
    prev: "Previous",
    next: "Next",
    degradedTitle: "The indexer is unreachable — reading from {chain} directly.",
    degradedFields: "Unavailable in this mode: {fields}.",
    degradedRange: "Only launches from the last {blocks} blocks are shown, so this list is partial.",
    loading: "Loading tokens…",
  },

  common: {
    connectWallet: "Connect wallet",
    disconnect: "Disconnect",
    checkYourWallet: "Check your wallet…",
    copy: "Copy",
    copied: "Copied",
    copyFailed: "Copy failed",
    loading: "Loading…",
    retry: "Retry",
    cancel: "Cancel",
    back: "Back to all tokens",
    unavailable: "unavailable",
    explore: "Explore",
    about: "About",
  },

  toast: {
    boughtTitle: "Bought",
    soldTitle: "Sold",
    confirmedTitle: "Confirmed",
    tradeFailed: "Trade failed",
    launched: "Token launched",
    launchFailed: "Launch failed",
  },

  chart: {
    heading: "Price",
    noTradesYet: "No trades yet — this is the launch price.",
    historyUnavailable: "Earlier trades predate price recording.",
    unavailable: "Price history is unavailable right now.",
    midPriceNote: "Curve mid-price, before fees and snipe tax.",
    oneSecondNote:
      "1-second buckets · latest 10 minutes · empty seconds carry the last price because the curve does not move between trades.",
    // Stated once, here, rather than on every axis label -- see lib/chartFormat.ts.
    priceScaleNote: "Prices {scale} USDC",
    // {offset} is a UTC offset like "UTC+1", so a bare "14:32" on the axis is never
    // ambiguous about which zone it's in.
    localTimeNote: "Times shown in your local time ({offset})",
    timeframeLabel: "Timeframe",
    resetZoom: "Reset",
  },

  create: {
    heading: "Launch a token",
    name: "Name",
    symbol: "Symbol",
    metadataUri: "Image or metadata URL",
    uriPlaceholder: "https://… or ipfs://…",
    image: "Image",
    imageHint: "PNG, JPG, GIF or WebP.",
    imagePreviewAlt: "Your token image",
    imageUriLabel: "Image URI",
    uploadChoose: "Choose image",
    uploadReplace: "Replace image",
    uploadPreparing: "Preparing…",
    uploadUploading: "Uploading…",
    uploadHint: "PNG, JPG, GIF or WebP, up to {max}. Stored on IPFS.",
    uploadTooLarge: "That image is {size}. The limit is {max}.",
    uploadTooLargeServer: "That image is over the size limit.",
    uploadBadType: "{type} is not a supported image format. Use PNG, JPG, GIF or WebP.",
    uploadEmpty: "That file is empty.",
    uploadNotConfigured:
      "Image upload is not configured on this deployment. You can still paste an image URL below.",
    uploadSignFailed:
      "Could not start the upload. This is a problem with this site, not your image — paste an image URL below, or try again.",
    uploadRejected: "The storage provider rejected that image. Try a different file.",
    uploadFailed: "The upload did not complete. Check your connection and try again.",
    description: "Description",
    descriptionPlaceholder: "What is this token?",
    xHandle: "X",
    telegram: "Telegram",
    previewHeading: "Preview",
    previewNote: "How the card will look. Nothing is on chain until you launch.",
    previewName: "Untitled",
    previewSymbol: "TICKER",
    previewThreshold: "Graduates at",
    previewSnipe: "Snipe tax decays over",
    previewSnipeValue: "{seconds}s",
    launchBuy: "Buy at launch (optional)",
    launchBuyPlaceholder: "Amount in USDC",
    launchBuyHint:
      "Bought in the same transaction as the launch, untaxed, up to {pct}% of curve supply. This is a cap on this privileged buy only — it does not limit how much you can hold.",

    poolBoost: "Send my creator fees into the pool instead",
    poolBoostNote: "Deepens the pool at graduation by roughly 1-4%.",
    poolBoostTip:
      "Your creator fees go into the pool at graduation instead of to you. It deepens liquidity for holders; it is not a payout to them.",
    feeLabel: "Creation fee",
    launch: "Launch",
    approving: "Approving the fee — check your wallet…",
    launching: "Launching — check your wallet…",
    receiptReverted: "The launch transaction reverted. No token was launched.",
    receiptMissingToken: "The transaction completed without a TokenCreated event. No launch was confirmed.",
    errNameEmpty: "A name is required.",
    errSymbolEmpty: "A symbol is required.",
    warnSymbolLong:
      "{length} characters. The contract accepts this, but wallets cap the symbol at {max}, so holders will not be able to add it in one click.",
    warnBidi:
      "This contains text-direction characters, which can make one token render as another. It will still launch.",
    warnUriScheme: "That does not look like a URL a browser can load.",
    blockConnect: "Connect a wallet to launch.",
    blockChain: "Switch to {chain} to launch.",
    blockCooldown: "Wait {seconds}s — one launch per address at a time.",
    blockFunds: "You need about {needed} USDC — the fee plus gas, which is also USDC.",
    blockUnavailable: "Launch settings or your USDC balance could not be read. Try again shortly.",
  },

  wallet: {
    noWalletDetected: "No wallet extension detected.",
    connectionDeclined: "Connection declined.",
    unidentifiedWallet: "{name} (unidentified wallet)",
    notConnected: "Not connected",
    boundTo: "The wallet this page is bound to",
    connectsTo: "Connects specifically to {name}",
    genericWarning: "No wallet announced itself; this connects to window.ethereum",
    connect: "Connect",
    pickerTitle: "Connect a wallet",
    pickerClose: "Close",
    badgeInstalled: "Installed",
    // ⚠ "70+" IS A LOWER BOUND CHOSEN SO IT IS TRUE EITHER WAY, not a precise count.
    // Measured against the registry with this project's own id: 609 wallets unfiltered,
    // but 79 when filtered to the chain the dapp requests (eip155:5042002) -- and 544 for
    // eip155:1, so the filter is doing real work. It could not be established from outside
    // which of the two the embedded modal applies, so the copy states a floor that holds
    // under both readings rather than a figure that is wrong under one of them.
    //
    // ⚠ The modal differs by width. At 390px it opens on "All Wallets" with a search box
    // and a grid (Trust, MetaMask, Binance, SafePal, TokenPocket, imToken, Safe...). On
    // desktop it opens on a bare QR pairing screen -- but that QR is a generic WalletConnect
    // URI any of those wallets can scan, so the badge is honest at both sizes.
    badgeQr: "QR / 70+ wallets",
    // Deliberately not "Installed": something is at window.ethereum but we cannot say
    // which wallet it is, and claiming an identity we do not have is the failure this
    // whole connector path exists to prevent.
    badgeUnknown: "Unidentified",
    pickerHint: "Browsing needs no wallet. You only need one to trade.",
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
    // The wallet never offered the chain, so nobody declined anything. wagmi rethrows a
    // namespace miss as UserRejectedRequestError, which made the UI blame the user for a
    // prompt that was never shown. Naming both sides is what makes this self-diagnosing.
    switchNotInSession:
      "Your wallet’s WalletConnect session does not include {chain} (chain {target}, {targetHex}). It approved {offered}. Reconnect and approve {chain}, or add it in your wallet first — nothing was declined.",
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
    linkContract: "Contract ↗",
    linkPool: "Pool ↗",
    linkDexscreener: "Dexscreener ↗",
    linkGeckoterminal: "GeckoTerminal ↗",
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
    addFailed: "The wallet refused the request. Add it manually using this address:",
    addFailedDetails: "Tap for details",
    added: "Added.",
    addUnconfirmed:
      "Your wallet did not confirm the token was added. If no prompt appeared, add it manually using the contract address above.",
    addUnsupported: "Your wallet doesn’t support one-click adding — use the address above.",
    readFromChain:
      "Balances are read from {chain} directly, so they are correct even while your wallet is on another network.",
  },

  price: {
    marketCap: "Market cap",
    inTheCurve: "In the curve",
    threshold: "Threshold",
    progressLabel: "Progress",
    graduationExplainer:
      "At the threshold the curve closes and its liquidity moves to a Uniswap pool. The LP tokens are burned, so the liquidity cannot be withdrawn.",
    graduated: "Graduated.",
    graduatedBody: "Trading has moved to the DEX pool.",
    marketCapGraduated: "Price now comes from the pool",
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
    fee: "Fee",
    // While the snipe window is open the tax is most of what a buyer pays -- folding it
    // silently into "Fee" would understate it. Buy side only; see TradePanel.tsx.
    feeWithSnipeTax: "Fee + snipe tax",
    // A2. The probe method yields one ratio and the formula picks a side; 15.65% and
    // 18.55% are reciprocals of the same $500 trade. We report PRICE MOVE, so the label
    // has to say that -- "Price impact" alone is not self-describing and either figure
    // would be defensible under it.
    priceImpact: "Price impact",
    priceImpactNote: "your average price vs. the best available rate",
    minimumReceived: "Minimum received",
    atSlippage: "at {pct} slippage",
    slippageLabel: "Max slippage",
    slippageCustom: "Custom",
    slippageCustomAria: "Custom slippage tolerance, percent",
    slippageOpen: "Max slippage {pct} — change",

    slippageAck: "I understand a {pct}% floor can fill far below the quote.",
    slippageBound: "Up to {max}%. Above that the trade has no meaningful floor.",
    slippageHigh:
      "{pct}% is a wide floor. On a bonding curve during the snipe window this can fill far below the quote.",
    slippageRefused: "Too high — {max}% is the maximum. Above that you are accepting any price.",
    slippageNegative: "Slippage cannot be negative.",
    slippageNaN: "Enter a number.",
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
    receiptReverted: "The trade transaction reverted. No trade was confirmed.",
    receiptMissingTrade: "The transaction completed without a matching Trade event. No trade was confirmed.",
    // A4: these report the amounts THIS TRANSACTION moved, decoded from its own Trade
    // event. Not a balance read afterwards, which a concurrent trade or the gas deduction
    // could have raced.
    settledBuyExact: "Settled. You paid {usdc} USDC and received {tokens} {symbol}.",
    settledSellExact: "Settled. You sold {tokens} {symbol} and received {usdc} USDC.",
    settledUnknown:
      "Settled, but this page could not read the amounts from the transaction. Check the explorer for the exact figures.",

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
    // ⚠ STATES THE FACT, NOT A MOTIVE. This read "the creator did not use their launch
    // allocation", which implies a decision. Measured 4 September 2026: no wallet exposes
    // EIP-5792 atomic batching on Arc, and the ordinary flow needs three sequential
    // signatures inside a ~3 second window -- so on this chain today the allocation is
    // unreachable, and every token reads the same regardless of what its creator wanted.
    //
    // The contract stores an AMOUNT and nothing else. It cannot tell "chose not to" from
    // "could not", so neither can this copy, and the note below says so rather than
    // guessing. Not phrased as a virtue either -- a short window is a design choice, not
    // an achievement to advertise.
    creatorBoughtNone: "None taken.",
    creatorBoughtNoneNote:
      "The launch allocation can only be claimed in the first seconds after creation. The contract records the amount, not whether the creator chose not to use it or was unable to.",
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
    // A5: a missing indexer CONFIG is a different failure from an unreachable indexer, and
    // the first version rendered an empty section for it -- silently. Trap 19's rule is to
    // name what is unavailable, not to show nothing.
    indexerNotConfigured:
      "Trade history is not configured for this deployment. Everything above is read from {chain} directly and is unaffected.",
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
