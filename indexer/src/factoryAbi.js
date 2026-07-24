// Hand-picked subset of ArcLaunchFactory's ABI. Kept minimal and independent of
// artifacts-manual/ (the contracts project's build output) so this indexer doesn't
// silently break if that build folder is regenerated or restructured — if the real
// contract's interface changes, update this file deliberately.
module.exports = [
  "event TokenCreated(address indexed token, address indexed creator, string name, string symbol, string metadataURI)",
  "event Trade(address indexed token, address indexed trader, bool isBuy, uint256 usdcAmount, uint256 tokenAmount)",
  "event Graduated(address indexed token, uint256 tokenLiquidity, uint256 usdcLiquidity, uint256 lpTokensBurned)",
  "function curves(address token) view returns (address token_, address creator, uint256 virtualTokenReserves, uint256 virtualUsdcReserves, uint256 realUsdcReserves, uint256 tokenReserves, bool graduated, uint16 buyFeeBps, uint16 sellFeeBps, uint256 graduationThresholdUsdc)",
];
