import type { Pool } from "pg";
import type { CoreDependencies } from "./app.js";
import type { Database } from "./db/client.js";
import { login, signup } from "./auth/service.js";
import { issueAccessToken, verifyAccessToken } from "./auth/tokens.js";
import {
  issueRefreshToken as issueRefreshTokenRecord,
  revokeRefreshToken as revokeRefreshTokenRecord,
  rotateRefreshToken as rotateRefreshTokenRecord,
} from "./auth/refresh.js";
import { findPlayerById, findPlayerState } from "./players/queries.js";
import { purchase } from "./players/purchase.js";
import { collect } from "./players/collect.js";
import { syncPlayerLeaderboard } from "./leaderboard/service.js";
import { readLeaderboard } from "./leaderboard/store.js";
import type { LeaderboardClient } from "./leaderboard/client.js";
import type { createBonusQueue } from "./world-events/queue.js";
import { markOutboxDispatched, recordBonusIntent } from "./world-events/outbox.js";
import { bonusJobSchema, logEvent } from "./world-events/service.js";

type BonusQueue = ReturnType<typeof createBonusQueue>;

export type AppWiring = {
  db: Database;
  pool: Pool;
  bonusQueue: BonusQueue;
  leaderboard: LeaderboardClient;
  jwtSecret: string;
  refreshTokenTtlSeconds: number;
};

export function createAppDependencies({
  db, pool, bonusQueue, leaderboard, jwtSecret, refreshTokenTtlSeconds,
}: AppWiring): CoreDependencies {
  return {
    isAdmin: async (playerId) => (await findPlayerById(db, playerId))?.role === "admin",
    enqueueBonus: async (occurrenceId) => {
      const normalized = `manual-${occurrenceId.toLowerCase()}`;
      await recordBonusIntent(db, normalized);
      try {
        const data = bonusJobSchema.parse({
          source: "manual", version: 1, occurrenceId: occurrenceId.toLowerCase(),
        });
        const job = await bonusQueue.enqueueJob(data, normalized);
        await markOutboxDispatched(db, normalized);
        return { jobId: job.id, occurrenceId: normalized, status: "accepted" as const };
      } catch {
        logEvent("bonus_intent_pending_dispatch", { occurrenceId: normalized }, "error");
        return { jobId: undefined, occurrenceId: normalized, status: "accepted" as const };
      }
    },
    getFailedJobs: (limit) => bonusQueue.getFailedJobs(limit),
    signup: async (input) => {
      const result = await signup(db, input);
      if (result.ok) await syncPlayerLeaderboard(db, leaderboard, result.player.id);
      return result;
    },
    login: (input) => login(db, input),
    issueAccessToken: (player) => issueAccessToken(player, jwtSecret),
    issueRefreshToken: async (playerId) => {
      const issued = await issueRefreshTokenRecord(db, playerId, refreshTokenTtlSeconds);
      return { refreshToken: issued.refreshToken, expiresIn: refreshTokenTtlSeconds };
    },
    rotateRefreshToken: (token) => rotateRefreshTokenRecord(db, token, refreshTokenTtlSeconds),
    revokeRefreshToken: (token) => revokeRefreshTokenRecord(db, token),
    verifyAccessToken: (token) => verifyAccessToken(token, jwtSecret),
    purchase: async (playerId, input, key) => {
      const result = await purchase(db, playerId, input, key);
      if (result.ok) await syncPlayerLeaderboard(db, leaderboard, playerId);
      return result;
    },
    collect: async (playerId) => {
      const result = await collect(db, playerId);
      if (result.ok) await syncPlayerLeaderboard(db, leaderboard, playerId);
      return result;
    },
    findPlayerState: (playerId) => findPlayerState(db, playerId),
    readLeaderboard: (playerId, limit) => readLeaderboard(leaderboard, playerId, limit),
    checkReadiness: async () => {
      const [dbOk, redisOk] = await Promise.all([
        pool.query("SELECT 1").then(() => true).catch(() => false),
        leaderboard.redis.ping().then((pong) => pong === "PONG").catch(() => false),
      ]);
      return { db: dbOk, redis: redisOk };
    },
  };
}
