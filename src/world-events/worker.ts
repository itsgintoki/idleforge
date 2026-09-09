import { Worker, UnrecoverableError, type Job } from "bullmq";
import { Redis } from "ioredis";
import { z } from "zod";
import type { Database } from "../db/client.js";
import { applyGoldBonus } from "./apply-bonus.js";
import { bonusJobSchema, goldBonusJobName, occurrenceForJob, worldEventQueueName } from "./contracts.js";
import { logEvent } from "./log.js";

function validatedJob(job: Job<unknown>) {
  const data = bonusJobSchema.safeParse(job.data);
  const id = z.string().min(1).max(256).safeParse(job.id);
  if (job.name !== goldBonusJobName || !data.success || !id.success) {
    throw new UnrecoverableError("Invalid world-event job");
  }
  return { occurrenceId: occurrenceForJob(data.data, id.data), jobId: id.data, attempt: job.attemptsMade + 1 };
}

export function createBonusWorker(db: Database, redisUrl: string, prefix: string) {
  const connection = new Redis(redisUrl, { maxRetriesPerRequest: null, connectTimeout: 5000 });
  connection.on("error", () => logEvent("redis_worker_error"));
  const worker = new Worker<unknown>(worldEventQueueName, async (job) => {
    const context = validatedJob(job);
    logEvent("bonus_started", context);
    try {
      const result = await applyGoldBonus(db, context.occurrenceId);
      logEvent(result.replayed ? "bonus_replayed" : "bonus_applied", { ...context, playersRewarded: result.playersRewarded });
      return result;
    } catch {
      logEvent("bonus_application_failed", context);
      // Avoid persisting raw SQL/connection details in BullMQ's failedReason.
      throw new Error("World bonus application failed");
    }
  }, { connection, prefix, concurrency: 1 });
  worker.on("failed", (job, error) => logEvent("bonus_job_failed", {
    jobId: job?.id, attempt: job?.attemptsMade,
    reason: error instanceof UnrecoverableError ? "invalid_job" : "application_failed",
  }));
  worker.on("error", () => logEvent("bonus_worker_error"));
  return {
    worker,
    async close() {
      try { await worker.close(); } finally { connection.disconnect(); }
    },
  };
}
