import { workerEnvSchema } from "../config.js";
import { createDatabase } from "../db/client.js";
import { createLeaderboardClient, type LeaderboardClient } from "./client.js";
import { reconcileLeaderboard } from "./service.js";
import { logEvent } from "../world-events/service.js";

async function waitUntilReady({ redis }: LeaderboardClient): Promise<void> {
  if (redis.status === "ready") return;
  await new Promise<void>((resolve, reject) => {
    const ready = () => finish();
    const failed = () => finish(new Error("Leaderboard Redis unavailable"));
    const timer = setTimeout(failed, 5000);
    function finish(error?: Error) {
      clearTimeout(timer);
      redis.off("ready", ready).off("error", failed).off("end", failed);
      if (error) reject(error);
      else resolve();
    }
    redis.once("ready", ready).once("error", failed).once("end", failed);
    if (redis.status === "end") failed();
  });
}

async function main(): Promise<void> {
  const config = workerEnvSchema.parse(process.env);
  const { db, pool } = createDatabase(config.DATABASE_URL);
  let leaderboard: LeaderboardClient | undefined;
  pool.on("error", () => logEvent("leaderboard_database_error"));
  try {
    leaderboard = createLeaderboardClient(config.REDIS_URL, config.QUEUE_PREFIX);
    await waitUntilReady(leaderboard);
    const result = await reconcileLeaderboard(db, leaderboard);
    logEvent("leaderboard_rebuild_finished", result);
    if (!result.ok) process.exitCode = 1;
  } finally {
    leaderboard?.redis.disconnect();
    await pool.end();
  }
}

void main().catch(() => {
  logEvent("leaderboard_rebuild_failed");
  process.exitCode = 1;
});
