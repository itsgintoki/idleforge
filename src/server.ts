import { createBonusQueue } from "./world-events/queue.js";
import { findPlayerById } from "./players/queries.js";
import { purchase } from "./players/purchase.js";
import { collect } from "./players/collect.js";
import { createApp } from "./app.js";
import { envSchema } from "./config.js";
import { createDatabase } from "./db/client.js";
import { login, signup } from "./auth/service.js";
import { issueAccessToken, verifyAccessToken } from "./auth/tokens.js";
import { findPlayerState } from "./players/queries.js";
import { createLeaderboardClient } from "./leaderboard/client.js";
import { syncPlayerLeaderboard } from "./leaderboard/service.js";
import { readLeaderboard } from "./leaderboard/store.js";
import { logEvent } from "./world-events/service.js";

const config = envSchema.parse(process.env);
const port = config.PORT;
const { db, pool } = createDatabase(config.DATABASE_URL);
const bonusQueue = createBonusQueue(config.REDIS_URL, config.QUEUE_PREFIX);
const leaderboard = createLeaderboardClient(config.REDIS_URL, config.QUEUE_PREFIX);
const app = createApp({
  isAdmin: async (playerId) => (await findPlayerById(db, playerId))?.role === "admin",
  enqueueBonus: (occurrenceId) => bonusQueue.enqueueManual(occurrenceId),
  getFailedJobs: (limit) => bonusQueue.getFailedJobs(limit),
  signup: async (input) => {
    const result = await signup(db, input);
    if (result.ok) await syncPlayerLeaderboard(db, leaderboard, result.player.id);
    return result;
  },
  login: (input) => login(db, input),
  issueAccessToken: (player) => issueAccessToken(player, config.JWT_SECRET),
  verifyAccessToken: (token) => verifyAccessToken(token, config.JWT_SECRET),
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
  readLeaderboard: (playerId, limit) => readLeaderboard(leaderboard.redis, leaderboard.key, playerId, limit),
  checkReadiness: async () => {
    const [dbOk, redisOk] = await Promise.all([
      pool.query("SELECT 1").then(() => true).catch(() => false),
      leaderboard.redis.ping().then((pong) => pong === "PONG").catch(() => false),
    ]);
    return { db: dbOk, redis: redisOk };
  },
});

pool.on("error", () => logEvent("database_pool_error", { level: "error" }));

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
    void Promise.all([pool.end(), bonusQueue.close()])
      .then(() => logEvent("api_stopped"))
      .catch(() => {
        logEvent("api_shutdown_failed", { level: "error" });
        process.exitCode = 1;
      });
  });
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
