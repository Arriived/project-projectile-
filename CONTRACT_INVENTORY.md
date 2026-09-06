# Contract inventory — GENERATED, DO NOT HAND-EDIT

Regenerate with `npm run inventory`. It runs as part of `npm run build`.

This file exists because a five-minute symbol lock lived in `LFX1.sol` and appeared
nowhere in `CLAUDE.md` — a rewrite of a hand-maintained document dropped a real feature
and nothing caught it. Everything below is read from the compiled ABI and the source at
generation time, so it cannot drift from the contract. **`CLAUDE.md` explains WHY things
are the way they are; this file is the exhaustive WHAT.**

The coverage section at the end lists every exposed identifier that `CLAUDE.md` does not
mention. That list is what to read after any contract change.


---

## LFX1

### Constants (immutable by construction — changing one is a redeploy)

| name | value |
|---|---|
| `CURVE_TOKEN_SUPPLY` | `807_000_000e18` |
| `LP_TOKEN_RESERVE` | `193_000_000e18` |
| `TOTAL_TOKEN_SUPPLY` | `CURVE_TOKEN_SUPPLY + LP_TOKEN_RESERVE` |
| `INITIAL_VIRTUAL_TOKEN_RESERVES` | `1_075_000_000e18` |
| `INITIAL_VIRTUAL_USDC_RESERVES` | `2_667e6` |
| `BURN_ADDRESS` | `0x000000000000000000000000000000000000dEaD` |
| `ROUTER_TIMELOCK` | `24 hours` |
| `MAX_FEE_BPS` | `1000` |
| `BPS_DENOMINATOR` | `10_000` |
| `MAX_TOTAL_FEE_BPS` | `9900` |

### State variables that govern behaviour

| name | type | declared default | owner-settable via | in economics hash |
|---|---|---|---|---|
| `defaultGraduationThresholdUsdc` | `uint256` | `8_000e6` | `setDefaultGraduationThreshold` | yes |
| `defaultBuyFeeBps` | `uint16` | `100` | **no setter — redeploy** | yes |
| `defaultSellFeeBps` | `uint16` | `100` | **no setter — redeploy** | yes |
| `maxCreatorLaunchBps` | `uint16` | `250` | `setMaxCreatorLaunchBps` | yes |
| `creatorLaunchWindow` | `uint32` | `3` | `setCreatorLaunchWindow` | yes |
| `lpRecipient` | `address` | `BURN_ADDRESS` | `setLpRecipient` | yes |
| `defaultCreatorBuyFeeBps` | `uint16` | `90` | **no setter — redeploy** | yes |
| `defaultCreatorSellFeeBps` | `uint16` | `50` | **no setter — redeploy** | yes |
| `defaultSnipeTaxTreasuryBps` | `uint16` | `7000` | `setDefaultSnipeTaxTreasuryBps` | yes |
| `creationFeeUsdc` | `uint256` | `5e5` | `setCreationFee` | no |
| `launchCooldown` | `uint256` | `10` | `setLaunchCooldown` | no |
| `symbolLockDuration` | `uint256` | `5 minutes` | `setSymbolLockDuration` | yes |
| `caseSensitiveSymbols` | `bool` | `true` | `setCaseSensitiveSymbols` | yes |
| `router` | `address` | `—` | **no setter — redeploy** | no |
| `routerProposedAt` | `mapping(address => uint256)` | `—` | **no setter — redeploy** | no |
| `treasuryFeesAccrued` | `uint256` | `—` | **no setter — redeploy** | no |
| `creatorFeesAccrued` | `mapping(address => uint256)` | `—` | `setDefaultCreatorFees` | no |
| `snipeTaxTableMaxBps` | `mapping(uint32 => uint16)` | `—` | **no setter — redeploy** | no |
| `activeSnipeTaxTableVersion` | `uint32` | `—` | **no setter — redeploy** | yes |
| `treasury` | `address` | `—` | `setTreasury` | no |
| `lastLaunchTimestamp` | `mapping(address => uint256)` | `—` | **no setter — redeploy** | no |
| `symbolUnlocksAt` | `mapping(bytes32 => uint256)` | `—` | **no setter — redeploy** | no |

