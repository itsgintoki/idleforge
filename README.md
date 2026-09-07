# IdleForge

Learning project: a TypeScript API for an idle-game economy.

## Local setup

Requires Node.js 22.9+ and Docker Compose. Install dependencies with `npm ci`.
Copy `.env.example` to `.env` if you do not already have local settings.
The example credentials are for the local database in `compose.yaml`.
Set `JWT_SECRET` in `.env` to a generated random secret (minimum 64 characters).
Generate one with `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"`.
Keep it private; do not commit `.env`. Changing the secret invalidates existing tokens.

```sh
npm run db:up
npm run db:migrate
npm run build
npm start
```

PostgreSQL is available at `127.0.0.1:5434`. The API defaults to port 3000.
`npm run db:stop` stops PostgreSQL while retaining its data volume.

## Schema workflow

Edit `src/db/schema.ts`, then run `npm run db:generate`.
Read the generated SQL in `drizzle/` before applying it with `npm run db:migrate`.
Commit both the SQL migrations and their metadata. Do not edit migrations after
they have been applied; generate a new migration for subsequent changes.

`src/roles.ts` supplies the shared player/admin values to Zod, TypeScript, and
the PostgreSQL enum. `src/db/client.ts` creates a connection pool and a typed
Drizzle client; callers must close the pool when they are finished.

Players have unique emails. Resource rows use the player ID as both their
primary key and foreign key, allowing at most one resource row per player.
Signup creates both rows in a single transaction.

Gold and gold-per-second use `numeric(30, 6)`: up to 24 integer digits and six
fractional digits. They remain strings in TypeScript to preserve precision.
The initial balance is zero and the initial production rate is one gold per
second. Lifetime gold earned starts at zero and increases by the exact amount
credited by collection. Existing development rows also start their lifetime counter
at zero when the Milestone 2 migration is applied; prior earnings are not reconstructed.

## Verification

```sh
npm run typecheck
npm test
npm run test:db
npm run build
```

`npm test` runs the tests in `tests/`. `npm run test:db` requires the migrated
local database and runs `integration/`. Schema and lookup tests roll back their
fixtures. Signup tests create a uniquely named temporary database, apply the
migrations, and drop that database afterward so real commits and rollback can
be tested. The local database user therefore needs permission to create databases.
Neither suite truncates existing development rows.
The type-check command covers source, both test folders, and Drizzle configuration.
The production build emits only `src`.

`skipLibCheck` skips checking dependency declaration files because the installed
Drizzle release contains declaration errors for optional database adapters.
Strict checking remains enabled for application and test TypeScript.

## Signup

`POST /auth/signup` accepts JSON with `email` and `password` only. Emails are
trimmed and lowercased. Passwords are preserved exactly and must contain 12–128
characters. A successful request returns 201 with public player details; invalid
input returns 400, duplicate email returns 409, and an unexpected failure returns
500 without internal details. Request bodies are limited to 16 KB (413 if exceeded).

The service hashes passwords with Argon2id before opening its transaction. The
player and initial gold resource commit together. PostgreSQL's unique email
constraint handles concurrent duplicate signups. Only the public player projection
is returned; hashes and passwords are not included. The API receives its signup
function through `createApp`, letting route tests supply a controlled implementation.

## Login credential verification

`src/auth/login.ts` verifies a normalized email/password pair and returns either
public player details or `invalid_credentials`. Unknown emails and incorrect
passwords share the same result. Unknown emails still perform Argon2 verification
against a dummy hash to avoid skipping the expensive verification step; this is
not a guarantee of identical response timing. Stored hashes are verified, never
compared with a newly generated hash. Database and corrupt-hash failures propagate
as internal errors rather than being treated as incorrect credentials.

Login accepts nonempty passwords up to 128 characters without changing their
contents; signup's minimum length is a creation rule. Both input schemas share
email normalization. Login schema validation must happen at the HTTP boundary,
just as it does for signup.

## Login endpoint and access tokens

`POST /auth/login` accepts the same email/password fields as signup. On success,
it returns 200 with `accessToken`, `tokenType: "Bearer"`, `expiresIn: 900`, and
public `player` details. Responses containing tokens use `Cache-Control: no-store`.
Invalid input returns 400. Unknown accounts and wrong passwords both return 401
with `invalid_credentials`; internal failures return 500.

Access tokens are signed using HS256 with `JWT_SECRET`, expire after 15 minutes,
and include the player ID (`sub`), role, issuer (`idleforge`), audience
(`idleforge-api`), issue time, and expiry time. They do not contain email,
password, or password hash. Tokens are signed, not encrypted.

## Protected player state

`GET /player/me` requires `Authorization: Bearer <accessToken>`. Middleware
verifies the HS256 signature, expiry, issuer, audience, and maximum token age,
then validates the decoded payload with Zod. Signature verification alone does
not establish the application's required claim types. No payload type assertion
is used. Missing or invalid tokens return 401 with a Bearer challenge.

