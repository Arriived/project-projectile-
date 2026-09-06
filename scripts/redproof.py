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


R17_ERR_ANCHOR = '    error ZeroAmount();'
R17_PAUSE_ANCHOR = '    function pause() external onlyOwner {'
R17_OVERRIDE = '    /// MUTATED: R17 candidate fix.\n    function renounceOwnership() public pure override {\n        revert OwnershipCannotBeRenounced();\n    }\n\n'


def mut_r17_block_renounce(s):
    """R17 candidate fix: override renounceOwnership() to revert. Measurement -- how
    many bytes does closing the one-transaction permanent-freeze footgun cost?"""
    a = _anchor(s, R17_ERR_ANCHOR)
    s = s.replace(a, a + "\n    error OwnershipCannotBeRenounced(); // MUTATED")
    b = _anchor(s, R17_PAUSE_ANCHOR)
    return s.replace(b, R17_OVERRIDE + b)


R17_LIVE_OVERRIDE = '    function renounceOwnership() public pure override {\n        revert OwnershipCannotBeRenounced();\n    }\n\n'


def mut_r17_unblock_renounce(s):
    """Remove the R17 override, restoring Ownable's live renounceOwnership(). The R17
    tests must go red; the two RESIDUAL tests must stay green, since they exercise
    transferOwnership and never touched the override."""
    a = _anchor(s, R17_LIVE_OVERRIDE)
    return s.replace(a, "    // MUTATED: R17 override removed\n\n")


V4_SRC = "contracts/BallistaV4Adapter.sol"

# The Base fork is opt-in, and a fork suite that SKIPS prints "0 passing" with nothing
# failing -- which this harness would report as the mutation SURVIVING. That is a false
# negative on the most important red-proof here, so the environment every v4 mutation
# needs travels WITH the mutation instead of being something the operator has to
# remember. Same reasoning as the grep: a red-proof that silently tests nothing is worse
# than one that errors.
V4_ENV = {"FORK_BASE": "1"}
V4_GREP = "REAL Uniswap v4"


def mut_v4_decimal_normalise(s):
    """Normalise one side to 18 decimals before deriving the price -- the plausible
    "fix" for an 18dp token against 6dp USDC, and wrong by exactly the 1e12 the raw
    amounts already carry. It still initialises, still mints and still returns a
    non-zero liquidity, so ONLY a price assertion can catch it."""
    a = _anchor(s, "        uint256 ratio = amount1 / amount0;")
    return s.replace(a, "        amount1 = amount1 * 1e12; // MUTATED\n" + a)


def mut_v4_pull_99pct(s):
    """Take a computed SUBSET instead of the full desired amounts.

    Applied to the desired amounts themselves, before anything reads them, so the
    adapter stays internally CONSISTENT -- it pulls 99%, prices 99% and mints 99%, and
    every one of its own guards passes. Scaling only the transferFrom would instead
    make the mint try to settle more than the adapter holds and revert, which proves
    the adapter is self-consistent but says NOTHING about whether the test would notice
    funds stranded in the factory. That second thing is the assertion under proof here.

    The 1% left behind sits in the FACTORY with no accounting entry, and every LFX1
    payout path is bounded by accounting rather than by balance, so nothing can ever
    reach it again (CLAUDE.md R14)."""
    a = _anchor(s, "        // 1. Pull the FULL desired amounts, never a computed subset.")
    return s.replace(
        a,
        "        amountADesired = amountADesired * 99 / 100; // MUTATED\n"
        "        amountBDesired = amountBDesired * 99 / 100; // MUTATED\n" + a,
    )


def mut_v4_lp_to_sender(s):
    """Mint the position to the caller instead of the snapshotted lpRecipient. Applied at
    the FORWARDING site so the adapter stays self-consistent -- its own ownerOf check
    then passes -- and the test's own burn-address assertion is what has to fire."""
    a = _anchor(s, "            (amountA, amountB, liquidity) = _seed(tokenA, tokenB, amountADesired, amountBDesired, to, deadline);")
    b = _anchor(s, "            (amountB, amountA, liquidity) = _seed(tokenB, tokenA, amountBDesired, amountADesired, to, deadline);")
    s = s.replace(a, a.replace(", to, deadline)", ", msg.sender, deadline) /* MUTATED */"))
    return s.replace(b, b.replace(", to, deadline)", ", msg.sender, deadline) /* MUTATED */"))


