# -*- coding: utf-8 -*-
"""The mutation lease.

A red-proof mutates contracts/ on disk. If the run is killed before its restore, the
mutation stays in the working tree -- this has happened. The bad outcome is not a lost
hour, it is a mutation surviving into a commit unnoticed.

The pre-commit hook used to grep the staged diff for markers the mutation tools write.
That only catches mutations that ANNOUNCE themselves: a hand-edited one carries no marker
and passes, and a green hook then gets read as a clean tree. Worse, the mutation class
that motivated the guard -- a cross-curve steal that ADDS lines and removes no guard --
carries no marker and removes no `revert`, so no content rule sees it at all.

So the lease checks STATE, not content. Every mutation path takes it before touching
contracts/ and releases it in the same path that restores. The hook refuses ANY commit
while it exists. A killed run leaves the lease behind, which fails closed: the next commit
is refused until a human confirms the tree matches HEAD and removes it.

The lease is gitignored, so it can never itself be committed.
"""
import io
import json
import os
import time

LEASE = ".mutation-lease"


class LeaseHeld(Exception):
    pass


def acquire(tool, detail=""):
    """Take the lease. Raises LeaseHeld if one already exists -- never steal it, because
    an existing lease may mean another run is live OR that a killed one left a mutation
    on disk, and those must not be silently merged."""
    if os.path.exists(LEASE):
        try:
            existing = io.open(LEASE, encoding="utf-8").read()
        except Exception:
            existing = "(unreadable)"
        raise LeaseHeld(
            "%s already exists -- another mutation run is live, or one was killed and "
            "left a mutation on disk.\n\nExisting lease:\n%s\n"
            "Verify the tree first:\n"
            "    git diff --stat contracts/\n"
            "    git checkout -- contracts/    # if it differs from HEAD\n"
            "Then:  rm %s" % (LEASE, existing, LEASE)
        )
    io.open(LEASE, "w", encoding="utf-8", newline="\n").write(
        json.dumps(
            {
                "tool": tool,
                "detail": detail,
                "pid": os.getpid(),
                "started": time.strftime("%Y-%m-%d %H:%M:%S"),
            },
            indent=2,
        )
        + "\n"
    )


def release():
    """Always safe to call, including when no lease is held."""
    try:
        os.remove(LEASE)
    except OSError:
        pass
