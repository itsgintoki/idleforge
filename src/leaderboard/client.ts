import { Redis } from "ioredis";
import { logEvent } from "../world-events/service.js";

export type LeaderboardClient = { redis: Redis; key: string };

export function createLeaderboardClient(redisUrl: string, prefix: string): LeaderboardClient {
  const redis = new Redis(redisUrl, {
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    connectTimeout: 2000,
    commandTimeout: 2000,
  });

  redis.on("error", () => {
    logEvent("leaderboard_redis_error");
  });

  const key = `${prefix}:leaderboard:lifetime-gold`;

  return { redis, key };
}