### Owner-gated functions

| function | what it changes |
|---|---|
| `activateRouter(address router_)` | owner only |
| `pause()` | owner only |
| `proposeRouter(address router_)` | owner only |
| `publishSnipeTaxTable(uint16[] table) -> (uint32)` | owner only |
| `revokeRouter(address router_)` | owner only |
| `setCaseSensitiveSymbols(bool caseSensitive_)` | owner only |
| `setCreationFee(uint256 creationFeeUsdc_)` | owner only |
| `setCreatorLaunchWindow(uint32 creatorLaunchWindow_)` | owner only |
| `setDefaultCreatorFees(uint16 creatorBuyFeeBps_, uint16 creatorSellFeeBps_)` | owner only |
| `setDefaultFees(uint16 buyFeeBps_, uint16 sellFeeBps_)` | owner only |
| `setDefaultGraduationThreshold(uint256 thresholdUsdc_)` | owner only |
| `setDefaultSnipeTaxTreasuryBps(uint16 treasuryBps_)` | owner only |
| `setLaunchCooldown(uint256 launchCooldown_)` | owner only |
| `setLpRecipient(address lpRecipient_)` | owner only |
| `setMaxCreatorLaunchBps(uint16 maxCreatorLaunchBps_)` | owner only |
| `setSymbolLockDuration(uint256 symbolLockDuration_)` | owner only |
| `setTreasury(address treasury_)` | owner only |
| `unpause()` | owner only |

### Permissionless state-changing functions

| function | mutability |
|---|---|
| `buy(address token, uint256 usdcIn, uint256 minTokensOut)` | nonpayable |
| `claimCreatorFees() -> (uint256)` | nonpayable |
| `claimTreasuryFees() -> (uint256)` | nonpayable |
| `createToken(string name, string symbol, string metadataURI, bytes32 expectedEconomicsHash, bool poolBoostEnabled) -> (address)` | nonpayable |
| `creatorLaunchBuy(address token, uint256 usdcIn, uint256 minTokensOut)` | nonpayable |
| `graduate(address token)` | nonpayable |
| `sell(address token, uint256 tokensIn, uint256 minUsdcOut)` | nonpayable |
| `transferOwnership(address newOwner)` | nonpayable |
| `updateMetadataURI(address token, string newURI)` | nonpayable |

### Views

| function |
|---|
| `currentEconomicsHash() -> (bytes32)` |
| `currentPrice(address token) -> (uint256)` |
| `currentSnipeTaxBps(address token) -> (uint16)` |
| `curves(address token) -> (tuple)` |
| `graduationProgressBps(address token) -> (uint256)` |
| `isSymbolAvailable(string symbol) -> (bool)` |
| `owner() -> (address)` |
| `paused() -> (bool)` |
| `quoteBuy(address token, uint256 usdcIn) -> (tuple)` |
| `quoteSell(address token, uint256 tokensIn) -> (tuple)` |
| `renounceOwnership()` |
| `snipeTaxTable(uint32 version) -> (uint16[])` |
| `usdc() -> (address)` |

### Public getters (state and constants)

`BPS_DENOMINATOR`, `BURN_ADDRESS`, `CURVE_TOKEN_SUPPLY`, `INITIAL_VIRTUAL_TOKEN_RESERVES`, `INITIAL_VIRTUAL_USDC_RESERVES`, `LP_TOKEN_RESERVE`, `MAX_FEE_BPS`, `MAX_TOTAL_FEE_BPS`, `ROUTER_TIMELOCK`, `TOTAL_TOKEN_SUPPLY`, `activeSnipeTaxTableVersion`, `caseSensitiveSymbols`, `creationFeeUsdc`, `creatorFeesAccrued`, `creatorLaunchWindow`, `defaultBuyFeeBps`, `defaultCreatorBuyFeeBps`, `defaultCreatorSellFeeBps`, `defaultGraduationThresholdUsdc`, `defaultSellFeeBps`, `defaultSnipeTaxTreasuryBps`, `lastLaunchTimestamp`, `launchCooldown`, `lpRecipient`, `maxCreatorLaunchBps`, `router`, `routerProposedAt`, `snipeTaxTableMaxBps`, `symbolLockDuration`, `symbolUnlocksAt`, `treasury`, `treasuryFeesAccrued`

