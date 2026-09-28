import { eq } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { playerResources } from "../db/schema.js";

export type AuthoritativeScore = { playerId: string; lifetimeGoldEarned: string };
export type LeaderboardSnapshot = { startedAt: string; players: AuthoritativeScore[] };

export async function findLifetimeGold(db: Database, playerId: string): Promise<string | null> {
  const [resource] = await db.select({ lifetimeGoldEarned: playerResources.lifetimeGoldEarned })
    .from(playerResources).where(eq(playerResources.playerId, playerId)).limit(1);
  return resource?.lifetimeGoldEarned ?? null;
}

export async function readLeaderboardSnapshot(db: Database): Promise<LeaderboardSnapshot> {
  const startedAt = new Date().toISOString();

  const players = await db.select({
    playerId: playerResources.playerId,
    lifetimeGoldEarned: playerResources.lifetimeGoldEarned,
  }).from(playerResources);

  return { startedAt, players };
}
