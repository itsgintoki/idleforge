import type { Database } from "../db/client.js";
import { logEvent } from "../world-events/service.js";
import type { LeaderboardClient } from "./client.js";
import { findLifetimeGold, iterateLeaderboardSnapshot } from "./queries.js";
import {
  leaderboardSnapshotBatchSize,
  publishLeaderboardSnapshot,
  writeLeaderboardScore,
  type PreparedScore,
} from "./store.js";

export async function syncPlayerLeaderboard(
  db: Database,
  leaderboard: LeaderboardClient,
  playerId: string,
): Promise<void> {
  const { redis, key } = leaderboard;

  try {
    const lifetimeGold = await findLifetimeGold(db, playerId);

    if (lifetimeGold === null) {
      await redis.multi().zrem(key, playerId).hdel(leaderboard.exactKey, playerId).exec();
    } else {
      await writeLeaderboardScore(leaderboard, playerId, lifetimeGold);
    }
  } catch (error) {
    const invalidScore = error instanceof TypeError;
    if (invalidScore) {
      try {
        await redis.del(leaderboard.readyKey);
      } catch (invalidationError) {
        const message = invalidationError instanceof Error ? invalidationError.message : String(invalidationError);
        logEvent("leaderboard_ready_invalidation_failed", {
          playerId, reason: "invalid_score", error: message,
        }, "error");
      }
    }
    logEvent("leaderboard_player_sync_failed", {
      playerId, reason: invalidScore ? "invalid_score" : "unavailable",
    });
  }
}

export type ReconcileResult =
  | { ok: true; players: number; published: boolean }
  | { ok: false; reason: "invalid_score" | "unavailable" };

export async function reconcileLeaderboard(
  db: Database,
  leaderboard: LeaderboardClient,
): Promise<ReconcileResult> {
  const { redis } = leaderboard;

  try {
    const startedAt = new Date().toISOString();
    const pages = async function* (): AsyncGenerator<PreparedScore[]> {
      for await (const page of iterateLeaderboardSnapshot(db, leaderboardSnapshotBatchSize)) {
        yield page.map((row) => ({
          playerId: row.playerId, lifetimeGoldEarned: row.lifetimeGoldEarned,
        }));
      }
    };

    const result = await publishLeaderboardSnapshot(leaderboard, pages(), startedAt);
    return { ok: true, players: result.players, published: result.published };
  } catch (error) {
    const reason = error instanceof TypeError ? "invalid_score" : "unavailable";
    if (reason === "invalid_score") {
      try {
        await redis.del(leaderboard.readyKey);
      } catch (invalidationError) {
        const message = invalidationError instanceof Error ? invalidationError.message : String(invalidationError);
        logEvent("leaderboard_ready_invalidation_failed", {
          reason, error: message,
        }, "error");
      }
    }
    logEvent("leaderboard_reconcile_failed", { reason });
    return { ok: false, reason };
  }
}
