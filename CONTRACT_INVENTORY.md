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

### State-changing functions without `onlyOwner` in this file

Not the same as permissionless. **inherited** means the function is declared in a parent
contract, so its gate lives there and is not read here.

| function | mutability | modifiers here | compares `msg.sender` here |
|---|---|---|---|
| `buy(address token, uint256 usdcIn, uint256 minTokensOut)` | nonpayable | `nonReentrant`, `whenNotPaused` | no |
| `claimCreatorFees() -> (uint256)` | nonpayable | `nonReentrant` | no |
| `claimTreasuryFees() -> (uint256)` | nonpayable | `nonReentrant` | no |
| `createToken(string name, string symbol, string metadataURI, bytes32 expectedEconomicsHash, bool poolBoostEnabled) -> (address)` | nonpayable | `nonReentrant`, `whenNotPaused` | no |
| `creatorLaunchBuy(address token, uint256 usdcIn, uint256 minTokensOut)` | nonpayable | `nonReentrant`, `whenNotPaused` | **yes** |
| `graduate(address token)` | nonpayable | `nonReentrant` | no |
| `sell(address token, uint256 tokensIn, uint256 minUsdcOut)` | nonpayable | `nonReentrant`, `whenNotPaused` | no |
| `transferOwnership(address newOwner)` | nonpayable | **inherited** | **inherited** |
| `updateMetadataURI(address token, string newURI)` | nonpayable | — | **yes** |

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
| `EnforcedPause()` | inherited — not in this file |
| `ExpectedPause()` | inherited — not in this file |
| `FeeBelowCreatorShare()` | L769 |
| `FeeExceedsCeiling()` | L767 |
| `GraduationFailed()` | L695 |
| `LaunchCooldownActive(uint256 readyAt)` | L314 |
| `LaunchWindowClosed(uint256 closedAt)` | L478 |
| `NotCreator()` | L421, L477 |
| `NotReadyToGraduate(uint8 state)` | L693 |
| `NothingToClaim()` | L631, L639 |
| `OwnableInvalidOwner(address owner)` | inherited — not in this file |
| `OwnableUnauthorizedAccount(address account)` | inherited — not in this file |
| `OwnershipCannotBeRenounced()` | L834 |
| `ReentrancyGuardReentrantCall()` | inherited — not in this file |
| `RouterNotProposed()` | L751 |
| `RouterNotSet()` | L310, L694 |
| `RouterTimelockPending(uint256 activatableAt)` | L752 |
| `SafeERC20FailedOperation(address token)` | inherited — not in this file |
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
| `OwnershipTransferred(address previousOwner, address newOwner)` | inherited — not in this file |
| `Paused(address account)` | inherited — not in this file |
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
| `Unpaused(address account)` | inherited — not in this file |

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

### State-changing functions without `onlyOwner` in this file

Not the same as permissionless. **inherited** means the function is declared in a parent
contract, so its gate lives there and is not read here.

| function | mutability | modifiers here | compares `msg.sender` here |
|---|---|---|---|
| `approve(address spender, uint256 value) -> (bool)` | nonpayable | **inherited** | **inherited** |
| `setMetadataURI(string newURI)` | nonpayable | — | **yes** |
| `transfer(address to, uint256 value) -> (bool)` | nonpayable | **inherited** | **inherited** |
| `transferFrom(address from, address to, uint256 value) -> (bool)` | nonpayable | **inherited** | **inherited** |

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
| `ERC20InsufficientAllowance(address spender, uint256 allowance, uint256 needed)` | inherited — not in this file |
| `ERC20InsufficientBalance(address sender, uint256 balance, uint256 needed)` | inherited — not in this file |
| `ERC20InvalidApprover(address approver)` | inherited — not in this file |
| `ERC20InvalidReceiver(address receiver)` | inherited — not in this file |
| `ERC20InvalidSender(address sender)` | inherited — not in this file |
| `ERC20InvalidSpender(address spender)` | inherited — not in this file |

### Events (2)

| event | emitted at |
|---|---|
| `Approval(address owner, address spender, uint256 value)` | inherited — not in this file |
| `Transfer(address from, address to, uint256 value)` | inherited — not in this file |

