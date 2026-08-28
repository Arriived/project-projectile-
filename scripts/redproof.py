# -*- coding: utf-8 -*-
"""Single-site red-proof: mutate one thing, run one suite, restore.

Why this exists alongside guard-coverage.py: that harness disables `if (!(...)) revert`
GUARD sites and runs the HARDHAT suite. It cannot red-proof a Foundry invariant -- it
parses mocha's "N passing/failing", and an accounting bug is not a guard site, so its
mutation vocabulary cannot express one. Before this script the only route was a hand-
edited contract, which is exactly what CLAUDE.md 5 bans.

This is NOT a loop. One named mutation, applied, tested, restored. It mirrors
guard-coverage.py's safety properties -- refuses to start dirty, restores from git after
the run, on SIGINT/SIGTERM and via atexit -- and additionally takes the mutation lease, so
a kill mid-run cannot produce a committable tree.

    python scripts/redproof.py --list
    python scripts/redproof.py treasury
    python scripts/redproof.py multicurve-claim-prank --runner forge
    python scripts/redproof.py isolation --full

Runs at reduced fuzz settings by default: a mutation that DIES in 50 runs is proved dead.
One that SURVIVES 50 has proved nothing and must be re-run with --full before you believe
it -- see CLAUDE.md 5.
"""
import argparse
import atexit
import io
import os
import re
import shutil
import signal
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import mutation_lease  # noqa: E402

SRC = "contracts/LFX1.sol"
MULTI_HANDLER = "test/invariant/MultiCurveHandler.sol"
CROSS_SUITE = "test/invariant/CrossCurveInvariant.t.sol"
MULTI_SUITE = "test/invariant/MultiCurveInvariant.t.sol"


def _anchor(s, a, n=1):
    if s.count(a) != n:
        sys.exit("anchor matched %d times, expected %d:\n  %s" % (s.count(a), n, a))
    return a


def mut_isolation(s):
    a = _anchor(s, "    mapping(address => Curve) private _curves;")
    b = _anchor(s, "        emit TokenCreated(token, msg.sender, name, symbol, metadataURI);")
    c = _anchor(s, "        c.tokenReserves -= q.tokensOut;")
    s = s.replace(a, a + "\n    address[] public allTokens; // MUTATED")
    s = s.replace(b, "        allTokens.push(token); // MUTATED\n" + b)
    return s.replace(c, c + """
        { // MUTATED
            Curve storage victim = _curves[allTokens[0]]; // MUTATED
            if (victim.token != token && victim.realUsdcReserves > 0) { // MUTATED
                victim.realUsdcReserves -= 1; // MUTATED
                c.realUsdcReserves += 1; // MUTATED
            } // MUTATED
        } // MUTATED""")


def mut_lprecipient(s):
    a = _anchor(s, "        uint16 taxBps = _snipeTaxBps(c);")
    return s.replace(a, "        c.lpRecipient = address(0xBEEF); // MUTATED\n" + a)


def mut_treasury(s):
    a = _anchor(s, "        if (f.treasuryCut > 0) treasuryFeesAccrued += f.treasuryCut;")
    return s.replace(a, "        if (false) treasuryFeesAccrued += f.treasuryCut; // MUTATED")


def mut_regress_router_single_use(s):
    """Undo half of the R12 fix: stop consuming the approval on activation, so a matured
    router stays permanently re-activatable."""
    a = _anchor(s, "        routerProposedAt[router_] = 0;\n        router = router_;")
    return s.replace(a, "        // MUTATED: approval no longer consumed\n        router = router_;")


def mut_regress_router_bootstrap(s):
    """Undo the other half: let the constructor bank a permanent approval for the
    bootstrap router again. Clearing on activation alone does NOT close this, because the
    constructor never routes through activateRouter."""
    a = _anchor(s, "            emit RouterProposed(initialRouter_, block.timestamp);")
    return s.replace(a, "            routerProposedAt[initialRouter_] = block.timestamp; // MUTATED\n" + a)


def mut_fix_creationfee_hash(s):
    """The candidate FIX for R13: pin creationFeeUsdc in the economics hash."""
    a = _anchor(s, "            symbolLockDuration\n        ));")
    return s.replace(a, "            symbolLockDuration,\n            creationFeeUsdc // MUTATED\n        ));")


def mut_zero_mins(s):
    """Revert section 1.1: put the literal zeros back as amountAMin/amountBMin. Against a
    real skewed pair this makes graduation SUCCEED at the attacker's ratio instead of
    reverting, which is the vulnerability strict mins closed."""
    a = _anchor(s, "            tokenLiquidity,\n            usdcLiquidity,\n            c.lpRecipient,")
    return s.replace(a, "            0, // MUTATED\n            0, // MUTATED\n            c.lpRecipient,")


