# IdleForge

Learning project: a TypeScript API for an idle-game economy.

## Local setup

Requires Node.js 22.9+ and Docker Compose. Install dependencies with `npm ci`.
Compose pins PostgreSQL **18.6** and Redis **8.10.1**, the stable releases selected
on September 9, 2026. Version updates are deliberate; image tags do not track `latest`.
Copy `.env.example` to `.env` if you do not already have local settings.
The example credentials are for the local database in `compose.yaml`.
Set `JWT_SECRET` in `.env` to a generated random secret (minimum 64 characters).
Generate one with `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"`.
Keep it private; do not commit `.env`. Changing the secret invalidates existing tokens.

```sh
npm run services:up
npm run db:migrate
npm run build
npm run scheduler
npm start
```

In a second terminal, run `npm run worker`. The scheduler command registers the
recurring schedule and exits; the API and worker are separate long-running processes.
Use `npm run dev` and `npm run worker:dev` for source-watching development.

PostgreSQL is available at `127.0.0.1:5434`, Redis at `127.0.0.1:6384`, and the API
defaults to port 3000. All processes must use the same `REDIS_URL`, `QUEUE_PREFIX`,
and database. `npm run services:stop` stops both services while retaining their volumes.

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
credited by collection and world-event bonuses. Existing development rows also start their lifetime counter
at zero when the Milestone 2 migration is applied; prior earnings are not reconstructed.

## Verification

```sh
npm run verify
```

This runs strict TypeScript checking of application source and Drizzle configuration,
then builds production JavaScript. Automated tests, test dependencies, and the race
regression script have been removed at the learner's request. Tests will be written
at the end of the project; `verify` does not currently run behavioral tests.

`skipLibCheck` skips checking dependency declaration files because the installed
Drizzle release contains declaration errors for optional database adapters.
Strict checking remains enabled for application TypeScript.

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
function through `createApp`, keeping HTTP handling separate from database operations.

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
current database role. Token roles are snapshots; the admin world-event endpoint
checks the current database role on every request, so demotion takes effect immediately.

Milestones 1–4 are implemented: foundation, authentication, player state, atomic
offline collection, transactional building purchases with persisted retry results,
and scheduled world-event bonuses. Leaderboards and operational hardening remain
for later milestones. Refresh tokens are not implemented.

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

