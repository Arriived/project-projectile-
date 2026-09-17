// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

// _quoteBuy, _quoteSell and _ceilDiv, extracted verbatim out of BXR1.sol into an
// external library. Measured, not estimated: this extraction alone frees 345 bytes
// of BXR1's deployed bytecode (24,484 -> 24,139), against a 92-byte overage at the
// time this was built. The fee-split helpers (_creatorCut, _splitBuyFee,
// _routeCreatorCut) were measured too and deliberately NOT moved here -- for
// functions that small, the external-call ABI encode/decode overhead (especially
// decoding a returned struct) costs more bytes in BXR1 than the inlined body it
// would replace. _routeCreatorCut additionally cannot move at all: it writes
// contract storage (creatorFeesAccrued, poolBoost) and emits events, neither of
// which an external (non-delegatecall) library function can reach.
//
// Stateless: no storage, pure functions only. Deploys once, links into BXR1 at
// deploy time (see scripts/deploy-bxr1.js), and never needs redeployment unless
// this file itself changes.
library CurveMath {
    uint256 constant BPS_DENOMINATOR = 10_000;

    error CurveMathError();
    error ClampCostExceededOffer();
    error ClampInputExceededOffer();

    struct BuyQuote {
        uint256 tokensOut;
        uint256 newVirtualQuote;
        uint256 newVirtualToken;
        uint256 actualQuoteIn;
        uint256 actualFee;
    }

    struct SellQuote {
        uint256 actualTokensIn;
        uint256 newVirtualQuote;
        uint256 newVirtualToken;
        uint256 quoteOutGross;
        uint256 fee;
    }

    // Rounds up. Every division on the curve rounds against the trader.
    function ceilDiv(uint256 a, uint256 b) public pure returns (uint256) {
        return (a + b - 1) / b;
    }

    function quoteBuy(
        uint256 quoteIn,
        uint16 buyFeeBps,
        uint256 virtualQuoteReserves,
        uint256 virtualTokenReserves,
        uint256 tokenReservesAvailable
    ) external pure returns (BuyQuote memory q) {
        uint256 k = virtualQuoteReserves * virtualTokenReserves;
        uint256 fee = (quoteIn * buyFeeBps) / BPS_DENOMINATOR;
        uint256 quoteInAfterFee = quoteIn - fee;
        uint256 newVirtualQuote = virtualQuoteReserves + quoteInAfterFee;

        uint256 newVirtualToken = ceilDiv(k, newVirtualQuote);
        if (!(newVirtualToken <= virtualTokenReserves)) revert CurveMathError();
        uint256 tokensOut = virtualTokenReserves - newVirtualToken;

        if (tokensOut <= tokenReservesAvailable) {

            q.tokensOut = tokensOut;
            q.newVirtualQuote = newVirtualQuote;
            q.newVirtualToken = newVirtualToken;
            q.actualQuoteIn = quoteIn;
            q.actualFee = fee;
            return q;
        }

        // Clamp: solve the curve backwards from the tokens actually available to the
        // input that buys exactly them, then re-add the fee.
        q.tokensOut = tokenReservesAvailable;
        q.newVirtualToken = virtualTokenReserves - q.tokensOut;

        q.newVirtualQuote = ceilDiv(k, q.newVirtualToken);
        uint256 clampedQuoteInAfterFee = q.newVirtualQuote - virtualQuoteReserves;

        q.actualQuoteIn = ceilDiv(clampedQuoteInAfterFee * BPS_DENOMINATOR, BPS_DENOMINATOR - buyFeeBps);
        q.actualFee = q.actualQuoteIn - clampedQuoteInAfterFee;

        if (!(q.actualQuoteIn <= quoteIn)) revert ClampCostExceededOffer();
    }

    function quoteSell(
        uint256 tokensIn,
        uint16 sellFeeBps,
        uint256 virtualQuoteReserves,
        uint256 virtualTokenReserves,
        uint256 realQuoteReservesAvailable
    ) external pure returns (SellQuote memory q) {
        uint256 k = virtualQuoteReserves * virtualTokenReserves;
        uint256 newVirtualToken = virtualTokenReserves + tokensIn;

        uint256 newVirtualQuote = ceilDiv(k, newVirtualToken);
        if (!(newVirtualQuote <= virtualQuoteReserves)) revert CurveMathError();
        uint256 quoteOutGross = virtualQuoteReserves - newVirtualQuote;

        if (quoteOutGross <= realQuoteReservesAvailable) {

            q.actualTokensIn = tokensIn;
            q.newVirtualToken = newVirtualToken;
            q.newVirtualQuote = newVirtualQuote;
            q.quoteOutGross = quoteOutGross;
            q.fee = (quoteOutGross * sellFeeBps) / BPS_DENOMINATOR;
            return q;
        }

        // Clamp: same inversion as the buy side, driven by available quote instead.
        q.quoteOutGross = realQuoteReservesAvailable;
        q.newVirtualQuote = virtualQuoteReserves - q.quoteOutGross;

        q.newVirtualToken = ceilDiv(k, q.newVirtualQuote);
        q.actualTokensIn = q.newVirtualToken - virtualTokenReserves;
        q.fee = (q.quoteOutGross * sellFeeBps) / BPS_DENOMINATOR;

        if (!(q.actualTokensIn <= tokensIn)) revert ClampInputExceededOffer();
    }
}
