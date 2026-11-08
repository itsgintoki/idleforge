import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  occurrenceForJob,
  occurrenceIdSchema,
  scheduledHourStart,
  scheduledOccurrenceId,
  type BonusJobData,
} from "../../src/world-events/service.js";

describe("world event occurrence ids", () => {
  it("lowercases manual UUIDs and prefixes them", () => {
    const occurrenceId = randomUUID();
    const data: BonusJobData = { source: "manual", version: 1, occurrenceId };
    expect(occurrenceForJob(data)).toBe(`manual-${occurrenceId.toLowerCase()}`);
  });

  it("derives scheduled ids from the UTC hour", () => {
    const data: BonusJobData = {
      source: "scheduled", version: 1, schedulerId: "hourly-gold-bonus-v1",
    };
    const at = new Date("2026-01-01T12:34:56.789Z");
    const expected = scheduledOccurrenceId(at);

    expect(occurrenceForJob(data, at)).toBe(expected);
    expect(occurrenceIdSchema.safeParse(expected).success).toBe(true);
    expect(scheduledHourStart(at).toISOString()).toBe("2026-01-01T12:00:00.000Z");

    expect(occurrenceForJob(data, new Date("2026-01-01T12:59:59.999Z"))).toBe(expected);
    expect(occurrenceForJob(data, new Date("2026-01-01T13:00:00.000Z"))).not.toBe(expected);
  });

  it("keeps the historical job-id scheme distinct from the hour scheme", () => {
    const legacy = `scheduled-${createHash("sha256").update("job-42").digest("hex")}`;
    expect(occurrenceIdSchema.safeParse(legacy).success).toBe(true);
    expect(legacy).not.toBe(scheduledOccurrenceId(new Date("2026-01-01T12:00:00.000Z")));
  });

  it("rejects ids outside the supported schemes", () => {
    expect(occurrenceIdSchema.safeParse("manual-not-a-uuid").success).toBe(false);
    expect(occurrenceIdSchema.safeParse(`scheduled-${"a".repeat(63)}`).success).toBe(false);
    expect(occurrenceIdSchema.safeParse("bonus-123").success).toBe(false);
  });
});
