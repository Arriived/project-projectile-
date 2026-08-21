// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

interface IBallistaLaunch {
    function createToken(string calldata, string calldata, string calldata, bytes32)
        external returns (address);
    function currentEconomicsHash() external view returns (bytes32);
    function creatorLaunchBuy(address token, uint256 usdcIn, uint256 minTokensOut) external;
}

/// @notice TEST ONLY. Creates a token and then hammers creatorLaunchBuy() many times
///         inside that SAME transaction -- and therefore the same block, which is the
///         entire window the privileged buy is open for.
///
///         This is the exploit the cumulative cap exists to stop. With a per-transaction
///         cap, ten "2.5%" buys would take ~37% of curve supply for a few hundred
///         dollars. The cap must be cumulative per token or it is not a cap.
contract CreatorLauncher {
    IBallistaLaunch public immutable ballista;
    IERC20 public immutable usdc;
    address public token;

    constructor(address ballista_, address usdc_) {
        ballista = IBallistaLaunch(ballista_);
        usdc = IERC20(usdc_);
    }

    function approveAll() external {
        usdc.approve(address(ballista), type(uint256).max);
    }

    /// @notice Launch, then loop the privileged buy `times` times in one transaction.
    function launchAndLoop(string calldata symbol, uint256 usdcEach, uint256 times)
        external
        returns (address)
    {
        token = ballista.createToken("Loop", symbol, "ipfs://x", ballista.currentEconomicsHash());
        for (uint256 i = 0; i < times; i++) {
            // Swallow the revert once the allowance is exhausted, so the loop measures
            // how much can actually be taken rather than just reverting the whole tx.
            try ballista.creatorLaunchBuy(token, usdcEach, 0) {} catch {}
        }
        return token;
    }
}
