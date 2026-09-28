# Demo surface

## Automated demo

`scripts/demo.mjs` exercises the full economy against a local API:

```sh
npm run services:up
npm run db:migrate
npm start        # terminal 1
npm run worker   # terminal 2
npm run demo     # terminal 3 (BASE_URL=http://127.0.0.1:3000 by default)
```

It signs up a random user, logs in, collects, buys a mine with a fresh
`Idempotency-Key`, reads `/player/me` and `/leaderboard`, and prints the
`X-Request-ID` of one response to show correlation IDs.

Admin demo (bonus + failed-job inspection) needs an admin token:

```sh
# promote the demo user to admin by its player ID, then:
ADMIN_TOKEN=<adminAccessToken> OCCURRENCE_ID=$(node -e "console.log(crypto.randomUUID())") npm run demo
```

## Manual reproductions

- `scripts/repro-idempotency.sh TOKEN=<token>`: same key twice → identical body;
  different building with the same key → 409.
- `scripts/repro-concurrency.sh TOKEN=<token>`: 10 parallel collects → checkpoint
  advances once per interval, no double-credit (compare `lifetimeEarned` deltas).
- `scripts/repro-reconciliation.sh`: deletes leaderboard keys in Redis, shows 503,
  runs `npm run leaderboard:rebuild`, shows 200 again.

All scripts are intentionally thin `curl` wrappers so reviewers can read them in
under a minute.
