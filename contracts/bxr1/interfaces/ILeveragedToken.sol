// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

// The one function AssetRegistry needs from a leveraged token (LT) registered as a
// LEVERAGED quote asset: the USDC value of one WHOLE LT, WAD-scaled (1e18 == 1 USDC
// per LT). Matches Bounce's LeveragedToken semantics
// (bounce-tech/bounce-smart-contracts@b4b39ba, src/LeveragedToken.sol:344-347).
//
// AssetRegistry.launchTerms() reads this ONCE per call, at the moment a curve is
// created against a LEVERAGED asset -- never re-read afterward. The curve's amounts
// are fixed in the LT's own raw units at that point; a later NAV move can never
// retroactively change a curve that already exists (CLAUDE.md section 27).
interface ILeveragedToken {
    function exchangeRate() external view returns (uint256);
}
