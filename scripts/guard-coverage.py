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
    one mutation behind, and the next start self-heals before doing anything.
"""
import atexit
import io
import json
import os
import re
import signal
import subprocess
import sys

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
    if not is_clean():
        print("!! %s was dirty at start (previous run killed mid-mutation). Restoring."
              % SRC, flush=True)
        restore()
        if not is_clean():
            sys.exit("refusing to run: %s still differs from HEAD" % SRC)

    atexit.register(restore)
    for sig in (signal.SIGINT, signal.SIGTERM):
        signal.signal(sig, lambda *_: (restore(), sys.exit(130)))

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
        restore()
        run("npx hardhat compile")
        print("RESTORED, clean=%s" % is_clean(), flush=True)


main()
