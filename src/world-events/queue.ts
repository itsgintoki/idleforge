import { Queue, type JobsOptions } from "bullmq";
import { Redis } from "ioredis";
import { goldBonusCron, goldBonusJobName, goldBonusSchedulerId, logEvent, worldEventQueueName, type BonusJobData } from "./service.js";

export const bonusJobOptions: JobsOptions = {
  attempts: 5,
  backoff: { type: "exponential", delay: 1000 },
  removeOnComplete: { count: 1000 },
  removeOnFail: false,
};

export type FailedBonusJob = {
  jobId: string;
  attemptsMade: number;
  failedReason: string;
  finishedOn: number | null;
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

  async function enqueueJob(data: BonusJobData, jobId: string) {
    if (connection.status !== "ready") throw new Error("Bonus queue unavailable");
    return queue.add(goldBonusJobName, data, { jobId });
  }

  return {
    queue,
    enqueueJob,
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
    async getFailedJobs(limit: number): Promise<FailedBonusJob[]> {
      const count = Math.min(Math.max(limit, 1), 100);
      const jobs = await queue.getFailed(0, count - 1);
      return jobs.map((job) => ({
        jobId: job.id ?? "unknown",
        attemptsMade: job.attemptsMade,
        failedReason: String(job.failedReason ?? "unknown").slice(0, 500),
        finishedOn: job.finishedOn ?? null,
      }));
    },
    async close() {
      connection.disconnect();
      await queue.close();
    },
  };
}

export type BonusQueue = ReturnType<typeof createBonusQueue>;

export async function registerBonusSchedule(queue: Queue<BonusJobData>): Promise<void> {
  await queue.upsertJobScheduler(goldBonusSchedulerId, { pattern: goldBonusCron, tz: "UTC" }, {
    name: goldBonusJobName,
    data: { source: "scheduled", version: 1, schedulerId: goldBonusSchedulerId },
    opts: bonusJobOptions,
  });
  logEvent("bonus_schedule_registered", { schedulerId: goldBonusSchedulerId, pattern: goldBonusCron, timezone: "UTC" });
}
