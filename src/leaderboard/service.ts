import type { Database } from "../db/client.js";
import { logEvent } from "../world-events/service.js";
import type { LeaderboardClient } from "./client.js";
import { findLifetimeGold, readLeaderboardSnapshot } from "./queries.js";
import { toLeaderboardScore } from "./score.js";
import { publishLeaderboardSnapshot, writeLeaderboardScore } from "./store.js";

export async function syncPlayerLeaderboard(
  db: Database,
  leaderboard: LeaderboardClient,
  playerId: string,
): Promise<void> {
  const { redis, key } = leaderboard;

  try {
    const lifetimeGold = await findLifetimeGold(db, playerId);

    if (lifetimeGold === null) await redis.zrem(key, playerId);
    else await writeLeaderboardScore(redis, key, playerId, lifetimeGold);
  } catch (error) {
    const invalidScore = error instanceof RangeError || error instanceof TypeError;
    if (invalidScore) await redis.del(`${key}:ready`).catch(() => {});
    logEvent("leaderboard_player_sync_failed", {
      playerId, reason: invalidScore ? "invalid_score" : "unavailable",
    });
  }
}

export type ReconcileResult =
  | { ok: true; players: number; published: boolean }
  | { ok: false; reason: "score_out_of_range" | "invalid_score" | "unavailable" };

export async function reconcileLeaderboard(
  db: Database,
  leaderboard: LeaderboardClient,
): Promise<ReconcileResult> {
  const { redis, key } = leaderboard;

  try {
    const snapshot = await readLeaderboardSnapshot(db);

    const preparedScores = snapshot.players.map((player) => ({
      playerId: player.playerId, score: toLeaderboardScore(player.lifetimeGoldEarned),
    }));

    const published = await publishLeaderboardSnapshot(
      redis,
      key,
      preparedScores,
      snapshot.startedAt,
    );

    return {
      ok: true,
      players: preparedScores.length,
      published,
    };
  } catch (error) {
    const reason = error instanceof RangeError ? "score_out_of_range"
      : error instanceof TypeError ? "invalid_score" : "unavailable";
    if (reason !== "unavailable") await redis.del(`${key}:ready`).catch(() => {});
    logEvent("leaderboard_reconcile_failed", { reason });
    return { ok: false, reason };
  }
}
