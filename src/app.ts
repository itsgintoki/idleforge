import { createWorldEventRouter, type WorldEventDependencies } from "./world-events/routes.js";
import express, { type ErrorRequestHandler } from "express";
import { z } from "zod";
import { createAuthRouter, type AuthDependencies } from "./auth/routes.js";
import { createPlayerRouter, type PlayerDependencies } from "./players/routes.js";
import { createLeaderboardRouter, type LeaderboardDependencies } from "./leaderboard/routes.js";
import { getRequestId, requestIdMiddleware, requestLoggerMiddleware } from "./observability.js";
import { createRateLimiter, ipKey, playerOrIpKey } from "./rate-limit.js";

export type ReadinessState = { db: boolean; redis: boolean };
export type AppDependencies = AuthDependencies & PlayerDependencies & WorldEventDependencies & LeaderboardDependencies & {
  checkReadiness: () => Promise<ReadinessState>;
};

const bodyErrorSchema = z.object({
  type: z.enum(["entity.parse.failed", "entity.too.large"]),
});

export const handleError: ErrorRequestHandler = (error: unknown, req, res, _next) => {
  const parsed = bodyErrorSchema.safeParse(error);
  if (parsed.success) {
    const status = parsed.data.type === "entity.too.large" ? 413 : 400;
    res.status(status).json({ error: "invalid_request_body" });
    return;
  }

  const requestId = req.requestId ?? getRequestId();
  console.error(JSON.stringify({
    time: new Date().toISOString(),
    level: "error",
    event: "http_request_failed",
    ...(requestId === undefined ? {} : { requestId }),
    method: req.method,
    path: req.path,
  }));
  res.status(500).json({ error: "internal_error" });
};

export function createApp(dependencies: AppDependencies) {
  const app = express();
  app.set("trust proxy", 1);
  app.use(requestIdMiddleware);
  app.use(requestLoggerMiddleware);
  app.use(express.json({ limit: "16kb" }));

  const authLimiter = createRateLimiter({ windowMs: 15 * 60 * 1000, max: 100 }, ipKey);
  const playerLimiter = createRateLimiter({ windowMs: 60 * 1000, max: 300 }, playerOrIpKey);
  const leaderboardLimiter = createRateLimiter({ windowMs: 60 * 1000, max: 300 }, playerOrIpKey);
  const adminLimiter = createRateLimiter({ windowMs: 60 * 1000, max: 60 }, playerOrIpKey);

  app.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  app.get("/ready", async (_req, res) => {
    try {
      const checks = await dependencies.checkReadiness();
      if (checks.db && checks.redis) {
        res.json({ status: "ready", checks });
        return;
      }
      res.status(503).json({ status: "not_ready", checks });
    } catch {
      res.status(503).json({ status: "not_ready", checks: { db: false, redis: false } });
    }
  });

  app.get("/", (_req, res) => {
    res.json({ name: "IdleForge", version: "0.1.0" });
  });

  app.use("/auth", authLimiter, createAuthRouter(dependencies));
  app.use("/player", playerLimiter, createPlayerRouter(dependencies));
  app.use("/admin/world-events", adminLimiter, createWorldEventRouter(dependencies));
  app.use("/leaderboard", leaderboardLimiter, createLeaderboardRouter(dependencies));
  app.use(handleError);
  return app;
}
