import { Router } from "express";
import { z } from "zod";
import { createAuthentication, type VerifyAccessToken } from "../auth/tokens.js";
import type { LeaderboardPage } from "./store.js";

export type LeaderboardDependencies = {
  verifyAccessToken: VerifyAccessToken;
  readLeaderboard: (playerId: string, limit: number) => Promise<LeaderboardPage>;
};

const leaderboardQuerySchema = z.strictObject({
  limit: z.string().regex(/^\d+$/).transform(Number)
    .pipe(z.number().int().min(1).max(100)).default(20),
});

export function createLeaderboardRouter(dependencies: LeaderboardDependencies): Router {
  const router = Router();

  router.use(createAuthentication(dependencies.verifyAccessToken));

  router.get("/", async (req, res) => {
    res.set("Cache-Control", "no-store");
    const parsedQuery = leaderboardQuerySchema.safeParse(req.query);
    if (!parsedQuery.success) {
      res.status(400).json({ error: "invalid_input" });
      return;
    }

    const { limit } = parsedQuery.data;
    const playerId = req.auth?.sub;

    if (!playerId) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }

    try {
      const page = await dependencies.readLeaderboard(playerId, limit);

      res.status(200).json(page);
    } catch {
      res.status(503).json({ error: "leaderboard_unavailable" });
    }
  });

  return router;
}
