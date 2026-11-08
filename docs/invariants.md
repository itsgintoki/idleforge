# Invariants

These are the guarantees the retained Vitest suite proves against real
PostgreSQL and Redis. Each maps to code and to a test file under `tests/`.

## Collection — `tests/integration/collect.test.ts`

- One SQL statement: `SELECT ... FOR UPDATE`, sample clock, exact arithmetic,
  update balance + lifetime + checkpoint, and insert the ledger entry together
  (`src/players/collect.ts`).
- Checkpoint never moves backwards; future checkpoints credit zero.
- Seconds clamped to `[0, 28800]` (8 h cap); credit is `trunc(seconds * rate, 6)`.
- Concurrent collects serialize on the row lock; the waiter reads the committed
  checkpoint and cannot re-earn the interval.

## Purchases — `tests/integration/purchase.test.ts`

- `purchase_commands(player_id, idempotency_key)` PK reserves the command and its
  result in the same transaction (`src/players/purchase.ts`).
- Concurrent identical keys execute exactly once; every response is the saved
  result.
- Same key + different building returns 409 `idempotency_key_reused`.
- Guarded balance deduction prevents negative gold; spending never reduces
  lifetime earnings; settlement uses the old rate before the rate increase.
- Expected domain failures are persisted and replayed; a new key is required to
  retry after state changes.

## World events — `tests/integration/world-events.test.ts`

- `world_events.occurrence_id` PK is the final duplicate-award guard
  (`src/world-events/service.ts`).
- Manual IDs are `manual-<uuid>`. Scheduled IDs are derived from the UTC hour:
  `scheduled-<sha256(schedulerId + ":" + hour)>`.
- Duplicate delivery replays the persisted outcome without extra gold.
- A scheduled run is guarded by a row-level advisory lock keyed by the hour. Any
  applied `scheduled-*` row in that hour (including legacy job-id-derived rows)
  wins and the new run replays it.
- Application is batched by `player_id` keyset. `last_player_id` and the
  cumulative `players_rewarded` commit with each batch; a failed run resumes from
  the cursor without re-crediting committed batches.
- The worker supervisor applies the current UTC hour even when Redis and the
  BullMQ cron are unavailable.
- Manual intents are durable in `event_outbox` before enqueue. The admin endpoint
  returns 202 after the Postgres commit, even if Redis is down.
- The reconciler drains outbox rows whose dispatch lease is older than 5 minutes,
  and marks settled rows complete from `world_events`.
- Invalid jobs fail with `UnrecoverableError` (no retry); valid jobs get 5 attempts
  with 1/2/4/8 s backoff. Failed jobs stay in Redis; see
  `GET /admin/world-events/jobs/failed?limit=20`.

## Leaderboard — `tests/integration/leaderboard.test.ts`

- PostgreSQL is authoritative; Redis is an absolute-value projection.
- The ranking ZSET stores `Number(exactGold)`; the exact six-decimal string lives
  in a companion Redis hash.
- Per-player sync runs in Lua: it compares exact strings and only advances both
  structures, so delayed smaller totals are ignored and the two structures never
  disagree.
- Full reconciliation reads PostgreSQL in keyset pages, streams batches into
  staging ZSET + HASH, then atomically publishes both via Lua. Memory is
  O(batch), not O(players).
- Missing, stale, incomplete, or inconsistent projections return 503
  `leaderboard_unavailable`.
- Ranks start at 1, descending; ties get distinct positions by member order.
- There is no nine-billion cap. Displayed totals remain exact across the full
  `numeric(30,6)` range; ordering above 2^53 gold degrades to float64 precision
  and ties are broken by player ID.

## Authentication — `tests/unit/tokens.test.ts`, `tests/integration/auth.test.ts`

- Access tokens are HS256 with issuer/audience/claims validation and a 15-minute
  expiry (`src/auth/tokens.ts`).
- Refresh tokens are opaque 32-byte values stored only as SHA-256 hashes.
- Rotation revokes the presented token and issues a replacement in the same
  family. Presenting a revoked token revokes the entire family.
- Logout revokes the family; expired and unknown tokens return 401
  `invalid_refresh_token`.

## Ledger — `tests/integration/ledger.test.ts`

- Every balance mutation inserts an append-only `ledger_entries` row in the same
  transaction.
- `SUM(amount) = player_resources.gold` for every player, excluding the
  lifetime-baseline row.
- `SUM(positive non-baseline amounts) + lifetime baseline =
  lifetime_gold_earned`.
- Migration baselines (`migration:ledger-baseline`,
  `migration:lifetime-baseline`) are the only opening balances.
- `npm run ledger:verify` exits non-zero on any mismatch.

## Retention — `tests/integration/retention.test.ts`

- `purchase_commands` older than the configured window are deleted in batches;
  newer rows survive.
- Applied `world_events` rows are never deleted.
- Stale zero-progress reservations are deleted; progress-carrying rows survive.
- Only one retention run proceeds at a time (advisory lock).

## Operations — `tests/http/contract.test.ts`, `tests/integration/rate-limit.test.ts`,
`tests/integration/metrics.test.ts`, `tests/unit/config.test.ts`

- `/health` is liveness only; `/ready` requires both PostgreSQL (`SELECT 1`) and
  Redis (`PING`) to succeed. The worker exposes the same endpoints.
- Rate limits are Redis fixed windows shared across API replicas, keyed by player
  after authentication (IP for `/auth`). 429 responses carry `Retry-After`.
- A rate-limit Redis outage fails open and is logged/counted.
- Every HTTP response carries `X-Request-ID`; logs carry the same ID.
- `/metrics` exposes HTTP latency/counts, pool gauges, BullMQ job counts, outbox
  pending count, bonus and leaderboard durations, and default process metrics.
- OpenTelemetry tracing initializes only when `OTEL_EXPORTER_OTLP_ENDPOINT` is
  set.
