// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {LFX1} from "../LFX1.sol";

// Serves a controllable `curves(address)` so the hook's registration guards can be driven
// into states the real, frozen LFX1 cannot produce.
//
// ⚠ IT RETURNS LFX1's OWN Curve STRUCT, imported rather than restated. A hand-copied
// 22-field struct that drifts by one field would decode garbage and the tests would assert
// against nonsense while looking healthy -- CLAUDE.md 1.3's rule applied to a fixture.
//
// The zero-creator case is the reason this exists: LFX1 writes `creator = msg.sender` at
// LFX1.sol:342 and has no setter, so a curve with creator == address(0) is unreachable
// through the real contract. The hook guards against it anyway, because the cost of being
// wrong is that half of every fee on that pool accrues to address(0) for ever, and a guard
// that cannot be exercised is a guard nobody knows still works.
contract MockLfx1Curves {
    mapping(address => LFX1.Curve) private _curves;

    function setCurve(address token, address curveToken, address creator) external {
        LFX1.Curve storage c = _curves[token];
        c.token = curveToken;
        c.creator = creator;
    }

    function curves(address token) external view returns (LFX1.Curve memory) {
        return _curves[token];
    }
}
