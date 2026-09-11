import { workerEnvSchema } from "./config.js";
import { createDatabase } from "./db/client.js";
import { createBonusWorker } from "./world-events/worker.js";
import { logEvent } from "./world-events/service.js";

const config = workerEnvSchema.parse(process.env);
const { db, pool } = createDatabase(config.DATABASE_URL);
const bonusWorker = createBonusWorker(db, config.REDIS_URL, config.QUEUE_PREFIX);
pool.on("error", () => logEvent("worker_database_connection_error"));
bonusWorker.worker.on("ready", () => logEvent("worker_ready"));

let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  try {
    await bonusWorker.close(); // Wait for the active job before closing PostgreSQL.
    await pool.end();
    logEvent("worker_stopped");
  } catch {
    logEvent("worker_shutdown_failed");
    process.exitCode = 1;
  }
}
process.once("SIGINT", () => { void shutdown(); });
process.once("SIGTERM", () => { void shutdown(); });