PostgreSQL documents [row behavior at READ COMMITTED](https://www.postgresql.org/docs/18/transaction-iso.html#XACT-READ-COMMITTED)
and the distinction between [database clock functions](https://www.postgresql.org/docs/18/functions-datetime.html#FUNCTIONS-DATETIME-CURRENT).
The service owns the SQL and expected outcomes; `src/players/routes.ts` owns HTTP
validation and status codes. This is safe interval collection, not persisted
request idempotency: a later retry can collect time earned since the first request.

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
[conflict handling](https://www.postgresql.org/docs/18/sql-insert.html) and
[row locking rules](https://www.postgresql.org/docs/18/explicit-locking.html).

The result is saved before commit, so loss of the HTTP response after commit does
not lose the result. Persisted results are runtime-validated with Zod, restoring
ISO timestamp strings to Dates; malformed or incomplete records produce a generic
500 rather than executing the purchase again. Records have no expiry in this
milestone and are deleted with their owning player. Deleting a live command record
would remove its retry protection; retention cleanup is not implemented.

Example request (use your own token and keep the key for retries):

```http
POST /player/purchases
Authorization: Bearer <accessToken>
Idempotency-Key: first-mine-001
Content-Type: application/json

{ "building": "mine" }
```


## Scheduled world events (Milestone 4)

The bonus is **100 gold per player**, counted in both balance and lifetime earnings.
It does not change production rate, buildings, or the offline collection checkpoint.
Eligible players are those with a resource row visible when the worker's update
statement starts. An account created afterward waits for a later occurrence. A
successful occurrence with zero recipients is still recorded as applied.

### Queue, scheduler, and worker

- `src/world-events/contracts.ts` defines queue/job names, runtime schemas, inferred
  TypeScript types, the fixed amount, and schedule settings.
- `src/world-events/queue.ts` creates the producer and registers the scheduler.
- `src/scheduler.ts` registers the stable `hourly-gold-bonus-v1` scheduler and exits.
  Running it repeatedly updates the same schedule, rather than creating another one.
- `src/worker.ts` starts the separate worker process. `src/world-events/worker.ts`
  validates each job and calls the database service. The API never processes jobs.
- `src/world-events/apply-bonus.ts` owns the transaction and retry protection.

The cron expression `0 * * * *` runs at the top of every UTC hour. Registration
schedules a future run; it does not immediately reward players. A worker must be
running for execution. Jobs may run late during downtime or backlog. This is a
periodic world event, not a promise to backfill a bonus for every missed clock hour.
BullMQ generates the next scheduled job as the preceding scheduled job starts.

Manual and scheduled jobs share the validated, versioned contract and the same
application service. Manual occurrences use a caller-generated UUID. Scheduled
occurrences derive their stable database ID from the scheduler-generated job ID.
Each scheduled repetition is a new occurrence; retrying that job retains its ID.

### Atomic application and retries

In one PostgreSQL transaction, the service reserves `world_events.occurrence_id`,
locks eligible resource rows in player-ID order, increments both gold totals using
exact numeric arithmetic, and saves the recipient count and application timestamp.
The occurrence ID is a primary key. A concurrent duplicate waits, then reads the
committed outcome without awarding gold again. On failure, all changes—including
the reservation—roll back, allowing the same occurrence to retry.

If PostgreSQL commits but the worker crashes before acknowledging completion to
Redis, redelivery returns the persisted outcome. Queue job-ID deduplication is only
an optimization: even another transport job ID with the same manual occurrence UUID
cannot award gold twice. Do not delete applied occurrence rows; there is no retention
cleanup in this milestone.

Jobs get at most five application attempts, with exponential delays starting at one
second (1, 2, 4, 8 seconds before the next attempt). Invalid job names or payloads
fail immediately without retries. Failed jobs remain in Redis for inspection;
completed jobs are retained up to a count of 1,000. Logs contain job and occurrence
IDs, attempt, recipient count, and outcome; raw database errors and secrets are
not stored in job failure messages.

### Admin trigger

```http
POST /admin/world-events/gold-bonus
Authorization: Bearer <admin-accessToken>
Content-Type: application/json

{ "occurrenceId": "4f4e6fb8-fbb2-4baf-af2e-9b97006601b2" }
```

Generate a UUID with `crypto.randomUUID()` for each intentional bonus. Reuse it
when retrying that bonus, including after a timeout or 503. A new UUID means another
bonus. The request cannot choose the amount or recipients.

A successful enqueue returns **202** with `jobId` and `occurrenceId`: accepted for
processing, not necessarily awarded yet. Missing/invalid authentication returns
401, a non-admin account returns 403, invalid input returns 400, and an unavailable
queue returns 503. Authorization checks the current database role rather than
trusting an old role claim. Signup still creates ordinary players; no existing
account is automatically promoted. For a deliberate local admin account, update
that account's role in the database by its exact player ID.

### Local operation and limits

Redis uses a persistent Docker volume, AOF with `appendfsync everysec`, and
`noeviction`. Redis holds delivery state; PostgreSQL holds the authoritative economy
and applied-occurrence records. AOF every-second persistence can still lose recent
queued work on a crash. There is no database outbox or lost-job reconciliation yet;
database idempotency prevents duplicate application but cannot restore lost delivery.

The API can serve database-backed routes while Redis is unavailable; the admin
trigger returns 503. Producers fail promptly, while workers reconnect and wait for
Redis. SIGTERM/SIGINT closes the API's connections; the worker waits for its active
job before closing its database pool.

Each global reward currently updates all eligible rows in one transaction. This is
appropriate for this learning milestone; it can delay concurrent player writes as
the player count grows. Batching would need a different persisted progress model.

Milestone 4 was manually checked using disposable PostgreSQL and Redis namespaces:
independent API/worker startup, exact rewards, duplicate delivery, concurrent replay,
invalid jobs, forced rollback followed by a real queue retry, scheduler registration
and execution, current-role authorization, and shutdown. No verification fixtures or
test suites are retained in the codebase.

See [the Milestone 4 study guide](docs/milestone-4-study.md) for concepts and reading order.


## Database version upgrades

PostgreSQL 18's Docker image uses `/var/lib/postgresql/18/docker` for its data
inside the container. Compose mounts the `postgres_18_data` volume at
`/var/lib/postgresql`. Redis uses `redis_8_data` mounted at `/data`.

Changing PostgreSQL's major version requires a database upgrade or logical
backup/restore; changing the image tag alone does not migrate an existing data
volume. Application SQL and TypeScript needed no changes for this upgrade.

The September 9, 2026 local upgrade restored PostgreSQL 17 into a fresh PostgreSQL
18 volume and copied the stopped Redis 7 persistence files into a fresh Redis 8
volume. The original `idleforge_postgres_data` and `idleforge_redis_data` volumes
remain untouched as recovery copies. They represent the state at upgrade time;
reverting to them later would omit subsequent writes.

Private logical backups, Redis persistence files, a pre-upgrade Compose file, and
data fingerprints are in `.local-backups/2026-09-09-db-upgrade/` (ignored by Git).
Those backups contain private database data. Keep them local. All existing rows,
sequence state, and Redis values matched after restoration. Temporary application
checks used a separate database and queue prefix.

References: [PostgreSQL supported versions](https://www.postgresql.org/support/versioning/),
[PostgreSQL Docker image layout](https://hub.docker.com/_/postgres), and
[Redis 8.10 release notes](https://redis.io/docs/latest/operate/oss_and_stack/stack-with-enterprise/release-notes/redisce/redisos-8.10-release-notes/).
