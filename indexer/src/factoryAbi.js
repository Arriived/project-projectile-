// Hand-picked subset of Ballista's ABI (the contract formerly named ArcLaunchFactory).
// Kept minimal and independent of the contracts project's build output so this indexer
// doesn't silently break if that build folder is regenerated or restructured — if the
// real contract's interface changes, update this file deliberately.
//
// These fragments were copied from artifacts/contracts/Ballista.sol/Ballista.json, not
// written by hand. If you edit them, re-derive from that artifact rather than guessing:
// a wrong tuple order here decodes into wrong values with no error raised.
module.exports = [
  "event TokenCreated(address indexed token, address indexed creator, string name, string symbol, string metadataURI)",
  "event Trade(address indexed token, address indexed trader, bool isBuy, uint256 usdcAmount, uint256 tokenAmount)",
  "event Graduated(address indexed token, uint256 tokenLiquidity, uint256 usdcLiquidity, uint256 lpTokensBurned)",
  // Emitted when a curve crosses its threshold but the DEX hand-off has not completed
  // yet. Graduation is decoupled, so a token can sit in this state indefinitely until
  // someone calls graduate() successfully.
  "event GraduationReady(address indexed token)",
  // Creator fee accrual and withdrawal. Accrual carries the token, which is the only
  // place per-token attribution of creator revenue exists -- creatorFeesAccrued is
  // keyed by creator alone.
  "event CreatorFeeAccrued(address indexed token, address indexed creator, uint256 amount)",
  "event CreatorFeesClaimed(address indexed creator, uint256 amount)",
  "event SnipeTaxCollected(address indexed token, address indexed buyer, uint256 toTreasury, uint256 toCurve)",
  // ROUTER GOVERNANCE -- these are the early-warning signals, not indexer data.
  // RouterProposed is the one to alert on: it is the only advance notice that the most
  // dangerous address in the contract is about to change, and it fires ROUTER_TIMELOCK
  // (24h) before the change can take effect. Anyone running monitoring should page on it.
  "event RouterProposed(address indexed router, uint256 activatableAt)",
  "event RouterActivated(address indexed router)",
  "event RouterRevoked(address indexed router, bool wasLive)",
  // The single creatorFeeBps became the asymmetric pair creatorBuyFeeBps /
  // creatorSellFeeBps -- buy and sell no longer pay the creator the same share.
  // curves() returns the Curve STRUCT now, not a flat tuple. Solidity's auto-getter
  // flattened it, but at 15 fields that overflowed the ABI encoder's stack, so the
  // mapping is private behind an explicit struct getter. ethers still surfaces named
  // fields, so `curve.state` and friends keep working unchanged.
  //
  // Field order still matters -- a mismatch decodes into wrong values silently, with no
  // error raised anywhere. Copied verbatim from the compiled artifact; verify with:
  //   node -e "...Interface(abi).getFunction('curves').format('full')"
  "function curves(address token) view returns ((address token, address creator, uint256 virtualTokenReserves, uint256 virtualUsdcReserves, uint256 realUsdcReserves, uint256 tokenReserves, uint8 state, uint16 buyFeeBps, uint16 sellFeeBps, uint16 creatorBuyFeeBps, uint16 creatorSellFeeBps, uint256 graduationThresholdUsdc, uint256 creationBlock, uint256 creationTimestamp, uint32 snipeTaxTableVersion, uint16 snipeTaxTreasuryBps))",
];
