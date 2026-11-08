import { sql } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "../db/client.js";

export type LedgerMismatch = {
  playerId: string;
  gold: string;
  lifetimeGoldEarned: string;
  ledgerGold: string;
  ledgerLifetime: string;
};

export type LedgerVerification =
  | { ok: true; playersChecked: number }
  | { ok: false; mismatches: number; sample: LedgerMismatch[] };

const mismatchSchema = z.object({
  playerId: z.uuid(),
  gold: z.string(),
  lifetimeGoldEarned: z.string(),
  ledgerGold: z.string(),
  ledgerLifetime: z.string(),
  total: z.number().int().nonnegative().optional(),
});

export async function verifyLedger(db: Database): Promise<LedgerVerification> {
  const result = await db.execute(sql`
    WITH mismatches AS (
      SELECT r.player_id AS "playerId",
             r.gold,
             r.lifetime_gold_earned AS "lifetimeGoldEarned",
             COALESCE(SUM(l.amount) FILTER (
               WHERE l.reference_id IS DISTINCT FROM 'migration:lifetime-baseline'
             ), 0) AS "ledgerGold",
             COALESCE(SUM(l.amount) FILTER (
               WHERE l.kind <> 'baseline' AND l.amount > 0
             ), 0) + COALESCE(SUM(l.amount) FILTER (
               WHERE l.reference_id = 'migration:lifetime-baseline'
             ), 0) AS "ledgerLifetime"
      FROM player_resources r
      LEFT JOIN ledger_entries l ON l.player_id = r.player_id
      GROUP BY r.player_id, r.gold, r.lifetime_gold_earned
      HAVING COALESCE(SUM(l.amount) FILTER (
                 WHERE l.reference_id IS DISTINCT FROM 'migration:lifetime-baseline'
               ), 0) <> r.gold
          OR COALESCE(SUM(l.amount) FILTER (
                 WHERE l.kind <> 'baseline' AND l.amount > 0
               ), 0) + COALESCE(SUM(l.amount) FILTER (
                 WHERE l.reference_id = 'migration:lifetime-baseline'
               ), 0) <> r.lifetime_gold_earned
    )
    SELECT *, count(*) OVER ()::int AS total FROM mismatches
    ORDER BY "playerId" LIMIT 20
  `);

  const rows = result.rows.map((row) => mismatchSchema.parse(row));
  if (rows.length === 0) {
    const countResult = await db.execute(sql`
      SELECT count(*)::int AS count FROM player_resources
    `);
    const playersChecked = Number(
      (countResult.rows[0] as { count: number } | undefined)?.count ?? 0,
    );
    return { ok: true, playersChecked };
  }

  const sample = rows.map(({ total: _total, ...mismatch }) => mismatch);
  return { ok: false, mismatches: rows[0]?.total ?? rows.length, sample };
}
