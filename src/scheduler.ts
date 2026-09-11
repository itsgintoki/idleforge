import { workerEnvSchema } from "./config.js";
import { createBonusQueue, registerBonusSchedule } from "./world-events/queue.js";
import { logEvent } from "./world-events/service.js";

const config = workerEnvSchema.parse(process.env);
const bonusQueue = createBonusQueue(config.REDIS_URL, config.QUEUE_PREFIX);
try {
  await bonusQueue.waitUntilReady();
  await registerBonusSchedule(bonusQueue.queue);
} catch {
  logEvent("scheduler_registration_failed");
  process.exitCode = 1;
} finally {
  await bonusQueue.close();
}
