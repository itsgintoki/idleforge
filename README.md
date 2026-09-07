# IdleForge

Learning project: a TypeScript API for an idle-game economy.

## Local setup

Requires Node.js 22.9+ and Docker Compose. Install dependencies with `npm ci`.
Copy `.env.example` to `.env` if you do not already have local settings.
The example credentials are for the local database in `compose.yaml`.

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
second. Collection arithmetic and its rounding rules will be added in Milestone 2.

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

Login, JWT authentication, and economy endpoints are not implemented yet.
The health endpoint is liveness only; it does not check database readiness.

