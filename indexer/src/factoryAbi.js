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
  // NOTE: `state` replaced the old `graduated` bool, and `creationBlock` is new on the
  // end of the tuple. Both changed in the Ballista rewrite.
  "function curves(address) view returns (address token, address creator, uint256 virtualTokenReserves, uint256 virtualUsdcReserves, uint256 realUsdcReserves, uint256 tokenReserves, uint8 state, uint16 buyFeeBps, uint16 sellFeeBps, uint256 graduationThresholdUsdc, uint256 creationBlock)",
];
