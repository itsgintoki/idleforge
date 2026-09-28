import { Router } from "express";
import { z } from "zod";
import { createAuthentication, type VerifyAccessToken } from "../auth/tokens.js";
import { logEvent, manualBonusSchema } from "./service.js";
import type { FailedBonusJob } from "./queue.js";

export type WorldEventDependencies = {
  verifyAccessToken: VerifyAccessToken;
  isAdmin: (playerId: string) => Promise<boolean>;
  enqueueBonus: (occurrenceId: string) => Promise<{ jobId: string | undefined; occurrenceId: string }>;
  getFailedJobs: (limit: number) => Promise<readonly FailedBonusJob[]>;
};
export function createWorldEventRouter(dependencies: WorldEventDependencies) {
  const router = Router();
  router.use(createAuthentication(dependencies.verifyAccessToken));
  router.use(async (req, res, next) => {
    if (!req.auth || !(await dependencies.isAdmin(req.auth.sub))) {
      res.status(403).json({ error: "forbidden" });
      return;
    }
    next();
  });
  router.post("/gold-bonus", async (req, res) => {
    const body: unknown = req.body;
    const parsed = manualBonusSchema.safeParse(body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_input" });
      return;
    }
    try {
      const queued = await dependencies.enqueueBonus(parsed.data.occurrenceId);
      logEvent("bonus_enqueued", { ...queued, playerId: req.auth?.sub });
      res.set("Cache-Control", "no-store").status(202).json(queued);
    } catch {
      res.status(503).json({ error: "queue_unavailable" });
    }
  });
  router.get("/jobs/failed", async (req, res) => {
    const parsed = z.strictObject({
      limit: z.string().regex(/^\d+$/).transform(Number)
        .pipe(z.number().int().min(1).max(100)).default(20),
    }).safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_input" });
      return;
    }
    try {
      const jobs = await dependencies.getFailedJobs(parsed.data.limit);
      res.set("Cache-Control", "no-store").status(200).json({ jobs });
    } catch {
      res.status(503).json({ error: "queue_unavailable" });
    }
  });
  return router;
}
