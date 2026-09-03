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