### Custom errors (36)

| error | thrown where |
|---|---|
| `BaseFeeCeilingExceeded()` | L312 |
| `BpsExceedsDenominator()` | L280, L787 |
| `ClampCostExceededOffer()` | L415 |
| `ClampInputExceededOffer()` | L554 |
| `CreatorAllocationUsed()` | L483 |
| `CreatorBuyShareExceedsFee()` | L779 |
| `CreatorSellShareExceedsFee()` | L780 |
| `CurveMathError()` | L391, L533 |
| `CurveNotActive(uint8 state)` | L479, L509, L560, L701, L709 |
| `EconomicsChanged()` | L313 |
| `EnforcedPause()` | declared, never thrown |
| `ExpectedPause()` | declared, never thrown |
| `FeeBelowCreatorShare()` | L769 |
| `FeeExceedsCeiling()` | L767 |
| `GraduationFailed()` | L695 |
| `LaunchCooldownActive(uint256 readyAt)` | L314 |
| `LaunchWindowClosed(uint256 closedAt)` | L478 |
| `NotCreator()` | L421, L477 |
| `NotReadyToGraduate(uint8 state)` | L693 |
| `NothingToClaim()` | L631, L639 |
| `OwnableInvalidOwner(address owner)` | declared, never thrown |
| `OwnableUnauthorizedAccount(address account)` | declared, never thrown |
| `OwnershipCannotBeRenounced()` | L834 |
| `ReentrancyGuardReentrantCall()` | declared, never thrown |
| `RouterNotProposed()` | L751 |
| `RouterNotSet()` | L310, L694 |
| `RouterTimelockPending(uint256 activatableAt)` | L752 |
| `SafeERC20FailedOperation(address token)` | declared, never thrown |
| `SlippageExceeded(uint256 received, uint256 minRequested)` | L492, L517, L567 |
| `SnipeTaxCeilingExceeded()` | L253 |
| `SymbolLocked(uint256 unlocksAt)` | L320 |
| `TradingNotOpenYet()` | L510, L561 |
| `UnknownToken()` | L268, L420, L476, L508, L559, L692, L700, L708, L715, L721 |
| `UsdcTransferMismatch()` | L457 |
| `ZeroAddress()` | L212, L743, L749, L759, L803, L829 |
| `ZeroAmount()` | L480, L511, L562 |

### Events (30)

