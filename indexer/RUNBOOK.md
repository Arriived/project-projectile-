# Indexer / database runbook

The repo had no runbook. This is the minimum one: how to stand a database up, and how to
tell whether it actually works. It lives here rather than in `docs/` because it is read
next to `migrations/`, which is what it operates on.

## Bring up a fresh database

1. **Apply the schema.** Supabase → SQL Editor → New query → paste
   `migrations/APPLY-ALL.sql` → Run.

   ⚠ `APPLY-ALL.sql` is **generated**. Do not hand-edit it — regenerate with
   `node indexer/scripts/gen-apply-all.js`. It was hand-maintained once and drifted into
   missing twelve objects, including every base table and all of migration 004.

   ⚠ DDL needs SQL-editor or superuser rights. **The service-role key cannot do this** —
   it is a PostgREST credential, and PostgREST exposes no SQL-execution endpoint.

2. **Verify the objects exist.** Paste `migrations/VERIFY-SCHEMA.sql` → Run.
   Every row must show `ok = true`. False rows sort to the top.

3. **Verify the ANON role can actually read.** This is a separate step and it is not
   optional:

   ```
   SUPABASE_URL=... SUPABASE_ANON_KEY=... node indexer/scripts/verify-anon-access.js
   ```

   Expect **11/11**.

   ⚠ **Why step 2 is not enough.** `tokens_with_volume` is `SECURITY INVOKER`, so the
   caller needs its own SELECT rights. Without them the view returns **zero rows and no
   error** — the site shows an empty token list and nothing looks broken. That is also
   exactly what launch day legitimately looks like, so the two are indistinguishable by
   eye. The **service-role key cannot detect this**: it bypasses RLS and returns rows
   either way. Only the anon key can.

4. **Set the checkpoint.** `indexer_state.last_processed_block` must be **one below** the
   factory's deploy block, so the deploy block itself is scanned.

   ⚠ The checkpoint is per-factory and is **not** reset by a redeploy. Left alone after a
   factory change, the indexer replays millions of blocks of a dead contract, indexes
   nothing, and reports no error.

## After any migration

Run steps 2 and 3 again. Then confirm the applied-state record:

```sql
SELECT version, applied_at FROM public.schema_migrations ORDER BY version;
```

Every numbered migration stamps its own row (guarded with `to_regclass`, so a file can be
applied before `005` exists without failing).

## Is the indexer alive?

Liveness is **head-relative**, never wall-clock:

| chain head | checkpoint | verdict |
|---|---|---|
| moving | moving | healthy |
| still | still | quiet chain — fine |
| **moving** | **still** | **silently dead** |

On a timer, rows 2 and 3 are identical. Against the head they are opposites. Compare
`indexer_state.last_processed_block` against `eth_blockNumber` before believing any claim
about indexer health.

⚠ **Check nothing else is already running it.** Two instances fight over the checkpoint
and drive it backwards; `saveCheckpoint` refuses to lower it, which makes concurrent
instances merely wasteful rather than corrupting, but progress stalls with no obvious cause.

## Rolling back

Rollbacks live in `migrations/rollbacks/`, **not** alongside the numbered files.

⚠ They were moved there because `003_ROLLBACK.sql` sorted **before**
`003_list_page_columns.sql` (`R` = 0x52 < `l` = 0x6C), so anyone applying "everything in
this directory in order" ran the rollback first.

Read the header of the rollback before running it: for 003 the dangerous half is not the
DROP but the re-`GRANT` — a recreated view without its grant is the silent-empty-list
failure again, in the other direction.

## Hosting on Fly.io

Config lives in `indexer/fly.toml`; the image is built from `indexer/Dockerfile`. Read
both before the first deploy — the comments explain which Fly defaults are wrong for a
stateful poller and why.

### Secrets

Set these before the first deploy. **Names only here; values never enter the repo, the
image, or this file.**

```
fly secrets set SUPABASE_URL=...
fly secrets set SUPABASE_SERVICE_ROLE_KEY=...
fly secrets set FACTORY_RPC_URL=...
fly secrets set FACTORY_ADDRESS=...
fly secrets set FACTORY_DEPLOY_BLOCK=...
fly secrets set HEARTBEAT_URL=...          # optional — omit and no heartbeat is sent
```

⚠ **All five of the first group are validated at startup and the process exits if any is
missing.** `FACTORY_DEPLOY_BLOCK` was added to that validation in this change: it was
destructured but never checked, so a missing value fell through silently and the indexer
started from the wrong block. On a laptop with a populated `.env` that never bit; on a
fresh host with secrets set one at a time it is exactly what happens.

