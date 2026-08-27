# -*- coding: utf-8 -*-
"""Ground-truth guard coverage.

Disables each `if (!(...)) revert X();` in contracts/LFX1.sol one at a time and runs the
full Hardhat suite. A guard that no test notices being switched off is a guard nothing
covers. This is ground truth rather than a heuristic: it does not care how a test is
written or which helper it calls through.

Rebuilt after the first version produced results that were wrong in BOTH directions:

  * When a test run produced no parseable output, the regex found no "N failing" and
    the site was recorded as UNDETECTED -- a false negative that survived until it was
    checked by hand. Unparseable output is now an explicit INCONCLUSIVE state and is
    never silently read as zero failures.
  * 29 of 54 sites reported phantom COMPILE_FAIL from OneDrive contending on
    artifacts/. The repo has moved off OneDrive; a compile failure here is now a real
    signal, and is retried once before being believed.
  * Windows cp1252 could not decode hardhat's check marks and killed the run outright.
    All subprocess IO is explicitly UTF-8 with errors="replace".
  * The run was stopped externally and left a disabled guard sitting in the working
    tree, which could have poisoned every result after it. The source is now restored
    from git after EVERY site, on signals, and via atexit -- so a kill leaves at most
    one mutation behind. It also took the mutation lease, so a leftover blocks commits
    until a human clears it.
  * That self-heal used to RESTORE a dirty SRC at start. It now refuses and prints the
    diff. The tool cannot distinguish a killed run leftover from real uncommitted work,
    and discarding the latter is unrecoverable.
"""
import atexit
import io
import json
import os
import re
import signal
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import mutation_lease  # noqa: E402

SRC = "contracts/LFX1.sol"
OUT = os.environ.get("GUARD_OUT", "guard-coverage.jsonl")


def run(cmd):
    p = subprocess.run(cmd, capture_output=True, shell=True,
                       encoding="utf-8", errors="replace")
    return p.returncode, (p.stdout or "") + (p.stderr or "")


def restore():
    """Always safe to call. The file is expected to equal HEAD at rest."""
    subprocess.run(["git", "checkout", "--", SRC], shell=True,
                   capture_output=True, encoding="utf-8", errors="replace")


def cleanup():
    """Restore AND release the lease. Every exit path goes through this: a lease left
    behind is a commit refused, which is the fail-closed direction but still needs
    clearing by hand."""
    restore()
    mutation_lease.release()


def is_clean():
    rc, _ = run('git diff --quiet -- "%s"' % SRC)
    return rc == 0


def parse_result(out):
    """(status, failing). Never infers zero failures from unreadable output."""
    passing = re.search(r"(\d+) passing", out)
    failing = re.search(r"(\d+) failing", out)
    if not passing and not failing:
        return "INCONCLUSIVE", None
    return ("DETECTED", int(failing.group(1))) if failing else ("UNDETECTED", 0)


def main():
    # REFUSE on dirty; never auto-restore. This used to self-heal by discarding whatever
    # it found, on the assumption that a dirty SRC could only be a killed run's leftover
    # mutation. It cannot tell that from real uncommitted work, and discarding the latter
    # is unrecoverable -- the sibling tool did exactly that to an unstaged fix. Least of
    # all should the freeze gate do it silently.
    if not is_clean():
        _, diff = run('git diff --stat -- "%s"' % SRC)
        sys.exit(
            "refusing to run: %s has uncommitted changes.\n\n%s\n"
            "If this is a killed run's leftover mutation, discard it:\n"
            "    git checkout -- %s\n"
            "If it is real work, commit or stash it first -- a guard sweep restores from\n"
            "git after every site and would destroy it." % (SRC, diff.strip(), SRC)
        )

    try:
        mutation_lease.acquire("guard-coverage.py", "full guard sweep over " + SRC)
    except mutation_lease.LeaseHeld as e:
        sys.exit(str(e))

    atexit.register(cleanup)
    for sig in (signal.SIGINT, signal.SIGTERM):
        signal.signal(sig, lambda *_: (cleanup(), sys.exit(130)))

    orig = io.open(SRC, encoding="utf-8").read()
    lines = orig.split("\n")

    fn_of, cur = {}, None
    for i, l in enumerate(lines):
        m = re.match(r"\s*function\s+(\w+)\s*\(", l)
        if m:
            cur = m.group(1)
        fn_of[i] = cur

    sites = [{"line": i + 1, "fn": fn_of.get(i), "err": m.group(1)}
             for i, l in enumerate(lines)
             for m in [re.search(r"if \(!\(.*\)\) revert (\w+)\(", l)] if m]

    done = 0
    if os.path.exists(OUT):
        done = sum(1 for _ in io.open(OUT, encoding="utf-8"))
        print("resuming: %d sites already recorded" % done, flush=True)

    print("guard sites: %d" % len(sites), flush=True)
    fh = io.open(OUT, "a", encoding="utf-8")
    try:
        for n, s in enumerate(sites, 1):
            if n <= done:
                continue
            mut = list(lines)
            mut[s["line"] - 1] = re.sub(r"if \(!\(.*\)\) revert", "if (false) revert",
                                        mut[s["line"] - 1], count=1)
            io.open(SRC, "w", encoding="utf-8", newline="\n").write("\n".join(mut))

            rc, cout = run("npx hardhat compile")
            if rc != 0:
                rc, cout = run("npx hardhat compile")   # retry once before believing it
            if rc != 0:
                s["result"] = "COMPILE_FAIL"
                s["detail"] = cout.strip().splitlines()[-1][:200] if cout.strip() else ""
            else:
                _, tout = run("npx hardhat test")
                s["result"], s["failing"] = parse_result(tout)
                if s["result"] == "INCONCLUSIVE":
                    s["detail"] = tout.strip()[-200:]

            restore()
            fh.write(json.dumps(s) + "\n")
            fh.flush()
            print("%2d/%d  L%-5d %-28s %-26s %s"
                  % (n, len(sites), s["line"], s["fn"], s["err"], s["result"]), flush=True)
    finally:
        fh.close()
        cleanup()
        run("npx hardhat compile")
        print("RESTORED, clean=%s, lease released=%s"
              % (is_clean(), not os.path.exists(mutation_lease.LEASE)), flush=True)


main()
