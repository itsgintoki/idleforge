import { eq, gt } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { playerResources } from "../db/schema.js";

export type AuthoritativeScore = { playerId: string; lifetimeGoldEarned: string };

export async function findLifetimeGold(db: Database, playerId: string): Promise<string | null> {
  const [resource] = await db.select({ lifetimeGoldEarned: playerResources.lifetimeGoldEarned })
    .from(playerResources).where(eq(playerResources.playerId, playerId)).limit(1);
  return resource?.lifetimeGoldEarned ?? null;
}

export async function* iterateLeaderboardSnapshot(
  db: Database,
  batchSize = 1000,
): AsyncGenerator<AuthoritativeScore[]> {
  let cursor: string | null = null;
  for (;;) {
    const rows = await db.select({
      playerId: playerResources.playerId,
      lifetimeGoldEarned: playerResources.lifetimeGoldEarned,
    }).from(playerResources)
      .where(cursor === null ? undefined : gt(playerResources.playerId, cursor))
      .orderBy(playerResources.playerId)
      .limit(batchSize);

    if (rows.length === 0) return;
    yield rows;
    if (rows.length < batchSize) return;
    cursor = rows[rows.length - 1]?.playerId ?? null;
  }
}
