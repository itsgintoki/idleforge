import { Router } from "express";
import { createAuthentication, type VerifyAccessToken } from "../auth/middleware.js";
import type { PlayerState } from "./queries.js";

export type PlayerDependencies = {
  verifyAccessToken: VerifyAccessToken;
  findPlayerState: (playerId: string) => Promise<PlayerState | null>;
};

export function createPlayerRouter(dependencies: PlayerDependencies) {
  const router = Router();
  router.use(createAuthentication(dependencies.verifyAccessToken));

  router.get("/me", async (req, res) => {
    // The property is optional in Express's type because public routes lack it.
    if (!req.auth) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }

    const state = await dependencies.findPlayerState(req.auth.sub);
    if (!state) {
      res.status(404).json({ error: "player_state_not_found" });
      return;
    }

    res.set("Cache-Control", "no-store").json(state);
  });

  return router;
}
