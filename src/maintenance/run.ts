import { workerEnvSchema } from "../config.js";
import { createDatabase } from "../db/client.js";
import { logEvent } from "../world-events/service.js";
import { runRetention } from "./retention.js";

const config = workerEnvSchema.parse(process.env);
const { pool } = createDatabase(config.DATABASE_URL);
try {
  const result = await runRetention(pool, {
    purchaseCommandRetentionDays: config.PURCHASE_COMMAND_RETENTION_DAYS,
    staleReservationHours: config.WORLD_EVENT_STALE_RESERVATION_HOURS,
  });
  logEvent("retention_finished", result);
} catch {
  logEvent("retention_failed", {}, "error");
  process.exitCode = 1;
} finally {
  await pool.end();
}
