import { Queue, type JobsOptions } from "bullmq";
import { Redis } from "ioredis";
import { bonusJobSchema, goldBonusCron, goldBonusJobName, goldBonusSchedulerId, logEvent, worldEventQueueName, type BonusJobData } from "./service.js";

export const bonusJobOptions: JobsOptions = {
  attempts: 5,
  backoff: { type: "exponential", delay: 1000 },
  removeOnComplete: { count: 1000 },
  removeOnFail: false,
};

export function createBonusQueue(redisUrl: string, prefix: string) {
  const connection = new Redis(redisUrl, {
    maxRetriesPerRequest: 1, enableOfflineQueue: false, connectTimeout: 5000, commandTimeout: 5000,
  });
  connection.on("error", () => logEvent("redis_producer_error"));
  const queue = new Queue<BonusJobData>(worldEventQueueName, {
    connection, prefix, defaultJobOptions: bonusJobOptions,
  });
  queue.on("error", () => logEvent("bonus_queue_error"));
  return {
    queue,
    async enqueueManual(occurrenceId: string): Promise<{ jobId: string | undefined; occurrenceId: string }> {
      const data = bonusJobSchema.parse({ source: "manual", version: 1, occurrenceId: occurrenceId.toLowerCase() });
      if (connection.status !== "ready") throw new Error("Bonus queue unavailable");
      // Job deduplication is an optimization. PostgreSQL remains the final guard,
      // including after completed jobs have been removed from Redis.
      const job = await queue.add(goldBonusJobName, data, { jobId: `manual-${occurrenceId.toLowerCase()}` });
      return { jobId: job.id, occurrenceId: `manual-${occurrenceId.toLowerCase()}` };
    },
    async waitUntilReady(): Promise<void> {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          queue.waitUntilReady(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error("Bonus queue unavailable")), 5000);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    },
    async close() {
      connection.disconnect();
      await queue.close();
    },
  };
}

export async function registerBonusSchedule(queue: Queue<BonusJobData>): Promise<void> {
  await queue.upsertJobScheduler(goldBonusSchedulerId, { pattern: goldBonusCron, tz: "UTC" }, {
    name: goldBonusJobName,
    data: { source: "scheduled", version: 1, schedulerId: goldBonusSchedulerId },
    opts: bonusJobOptions,
  });
  logEvent("bonus_schedule_registered", { schedulerId: goldBonusSchedulerId, pattern: goldBonusCron, timezone: "UTC" });
}
