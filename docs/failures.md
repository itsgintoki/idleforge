# Failure behaviour

## PostgreSQL outage

- Economy writes (`signup`, `collect`, `purchase`, `GET /player/me`) return 500
  `internal_error`; no partial writes (transactions roll back).
- Leaderboard serves the last Redis snapshot until its 90 s marker expires, then
  returns 503 `leaderboard_unavailable` (`src/leaderboard/store.ts`).
- Worker bonus attempts fail, log `bonus_application_failed`, and retry with
  backoff; duplicates after recovery replay instead of double-crediting.
- `/ready` returns 503 `{ status: "not_ready", checks: { db: false, ... } }`;
  `/health` still returns 200 (liveness only).

## Redis outage

- DB-backed routes keep working. Reads/writes to PostgreSQL are unaffected.
- `POST /admin/world-events/gold-bonus` returns 503 `queue_unavailable`; retry
  with the same occurrence UUID after recovery.
- Leaderboard reads return 503 `leaderboard_unavailable`; per-player sync logs
  `leaderboard_player_sync_failed` without changing the committed command.
- Producer uses `maxRetriesPerRequest: 1`, `enableOfflineQueue: false`, 5 s
  `waitUntilReady` timeout (`src/world-events/queue.ts`). Leaderboard uses 2 s
  timeouts (`src/leaderboard/client.ts`). Workers reconnect and resume.
- Failed-job inspection also returns 503 while Redis is down.

## Retry exhaustion

- After 5 attempts the job stays in the failed set with a sanitized
  `failedReason` (no SQL/secrets). Inspect:
  `GET /admin/world-events/jobs/failed?limit=20` (admin token required).
- Re-enqueue with the same occurrence ID after fixing the cause; PostgreSQL
  replay returns the outcome if it already applied.

## Shutdown

- API: `SIGINT/SIGTERM` stops accepting, drains, closes Redis + pool
  (`src/server.ts`). Worker: waits for the active job and refresh before closing
  (`src/worker.ts`). Both log `*_stopped` / `*_shutdown_failed`.