---

## BallistaV4Adapter

### Constants (immutable by construction — changing one is a redeploy)

| name | value |
|---|---|
| `POOL_FEE` | `0` |
| `TICK_SPACING` | `60` |
| `BURN_ADDRESS` | `0x000000000000000000000000000000000000dEaD` |

### State variables that govern behaviour

| name | type | declared default | owner-settable via | in economics hash |
|---|---|---|---|---|
| `lfx1` | `address` | `—` | **no setter — redeploy** | no |

### Owner-gated functions

| function | what it changes |
|---|---|

### State-changing functions without `onlyOwner` in this file

Not the same as permissionless. **inherited** means the function is declared in a parent
contract, so its gate lives there and is not read here.

| function | mutability | modifiers here | compares `msg.sender` here |
|---|---|---|---|
| `addLiquidity(address tokenA, address tokenB, uint256 amountADesired, uint256 amountBDesired, uint256, uint256, address to, uint256 deadline) -> (uint256, uint256, uint256)` | nonpayable | `nonReentrant` | **yes** |

### Views

| function |
|---|
| `hook() -> (address)` |
| `permit2() -> (address)` |
| `poolManager() -> (address)` |
| `positionManager() -> (address)` |

### Public getters (state and constants)

`BURN_ADDRESS`, `POOL_FEE`, `TICK_SPACING`, `lfx1`

### Custom errors (16)

| error | thrown where |
|---|---|
| `AmountRatioOutOfRange()` | L548 |
| `DeadlineExpired()` | L224 |
| `HookFlagsWrong(uint160 flags, uint160 required)` | L157 |
| `HookNotBoundToThis(address hookThinksAdapterIs)` | L175 |
| `IdenticalCurrencies()` | L225 |
| `NoLiquidityMinted()` | L301, L445 |
| `NotLfx1(address caller)` | L223 |
| `NothingConsumed()` | L293 |
| `PoolPriceMismatch(uint160 expectedSqrtPriceX96, uint160 actualSqrtPriceX96)` | L415 |
| `PositionNotMinted(uint256 tokenId, address expectedOwner, address actualOwner)` | L304 |
| `ReentrancyGuardReentrantCall()` | inherited — not in this file |
| `SafeERC20FailedOperation(address token)` | inherited — not in this file |
| `SqrtPriceOutOfRange(uint256 sqrtPriceX96)` | L552 |
| `ZeroAddress()` | L128 |
| `ZeroAmount()` | L226 |
| `ZeroHook()` | L145 |

### Events (1)

| event | emitted at |
|---|---|
| `PoolSeeded(address currency0, address currency1, uint256 tokenId, uint160 sqrtPriceX96, uint128 liquidity, uint256 consumed0, uint256 consumed1, address recipient)` | L307 |

---

## BallistaFeeHook

### Constants (immutable by construction — changing one is a redeploy)

| name | value |
|---|---|
| `FEE_BPS` | `100` |
| `BPS_DENOMINATOR` | `10_000` |
| `REQUIRED_FEE` | `0` |
| `REQUIRED_TICK_SPACING` | `60` |

### State variables that govern behaviour

| name | type | declared default | owner-settable via | in economics hash |
|---|---|---|---|---|
| `usdc` | `address` | `—` | **no setter — redeploy** | no |
| `protocolRecipient` | `address` | `—` | **no setter — redeploy** | no |
| `adapter` | `address` | `—` | **no setter — redeploy** | no |
| `launches` | `mapping(PoolId => Launch)` | `—` | **no setter — redeploy** | no |
| `pendingUsdc` | `mapping(PoolId => uint256)` | `—` | **no setter — redeploy** | no |
| `pendingToken` | `mapping(PoolId => uint256)` | `—` | **no setter — redeploy** | no |
| `owedUsdc` | `mapping(address => uint256)` | `—` | **no setter — redeploy** | no |
| `owedToken` | `mapping(address => mapping(address => uint256))` | `—` | **no setter — redeploy** | no |

### Owner-gated functions

| function | what it changes |
|---|---|

### State-changing functions without `onlyOwner` in this file

