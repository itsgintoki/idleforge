# Invariants

These are the guarantees revision-phase tests must prove. Each maps to code.

## Collection

- One SQL statement: `SELECT ... FOR UPDATE`, sample clock, exact arithmetic,
  update balance + lifetime + checkpoint together (`src/players/collect.ts`).
- Checkpoint never moves backwards; future checkpoints credit zero.
- Seconds clamped to `[0, 28800]` (8 h cap); credit is `trunc(seconds * rate, 6)`.
- Concurrent collects serialize on the row lock; the waiter reads the committed
  checkpoint and cannot re-earn the interval.

## Purchases

- `purchase_commands(player_id, idempotency_key)` PK reserves the command and its
  result in the same transaction (`src/players/purchase.ts`).
- Same key + building returns the saved result without touching the economy.
- Same key + different building returns 409 `idempotency_key_reused`.
- Guarded balance deduction prevents negative gold; spending never reduces
  lifetime earnings; settlement uses the old rate before the rate increase.

## World events

- `world_events.occurrence_id` PK is the final guard (`src/world-events/service.ts`).
- Manual IDs are `manual-<uuid>`; scheduled IDs are `scheduled-<sha256(jobId)>`.
- Duplicate delivery replays the persisted outcome without extra gold.
- Invalid jobs fail with `UnrecoverableError` (no retry); valid jobs get 5 attempts
  with 1/2/4/8 s backoff. Failed jobs stay in Redis; see
  `GET /admin/world-events/jobs/failed?limit=20`.

## Leaderboard

- PostgreSQL is authoritative; Redis is an absolute-value projection.
- `ZADD GT` + post-commit sync means repeats are no-ops and delayed writes cannot
  lower a score (`src/leaderboard/store.ts`, `src/leaderboard/service.ts`).
- Full reconciliation stages a temp set then atomically publishes via Lua
  (`publishLeaderboardSnapshot`). Missing/stale/incomplete snapshots return 503.
- Ranks start at 1, descending; ties get distinct positions by member order.
- Scores above 9007199254.740991 gold invalidate the projection by design.

## Operations

- `/health` is liveness only; `/ready` requires both PostgreSQL (`SELECT 1`) and
  Redis (`PING`) to succeed.
- Rate limits return 429 `rate_limited` with `Retry-After`; auth is strictest.
- Every HTTP response carries `X-Request-ID`; logs carry the same ID.
