import { eq } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { players, type Player } from "../db/schema.js";

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
