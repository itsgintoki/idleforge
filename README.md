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
atomic offline collection. Milestone 3 adds transactional building purchases
with persisted idempotency keys and retry results. Workers, readiness checks, and
operational hardening belong to later milestones. Refresh tokens are not implemented.

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


## Building purchases (Milestone 3)

`POST /player/purchases` requires a Bearer token and an `Idempotency-Key` header.
Keys are case-sensitive, 1–128 ASCII letters, digits, underscores, or hyphens.
Generate a fresh key for each intentional purchase (for example, with
`crypto.randomUUID()`), and reuse it when retrying that same command. Missing or
invalid keys return 400 `invalid_input` before the purchase service runs.
The body accepts exactly one JSON field:

```json
{ "building": "mine" }
```

The authenticated player ID always comes from the token. The client cannot supply
price, target level, rate, or another player's ID. Unknown buildings and extra body
fields return 400 `invalid_input`. A successful purchase or upgrade returns 200
with `Cache-Control: no-store`:

```json
{
  "building": "mine",
  "level": 1,
  "spent": "100.000000",
  "credited": "0.000000",
  "balance": "900.000000",
  "lifetimeEarned": "1000.000000",
  "rate": "2.000000",
  "collectedAt": "2026-09-08T12:00:00.000Z"
}
```

`credited` is passive gold settled at the old rate during the purchase. `balance`
is the final balance after spending and settlement. `rate` is the new total rate.
`GET /player/me` also returns a `buildings` array of `{ building, level }`, initially
empty. The player and resource fields retain their existing names and formats.

### Catalogue and pricing

`src/buildings/catalogue.ts` supplies the prices and production effects. Its key
schema supplies the shared building names for validation, TypeScript, and the
PostgreSQL enum; the catalogue type requires an entry for every supported key.

| Building key | First level price | Additional production per level |
| --- | ---: | ---: |
| `mine` | 100 gold | 1 gold/second |
| `forge` | 500 gold | 5 gold/second |

Every command buys one level. Price is `basePrice * nextLevel`: Mine levels 1, 2,
and 3 cost 100, 200, and 300 respectively. Each building is capped at level 100.
Prices are multiplied using BigInt and returned as fixed-six-decimal strings;
resource arithmetic remains exact PostgreSQL numeric arithmetic. There is one
building row per `(player_id, building_key)`, enforced by a composite primary key.
The database enforces the level range and cascades building deletion with its player.

### Transaction and rate changes

The service locks the resource row first, sharing the same per-player lock used by
collection. It reads the current building level and computes the next price only
after acquiring that lock. A guarded SQL update deducts gold only if the stored
balance is sufficient. Purchases of different building types share this lock because
they spend the same balance.

**Purchases spend already-collected gold.** Collect first if pending earnings are
needed to afford the building. Insufficient funds returns 409 `insufficient_funds`
and changes nothing, including the collection checkpoint. The level cap returns
409 `max_level_reached`, also without changes. Missing accounts/resources return
404 `player_not_found` / `resource_not_found`; unexpected failures return generic 500.

After successful deduction, the service settles elapsed time through the existing
collector at the OLD production rate, then creates/upgrades the building and raises
the rate. This prevents a new rate from being applied to earlier offline time.
The eight-hour cap, truncation, and nondecreasing checkpoint rules still apply.
Spending never reduces lifetime earnings; passive settlement can increase them.
Gold deduction, settlement, building mutation, and rate update all commit together.
Failure at any point rolls all of them back, including numeric overflow.

### Verification

Run `npm run db:migrate` before `npm run verify`. The migration adds only the
building enum and table. Integration tests use an isolated temporary database and
prove exact spending, upgrades, insufficient funds, level caps, failure rollback,
large values, old-rate settlement, and overlapping operations. Concurrency tests
hold a blocker lock until both requests are waiting, then test one affordable
purchase, updated upgrade pricing, purchases across building types, and collection
concurrent with a purchase. The collection mutation proof still runs with
`npm run test:race`.

### Persisted retry handling (Part 2)

The `purchase_commands` table has a composite primary key `(player_id,
idempotency_key)`. Each record stores the requested building and its complete
service result as JSON. Two players can independently use the same key. A
repeated key for the same player is checked against its saved building:

| Request | Outcome |
| --- | --- |
| New key | Reserve it, execute the purchase, and persist its result in one transaction |
| Same key and building | Return the saved result without changing the economy |
| Same key, different building | 409 `idempotency_key_reused`; the original command stays unchanged |

A replay returns the original balance, credited amount, level, rate, and timestamp,
even if later commands have changed the current state. Use `GET /player/me` to
read current state. Both successful outcomes and expected domain failures such as
`insufficient_funds`, `max_level_reached`, and `resource_not_found` are saved.
An insufficient-funds result changes no economy state; its command record is saved.
If funds later increase, the original key still returns that failure; use a new
key for a new attempt. Authentication/validation failures and missing accounts do
not reserve a key. Unexpected exceptions roll back both the economy mutations and
the command reservation, allowing the same key to be retried.

A small owner key-share lock prevents account deletion during execution. The command
reservation comes before the resource-row lock. Concurrent identical keys wait on
PostgreSQL's unique constraint: after the first transaction commits, the waiter
reads its persisted result in a new READ COMMITTED statement. If the first attempt
rolls back, the waiter can reserve the key and execute. This follows PostgreSQL's
[conflict handling](https://www.postgresql.org/docs/17/sql-insert.html) and
[row locking rules](https://www.postgresql.org/docs/17/explicit-locking.html).

The result is saved before commit, so loss of the HTTP response after commit does
not lose the result. Persisted results are runtime-validated with Zod, restoring
ISO timestamp strings to Dates; malformed or incomplete records produce a generic
500 rather than executing the purchase again. Records have no expiry in this
milestone and are deleted with their owning player. Deleting a live command record
would remove its retry protection; retention cleanup is not implemented.

The tests additionally cover simultaneous identical keys, conflicting payloads,
separate players using the same key, replay through a fresh database connection,
stable failed outcomes, result-storage rollback, a waiting retry after rollback,
corrupt stored results, and identical HTTP replay responses.

Example request (use your own token and keep the key for retries):

```http
POST /player/purchases
Authorization: Bearer <accessToken>
Idempotency-Key: first-mine-001
Content-Type: application/json

{ "building": "mine" }
```
