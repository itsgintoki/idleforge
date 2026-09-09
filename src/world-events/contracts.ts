import { createHash } from "node:crypto";
import { z } from "zod";

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
  // Scheduler templates are static. BullMQ assigns a stable unique job ID to
  // each repetition; retries of that job therefore derive the same event ID.
  return `scheduled-${createHash("sha256").update(jobId).digest("hex")}`;
}