def mut_swap_graduation_args(s):
    """Swap the token/USDC arguments to addLiquidity, leaving the amounts in place."""
    a = _anchor(s, "            token,\n            address(usdc),\n            tokenLiquidity,")
    return s.replace(a, "            address(usdc), // MUTATED\n            token, // MUTATED\n            tokenLiquidity,")


def mut_lp_elsewhere(s):
    """Send LP somewhere other than the snapshotted recipient."""
    a = _anchor(s, "            c.lpRecipient,")
    return s.replace(a, "            address(0xBEEF), // MUTATED")


def mut_helper_no_graduate(s):
    """Break the bundle: correct the pair but do not graduate in the same call. Every
    atomicity test must go red."""
    a = _anchor(s, "        lfx1.graduate(p.token);")
    return s.replace(a, "        // MUTATED: bundle broken, graduation not bundled")


def mut_helper_floor_not_ceil(s):
    """Floor instead of ceil on the USDC step, so D lands just BELOW the window. This is
    the bug class that made graduate() revert with GraduationFailed."""
    a = _anchor(s, "            usdcNeeded = (rhs - lhs + T - 1) / T; // ceil, lands D in [0, T)")
    return s.replace(a, "            usdcNeeded = (rhs - lhs) / T; // MUTATED: floor, lands D below the window")


GUARD_SRC = '        bytes32 symbolHash = caseSensitiveSymbols\n            ? keccak256(bytes(symbol))\n            : keccak256(bytes(_toUpperAscii(symbol)));\n        uint256 unlocksAt = symbolUnlocksAt[symbolHash];\n        if (!(unlocksAt == 0 || block.timestamp >= unlocksAt)) revert SymbolLocked(unlocksAt);'
WRITE_SRC = '        symbolUnlocksAt[symbolHash] = block.timestamp + symbolLockDuration;'


def mut_remove_symbol_lock(s):
    """Cut the symbol lock out entirely -- the hash, the guard and the write -- to
    price what setting symbolLockDuration = 0 does NOT recover. Measurement only; the
    symbol-lock tests are expected to go red under it."""
    a = _anchor(s, GUARD_SRC)
    s = s.replace(a, "        // MUTATED: symbol lock guard removed")
    b = _anchor(s, WRITE_SRC)
    return s.replace(b, "        // MUTATED: symbol lock write removed")


def mut_multicurve_claim_prank(s):
    a = _anchor(s, "        vm.prank(creator);")
    return s.replace(a, "        // MUTATED: prank removed, restoring the dead-claim bug")


MUTATIONS = {
    "isolation": {
        "file": SRC,
        "suite": CROSS_SUITE,
        "fn": mut_isolation,
        "doc": "zero-sum cross-curve steal; the SUM is unchanged so aggregate checks stay green",
    },
    "lprecipient": {
        "file": SRC,
        "suite": CROSS_SUITE,
        "fn": mut_lprecipient,
        "doc": "writes lpRecipient after creation, which 1.8 makes immutable per curve",
    },
    "treasury": {
        "file": SRC,
        "suite": CROSS_SUITE,
        "fn": mut_treasury,
        "doc": "drops the treasury accrual; unaccounted funds read as surplus to a >= check",
    },
    "regress-router-single-use": {
        "file": SRC,
        "suite": None,
        "fn": mut_regress_router_single_use,
        "doc": "undoes half the R12 fix: approval no longer consumed on activation",
    },
    "regress-router-bootstrap": {
        "file": SRC,
        "suite": None,
        "fn": mut_regress_router_bootstrap,
        "doc": "undoes the other half: constructor banks a permanent bootstrap approval",
    },
    "fix-creationfee-hash": {
        "file": SRC,
        "suite": None,
        "fn": mut_fix_creationfee_hash,
        "doc": "candidate fix for R13; the R13 characterisation test must go RED under it",
    },
    "zero-mins": {
        "file": SRC,
        "suite": None,
        "fn": mut_zero_mins,
        "doc": "reverts 1.1's strict mins to zeros; fork test 3 must go RED (attack succeeds)",
    },
    "swap-graduation-args": {
        "file": SRC,
        "suite": None,
        "fn": mut_swap_graduation_args,
        "doc": "swaps token/USDC into addLiquidity; fork test 1 must go RED",
    },
    "lp-elsewhere": {
        "file": SRC,
        "suite": None,
        "fn": mut_lp_elsewhere,
        "doc": "sends LP off the snapshotted recipient; fork test 2 must go RED",
    },
    "helper-no-graduate": {
        "file": "contracts/GraduationHelper.sol",
        "suite": None,
        "fn": mut_helper_no_graduate,
        "doc": "breaks the atomic bundle; every GraduationHelper atomicity test must go RED",
    },
    "helper-floor-not-ceil": {
        "file": "contracts/GraduationHelper.sol",
        "suite": None,
        "fn": mut_helper_floor_not_ceil,
        "doc": "floors the USDC step so D lands below the window; reintroduces GraduationFailed",
    },
    "remove-symbol-lock": {
        "file": SRC,
        "suite": None,
        "fn": mut_remove_symbol_lock,
        "doc": "cuts the symbol lock out; gas/bytes measurement, lock tests go red",
    },
    "multicurve-claim-prank": {
        "file": MULTI_HANDLER,
        "suite": MULTI_SUITE,
        "fn": mut_multicurve_claim_prank,
        "doc": "removes the claim prank, restoring the dead-claim bug the fix closed",
    },
}