⚠ `SUPABASE_SERVICE_ROLE_KEY` bypasses RLS. It is the only credential here that can write.

### Deploy

```
fly deploy --config indexer/fly.toml --dockerfile indexer/Dockerfile
```

⚠ **`strategy = "immediate"` is not a preference.** It stops the old machine before
starting the new one. Fly's default rolling deploy briefly runs two indexers, and two
indexers is a bug this project has already observed: each catches up from its own start
point and writes its own cursor, so the slower one overwrites the faster and the checkpoint
goes backwards (`59782875` written, then `59776875` over it). `saveCheckpoint` is monotonic
so nothing corrupts, but progress stalls with no obvious cause. Do not let `fly launch`
rewrite this out.

### Is it alive? (after deploying)

Run all three. They answer different questions and the first two can both pass while the
indexer is dead.

```
fly status                    # is a machine running at all
fly logs                      # is it saying anything
curl -sS https://<app>.fly.dev/health | jq
```

⚠ **Only the third can detect the failure this service is defended against.** The 29-hour
outage was a process that never crashed: `fly status` would have shown a healthy machine
and `fly logs` would have shown nothing wrong. `/health` compares the checkpoint against
the chain head, which is the only signal that separates a quiet chain from a dead indexer.

A healthy response is `200` and looks like:

```json
{
  "healthy": true,
  "reason": "checkpoint is keeping up with the chain head",
  "head": 60266785,
  "checkpoint": 60266783,
  "lagBlocks": 2,
  "lagSecondsApprox": 1,
  "thresholdBlocks": 1000,
  "thresholdSecondsApprox": 480
}
```

An unhealthy one is `503` and names the condition in words. **`lagBlocks` is the number to
read**; `lagSecondsApprox` is the same figure rendered at Arc's ~0.48s block time so it
means something at a glance.

⚠ **`/health` reports unhealthy during historical backfill, and it is right to** — the
checkpoint genuinely is far behind. `fly.toml` sets a 30-minute `grace_period` for this.
If a first deploy has a long backfill ahead of it, **widen the grace period; never raise
`MAX_HEAD_LAG_BLOCKS`.** Loosening the threshold to survive one afternoon blinds the check
permanently.

### Reading the logs

```
fly logs                      # live
fly logs --no-tail | tail -200
```

Worth grepping for:

| pattern | meaning |
|---|---|
| `⚠ LIVENESS` | the checkpoint is falling behind; a strike has been recorded |
| `❌ FATAL` | three consecutive liveness strikes — the process exited on purpose |
| `⚠ heartbeat SUPPRESSED` | unhealthy, so the ping was deliberately withheld |
| `Missing required env var` | a secret is unset; the process exited at startup |
| `Health endpoint on :` | the endpoint bound successfully |

### Verify only ONE instance is running

```
fly status
fly machines list
fly scale count 1
```

⚠ **Do this after every deploy.** `fly.toml` pins one machine in three places
(`auto_stop_machines`, `auto_start_machines`, `min_machines_count`) and Fly will not create
a second on its own — but a deploy against an app that already has two keeps two, and the
symptom is a stalled checkpoint rather than an error. `fly machines list` showing more than
one row is the whole diagnosis.

### Roll back

```
fly releases
fly deploy --image <previous-image-ref>
```

Or `fly releases rollback` if the previous release is intact. The checkpoint lives in the
database, not the machine, so a rollback resumes from wherever the newer version reached —
there is no state on the machine to lose. ⚠ A rollback is still a deploy: it obeys
`strategy = "immediate"`, and you should re-run the one-instance check afterwards.

### The heartbeat, and why silence is the alarm

If `HEARTBEAT_URL` is set, the indexer pings it every 60s **only while healthy**, carrying
the lag as both a query parameter and a JSON body. When lag exceeds the threshold it
**stops pinging** so a dead-man's switch fires.

⚠ **Do not "improve" this into pinging with `healthy: false`.** That relies on the
receiving service parsing a body and being configured to alert on its contents — a second
place for the alarm to be misconfigured, and it fails open: a receiver that ignores the
body sees a cheerful ping and reports everything fine. Silence needs no parsing and fails
closed.

⚠ **Do not alert on ping absence alone either.** The ping carries the lag precisely so a
dashboard can show it climbing before silence starts. A monitor that only knows "did it
ping" is the wall-clock failure moved up one layer — a process 29 hours behind pings
cheerfully forever.

If `HEARTBEAT_URL` is unset the indexer runs normally and logs that once. Monitoring must
never be able to prevent the service from starting.
