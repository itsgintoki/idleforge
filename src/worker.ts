import { workerEnvSchema } from "./config.js";
import { createDatabase } from "./db/client.js";
import { createBonusWorker } from "./world-events/worker.js";
import { logEvent } from "./world-events/service.js";
import { createLeaderboardClient } from "./leaderboard/client.js";
import { reconcileLeaderboard } from "./leaderboard/service.js";
import { leaderboardRefreshMs } from "./leaderboard/store.js";

const config = workerEnvSchema.parse(process.env);
const { db, pool } = createDatabase(config.DATABASE_URL);
const leaderboard = createLeaderboardClient(config.REDIS_URL, config.QUEUE_PREFIX);
let closing = false;
let refreshRequested = false;
let activeRefresh: Promise<void> | null = null;

function refreshLeaderboard(): Promise<void> {
  if (closing) return Promise.resolve();
  refreshRequested = true;
  if (!activeRefresh) {
    activeRefresh = (async () => {
      do {
        refreshRequested = false;
        await reconcileLeaderboard(db, leaderboard);
      } while (refreshRequested && !closing);
    })().catch(() => logEvent("leaderboard_refresh_failed")).finally(() => {
      activeRefresh = null;
      if (refreshRequested && !closing) void refreshLeaderboard();
    });
  }
  return activeRefresh;
}

const bonusWorker = createBonusWorker(db, config.REDIS_URL, config.QUEUE_PREFIX, refreshLeaderboard);
const refreshTimer = setInterval(() => { void refreshLeaderboard(); }, leaderboardRefreshMs);
leaderboard.redis.on("ready", () => { void refreshLeaderboard(); });
void refreshLeaderboard();
pool.on("error", () => logEvent("worker_database_connection_error"));
bonusWorker.worker.on("ready", () => logEvent("worker_ready"));

async function shutdown() {
  if (closing) return;
  closing = true;
  clearInterval(refreshTimer);
  try {
    try {
      await bonusWorker.close();
    } finally {
      try { await activeRefresh; } finally {
        leaderboard.redis.disconnect();
        await pool.end();
      }
    }
    logEvent("worker_stopped");
  } catch {
    logEvent("worker_shutdown_failed");
    process.exitCode = 1;
  }
}
process.once("SIGINT", () => { void shutdown(); });
process.once("SIGTERM", () => { void shutdown(); });
