# Architecture

IdleForge is a TypeScript + Express API with PostgreSQL as the source of truth,
Redis + BullMQ for world-event delivery and rate limiting, and a Redis leaderboard
projection.

```text
client -> API (dist/server.js) -> PostgreSQL (economy, idempotency, outbox, ledger)
client -> API -> Redis (rate limits, leaderboard projection, BullMQ queue)
scheduler (dist/scheduler.js) -> Redis (hourly job schedule, then exits)
worker (dist/worker.js) -> PostgreSQL + Redis (outbox, bonuses, retention, leaderboard)
```

## Processes

- `src/server.ts`: HTTP API only. Never processes BullMQ jobs. Commits to
  PostgreSQL first, then updates the leaderboard projection
  (`syncPlayerLeaderboard`). Redis rate limits are fail-open. Exposes `/metrics`.
- `src/worker.ts`: BullMQ consumer plus a 30 s supervisor. The supervisor drains
  `event_outbox`, applies the current UTC hour directly from PostgreSQL, and
  updates outbox metrics. The worker also runs hourly retention (advisory-locked),
  reconciles the leaderboard, and serves `/healthz`, `/ready`, and `/metrics`.
- `src/world-events/worker.ts`: validates jobs, then calls the batched
  `applyGoldBonus`. A failed batch leaves committed batches and the cursor intact;
  the retry resumes.
- `src/scheduler.ts`: registers the `hourly-gold-bonus-v1` schedule and exits.
  The worker self-heals a missing registration, so this is a cadence optimization.
- `src/leaderboard/rebuild.ts`: manual `reconcileLeaderboard` CLI
  (`npm run leaderboard:rebuild`).
- `src/maintenance/run.ts`: manual retention CLI (`npm run retention:run`).
- `src/ledger/run.ts`: ledger invariant check (`npm run ledger:verify`).

## Request path

`app.ts` wires, in order: `X-Request-ID` handling (`observability.ts`),
structured request logging plus HTTP metrics, 16 KB JSON limit, liveness
(`/health`), readiness (`/ready`), `/metrics`, then the routers:

- `/auth` — 100 req / 15 min per IP
- `/player` — 300 req / min per authenticated player
- `/leaderboard` — 300 req / min per authenticated player
- `/admin/world-events` — 60 req / min per authenticated admin

The player/leaderboard/admin limiters mount inside their routers **after**
authentication, so the bucket key is the verified player ID. Limiters are Redis
fixed windows, shared by every API replica. If Redis is unavailable they fail
open and increment `rate_limit_degraded_total`.

Every log line is JSON with `time`, `level`, `event`, and `requestId` when inside
an HTTP request. `X-Request-ID` is echoed back; clients may send their own.

## Data ownership

- PostgreSQL: balances, lifetime earnings, buildings, purchase commands,
  world-event occurrences with batch progress, the manual-bonus outbox, hashed
  refresh tokens, and the append-only gold ledger. All money math is
  `numeric(30,6)` strings in TS.
- Redis: rate-limit windows, BullMQ delivery state, and the leaderboard
  projection (ZSET + exact-score hash + `:ready` marker). All are recoverable or
  coordination state; losing Redis never loses money.
- Leaderboard pipeline: `lifetimeGoldEarned -> float64 rank score + exact
  six-decimal hash -> staging ZSET/HASH -> Lua RENAME publish -> ranked reads`.
  Per-player synchronization is a Lua compare-and-set, so delayed smaller totals
  cannot lower either structure. The marker expires 90 s after the DB read starts.
- Ledger: every economy mutation inserts a row in the same transaction. The
  baseline rows from migrations 0009/0010 account for pre-ledger balances.

See `invariants.md` for guarantees and `failures.md` for outage behaviour.
