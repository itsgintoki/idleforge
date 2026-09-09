# Milestone 4: what to understand first

You do not need to master Redis or distributed systems before reading this code.
Get the basic idea of the following topics, in this order.

| Topic | Basic idea you need |
| --- | --- |
| Processes and async work | `await` pauses an async function; it does not turn that function into a durable background worker. The API and worker here are two separate Node processes. |
| Redis versus PostgreSQL | Redis stores our queue's delivery state. PostgreSQL stores player gold and whether a bonus was already applied. Redis is not being used as a response cache here. |
| Producer → queue → worker | The producer adds a job, the queue keeps it waiting, and a worker takes it and does the work. A 202 response means queued, not completed. |
| Scheduling versus processing | A scheduler decides when jobs should become available. A worker performs them. A schedule alone does not award gold. |
| Job states, retries, and backoff | Jobs can be waiting, delayed, active, completed, or failed. Temporary failures can be retried; exponential backoff increases the delay. |
| Duplicate delivery and idempotency | Work can be delivered again after a crash. Reusing an occurrence ID must return the saved outcome rather than repeat the reward. |
| Transactions and row locks | Reserving the event, changing gold, and saving the result must commit together. A rollback undoes all three. Row locks coordinate concurrent changes. |
| TypeScript at runtime boundaries | `z.infer` creates a compile-time type from a schema. Zod still validates data arriving from Redis at runtime. A discriminated union uses `source` to distinguish manual and scheduled jobs. |

The transaction and idempotency ideas reuse Milestone 3. The main new concepts are
queues, a separate worker, recurring schedules, and delivery retries.

## Our example

```text
Hourly scheduler ─┐
                  ├─→ BullMQ queue in Redis ─→ worker ─→ PostgreSQL transaction
Admin API ────────┘                                      reserve occurrence
                                                        award 100 gold
                                                        save applied result
```

If the worker dies after the database commits but before reporting completion,
BullMQ can deliver the job again. The saved occurrence tells the next worker that
the bonus already happened. This is why both a queue and database retry protection
are present.

## Code reading order

1. `src/world-events/contracts.ts`: names, amount, schemas, and occurrence identity.
2. `src/world-events/queue.ts` then `src/scheduler.ts`: adding work and scheduling it.
3. `src/world-events/routes.ts`: authenticated admin request → queued job.
4. `src/worker.ts` then `src/world-events/worker.ts`: separate process, validation,
   execution, logging, and retries.
5. `src/db/schema.ts` (`worldEvents`) then `src/world-events/apply-bonus.ts`:
   database uniqueness, locking, atomic writes, and replay.
6. `compose.yaml`, `src/config.ts`, and package scripts: connecting the processes.

## Optional primary-source reading

- [BullMQ introduction](https://docs.bullmq.io/): queue terminology and purpose.
- [Job schedulers](https://docs.bullmq.io/guide/job-schedulers): scheduling and stable IDs.
- [Retrying failing jobs](https://docs.bullmq.io/guide/retrying-failing-jobs): attempts and backoff.

Read for the overall idea first. We can then walk through each file using one
manual bonus, a failed attempt, and a repeated occurrence as examples.
