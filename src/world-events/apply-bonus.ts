import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "../db/client.js";
import { worldEvents } from "../db/schema.js";
import { bonusResultSchema, goldBonusAmount, occurrenceIdSchema, type BonusResult } from "./contracts.js";

export async function applyGoldBonus(db: Database, rawOccurrenceId: string): Promise<BonusResult> {
  const occurrenceId = occurrenceIdSchema.parse(rawOccurrenceId);
  return db.transaction(async (tx): Promise<BonusResult> => {
    const [reserved] = await tx.insert(worldEvents).values({ occurrenceId, bonus: goldBonusAmount })
      .onConflictDoNothing({ target: worldEvents.occurrenceId }).returning();
    if (!reserved) {
      const [existing] = await tx.select().from(worldEvents).where(eq(worldEvents.occurrenceId, occurrenceId));
      return bonusResultSchema.parse({ ...existing, replayed: true });
    }
    // Lock recipients in a consistent order across world-event workers. A single
    // statement selects the eligible resource rows and adds exact numeric gold.
    // Accounts created after this statement's snapshot do not receive this event.
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