Not the same as permissionless. **inherited** means the function is declared in a parent
contract, so its gate lives there and is not read here.

| function | mutability | modifiers here | compares `msg.sender` here |
|---|---|---|---|
| `afterAddLiquidity(address sender, tuple key, tuple params, int256 delta, int256 feesAccrued, bytes hookData) -> (bytes4, int256)` | nonpayable | **inherited** | **inherited** |
| `afterDonate(address sender, tuple key, uint256 amount0, uint256 amount1, bytes hookData) -> (bytes4)` | nonpayable | **inherited** | **inherited** |
| `afterInitialize(address sender, tuple key, uint160 sqrtPriceX96, int24 tick) -> (bytes4)` | nonpayable | **inherited** | **inherited** |
| `afterRemoveLiquidity(address sender, tuple key, tuple params, int256 delta, int256 feesAccrued, bytes hookData) -> (bytes4, int256)` | nonpayable | **inherited** | **inherited** |
| `afterSwap(address sender, tuple key, tuple params, int256 delta, bytes hookData) -> (bytes4, int128)` | nonpayable | **inherited** | **inherited** |
| `beforeAddLiquidity(address sender, tuple key, tuple params, bytes hookData) -> (bytes4)` | nonpayable | **inherited** | **inherited** |
| `beforeDonate(address sender, tuple key, uint256 amount0, uint256 amount1, bytes hookData) -> (bytes4)` | nonpayable | **inherited** | **inherited** |
| `beforeInitialize(address sender, tuple key, uint160 sqrtPriceX96) -> (bytes4)` | nonpayable | **inherited** | **inherited** |
| `beforeRemoveLiquidity(address sender, tuple key, tuple params, bytes hookData) -> (bytes4)` | nonpayable | **inherited** | **inherited** |
| `beforeSwap(address sender, tuple key, tuple params, bytes hookData) -> (bytes4, int256, uint24)` | nonpayable | **inherited** | **inherited** |
| `claim()` | nonpayable | — | no |
| `claimToken(address token)` | nonpayable | — | no |
| `sweep(bytes32 poolId)` | nonpayable | — | no |
| `transferFeeRecipient(bytes32 poolId, address newRecipient)` | nonpayable | — | **yes** |

### Views

| function |
|---|
| `getHookPermissions() -> (tuple)` |
| `lfx1() -> (address)` |
| `owedToken(address, address) -> (uint256)` |
| `poolManager() -> (address)` |

### Public getters (state and constants)

`BPS_DENOMINATOR`, `FEE_BPS`, `REQUIRED_FEE`, `REQUIRED_TICK_SPACING`, `adapter`, `launches`, `owedUsdc`, `pendingToken`, `pendingUsdc`, `protocolRecipient`, `usdc`

### Custom errors (14)

| error | thrown where |
|---|---|
| `HookNotImplemented()` | inherited — not in this file |
| `NoUsdcSide(address currency0, address currency1)` | L230 |
| `NotAdapter(address sender)` | L215 |
| `NotFeeRecipient(address sender)` | L408 |
| `NotPoolManager()` | inherited — not in this file |
| `NothingOwed()` | L384, L392 |
| `SafeERC20FailedOperation(address token)` | inherited — not in this file |
| `UnknownCurve(address token)` | L237 |
| `UnknownPool(bytes32 poolId)` | L351, L407 |
| `WrongFee(uint24 fee)` | L220 |
| `WrongHook(address hooks)` | L222 |
| `WrongTickSpacing(int24 tickSpacing)` | L221 |
| `ZeroAddress()` | L163, L409 |
| `ZeroCreator(address token)` | L242 |

### Events (5)

| event | emitted at |
|---|---|
| `Claimed(address recipient, address currency, uint256 amount)` | L387, L395 |
| `FeeAccrued(bytes32 poolId, address currency, uint256 feeAmount, int128 amount0, int128 amount1)` | L327 |
| `FeeRecipientTransferred(bytes32 poolId, address previous, address next)` | L413 |
| `FeesSwept(bytes32 poolId, address token, address feeRecipient, uint256 usdcToProtocol, uint256 usdcToCreator, uint256 tokenToProtocol, uint256 tokenToCreator)` | L377 |
| `PoolRegistered(bytes32 poolId, address token, address creator, bool usdcIsCurrency0, uint24 fee, int24 tickSpacing)` | L251 |

