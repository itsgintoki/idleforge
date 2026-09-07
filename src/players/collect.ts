import { sql, eq } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "../db/client.js";
import { players } from "../db/schema.js";

export const maximumOfflineSeconds = 8 * 60 * 60;

const collectionSchema = z.object({
  credited: z.string(),
  balance: z.string(),
  lifetimeEarned: z.string(),
  rate: z.string(),
  // Raw Drizzle SQL returns PostgreSQL timestamps as strings.
  collectedAt: z.string().pipe(z.coerce.date()),
});

export type CollectResult =
  | ({ ok: true } & z.infer<typeof collectionSchema>)
  | { ok: false; reason: "player_not_found" | "resource_not_found" };

export async function collect(db: Database, playerId: string): Promise<CollectResult> {
  // Lock before reading the values used for arithmetic. At READ COMMITTED,
  // a waiting collector receives the previous collector's committed row.
  // MATERIALIZED keeps time sampling after the lock and evaluates it only once.
  const result = await db.execute(sql`
    WITH locked AS MATERIALIZED (
      SELECT * FROM player_resources WHERE player_id = ${playerId}::uuid FOR UPDATE
    ), timed AS MATERIALIZED (
      SELECT *, greatest(last_collected_at, date_trunc('milliseconds', clock_timestamp())) AS collected_at
      FROM locked
    ), earned AS MATERIALIZED (
      SELECT *, trunc(
        least(${maximumOfflineSeconds}::numeric,
          greatest(0::numeric, extract(epoch FROM (collected_at - last_collected_at))))
        * gold_per_second, 6)::numeric(30, 6) AS credited
      FROM timed
    )
    UPDATE player_resources AS resource
    SET gold = earned.gold + earned.credited,
        lifetime_gold_earned = earned.lifetime_gold_earned + earned.credited,
        last_collected_at = earned.collected_at
    FROM earned
    WHERE resource.player_id = earned.player_id
    RETURNING earned.credited AS credited, resource.gold AS balance,
      resource.lifetime_gold_earned AS "lifetimeEarned",
      resource.gold_per_second AS rate, resource.last_collected_at AS "collectedAt"
  `);
  const row: unknown = result.rows[0];
  if (row !== undefined) return { ok: true, ...collectionSchema.parse(row) };

  // No mutation occurred. Distinguish missing account from missing resource state.
  const [player] = await db.select({ id: players.id }).from(players)
    .where(eq(players.id, playerId)).limit(1);
  return { ok: false, reason: player ? "resource_not_found" : "player_not_found" };
}
