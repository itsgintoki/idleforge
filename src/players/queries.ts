import { eq } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { players, playerResources, type Player, type PlayerResource } from "../db/schema.js";
import type { PublicPlayer } from "../auth/types.js";

// Internal database row, including passwordHash; do not send it directly as JSON.
// The caller must validate external IDs as UUIDs before calling this function.
export async function findPlayerById(
  db: Database,
  playerId: string,
): Promise<Player | null> {
  const [player] = await db.select()
    .from(players)
    .where(eq(players.id, playerId))
    .limit(1);

  return player ?? null;
}

// Callers pass the email normalized by the signup/login schema.
export async function findPlayerByEmail(
  db: Database,
  email: string,
): Promise<Player | null> {
  const [player] = await db.select()
    .from(players)
    .where(eq(players.email, email))
    .limit(1);

  return player ?? null;
}

export type PlayerState = {
  player: PublicPlayer;
  resources: Omit<PlayerResource, "playerId">;
};

export async function findPlayerState(db: Database, playerId: string): Promise<PlayerState | null> {
  const [state] = await db.select({
    player: { id: players.id, email: players.email, role: players.role, createdAt: players.createdAt },
    resources: {
      gold: playerResources.gold,
      goldPerSecond: playerResources.goldPerSecond,
      lastCollectedAt: playerResources.lastCollectedAt,
    },
  }).from(players)
    .innerJoin(playerResources, eq(players.id, playerResources.playerId))
    .where(eq(players.id, playerId))
    .limit(1);

  return state ?? null;
}
