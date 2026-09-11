import { Router } from "express";
import { createAuthentication, type VerifyAccessToken } from "../auth/tokens.js";
import { logEvent, manualBonusSchema } from "./service.js";

export type WorldEventDependencies = {
  verifyAccessToken: VerifyAccessToken;
  isAdmin: (playerId: string) => Promise<boolean>;
  enqueueBonus: (occurrenceId: string) => Promise<{ jobId: string | undefined; occurrenceId: string }>;
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
      // A timeout can happen after enqueueing: retry with the SAME occurrence ID.
      res.status(503).json({ error: "queue_unavailable" });
    }
  });
  return router;
}
