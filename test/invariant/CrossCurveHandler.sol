// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Vm} from "forge-std/Vm.sol";
import "../../contracts/LFX1.sol";
import "../../contracts/mocks/MockUSDC.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice Drives trading across several curves that each have a DIFFERENT creator, and
///         after every mutation checks that the curves the call was not aimed at are
///         byte-identical to what they were before it.
///
///         MultiCurveInvariant's pooled check is a SUM: total USDC >= every curve's
///         reserves plus creator plus treasury fees, added together. That sum cannot see
///         value moving BETWEEN curves -- take a dollar of accounting off curve A, put it
///         on curve B, and the total is unchanged while A's holders are short. Only the
///         caller knows which curve a call was aimed at, so the handler is the only place
///         that can assert the rest of them did not move.
///
///         Creators are distinct on purpose. creatorFeesAccrued is keyed by creator, not
///         by token, so tokens sharing a creator merge their fee balances before any check
///         can see them -- and a claim by an address with no balance reverts into the
///         catch and executes nothing at all.
contract CrossCurveHandler {
    Vm internal constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    LFX1 public immutable factory;
    MockUSDC public immutable usdc;

    address[] public tokens;
    address[] public creators; // creators[i] created tokens[i]

    uint256 public buysExecuted;
    uint256 public sellsExecuted;
    uint256 public creatorClaimsExecuted;
    uint256 public treasuryClaimsExecuted;

    bool public isolationViolated;
    address public violatingToken;
    string public violationKind;

    struct Snapshot {
        bytes32[] curveFp;
        uint256[] factoryTokenBal;
        uint256[] creatorFees;
    }

    constructor(LFX1 factory_, MockUSDC usdc_, address[] memory tokens_, address[] memory creators_) {
        factory = factory_;
        usdc = usdc_;
        tokens = tokens_;
        creators = creators_;
    }

    function _curveFingerprint(address token) internal view returns (bytes32) {
        return keccak256(abi.encode(factory.curves(token)));
    }

    function _snapshot() internal view returns (Snapshot memory s) {
        uint256 n = tokens.length;
        s.curveFp = new bytes32[](n);
        s.factoryTokenBal = new uint256[](n);
        s.creatorFees = new uint256[](n);
        for (uint256 i; i < n; i++) {
            s.curveFp[i] = _curveFingerprint(tokens[i]);
            s.factoryTokenBal[i] = IERC20(tokens[i]).balanceOf(address(factory));
            s.creatorFees[i] = factory.creatorFeesAccrued(creators[i]);
        }
    }

    /// @notice Records the FIRST violation only, so the diagnostic stays stable while the
    ///         fuzzer keeps running after it trips.
    function _flag(address token, string memory kind) internal {
        if (isolationViolated) return;
        isolationViolated = true;
        violatingToken = token;
        violationKind = kind;
    }

    /// @notice Everything except the curve the call was aimed at must be untouched.
    ///
    ///         Two things are deliberately absent. The factory's USDC balance is pooled
    ///         across every curve, so it legitimately moves on any trade -- the per-curve
    ///         ACCOUNTING of that pool is what must stay put, and that is inside the
    ///         fingerprint. treasuryFeesAccrued is a single global accumulator that every
    ///         trade legitimately feeds, so it is checked by the conservation invariant
    ///         rather than here.
    function _assertOthersUnmoved(Snapshot memory before, uint256 targetIdx) internal {
        for (uint256 i; i < tokens.length; i++) {
            if (i == targetIdx) continue;
            if (_curveFingerprint(tokens[i]) != before.curveFp[i]) {
                _flag(tokens[i], "curve state moved on a token the trade was not aimed at");
            }
            if (IERC20(tokens[i]).balanceOf(address(factory)) != before.factoryTokenBal[i]) {
                _flag(tokens[i], "factory token balance moved on an untargeted token");
            }
            if (factory.creatorFeesAccrued(creators[i]) != before.creatorFees[i]) {
                _flag(tokens[i], "another creator's fee balance moved");
            }
        }
    }

    function buy(uint256 seed, uint256 amountSeed) external {
        uint256 idx = seed % tokens.length;
        address token = tokens[idx];
        if (factory.curves(token).state != LFX1.CurveState.ACTIVE) return;

        // Same sizing as MultiCurveHandler: large enough to reach graduation sometimes,
        // small enough that a run spends most of its length on the curve rather than
        // no-opping after an instant clamp-and-graduate.
        uint256 usdcIn = 1e6 + (amountSeed % (250e6));
        usdc.mint(address(this), usdcIn);
        usdc.approve(address(factory), usdcIn);

        Snapshot memory before = _snapshot();
        try factory.buy(token, usdcIn, 0) {
            buysExecuted++;
            _assertOthersUnmoved(before, idx);
        } catch {}
    }

    function sell(uint256 seed, uint256 pctSeed) external {
        uint256 idx = seed % tokens.length;
        address token = tokens[idx];
        if (factory.curves(token).state != LFX1.CurveState.ACTIVE) return;

        uint256 balance = IERC20(token).balanceOf(address(this));
        if (balance == 0) return;
        uint256 tokensIn = (balance * (1 + (pctSeed % 100))) / 100;
        if (tokensIn == 0) return;
        IERC20(token).approve(address(factory), tokensIn);

        Snapshot memory before = _snapshot();
        try factory.sell(token, tokensIn, 0) {
            sellsExecuted++;
            _assertOthersUnmoved(before, idx);
        } catch {}
    }

    /// @notice Pranked as the real creator, and skipped when there is nothing to claim, so
    ///         this path actually executes instead of reverting into the catch. A claim
    ///         moves USDC out of the pooled balance without touching any curve -- if
    ///         reserves and fees were ever backed by the same dollar, this separates them.
    function claimCreator(uint256 seed) external {
        uint256 idx = seed % creators.length;
        address creator = creators[idx];
        if (factory.creatorFeesAccrued(creator) == 0) return;

        Snapshot memory before = _snapshot();
        vm.prank(creator);
        try factory.claimCreatorFees() {
            creatorClaimsExecuted++;
            // A creator claim is aimed at a creator, not a curve, so NO curve may move.
            for (uint256 i; i < tokens.length; i++) {
                if (_curveFingerprint(tokens[i]) != before.curveFp[i]) {
                    _flag(tokens[i], "a creator claim moved a curve");
                }
                if (IERC20(tokens[i]).balanceOf(address(factory)) != before.factoryTokenBal[i]) {
                    _flag(tokens[i], "a creator claim moved a token balance");
                }
                if (i != idx && factory.creatorFeesAccrued(creators[i]) != before.creatorFees[i]) {
                    _flag(tokens[i], "a creator claim drained another creator's balance");
                }
            }
        } catch {}
    }

    /// @notice Permissionless, so it needs no prank. It is the widest-reaching claim in
    ///         the contract -- it empties a global accumulator fed by every curve -- so
    ///         nothing curve-side or creator-side may move with it.
    function claimTreasury() external {
        if (factory.treasuryFeesAccrued() == 0) return;

        Snapshot memory before = _snapshot();
        try factory.claimTreasuryFees() {
            treasuryClaimsExecuted++;
            for (uint256 i; i < tokens.length; i++) {
                if (_curveFingerprint(tokens[i]) != before.curveFp[i]) {
                    _flag(tokens[i], "a treasury claim moved a curve");
                }
                if (IERC20(tokens[i]).balanceOf(address(factory)) != before.factoryTokenBal[i]) {
                    _flag(tokens[i], "a treasury claim moved a token balance");
                }
                if (factory.creatorFeesAccrued(creators[i]) != before.creatorFees[i]) {
                    _flag(tokens[i], "a treasury claim moved a creator's balance");
                }
            }
        } catch {}
    }

    function tokenCount() external view returns (uint256) { return tokens.length; }
}