def mut_v4_fake_liquidity(s):
    """Report a non-zero liquidity for a pool that was never seeded: skip the mint, and
    strip every verification that would notice. LFX1 gates only on liquidity == 0, so
    this marks the token GRADUATED with the LP already gone and nothing able to undo it.
    If the suite stays green under this, it is not testing the failure that matters
    most."""
    a = _anchor(s, "        positionManager.modifyLiquidities(_encodeMint(key, liquidity, amount0, amount1, to), deadline);")
    b = _anchor(s, "        if (consumed0 == 0 || consumed1 == 0) revert NothingConsumed();")
    c = _anchor(s, "        mintedLiquidity = uint256(positionManager.getPositionLiquidity(tokenId));")
    d = _anchor(s, "        {\n            address actualOwner = positionManager.ownerOf(tokenId);\n"
                   "            if (actualOwner != to) revert PositionNotMinted(tokenId, to, actualOwner);\n        }")
    s = s.replace(a, "        // MUTATED: the mint never happens")
    s = s.replace(b, "        // MUTATED: consumption never checked")
    s = s.replace(c, "        mintedLiquidity = 1; // MUTATED: fabricated, never read back")
    return s.replace(d, "        // MUTATED: ownership never verified")


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
    "r17-block-renounce": {
        "file": SRC,
        "suite": None,
        "fn": mut_r17_block_renounce,
        "doc": "R17 candidate fix: renounceOwnership() reverts. Byte-cost measurement",
    },
    "r17-unblock-renounce": {
        "file": SRC,
        "suite": None,
        "fn": mut_r17_unblock_renounce,
        "doc": "removes the R17 override; the R17 tests must go RED, residuals stay green",
    },
    "v4-decimal-normalise": {
        "file": V4_SRC,
        "suite": None,
        "runner": "hardhat",
        "env": V4_ENV,
        "grep": V4_GREP,
        "fn": mut_v4_decimal_normalise,
        "doc": "1e12 decimal normalisation in the v4 price; the pool PRICE assertions must go RED",
    },
    "v4-pull-99pct": {
        "file": V4_SRC,
        "suite": None,
        "runner": "hardhat",
        "env": V4_ENV,
        "grep": V4_GREP,
        "fn": mut_v4_pull_99pct,
        "doc": "adapter pulls 99%; the stranded-in-the-factory assertion must go RED",
    },
    "v4-lp-to-sender": {
        "file": V4_SRC,
        "suite": None,
        "runner": "hardhat",
        "env": V4_ENV,
        "grep": V4_GREP,
        "fn": mut_v4_lp_to_sender,
        "doc": "position minted to the caller, not lpRecipient; the burn assertion must go RED",
    },
    "v4-fake-liquidity": {
        "file": V4_SRC,
        "suite": None,
        "runner": "hardhat",
        "env": V4_ENV,
        "grep": V4_GREP,
        "fn": mut_v4_fake_liquidity,
        "doc": "non-zero liquidity reported for a pool never seeded; something MUST go RED",
    },
    "multicurve-claim-prank": {
        "file": MULTI_HANDLER,
        "suite": MULTI_SUITE,
        "fn": mut_multicurve_claim_prank,
        "doc": "removes the claim prank, restoring the dead-claim bug the fix closed",
    },
}


def say(line):
    """print(), but survivable on a cp1252 console.

    mocha emits U+2714 and em dashes, and Windows stdout defaults to cp1252, so printing
    a captured line verbatim can raise UnicodeEncodeError and abort the run *after* the
    mutation has been applied. The subprocess capture already uses errors="replace";
    this gives stdout the same tolerance so a red-proof reports its result instead of
    dying on a tick mark."""
    enc = getattr(sys.stdout, "encoding", None) or "utf-8"
    try:
        print(line, flush=True)
    except UnicodeEncodeError:
        print(line.encode(enc, "replace").decode(enc, "replace"), flush=True)


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
    ap.add_argument("--runner", choices=["forge", "hardhat"], default=None)
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

    runner = args.runner or m.get("runner") or "forge"
    if runner == "forge":
        env = {} if args.full else {"FOUNDRY_INVARIANT_RUNS": "50",
                                    "FOUNDRY_INVARIANT_DEPTH": "50"}
        _, out = run('forge test --match-path "%s"' % (args.suite or m["suite"]), env=env)
        keep = lambda l: l.startswith("[PASS]") or l.startswith("[FAIL") or "Suite result" in l
    else:
        cmd = "npx hardhat test"
        grep = args.grep or m.get("grep")
        if grep:
            cmd += ' --grep "%s"' % grep
        _, out = run(cmd, env=m.get("env"))
        # Mocha prints the failure title and the reason on separate lines from the
        # counts, so a counts-only filter reports "1 failing" and hides WHICH and WHY --
        # which is most of what a red-proof is for.
        keep = lambda l: (
            " passing" in l or " failing" in l or "AssertionError" in l
            or "expected" in l or re.match(r"\s+\d+\)\s", l) is not None
            or "reverted" in l or "MEASURE" in l
        )

    # Chai does not put "AssertionError:" on the line carrying a CUSTOM message -- a
    # failed .to.be.greaterThanOrEqual(x, "why") prints the bare message on its own line
    # -- so a shape-matching filter drops exactly the sentence that says which assertion
    # fired. Rather than chase message shapes, keep a fixed window of lines after each
    # "N)" failure header, which captures the title and the message whatever their form.
    FAILURE_CONTEXT_LINES = 8
    header = re.compile(r"\s+\d+\)\s")

    printed = False
    remaining = 0
    for line in out.splitlines():
        if header.match(line) is not None:
            remaining = FAILURE_CONTEXT_LINES
        if remaining > 0:
            remaining -= 1
            if line.strip() or remaining == FAILURE_CONTEXT_LINES - 1:
                say(line)
                printed = True
                continue
        if keep(line):
            say(line)
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
