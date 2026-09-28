# Load test

Harness: `scripts/load-test.mjs` (zero dependencies, uses `fetch`).
It measures `/health` (liveness, no DB) and optionally authenticated reads when
`TOKEN` is set.

```sh
# baseline, no services required (API must be running):
npm run load:test
# custom:
node scripts/load-test.mjs --base-url http://127.0.0.1:3000 --requests 1000 --concurrency 50
# with auth (exercises /player/me + /leaderboard through rate limiters):
TOKEN=<accessToken> npm run load:test
```

## How to record results

1. `npm run services:up && npm run db:migrate && npm start` (terminal 1)
2. `npm run worker` (terminal 2)
3. `npm run load:test` (terminal 3), paste the output below.

## Results

| Date | Endpoint mix | Requests | Concurrency | p50 (ms) | p95 (ms) | rps | Errors |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 2026-09-28 | `/health` (liveness, DB/Redis down) | 200 | 20 | 14.8 | 35.1 | 875 | 0 |
| 2026-09-28 | `/health` (services up, worker running) | 300 | 20 | 11.6 | 27.9 | 1189 | 0 |
| _pending_ | `/health` + auth reads (TOKEN set) | | | | | | |

Rate-limit check 2026-09-28: 310x `GET /player/me` unauthenticated → 299x 401
then 429 `rate_limited` with `Retry-After` (limit 300/min). Verified working.

Rate limits to expect under load: `/player` and `/leaderboard` allow 300/min per
player; excess returns 429 `rate_limited` with `Retry-After`. That is working as
designed — report 429 counts separately from 5xx.
