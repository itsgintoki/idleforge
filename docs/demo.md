# Demo surface

The retained Vitest suite (`npm test`) is the authoritative proof of concurrency,
duplicate delivery, recovery, retention, and ledger guarantees. The script below
is a thin manual demo.

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
