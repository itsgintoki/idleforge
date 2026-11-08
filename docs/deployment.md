# Deployment (Railway)

IdleForge runs as three Railway services built from one Docker image, with
managed PostgreSQL and Redis plugins.

| Service | Command | Health check | Public |
| --- | --- | --- | --- |
| `api` | `node dist/server.js` | `/ready` | yes |
| `worker` | `node dist/worker.js` | `/ready` (health server) | no |
| `scheduler` | `node dist/scheduler.js` | n/a (one-shot cron) | no |

The worker also serves `/healthz` and `/metrics`; the API serves `/metrics`.
`railway.json` sets the Dockerfile builder, the `/ready` health check, and an
on-failure restart policy.

## Variables

Set these on all three services (use Railway's variable references for the
plugins):

| Variable | Example / source | Notes |
| --- | --- | --- |
| `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` | required |
| `REDIS_URL` | `${{Redis.REDIS_URL}}` | required |
| `QUEUE_PREFIX` | `idleforge` | all services must match |
| `JWT_SECRET` | 64+ random chars | API only, but keep it consistent |
| `NODE_ENV` | `production` | |
| `METRICS_PORT` | `3000` on the worker | matches the Dockerfile's exposed port |
| `BONUS_BATCH_SIZE` | `1000` | optional |
| `PURCHASE_COMMAND_RETENTION_DAYS` | `30` | optional |
| `WORLD_EVENT_STALE_RESERVATION_HOURS` | `24` | optional |
| `REFRESH_TOKEN_TTL_DAYS` | `30` | optional |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | unset | enables tracing when set |
| `OTEL_SERVICE_NAME` | `idleforge-api` / `idleforge-worker` | optional |

Railway injects `PORT`; the API and the worker's health server both prefer it
over `METRICS_PORT`. Set `METRICS_PORT=3000` on the worker so the platform's
health check targets the same port the image exposes.

## First deployment

1. Create a Railway project and add the **Postgres** and **Redis** plugins.
2. Connect the GitHub repository. Create three services from the same repo:
   - `api`: Dockerfile builder, start command `node dist/server.js`, generate a
     public domain, health check `/ready`.
   - `worker`: same image, start command `node dist/worker.js`, no public domain,
     health check `/ready`, `METRICS_PORT=3000`.
   - `scheduler`: Railway **cron** service, schedule `0 * * * *`, command
     `node dist/scheduler.js`.
3. Add the variables above to each service and redeploy.
4. Add repository secrets for the migration workflow:
   - `DATABASE_URL`: the Postgres plugin's **public** URL (`DATABASE_PUBLIC_URL`),
     because GitHub Actions runs outside Railway's private network.
   - `JWT_SECRET`: any 64+ character value; `drizzle.config.ts` parses it even
     though migrations do not use it. Use the production value.
5. Push to `master`. CI runs typecheck, build, the Vitest suite, and the Docker
   build. Run the `migrate` workflow manually from the Actions tab after setting
   the secrets; Railway deploys the new image. The workflow is manual-only until
   you enable deploys (add the `workflow_run` trigger back to run it after CI).

The scheduler is optional: the worker's supervisor materializes and applies the
current UTC hour even if the BullMQ cron registration is lost. Keep the cron
service for the documented cadence and defense in depth. A two-service deployment
(`api` + `worker`) is fully functional.

## Deploy from the CLI

Create the project and the Postgres/Redis plugins in the dashboard first, then
use a project-scoped token:

```sh
export RAILWAY_TOKEN=<project-token>          # not an account password
railway link --project <project-id> --environment production

railway variable set --service api --skip-deploys \
  JWT_SECRET="<64+ chars>" QUEUE_PREFIX=idleforge NODE_ENV=production
railway variable set --service worker --skip-deploys \
  METRICS_PORT=3000 QUEUE_PREFIX=idleforge NODE_ENV=production
```

Set `DATABASE_URL` and `REDIS_URL` with Railway references in the dashboard
(`${{Postgres.DATABASE_URL}}`, `${{Redis.REDIS_URL}}`). Then deploy:

```sh
railway up --service api --detach
railway up --service worker --detach
```

The start command is per service, so set `node dist/worker.js` for the worker in
the service settings (the API uses the image's default `node dist/server.js`).

Run migrations from a trusted machine without exposing Postgres publicly:

```sh
railway run --service api npm run db:migrate
```

`railway run` executes locally with the service's environment, so `drizzle-kit`
is available from `node_modules`.

## Verify a deployment

```sh
curl -fsS https://<api-domain>/ready
curl -fsS https://<api-domain>/metrics | grep -E 'http_requests_total|db_pool_connections'

# Admin bonus (admin bearer token required)
curl -fsS -X POST https://<api-domain>/admin/world-events/gold-bonus \
  -H "authorization: Bearer $ADMIN_TOKEN" \
  -H "content-type: application/json" \
  -d "{\"occurrenceId\":\"$(node -e 'console.log(crypto.randomUUID())')\"}"
```

Then check that the outbox row completes and the leaderboard reflects the
bonus. Run `npm run ledger:verify` against the production `DATABASE_URL` from a
trusted machine after the first deploy.

## Redis requirements

BullMQ delivery state lives in Redis, so the plugin must use
`maxmemory-policy noeviction` and persistence enabled. Verify with:

```sh
redis-cli -u "$REDIS_URL" CONFIG GET maxmemory-policy
redis-cli -u "$REDIS_URL" CONFIG GET appendonly
```

The leaderboard projection is rebuildable (`npm run leaderboard:rebuild`). The
database outbox makes a lost Redis enqueue recoverable; the worker drains it
every 30 seconds.

## Operations

- **Scaling:** API replicas share Redis rate-limit budgets and the same
  PostgreSQL, so horizontal scaling is safe. Multiple workers are also safe:
  world-event application serializes on the `world_events` row and batches on a
  persisted cursor. Retention uses an advisory lock so only one run proceeds.
- **Migrations** are forward-only. Redeploy the previous image to roll back
  application code; write a compensating migration to roll back schema.
- **Backups:** use Railway's PostgreSQL backups, and keep the Redis volume
  snapshot if BullMQ delivery state matters for an incident.
- **Observability:** scrape `/metrics` from the API and worker. Logs are
  newline-delimited JSON with `requestId`; set `OTEL_EXPORTER_OTLP_ENDPOINT` to
  export traces.

## Local prod-like run

```sh
npm run services:up
npm run db:migrate
npm run build
docker compose up --build api worker
# scheduler is one-shot:
docker compose run --rm scheduler
```
