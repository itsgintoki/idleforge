import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from "prom-client";
import type { Pool } from "pg";

export const metricsRegistry = new Registry();
collectDefaultMetrics({ register: metricsRegistry });

export const httpRequestDuration = new Histogram({
  name: "http_request_duration_seconds",
  help: "Duration of HTTP requests in seconds.",
  labelNames: ["method", "route", "status"] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [metricsRegistry],
});

export const httpRequestsTotal = new Counter({
  name: "http_requests_total",
  help: "Total number of HTTP requests.",
  labelNames: ["method", "route", "status"] as const,
  registers: [metricsRegistry],
});

export const rateLimitDegradedTotal = new Counter({
  name: "rate_limit_degraded_total",
  help: "Rate limit checks that failed open because Redis was unavailable.",
  labelNames: ["name"] as const,
  registers: [metricsRegistry],
});

export const outboxPendingJobs = new Gauge({
  name: "outbox_pending_jobs",
  help: "World-event intents waiting to be dispatched or completed.",
  registers: [metricsRegistry],
});

export const worldEventApplyDuration = new Histogram({
  name: "world_event_apply_duration_seconds",
  help: "Time to apply a world-event occurrence.",
  labelNames: ["outcome"] as const,
  buckets: [0.01, 0.05, 0.1, 0.5, 1, 2.5, 5, 10, 30],
  registers: [metricsRegistry],
});

export const worldEventRecipientsTotal = new Counter({
  name: "world_event_recipients_total",
  help: "Players rewarded by world events.",
  registers: [metricsRegistry],
});

export const leaderboardRefreshDuration = new Histogram({
  name: "leaderboard_refresh_duration_seconds",
  help: "Time to rebuild the leaderboard projection.",
  labelNames: ["outcome"] as const,
  buckets: [0.01, 0.05, 0.1, 0.5, 1, 2.5, 5, 10, 30],
  registers: [metricsRegistry],
});

export const leaderboardLastSuccess = new Gauge({
  name: "leaderboard_last_success_timestamp_seconds",
  help: "Unix timestamp of the last successful leaderboard reconciliation.",
  registers: [metricsRegistry],
});

export const dbPoolConnections = new Gauge({
  name: "db_pool_connections",
  help: "PostgreSQL pool connections by state.",
  labelNames: ["state"] as const,
  registers: [metricsRegistry],
});

export const bullmqJobs = new Gauge({
  name: "bullmq_jobs",
  help: "BullMQ jobs by state.",
  labelNames: ["state"] as const,
  registers: [metricsRegistry],
});

export function setPoolMetrics(pool: Pool): void {
  dbPoolConnections.set({ state: "total" }, pool.totalCount);
  dbPoolConnections.set({ state: "idle" }, pool.idleCount);
  dbPoolConnections.set({ state: "waiting" }, pool.waitingCount);
}

export interface JobCountSource {
  getJobCounts: () => Promise<Record<string, number>>;
}

export async function setQueueMetrics(queue: JobCountSource): Promise<void> {
  const counts = await queue.getJobCounts();
  for (const [state, count] of Object.entries(counts)) {
    if (typeof count === "number") bullmqJobs.set({ state }, count);
  }
}
