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
  // NOTE: `state` replaced the old `graduated` bool, `creatorFeeBps` sits between
  // sellFeeBps and graduationThresholdUsdc, and `creationBlock` is new on the end.
  // Field ORDER matters -- a mismatch here decodes into wrong values silently, with
  // no error raised anywhere.
  "function curves(address) view returns (address token, address creator, uint256 virtualTokenReserves, uint256 virtualUsdcReserves, uint256 realUsdcReserves, uint256 tokenReserves, uint8 state, uint16 buyFeeBps, uint16 sellFeeBps, uint16 creatorFeeBps, uint256 graduationThresholdUsdc, uint256 creationBlock)",
];
