import { purchaseRequestSchema, type PurchaseInput } from "../buildings/catalogue.js";
import type { PurchaseResult } from "./purchase.js";
import { z } from "zod";
import type { CollectResult } from "./collect.js";
import { Router } from "express";
import { createAuthentication, type VerifyAccessToken } from "../auth/middleware.js";
import type { PlayerState } from "./queries.js";

const collectBodySchema = z.strictObject({}).optional();

export type PlayerDependencies = {
  purchase: (playerId: string, input: PurchaseInput, key: string) => Promise<PurchaseResult>;
  collect: (playerId: string) => Promise<CollectResult>;
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

  router.post("/collect", async (req, res) => {
    if (!req.auth) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    // The command has no client-controlled amount, time, or player ID.
    const body: unknown = req.body;
    if (!collectBodySchema.safeParse(body).success) {
      res.status(400).json({ error: "invalid_input" });
      return;
    }
    const result = await dependencies.collect(req.auth.sub);
    if (!result.ok) {
      res.status(404).json({ error: result.reason });
      return;
    }
    const { ok, ...collection } = result;
    res.set("Cache-Control", "no-store").json(collection);
  });

  router.post("/purchases", async (req, res) => {
    if (!req.auth) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    const body: unknown = req.body;
    const parsed = purchaseRequestSchema.safeParse({ body, key: req.get("Idempotency-Key") });
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_input" });
      return;
    }
    const result = await dependencies.purchase(req.auth.sub, parsed.data.body, parsed.data.key);
    if (!result.ok) {
      const status = { player_not_found: 404, resource_not_found: 404,
        insufficient_funds: 409, max_level_reached: 409, idempotency_key_reused: 409 }[result.reason];
      res.status(status).json({ error: result.reason });
      return;
    }
    const { ok, ...purchased } = result;
    res.set("Cache-Control", "no-store").status(200).json(purchased);
  });

  return router;
}