| event | emitted at |
|---|---|
| `CaseSensitiveSymbolsSet(bool caseSensitive)` | L825 |
| `CreationFeeSet(uint256 oldValue, uint256 newValue)` | L798 |
| `CreatorFeeAccrued(address token, address creator, uint256 amount)` | L625 |
| `CreatorFeesClaimed(address creator, uint256 amount)` | L642 |
| `CreatorLaunchBuy(address token, address creator, uint256 usdcSpent, uint256 tokensReceived, uint256 bpsOfCurveSupply)` | L495 |
| `CreatorLaunchWindowSet(uint32 creatorLaunchWindow)` | L794 |
| `DefaultCreatorFeesSet(uint16 creatorBuyFeeBps, uint16 creatorSellFeeBps)` | L783 |
| `DefaultFeesSet(uint16 oldBuyFeeBps, uint16 newBuyFeeBps, uint16 oldSellFeeBps, uint16 newSellFeeBps)` | L770 |
| `DefaultGraduationThresholdSet(uint256 oldValue, uint256 newValue)` | L819 |
| `DefaultSnipeTaxTreasuryBpsSet(uint16 treasuryBps)` | L282 |
| `Graduated(address token, uint256 tokenLiquidity, uint256 usdcLiquidity, uint256 lpTokensBurned)` | L681 |
| `GraduationAttemptFailed(address token)` | L466 |
| `GraduationReady(address token)` | L465 |
| `LaunchCooldownSet(uint256 oldValue, uint256 newValue)` | L809 |
| `LpRecipientSet(address oldRecipient, address newRecipient)` | L804 |
| `MaxCreatorLaunchBpsSet(uint16 maxCreatorLaunchBps)` | L789 |
| `MetadataURIUpdated(address token, address creator, string oldURI, string newURI)` | L425 |
| `OwnershipTransferred(address previousOwner, address newOwner)` | **declared, never emitted** |
| `Paused(address account)` | **declared, never emitted** |
| `PoolBoostAccrued(address token, uint256 amount, uint256 total)` | L622 |
| `RouterActivated(address router)` | L220, L755 |
| `RouterProposed(address router, uint256 activatableAt)` | L218, L745 |
| `RouterRevoked(address router, bool wasLive)` | L763 |
| `SnipeTaxCollected(address token, address buyer, uint256 toTreasury, uint256 toCurve)` | L447 |
| `SnipeTaxTablePublished(uint32 version, uint16[] table, uint16 maxBps)` | L259 |
| `SymbolLockDurationSet(uint256 oldValue, uint256 newValue)` | L814 |
| `TokenCreated(address token, address creator, string name, string symbol, string metadataURI)` | L365 |
| `Trade(address token, address trader, bool isBuy, uint256 usdcAmount, uint256 tokenAmount)` | L460, L582 |
| `TreasuryFeesClaimed(address treasury, uint256 amount)` | L634 |
| `Unpaused(address account)` | **declared, never emitted** |

---

## LFX1Token

### Constants (immutable by construction — changing one is a redeploy)

| name | value |
|---|---|

### State variables that govern behaviour

| name | type | declared default | owner-settable via | in economics hash |
|---|---|---|---|---|
| `metadataURI` | `string` | `—` | **no setter — redeploy** | no |
| `creator` | `address` | `—` | **no setter — redeploy** | no |
| `factory` | `address` | `—` | **no setter — redeploy** | no |

### Owner-gated functions

| function | what it changes |
|---|---|

### Permissionless state-changing functions

| function | mutability |
|---|---|
| `approve(address spender, uint256 value) -> (bool)` | nonpayable |
| `setMetadataURI(string newURI)` | nonpayable |
| `transfer(address to, uint256 value) -> (bool)` | nonpayable |
| `transferFrom(address from, address to, uint256 value) -> (bool)` | nonpayable |

### Views

| function |
|---|
| `allowance(address owner, address spender) -> (uint256)` |
| `balanceOf(address account) -> (uint256)` |
| `decimals() -> (uint8)` |
| `name() -> (string)` |
| `symbol() -> (string)` |
| `totalSupply() -> (uint256)` |

### Public getters (state and constants)

`creator`, `factory`, `metadataURI`

### Custom errors (6)

| error | thrown where |
|---|---|
| `ERC20InsufficientAllowance(address spender, uint256 allowance, uint256 needed)` | declared, never thrown |
| `ERC20InsufficientBalance(address sender, uint256 balance, uint256 needed)` | declared, never thrown |
| `ERC20InvalidApprover(address approver)` | declared, never thrown |
| `ERC20InvalidReceiver(address receiver)` | declared, never thrown |
| `ERC20InvalidSender(address sender)` | declared, never thrown |
| `ERC20InvalidSpender(address spender)` | declared, never thrown |

### Events (2)

| event | emitted at |
|---|---|
| `Approval(address owner, address spender, uint256 value)` | **declared, never emitted** |
| `Transfer(address from, address to, uint256 value)` | **declared, never emitted** |

---

## CLAUDE.md coverage

Identifiers exposed by the contracts that `CLAUDE.md` never mentions: **80**.

Not every one needs prose — a getter for a constant that is already described by
its constant does not. But anything here that changes BEHAVIOUR and is unexplained
is the shape of the symbol-lock gap, and should be read as a candidate.

