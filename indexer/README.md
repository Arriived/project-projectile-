# Arc Launch — indexer

Watches `TokenCreated`, `Trade`, `GraduationReady`, and `Graduated` events from the
deployed `Ballista` contract (formerly `ArcLaunchFactory`) and keeps the Supabase
`tokens`/`trades` tables in sync.

## Migrations

`migrations/` holds schema changes, applied in filename order. Run them against
Supabase yourself before starting the indexer against a new contract version --
nothing here applies them automatically.

- `001_add_token_state.sql` — adds `tokens.state`, required by any build that
  indexes Ballista. Ballista replaced the `graduated` bool with a three-state enum,
  and a token that has finished its curve but not yet reached a DEX has no correct
  boolean value. Without this column that state renders as an ordinary tradeable
  token and users hit an unexplained revert. The old boolean is kept and kept in
  sync by a trigger, so existing readers keep working.

## What's verified vs. what isn't

I can confirm from this environment: all files are syntactically valid, all
dependencies (`ethers`, `@supabase/supabase-js`, `dotenv`) install and `require()`
cleanly, and the script fails with a clear, intentional error message when
configuration is missing rather than crashing confusingly.

What I could **not** verify from here: actual behavior against your real Supabase
project or a live Arc RPC endpoint — this sandbox's network access doesn't reach
`supabase.co` or Arc's RPC domains, same restriction that blocked Hardhat's compiler
download earlier. You'll be the first one to actually see this run against real
infrastructure. Watch the console output closely the first time — it logs every
event it processes (`[TokenCreated]`, `[Trade]`, `[Graduated]`) and every failure with
the specific address involved, so problems should be easy to spot rather than silent.

## Setup

```
cd indexer
npm install
cp .env.example .env
```

Fill in `.env`:
- `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` — same values from the database setup
  step. This uses the service_role key deliberately (not the anon key) — it needs to
  write to tables, and Row Level Security is enabled on `tokens`/`trades`, so the
  anon key wouldn't have write access even if you tried.
- `FACTORY_RPC_URL` — an Arc testnet RPC endpoint. A `wss://` (websocket) URL is
  better than `https://` if you have one — events arrive in real time instead of only
  being caught on the next poll (default 4-second interval for the http fallback).
- `FACTORY_ADDRESS` / `FACTORY_DEPLOY_BLOCK` — filled in once the contract is actually
  deployed to testnet. Nothing meaningful happens without this — next concrete step
  after this is the deployment script.

Run it:
```
npm start
```

## How it behaves

- **On startup**, it reads `indexer_state` for the last block it successfully
  processed and catches up from there in bounded chunks (2000 blocks at a time by
  default — tune `CHUNK_SIZE` in `src/index.js` if Arc's RPC provider has a different
  limit). If `indexer_state` is empty (first run ever), it starts from
  `FACTORY_DEPLOY_BLOCK` instead of scanning from block zero.
- **Idempotent by design**: token upserts are keyed to `contract_address`, so
  reprocessing a block range twice (e.g. after a crash before a checkpoint saved)
  overwrites with the same data rather than duplicating rows. Trades are checked
  against `tx_hash` before inserting, for the same reason.
- **Metadata fetch failures never block indexing.** If a token's `metadataURI` is
  unreachable or returns malformed JSON, the on-chain data still gets indexed — the
  description/logo fields just stay null. On-chain state is the source of truth;
  off-chain metadata is a nice-to-have layered on top, not a dependency.
- **Metadata is sanitized before it touches the database**: HTML tags stripped,
  length-bounded, and logo URLs restricted to `http(s)://` or `ipfs://` — rejecting
  anything like a `javascript:` URI. This is a second layer of defense; React/Next.js
  already auto-escapes text at render time, but bad data shouldn't reach the database
  in the first place if avoidable.
- **After catching up, it switches to live mode** — subscribing to new events going
  forward rather than re-polling from scratch.

## Known gap, flagged deliberately

If the indexer process itself crashes and restarts *between* processing a live event
and the next block-based checkpoint save, there's a small window where an event could
be reprocessed (handled fine — see idempotency above) but not one where an event is
silently lost, since checkpointing always happens after the corresponding data is
already written. Worth stress-testing this with a deliberate `Ctrl+C` mid-run once
you're pointed at real testnet data, to confirm it resumes correctly rather than
taking my word for it.
