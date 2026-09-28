import { createHash } from "node:crypto";
import { eq, sql } from "drizzle-orm";
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

export function occurrenceForJob(data: BonusJobData, jobId: string): string {
  if (data.source === "manual") return `manual-${data.occurrenceId.toLowerCase()}`;
  return `scheduled-${createHash("sha256").update(jobId).digest("hex")}`;
}

export function logEvent(event: string, fields: Record<string, unknown> = {}): void {
  const requestId = getRequestId();
  console.log(JSON.stringify({
    time: new Date().toISOString(),
    level: "info",
    event,
    ...(requestId === undefined ? {} : { requestId }),
    ...fields,
  }));
}

export async function applyGoldBonus(db: Database, rawOccurrenceId: string): Promise<BonusResult> {
  const occurrenceId = occurrenceIdSchema.parse(rawOccurrenceId);
  return db.transaction(async (tx): Promise<BonusResult> => {
    const [reserved] = await tx.insert(worldEvents).values({ occurrenceId, bonus: goldBonusAmount })
      .onConflictDoNothing({ target: worldEvents.occurrenceId }).returning();
    if (!reserved) {
      const [existing] = await tx.select().from(worldEvents).where(eq(worldEvents.occurrenceId, occurrenceId));
      return bonusResultSchema.parse({ ...existing, replayed: true });
    }

    const updated = await tx.execute(sql`
      WITH recipients AS MATERIALIZED (
        SELECT player_id FROM player_resources ORDER BY player_id FOR UPDATE
      )
      UPDATE player_resources AS resource
      SET gold = resource.gold + ${goldBonusAmount}::numeric,
          lifetime_gold_earned = resource.lifetime_gold_earned + ${goldBonusAmount}::numeric
      FROM recipients WHERE resource.player_id = recipients.player_id
    `);
    const playersRewarded = z.number().int().nonnegative().parse(updated.rowCount);
    const [applied] = await tx.update(worldEvents).set({ playersRewarded, appliedAt: sql`clock_timestamp()` })
      .where(eq(worldEvents.occurrenceId, occurrenceId)).returning();
    return bonusResultSchema.parse({ ...applied, replayed: false });
  });
}