The player ID comes from the verified `sub` claim. A query-string ID cannot
select another player. The response contains public player fields and resource
state; gold and rates remain exact strings. Missing player/resource state returns
404, and database failures return 500. The role returned in player state is the
current database role. Token roles are snapshots, not a live role lookup; future
admin authorization must define how role changes are handled.

Run `npm run dev` for automatic server restart on source changes. Run
`npm run verify` for type-checking, unit/route tests, database integration tests,
and the production build. Start the database and apply migrations first.

Milestones 1 and 2 are implemented: foundation, authentication, player state, and
atomic offline collection. Purchases, workers, readiness checks, and operational
hardening belong to later milestones. Refresh tokens are not implemented.

The health endpoint is liveness only; it does not check database readiness.



## Offline collection (Milestone 2)

`POST /player/collect` requires a Bearer access token and accepts no body or `{}`.
Extra JSON fields return 400. The authenticated token supplies the player ID;
query parameters cannot choose a player or control time, rate, or amount.
A successful response is 200 with `Cache-Control: no-store`, for example:

```json
{
  "credited": "60.000000",
  "balance": "160.000000",
  "lifetimeEarned": "260.000000",
  "rate": "1.000000",
  "collectedAt": "2026-09-08T12:00:00.000Z"
}
```

Missing/invalid authentication returns 401. A missing account returns 404
`player_not_found`; an account without resources returns 404 `resource_not_found`.
Unexpected database failures return 500 `internal_error`.
`GET /player/me` now includes `resources.lifetimeGoldEarned`.

### Numeric and time rules

- Balance, lifetime earnings, and rate use PostgreSQL `numeric(30, 6)`. API and
  TypeScript values remain strings; collection never converts them to JS numbers.
- PostgreSQL supplies the clock, sampled after acquiring the player's resource
  row lock. The checkpoint uses millisecond precision, matching JavaScript `Date`.
  The migration rounds existing checkpoints to that precision (at most 0.5 ms).
- The next checkpoint is the greater of the previous checkpoint and database time.
  A future checkpoint therefore credits zero and stays unchanged until time catches
  up. Moving it backwards would make a later request re-earn an old interval.
- Credited seconds are clamped to `[0, 28800]`: **eight hours maximum offline**.
  Excess offline time is discarded when the checkpoint advances to the current time.
- Credit is `trunc(creditedSeconds * rate, 6)`. Fractional gold below one millionth
  is discarded on each collection; it is not carried forward. There is no minimum
  payout. Repeated tiny collections can therefore lose fractional earnings.
- The credited amount is added to both balance and lifetime earnings in the same
  statement that advances the checkpoint. Numeric overflow fails the statement
  and leaves all three fields unchanged; it is not silently rounded or clamped.

### Why simultaneous collection is safe

`src/players/collect.ts` uses one SQL statement: lock the resource row with
`SELECT ... FOR UPDATE`, sample the clock, calculate credit with exact arithmetic,
and update all economy fields together. The materialized CTEs keep the calculation
based on the locked row. At PostgreSQL's default READ COMMITTED isolation, a waiting
collector reads the first collector's committed checkpoint, so it cannot credit
that interval again. Separate players have separate row locks.

PostgreSQL documents [row behavior at READ COMMITTED](https://www.postgresql.org/docs/17/transaction-iso.html#XACT-READ-COMMITTED)
and the distinction between [database clock functions](https://www.postgresql.org/docs/17/functions-datetime.html#FUNCTIONS-DATETIME-CURRENT).
The service owns the SQL and expected outcomes; `src/players/routes.ts` owns HTTP
validation and status codes. This is safe interval collection, not persisted
request idempotency: a later retry can collect time earned since the first request.

### Verification and deliberate race regression

```sh
npm run db:up
npm run db:migrate
npm run verify
npm run test:race
```

The collection integration suite creates and drops its own uniquely named database.
It checks normal earnings, zero effective elapsed time, future checkpoints, the cap,
large exact values, zero rate, missing state, constraints, overflow rollback,
authenticated HTTP collection, and concurrent collectors.

The concurrency test holds a row lock, starts two collectors, and waits until both
are blocked in PostgreSQL before releasing them. It checks that their combined
credit equals the elapsed interval exactly and agrees with the stored balance,
lifetime total, and checkpoint.

`test:race` copies source and tests into a temporary directory, first runs the safe
implementation, then replaces the locking read with an unsafe separate read and
update using stale values. The same concurrency test must fail its credited-total
assertion. The script removes the temporary copy; it never edits the working source.
The disposable test databases are also removed. This proves that a passing race test
is sensitive to the bug it is intended to catch.
