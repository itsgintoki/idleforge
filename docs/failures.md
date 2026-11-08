# Failure behaviour

## PostgreSQL outage

- Economy writes (`signup`, `collect`, `purchase`, `GET /player/me`) return 500
  `internal_error`; no partial writes (transactions roll back).
- Leaderboard serves the last Redis snapshot until its 90 s marker expires, then
  returns 503 `leaderboard_unavailable` (`src/leaderboard/store.ts`).
- Worker bonus attempts fail, log `bonus_application_failed`, and retry with
  backoff. Batches that already committed keep their cursor; the retry resumes
  instead of double-crediting.
- Manual bonus intent is already durable in `event_outbox`; the admin endpoint
  does not depend on the worker being healthy.
- `/ready` returns 503 `{ status: "not_ready", checks: { db: false, ... } }`;
  `/health` still returns 200 (liveness only).

## Redis outage

- DB-backed routes keep working. Reads/writes to PostgreSQL are unaffected.
- Rate limiting **fails open**: requests pass, `rate_limit_degraded` is logged
  (at most once per 10 s per limiter), and `rate_limit_degraded_total` increments.
- `POST /admin/world-events/gold-bonus` returns **202** once the intent is
  committed to `event_outbox`; it is no longer a 503. Retrying the same UUID is
  idempotent. The worker drains the outbox as soon as Redis returns.
- Leaderboard reads return 503 `leaderboard_unavailable`; per-player sync logs
  `leaderboard_player_sync_failed` without changing the committed command.
- The worker supervisor applies the current UTC hour directly from PostgreSQL,
  so losing the BullMQ cron registration no longer silently stops the event.
  Run `npm run scheduler` only to restore the documented cron cadence.
- Producer uses `maxRetriesPerRequest: 1`, `enableOfflineQueue: false`, 5 s
  `waitUntilReady` timeout (`src/world-events/queue.ts`). Leaderboard uses 2 s
  timeouts (`src/leaderboard/client.ts`). Workers reconnect and resume.
- Failed-job inspection also returns 503 while Redis is down.

## Retry exhaustion

- After 5 attempts the job stays in the failed set with a sanitized
  `failedReason` (no SQL/secrets). Inspect:
  `GET /admin/world-events/jobs/failed?limit=20` (admin token required).
- Re-enqueue with the same occurrence ID after fixing the cause; PostgreSQL
  replay returns the outcome if it already applied, and an incomplete batched
  run resumes from `world_events.last_player_id`.
- The reconciler also re-dispatches any outbox row whose `dispatched_at` lease is
  older than 5 minutes and whose occurrence is not applied.

## Retention

- `purchase_commands` older than `PURCHASE_COMMAND_RETENTION_DAYS` (default 30)
  are deleted in batches. Idempotency protection is therefore a 30-day window;
  a key older than that can execute again.
- Applied `world_events` rows are kept forever because they are the final
  duplicate-award guard.
- Only zero-progress reservations (`applied_at IS NULL`, `players_rewarded = 0`)
  older than `WORLD_EVENT_STALE_RESERVATION_HOURS` are reaped, so an in-progress
  batched run is never deleted.
- Retention uses a PostgreSQL advisory lock; concurrent workers skip the run.

## Ledger mismatch

- Every economy mutation inserts an append-only `ledger_entries` row in the same
  transaction as the balance change.
- `npm run ledger:verify` checks `SUM(ledger.amount) = gold` and
  `SUM(positive non-baseline) + lifetime baseline = lifetime_gold_earned`.
- A mismatch means a bug or manual database edit. The application does not
  repair balances automatically; investigate before changing data.
- The baseline rows created by migrations 0009/0010 are the only non-audited
  opening balances. Do not delete them.

## Shutdown

- API: `SIGINT/SIGTERM` stops accepting, drains, closes Redis + pool
  (`src/server.ts`).
- Worker: waits for the active job, supervisor drain, retention run, and
  leaderboard refresh, closes the health server, then closes Redis + pool
  (`src/worker.ts`).
- Both log `*_stopped` / `*_shutdown_failed`.
