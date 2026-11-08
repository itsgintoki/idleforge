import { workerEnvSchema } from "../config.js";
import { createDatabase } from "../db/client.js";
import { logEvent } from "../world-events/service.js";
import { verifyLedger } from "./verify.js";

const config = workerEnvSchema.parse(process.env);
const { db, pool } = createDatabase(config.DATABASE_URL);
try {
  const result = await verifyLedger(db);
  if (result.ok) {
    logEvent("ledger_verify_ok", result);
  } else {
    logEvent("ledger_verify_failed", result, "error");
    process.exitCode = 1;
  }
} catch {
  logEvent("ledger_verify_failed", {}, "error");
  process.exitCode = 1;
} finally {
  await pool.end();
}
