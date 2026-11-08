import { and, eq, isNull, lt, or, sql } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { eventOutbox } from "../db/schema.js";
import { outboxPendingJobs } from "../metrics.js";
import type { BonusQueue } from "./queue.js";
import {
  applyGoldBonus,
  bonusJobSchema,
  logEvent,
  occurrenceIdSchema,
  scheduledHourStart,
  scheduledOccurrenceId,
  type BonusResult,
} from "./service.js";

export const outboxKind = "world_event_gold_bonus";

export async function recordBonusIntent(
  db: Database,
  occurrenceId: string,
): Promise<{ created: boolean }> {
  const id = occurrenceIdSchema.parse(occurrenceId);
  if (!id.startsWith("manual-")) throw new TypeError("Only manual bonuses use the outbox");
  const data = bonusJobSchema.parse({
    source: "manual", version: 1, occurrenceId: id.slice("manual-".length),
  });
  const [inserted] = await db.insert(eventOutbox).values({
    occurrenceId: id, kind: outboxKind, payload: data,
  }).onConflictDoNothing({ target: eventOutbox.occurrenceId })
    .returning({ id: eventOutbox.id });
  return { created: inserted !== undefined };
}

export async function markOutboxDispatched(db: Database, occurrenceId: string): Promise<void> {
  await db.update(eventOutbox).set({
    dispatchedAt: sql`clock_timestamp()`,
    dispatchAttempts: sql`${eventOutbox.dispatchAttempts} + 1`,
    lastError: null,
  }).where(eq(eventOutbox.occurrenceId, occurrenceId));
}

export async function markOutboxDispatchFailed(
  db: Database,
  occurrenceId: string,
  reason: string,
): Promise<void> {
  await db.update(eventOutbox).set({
    dispatchAttempts: sql`${eventOutbox.dispatchAttempts} + 1`,
    lastError: reason.slice(0, 500),
  }).where(eq(eventOutbox.occurrenceId, occurrenceId));
}

export async function markOutboxCompleted(db: Database, occurrenceId: string): Promise<void> {
  await db.update(eventOutbox).set({ completedAt: sql`clock_timestamp()` })
    .where(and(eq(eventOutbox.occurrenceId, occurrenceId), isNull(eventOutbox.completedAt)));
}

export async function completeSettledOutbox(db: Database): Promise<void> {
  await db.execute(sql`
    UPDATE event_outbox AS outbox
    SET completed_at = clock_timestamp()
    WHERE outbox.completed_at IS NULL
      AND EXISTS (
        SELECT 1 FROM world_events AS event
        WHERE event.occurrence_id = outbox.occurrence_id AND event.applied_at IS NOT NULL
      )
  `);
}

export type DrainResult = { candidates: number; dispatched: number };

export async function drainOutbox(
  db: Database,
  queue: BonusQueue,
  limit = 100,
): Promise<DrainResult> {
  const candidates = await db.select({
    occurrenceId: eventOutbox.occurrenceId,
    payload: eventOutbox.payload,
  }).from(eventOutbox).where(and(
    isNull(eventOutbox.completedAt),
    or(
      isNull(eventOutbox.dispatchedAt),
      lt(eventOutbox.dispatchedAt, sql`clock_timestamp() - interval '5 minutes'`),
    ),
    sql`NOT EXISTS (
      SELECT 1 FROM world_events AS event
      WHERE event.occurrence_id = ${eventOutbox.occurrenceId} AND event.applied_at IS NOT NULL
    )`,
  )).orderBy(eventOutbox.createdAt).limit(Math.min(Math.max(limit, 1), 1000));

  let dispatched = 0;
  for (const candidate of candidates) {
    const data = bonusJobSchema.safeParse(candidate.payload);
    if (!data.success) {
      await markOutboxDispatchFailed(db, candidate.occurrenceId, "invalid_payload");
      continue;
    }
    try {
      await queue.enqueueJob(data.data, candidate.occurrenceId);
      await markOutboxDispatched(db, candidate.occurrenceId);
      dispatched += 1;
    } catch {
      await markOutboxDispatchFailed(db, candidate.occurrenceId, "queue_unavailable");
      logEvent("outbox_dispatch_failed", { occurrenceId: candidate.occurrenceId }, "error");
    }
  }

  await completeSettledOutbox(db);
  outboxPendingJobs.set(await pendingOutboxCount(db));
  return { candidates: candidates.length, dispatched };
}

export async function pendingOutboxCount(db: Database): Promise<number> {
  const result = await db.execute(sql`
    SELECT count(*)::int AS count FROM event_outbox WHERE completed_at IS NULL
  `);
  return Number((result.rows[0] as { count: number } | undefined)?.count ?? 0);
}

export async function applyScheduledHour(
  db: Database,
  at: Date = new Date(),
  batchSize?: number,
): Promise<BonusResult> {
  const hourStart = scheduledHourStart(at);
  return applyGoldBonus(db, scheduledOccurrenceId(at), {
    hourStart,
    ...(batchSize === undefined ? {} : { batchSize }),
  });
}
