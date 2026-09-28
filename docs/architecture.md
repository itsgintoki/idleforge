# Architecture

IdleForge is a TypeScript + Express API with PostgreSQL as the source of truth,
Redis + BullMQ for world-event delivery, and a Redis Sorted Set leaderboard projection.

```text
client -> API (dist/server.js) -> PostgreSQL (economy, idempotency, occurrences)
client -> API -> Redis (leaderboard projection, BullMQ queue)
scheduler (dist/scheduler.js) -> Redis (hourly job schedule, then exits)
worker (dist/worker.js) -> PostgreSQL + Redis (applies bonuses, reconciles leaderboard)
```

## Processes

- `src/server.ts`: HTTP API only. Never processes BullMQ jobs. Commits to
  PostgreSQL first, then updates the leaderboard projection (`syncPlayerLeaderboard`).
- `src/worker.ts`: BullMQ worker + leaderboard reconciler. Runs `applyGoldBonus`
  in a transaction, then refreshes the leaderboard. Retries with exponential backoff.
- `src/scheduler.ts`: registers the `hourly-gold-bonus-v1` schedule and exits.
- `src/leaderboard/rebuild.ts`: manual `reconcileLeaderboard` CLI (`npm run leaderboard:rebuild`).

## Request path

`app.ts` wires, in order: `X-Request-ID` handling (`observability.ts`),
structured request logging, 16 KB JSON limit, liveness (`/health`), readiness
(`/ready`), then rate-limited routers (`rate-limit.ts`):

- `/auth` — 100 req / 15 min per IP
- `/player` — 300 req / min per player (or IP when anonymous)
- `/leaderboard` — 300 req / min per player
- `/admin/world-events` — 60 req / min per player, plus DB admin recheck

Every log line is JSON with `time`, `level`, `event`, and `requestId` when inside
an HTTP request. `X-Request-ID` is echoed back; clients may send their own.

## Data ownership

- PostgreSQL: balances, lifetime earnings, buildings, purchase commands,
  world-event occurrences. All money math is `numeric(30,6)` strings in TS.
- Redis: BullMQ delivery state + leaderboard Sorted Set. Both are projections;
  loss is recoverable via PostgreSQL replay/reconciliation.
- Leaderboard pipeline: `lifetimeGoldEarned -> millionths integer -> ZADD GT ->
  staging set -> Lua RENAME publish -> ranked reads`. Marker `:ready` expires 90 s
  after the DB read starts.

See `invariants.md` for guarantees and `failures.md` for outage behaviour.