def run(cmd, env=None):
    e = dict(os.environ)
    if env:
        e.update(env)
    p = subprocess.run(cmd, capture_output=True, shell=True, env=e,
                       encoding="utf-8", errors="replace")
    return p.returncode, (p.stdout or "") + (p.stderr or "")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("mutation", nargs="?")
    ap.add_argument("--list", action="store_true")
    ap.add_argument("--runner", choices=["forge", "hardhat"], default="forge")
    ap.add_argument("--suite", help="override the mutation's default suite path")
    ap.add_argument("--grep", help="hardhat runner: mocha grep pattern")
    ap.add_argument("--full", action="store_true",
                    help="run at the shipped fuzz settings instead of reduced ones")
    args = ap.parse_args()

    if args.list or not args.mutation:
        for k in sorted(MUTATIONS):
            print("%-24s %s" % (k, MUTATIONS[k]["doc"]))
        return

    if args.mutation not in MUTATIONS:
        sys.exit("unknown mutation: %s (try --list)" % args.mutation)
    m = MUTATIONS[args.mutation]
    target = m["file"]

    # REFUSE on dirty; never auto-restore. Restoring silently destroys uncommitted
    # work -- it ate this script's own first red-proof target, an unstaged test fix, on
    # the first run. The restore-from-git this tool relies on can only recover what is
    # committed, so the target must be committed BEFORE it is mutated.
    rc, _ = run('git diff --quiet -- "%s"' % target)
    if rc != 0:
        _, st = run('git diff --stat -- "%s"' % target)
        sys.exit(
            "refusing to run: %s has uncommitted changes.\n\n%s\n"
            "A red-proof restores from git, so it can only recover what is committed.\n"
            "Commit the change first, or discard it with:\n"
            "    git checkout -- %s" % (target, st.strip(), target)
        )

    try:
        mutation_lease.acquire("redproof.py", "%s -> %s" % (args.mutation, target))
    except mutation_lease.LeaseHeld as e:
        sys.exit(str(e))

    def cleanup():
        run('git checkout -- "%s"' % target)
        mutation_lease.release()

    atexit.register(cleanup)
    for sig in (signal.SIGINT, signal.SIGTERM):
        signal.signal(sig, lambda *_: (cleanup(), sys.exit(130)))

    orig = io.open(target, encoding="utf-8").read()
    io.open(target, "w", encoding="utf-8", newline="\n").write(m["fn"](orig))
    print("=== mutation applied: %s  (%s) ===" % (args.mutation, target), flush=True)

    # Cached counterexamples replay before fuzzing and would mask a genuine result.
    shutil.rmtree("cache/invariant/failures", ignore_errors=True)

    if args.runner == "forge":
        env = {} if args.full else {"FOUNDRY_INVARIANT_RUNS": "50",
                                    "FOUNDRY_INVARIANT_DEPTH": "50"}
        _, out = run('forge test --match-path "%s"' % (args.suite or m["suite"]), env=env)
        keep = lambda l: l.startswith("[PASS]") or l.startswith("[FAIL") or "Suite result" in l
    else:
        cmd = "npx hardhat test"
        if args.grep:
            cmd += ' --grep "%s"' % args.grep
        _, out = run(cmd)
        # Mocha prints the failure title and the reason on separate lines from the
        # counts, so a counts-only filter reports "1 failing" and hides WHICH and WHY --
        # which is most of what a red-proof is for.
        keep = lambda l: (
            " passing" in l or " failing" in l or "AssertionError" in l
            or "expected" in l or re.match(r"\s+\d+\)\s", l) is not None
            or "reverted" in l
        )

    printed = False
    for line in out.splitlines():
        if keep(line):
            print(line, flush=True)
            printed = True
    if not printed:
        print("!! no parseable result -- INCONCLUSIVE, not a pass. Tail:", flush=True)
        print(out.strip()[-800:], flush=True)

    cleanup()
    shutil.rmtree("cache/invariant/failures", ignore_errors=True)
    rc, _ = run('git diff --quiet -- "%s"' % target)
    print("=== restored, clean=%s, lease released=%s ==="
          % (rc == 0, not os.path.exists(mutation_lease.LEASE)), flush=True)


main()
