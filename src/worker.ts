import { workerEnvSchema } from "./config.js";
import { createDatabase } from "./db/client.js";
import { createBonusWorker } from "./world-events/worker.js";
import { logEvent, scheduledHourStart } from "./world-events/service.js";
import { applyScheduledHour, drainOutbox } from "./world-events/outbox.js";
import { createBonusQueue } from "./world-events/queue.js";
import { createLeaderboardClient } from "./leaderboard/client.js";
import { reconcileLeaderboard } from "./leaderboard/service.js";
import { leaderboardRefreshMs } from "./leaderboard/store.js";
import { runRetention } from "./maintenance/retention.js";
import { leaderboardLastSuccess, leaderboardRefreshDuration } from "./metrics.js";
import { startHealthServer } from "./health-server.js";
import { z } from "zod";

const config = workerEnvSchema.parse(process.env);
const { db, pool } = createDatabase(config.DATABASE_URL);
const leaderboard = createLeaderboardClient(config.REDIS_URL, config.QUEUE_PREFIX);
const outboxQueue = createBonusQueue(config.REDIS_URL, config.QUEUE_PREFIX);
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
        const startedAt = Date.now();
        let outcome = "failed";
        try {
          const result = await reconcileLeaderboard(db, leaderboard);
          if (result.ok) {
            outcome = "completed";
            leaderboardLastSuccess.set(Date.now() / 1000);
          }
        } finally {
          leaderboardRefreshDuration.observe({ outcome }, (Date.now() - startedAt) / 1000);
        }
      } while (refreshRequested && !closing);
    })().catch(() => logEvent("leaderboard_refresh_failed")).finally(() => {
      activeRefresh = null;
      if (refreshRequested && !closing) void refreshLeaderboard();
    });
  }
  return activeRefresh;
}

const bonusWorker = createBonusWorker(
  db, config.REDIS_URL, config.QUEUE_PREFIX, refreshLeaderboard, config.BONUS_BATCH_SIZE,
);
const refreshTimer = setInterval(() => { void refreshLeaderboard(); }, leaderboardRefreshMs);
leaderboard.redis.on("ready", () => { void refreshLeaderboard(); });
void refreshLeaderboard();

const worldEventSupervisorMs = 30_000;
let appliedHour: string | undefined;
let supervisorPromise: Promise<void> | undefined;

async function superviseWorldEvents(): Promise<void> {
  await drainOutbox(db, outboxQueue);
  const now = new Date();
  const hour = scheduledHourStart(now).toISOString();
  if (appliedHour === hour) return;
  try {
    const result = await applyScheduledHour(db, now, config.BONUS_BATCH_SIZE);
    appliedHour = hour;
    logEvent(result.replayed ? "scheduled_bonus_replayed" : "scheduled_bonus_applied", {
      occurrenceId: result.occurrenceId, playersRewarded: result.playersRewarded,
    });
    await refreshLeaderboard();
  } catch {
    logEvent("scheduled_bonus_failed", {}, "error");
  }
}

function runWorldEventSupervisor(): void {
  if (closing || supervisorPromise !== undefined) return;
  supervisorPromise = superviseWorldEvents()
    .catch(() => logEvent("world_event_supervisor_failed", {}, "error"))
    .finally(() => { supervisorPromise = undefined; });
}

const supervisorTimer = setInterval(runWorldEventSupervisor, worldEventSupervisorMs);
runWorldEventSupervisor();

const retentionIntervalMs = 60 * 60 * 1000;
let retentionPromise: Promise<void> | undefined;

function runRetentionOnce(): void {
  if (closing || retentionPromise !== undefined) return;
  retentionPromise = runRetention(pool, {
    purchaseCommandRetentionDays: config.PURCHASE_COMMAND_RETENTION_DAYS,
    staleReservationHours: config.WORLD_EVENT_STALE_RESERVATION_HOURS,
  }).then((result) => logEvent("retention_finished", result))
    .catch(() => logEvent("retention_failed", {}, "error"))
    .finally(() => { retentionPromise = undefined; });
}

const retentionTimer = setInterval(runRetentionOnce, retentionIntervalMs);
const retentionInitialTimer = setTimeout(runRetentionOnce, 60_000);

const healthPort = z.coerce.number().int().min(1).max(65535)
  .parse(process.env.PORT ?? config.METRICS_PORT);
const health = startHealthServer({
  port: healthPort,
  pool,
  isHealthy: () => !closing,
  checkReady: async () => {
    const [dbOk, redisOk] = await Promise.all([
      pool.query("SELECT 1").then(() => true).catch(() => false),
      leaderboard.redis.ping().then((pong) => pong === "PONG").catch(() => false),
    ]);
    return { db: dbOk, redis: redisOk };
  },
});
health.server.on("error", () => logEvent("worker_health_server_error", {}, "error"));
logEvent("worker_health_listening", { port: healthPort });
pool.on("error", () => logEvent("worker_database_connection_error"));
bonusWorker.worker.on("ready", () => logEvent("worker_ready"));

async function shutdown() {
  if (closing) return;
  closing = true;
  clearInterval(refreshTimer);
  clearInterval(supervisorTimer);
  clearInterval(retentionTimer);
  clearTimeout(retentionInitialTimer);
  try {
    try {
      await bonusWorker.close();
    } finally {
      try {
        await supervisorPromise;
        await retentionPromise;
        await activeRefresh;
      } finally {
        leaderboard.redis.disconnect();
        await health.close().catch(() => undefined);
        await Promise.all([pool.end(), outboxQueue.close()]);
      }
    }
    logEvent("worker_stopped");
  } catch {
    logEvent("worker_shutdown_failed", {}, "error");
    process.exitCode = 1;
  }
}
process.once("SIGINT", () => { void shutdown(); });
process.once("SIGTERM", () => { void shutdown(); });
