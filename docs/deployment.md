# Deployment (GitHub-only scope)

There is no managed production deploy in this phase. GitHub is the delivery
surface; local Docker Compose is the reproducible runtime.

## What CI does

`.github/workflows/ci.yml` runs on push/PR:

- `npm ci` + `npm run verify` (strict typecheck + build)
- boots PostgreSQL 18.6 + Redis 8.10.1 as service containers
- builds the Docker image
- reserves a step for `npm test` once the revision-phase suite exists

## Run it locally (prod-like)

```sh
npm run services:up
npm run db:migrate
npm run build
docker compose up --build api worker
# scheduler is one-shot:
docker compose run --rm scheduler
```

`compose.yaml` defines `api` (port 3000), `worker`, and `scheduler` from the same
`Dockerfile`. The image defaults to `node dist/server.js`; worker/scheduler
override the command. `.env` supplies `JWT_SECRET`; compose overrides
`DATABASE_URL`/`REDIS_URL` to service hostnames inside containers.

## Promoting to hosted deploy later

- Build + push the image, set `DATABASE_URL`, `REDIS_URL`, `QUEUE_PREFIX`,
  `JWT_SECRET` (min 64 chars) in the host environment.
- Run migrations (`npm run db:migrate`) before starting `api`/`worker`.
- Run the scheduler once per deploy to upsert the hourly schedule.
- Expose `/health` for liveness and `/ready` for readiness probes.
