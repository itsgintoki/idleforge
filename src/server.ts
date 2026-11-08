import { createBonusQueue } from "./world-events/queue.js";
import { createApp } from "./app.js";
import { envSchema } from "./config.js";
import { createDatabase } from "./db/client.js";
import { createAppDependencies } from "./dependencies.js";
import { createLeaderboardClient } from "./leaderboard/client.js";
import { createRateLimitClient } from "./rate-limit.js";
import { setPoolMetrics, setQueueMetrics } from "./metrics.js";
import { logEvent } from "./world-events/service.js";

const config = envSchema.parse(process.env);
const port = config.PORT;
const { db, pool } = createDatabase(config.DATABASE_URL);
const bonusQueue = createBonusQueue(config.REDIS_URL, config.QUEUE_PREFIX);
const leaderboard = createLeaderboardClient(config.REDIS_URL, config.QUEUE_PREFIX);
const rateLimitRedis = createRateLimitClient(config.REDIS_URL);
const app = createApp({
  ...createAppDependencies({
    db, pool, bonusQueue, leaderboard, jwtSecret: config.JWT_SECRET,
    refreshTokenTtlSeconds: config.REFRESH_TOKEN_TTL_DAYS * 86_400,
  }),
  rateLimit: { client: rateLimitRedis, prefix: config.QUEUE_PREFIX },
  refreshMetrics: async () => {
    setPoolMetrics(pool);
    await setQueueMetrics(bonusQueue.queue);
  },
});

pool.on("error", () => logEvent("database_pool_error", {}, "error"));

const server = app.listen(port, () => {
  logEvent("api_listening", { port });
});

let closing = false;
function shutdown() {
  if (closing) return;
  closing = true;
  logEvent("api_shutdown_started");
  server.close(() => {
    leaderboard.redis.disconnect();
    rateLimitRedis.disconnect();
    void Promise.all([pool.end(), bonusQueue.close()])
      .then(() => logEvent("api_stopped"))
      .catch(() => {
        logEvent("api_shutdown_failed", {}, "error");
        process.exitCode = 1;
      });
  });
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