- `LFX1.INITIAL_VIRTUAL_TOKEN_RESERVES`
- `LFX1.INITIAL_VIRTUAL_USDC_RESERVES`
- `LFX1.MAX_FEE_BPS`
- `LFX1.ROUTER_TIMELOCK`
- `LFX1.TOTAL_TOKEN_SUPPLY`
- `LFX1.currentSnipeTaxBps`
- `LFX1.defaultGraduationThresholdUsdc`
- `LFX1.setCaseSensitiveSymbols`
- `LFX1.setCreatorLaunchWindow`
- `LFX1.setDefaultSnipeTaxTreasuryBps`
- `LFX1.setLaunchCooldown`
- `LFX1.setMaxCreatorLaunchBps`
- `LFX1.setSymbolLockDuration`
- `LFX1.snipeTaxTable`
- `LFX1.snipeTaxTableMaxBps`
- `LFX1.symbolUnlocksAt`
- `LFX1.unpause`
- `LFX1.BaseFeeCeilingExceeded`
- `LFX1.BpsExceedsDenominator`
- `LFX1.CreatorAllocationUsed`
- `LFX1.CreatorBuyShareExceedsFee`
- `LFX1.CreatorSellShareExceedsFee`
- `LFX1.CurveNotActive`
- `LFX1.EnforcedPause`
- `LFX1.ExpectedPause`
- `LFX1.FeeBelowCreatorShare`
- `LFX1.FeeExceedsCeiling`
- `LFX1.GraduationFailed`
- `LFX1.LaunchCooldownActive`
- `LFX1.LaunchWindowClosed`
- `LFX1.NotReadyToGraduate`
- `LFX1.NothingToClaim`
- `LFX1.OwnableInvalidOwner`
- `LFX1.OwnershipCannotBeRenounced`
- `LFX1.ReentrancyGuardReentrantCall`
- `LFX1.RouterNotProposed`
- `LFX1.RouterNotSet`
- `LFX1.RouterTimelockPending`
- `LFX1.SafeERC20FailedOperation`
- `LFX1.SlippageExceeded`
- `LFX1.SnipeTaxCeilingExceeded`
- `LFX1.SymbolLocked`
- `LFX1.UsdcTransferMismatch`
- `LFX1.ZeroAddress`
- `LFX1.ZeroAmount`
- `LFX1.CaseSensitiveSymbolsSet`
- `LFX1.CreationFeeSet`
- `LFX1.CreatorFeeAccrued`
- `LFX1.CreatorFeesClaimed`
- `LFX1.CreatorLaunchBuy`
- `LFX1.CreatorLaunchWindowSet`
- `LFX1.DefaultCreatorFeesSet`
- `LFX1.DefaultFeesSet`
- `LFX1.DefaultGraduationThresholdSet`
- `LFX1.DefaultSnipeTaxTreasuryBpsSet`
- `LFX1.GraduationAttemptFailed`
- `LFX1.GraduationReady`
- `LFX1.LaunchCooldownSet`
- `LFX1.LpRecipientSet`
- `LFX1.MaxCreatorLaunchBpsSet`
- `LFX1.MetadataURIUpdated`
- `LFX1.OwnershipTransferred`
- `LFX1.Paused`
- `LFX1.PoolBoostAccrued`
- `LFX1.RouterRevoked`
- `LFX1.SnipeTaxCollected`
- `LFX1.SnipeTaxTablePublished`
- `LFX1.SymbolLockDurationSet`
- `LFX1.TokenCreated`
- `LFX1.TreasuryFeesClaimed`
- `LFX1.Unpaused`
- `LFX1Token.metadataURI`
- `LFX1Token.setMetadataURI`
- `LFX1Token.totalSupply`
- `LFX1Token.ERC20InsufficientAllowance`
- `LFX1Token.ERC20InsufficientBalance`
- `LFX1Token.ERC20InvalidApprover`
- `LFX1Token.ERC20InvalidReceiver`
- `LFX1Token.ERC20InvalidSender`
- `LFX1Token.ERC20InvalidSpender`
