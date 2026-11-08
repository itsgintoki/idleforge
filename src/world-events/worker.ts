import { Worker, UnrecoverableError, type Job } from "bullmq";
import { Redis } from "ioredis";
import { z } from "zod";
import type { Database } from "../db/client.js";
import { worldEventApplyDuration, worldEventRecipientsTotal } from "../metrics.js";
import { markOutboxCompleted } from "./outbox.js";
import {
  applyGoldBonus,
  bonusJobSchema,
  goldBonusJobName,
  logEvent,
  occurrenceForJob,
  scheduledHourStart,
  scheduledOccurrenceId,
  worldEventQueueName,
  type BonusResult,
} from "./service.js";

type JobContext = { occurrenceId: string; jobId: string; attempt: number; hourStart?: Date };

function validatedJob(job: Job<unknown>): JobContext {
  const data = bonusJobSchema.safeParse(job.data);
  const id = z.string().min(1).max(256).safeParse(job.id);
  if (job.name !== goldBonusJobName || !data.success || !id.success) {
    throw new UnrecoverableError("Invalid world-event job");
  }

  const base = { jobId: id.data, attempt: job.attemptsMade + 1 };
  if (data.data.source === "manual") {
    return { ...base, occurrenceId: occurrenceForJob(data.data) };
  }
  const at = new Date();
  return { ...base, occurrenceId: scheduledOccurrenceId(at), hourStart: scheduledHourStart(at) };
}

export function createBonusWorker(
  db: Database, redisUrl: string, prefix: string, afterBonus?: () => Promise<void>,
  batchSize = 1000,
) {
  const connection = new Redis(redisUrl, { maxRetriesPerRequest: null, connectTimeout: 5000 });
  connection.on("error", () => logEvent("redis_worker_error"));
  const worker = new Worker<unknown>(worldEventQueueName, async (job): Promise<BonusResult> => {
    const context = validatedJob(job);
    logEvent("bonus_started", context);
    const startedAt = Date.now();
    let outcome = "failed";
    try {
      const result = await applyGoldBonus(
        db,
        context.occurrenceId,
        context.hourStart === undefined ? { batchSize } : { hourStart: context.hourStart, batchSize },
      );
      outcome = result.replayed ? "replayed" : "applied";
      worldEventRecipientsTotal.inc(result.playersRewarded);
      try {
        await markOutboxCompleted(db, context.occurrenceId);
      } catch {
        logEvent("outbox_completion_failed", context);
      }
      try {
        await afterBonus?.();
      } catch {
        logEvent("bonus_leaderboard_refresh_failed", context);
      }
      logEvent(result.replayed ? "bonus_replayed" : "bonus_applied", { ...context, playersRewarded: result.playersRewarded });
      return result;
    } catch {
      logEvent("bonus_application_failed", context);
      throw new Error("World bonus application failed");
    } finally {
      worldEventApplyDuration.observe({ outcome }, (Date.now() - startedAt) / 1000);
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