---

## BallistaPoolCorrector

### Constants (immutable by construction — changing one is a redeploy)

| name | value |
|---|---|

### State variables that govern behaviour

| name | type | declared default | owner-settable via | in economics hash |
|---|---|---|---|---|

### Owner-gated functions

| function | what it changes |
|---|---|

### State-changing functions without `onlyOwner` in this file

Not the same as permissionless. **inherited** means the function is declared in a parent
contract, so its gate lives there and is not read here.

| function | mutability | modifiers here | compares `msg.sender` here |
|---|---|---|---|
| `correct(tuple key, uint160 targetSqrtPriceX96) -> (bool)` | nonpayable | — | no |
| `unlockCallback(bytes data) -> (bytes)` | nonpayable | — | **yes** |

### Views

| function |
|---|
| `poolManager() -> (address)` |

### Public getters (state and constants)



### Custom errors (2)

| error | thrown where |
|---|---|
| `NotPoolManager(address caller)` | L128 |
| `PoolNotInitialized()` | L108 |

### Events (1)

| event | emitted at |
|---|---|
| `PoolCorrected(bytes32 poolId, uint160 fromSqrtPriceX96, uint160 toSqrtPriceX96, address caller)` | L119 |

---

## CLAUDE.md coverage

Identifiers exposed by the contracts that `CLAUDE.md` never mentions: **101**.

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
- `LFX1.EnforcedPause`
- `LFX1.ExpectedPause`
- `LFX1.FeeBelowCreatorShare`
- `LFX1.FeeExceedsCeiling`
- `LFX1.LaunchCooldownActive`
- `LFX1.LaunchWindowClosed`
- `LFX1.NothingToClaim`
- `LFX1.OwnableInvalidOwner`
- `LFX1.OwnershipCannotBeRenounced`
- `LFX1.RouterNotProposed`
- `LFX1.RouterTimelockPending`
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
- `LFX1Token.ERC20InsufficientAllowance`
- `LFX1Token.ERC20InsufficientBalance`
- `LFX1Token.ERC20InvalidApprover`
- `LFX1Token.ERC20InvalidReceiver`
- `LFX1Token.ERC20InvalidSender`
- `LFX1Token.ERC20InvalidSpender`
- `BallistaV4Adapter.POOL_FEE`
- `BallistaV4Adapter.DeadlineExpired`
- `BallistaV4Adapter.IdenticalCurrencies`
- `BallistaV4Adapter.NoLiquidityMinted`
- `BallistaV4Adapter.NothingConsumed`
- `BallistaV4Adapter.PositionNotMinted`
- `BallistaV4Adapter.SqrtPriceOutOfRange`
- `BallistaV4Adapter.ZeroAddress`
- `BallistaV4Adapter.ZeroAmount`
- `BallistaV4Adapter.PoolSeeded`
- `BallistaFeeHook.REQUIRED_FEE`
- `BallistaFeeHook.REQUIRED_TICK_SPACING`
- `BallistaFeeHook.afterAddLiquidity`
- `BallistaFeeHook.afterDonate`
- `BallistaFeeHook.afterInitialize`
- `BallistaFeeHook.afterRemoveLiquidity`
- `BallistaFeeHook.beforeAddLiquidity`
- `BallistaFeeHook.beforeDonate`
- `BallistaFeeHook.beforeRemoveLiquidity`
- `BallistaFeeHook.pendingToken`
- `BallistaFeeHook.pendingUsdc`
- `BallistaFeeHook.NotFeeRecipient`
- `BallistaFeeHook.NotPoolManager`
- `BallistaFeeHook.NothingOwed`
- `BallistaFeeHook.UnknownPool`
- `BallistaFeeHook.ZeroAddress`
- `BallistaPoolCorrector.NotPoolManager`
- `BallistaPoolCorrector.PoolNotInitialized`
- `BallistaPoolCorrector.PoolCorrected`
