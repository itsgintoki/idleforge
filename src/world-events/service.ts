import { createHash } from "node:crypto";
import { and, eq, gte, lt, sql } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "../db/client.js";
import { getRequestId } from "../observability.js";
import { worldEvents } from "../db/schema.js";

export const worldEventQueueName = "world-events";
export const goldBonusJobName = "global-gold-bonus-v1";
export const goldBonusSchedulerId = "hourly-gold-bonus-v1";
export const goldBonusCron = "0 * * * *";
export const goldBonusAmount = "100.000000";

export const manualBonusSchema = z.strictObject({ occurrenceId: z.uuid() });
export const bonusJobSchema = z.discriminatedUnion("source", [
  manualBonusSchema.extend({ source: z.literal("manual"), version: z.literal(1) }),
  z.strictObject({ source: z.literal("scheduled"), version: z.literal(1), schedulerId: z.literal(goldBonusSchedulerId) }),
]);
export type BonusJobData = z.infer<typeof bonusJobSchema>;
export const occurrenceIdSchema = z.string().regex(/^(manual-[0-9a-f-]{36}|scheduled-[0-9a-f]{64})$/);
export const bonusResultSchema = z.object({
  occurrenceId: occurrenceIdSchema,
  bonus: z.literal(goldBonusAmount),
  playersRewarded: z.number().int().nonnegative(),
  appliedAt: z.date(),
  replayed: z.boolean(),
});
export type BonusResult = z.infer<typeof bonusResultSchema>;

export function occurrenceForJob(data: BonusJobData, at: Date = new Date()): string {
  if (data.source === "manual") return `manual-${data.occurrenceId.toLowerCase()}`;
  return scheduledOccurrenceId(at);
}

export function scheduledHourStart(at: Date): Date {
  return new Date(Math.floor(at.getTime() / 3_600_000) * 3_600_000);
}

export function scheduledOccurrenceId(at: Date): string {
  const hour = scheduledHourStart(at).toISOString();
  return `scheduled-${createHash("sha256").update(`${goldBonusSchedulerId}:${hour}`).digest("hex")}`;
}

export function logEvent(
  event: string,
  fields: Record<string, unknown> = {},
  level: "info" | "error" = "info",
): void {
  const requestId = getRequestId();
  console.log(JSON.stringify({
    time: new Date().toISOString(),
    level,
    event,
    ...(requestId === undefined ? {} : { requestId }),
    ...fields,
  }));
}

export type ApplyGoldBonusOptions = { hourStart?: Date; batchSize?: number };

const bonusBatchSizeSchema = z.number().int().min(1).max(10_000);
type WorldEventRow = typeof worldEvents.$inferSelect;

function bonusResultFromRow(row: WorldEventRow, replayed: boolean): BonusResult {
  return bonusResultSchema.parse({
    occurrenceId: row.occurrenceId,
    bonus: row.bonus,
    playersRewarded: row.playersRewarded,
    appliedAt: row.appliedAt,
    replayed,
  });
}

type Reservation =
  | { done: true; row: WorldEventRow }
  | { done: false };

export async function applyGoldBonus(
  db: Database,
  rawOccurrenceId: string,
  options: ApplyGoldBonusOptions = {},
): Promise<BonusResult> {
  const occurrenceId = occurrenceIdSchema.parse(rawOccurrenceId);
  const { hourStart } = options;
  const batchSize = bonusBatchSizeSchema.parse(options.batchSize ?? 1000);
  if (occurrenceId.startsWith("scheduled-") && hourStart === undefined) {
    throw new TypeError("Scheduled occurrences require the hour they belong to");
  }

  const reservation = await db.transaction(async (tx): Promise<Reservation> => {
    if (hourStart !== undefined) {
      const hourEnd = new Date(hourStart.getTime() + 3_600_000);
      await tx.execute(sql`
        SELECT pg_advisory_xact_lock(
          hashtext(${`idleforge:world-event-hour:${hourStart.toISOString()}`})::bigint
        )
      `);
      const [alreadyApplied] = await tx.select().from(worldEvents)
        .where(and(
          gte(worldEvents.appliedAt, hourStart),
          lt(worldEvents.appliedAt, hourEnd),
          sql`${worldEvents.occurrenceId} LIKE 'scheduled-%'`,
        ))
        .limit(1);
      if (alreadyApplied) return { done: true, row: alreadyApplied };
    }

    const [inserted] = await tx.insert(worldEvents).values({ occurrenceId, bonus: goldBonusAmount })
      .onConflictDoNothing({ target: worldEvents.occurrenceId }).returning();
    if (inserted) return { done: false };

    const [existing] = await tx.select().from(worldEvents)
      .where(eq(worldEvents.occurrenceId, occurrenceId));
    if (existing === undefined) throw new Error("World event reservation disappeared");
    return existing.appliedAt === null ? { done: false } : { done: true, row: existing };
  });

  if (reservation.done) return bonusResultFromRow(reservation.row, true);

  for (;;) {
    const next = await db.transaction(async (tx) => {
      const [row] = await tx.select().from(worldEvents)
        .where(eq(worldEvents.occurrenceId, occurrenceId)).for("update");
      if (row === undefined) throw new Error("World event reservation disappeared");
      if (row.appliedAt !== null) return { done: true as const, row, replayed: true };

      const cursor = row.lastPlayerId;
      const updated = await tx.execute(sql`
        WITH batch AS MATERIALIZED (
          SELECT player_id FROM player_resources
          WHERE ${cursor === null ? sql`TRUE` : sql`player_id > ${cursor}::uuid`}
          ORDER BY player_id
          LIMIT ${batchSize}
          FOR UPDATE
        ), updated AS (
          UPDATE player_resources AS resource
          SET gold = resource.gold + ${goldBonusAmount}::numeric,
              lifetime_gold_earned = resource.lifetime_gold_earned + ${goldBonusAmount}::numeric
          FROM batch
          WHERE resource.player_id = batch.player_id
          RETURNING resource.player_id
        ), inserted AS (
          INSERT INTO ledger_entries (player_id, amount, kind, reference_id)
          SELECT player_id, ${goldBonusAmount}::numeric, 'bonus', ${occurrenceId}
          FROM updated
          RETURNING id
        )
        SELECT count(*)::int AS count, max(player_id::text) AS "maxId" FROM updated
      `);
      const summary = z.object({
        count: z.number().int().nonnegative(),
        maxId: z.uuid().nullable(),
      }).parse(updated.rows[0]);

      const complete = summary.count < batchSize;
      const [updatedRow] = await tx.update(worldEvents).set({
        lastPlayerId: summary.maxId,
        playersRewarded: row.playersRewarded + summary.count,
        ...(complete ? { appliedAt: sql`clock_timestamp()` } : {}),
      }).where(eq(worldEvents.occurrenceId, occurrenceId)).returning();
      if (updatedRow === undefined) throw new Error("World event reservation disappeared");
      return complete
        ? { done: true as const, row: updatedRow, replayed: false }
        : { done: false as const };
    });

    if (next.done) return bonusResultFromRow(next.row, next.replayed);
  }
}
