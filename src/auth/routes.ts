import { Router } from "express";
import { z } from "zod";
import type { PublicPlayer } from "../db/schema.js";
import {
  loginSchema,
  signupSchema,
  type LoginInput,
  type LoginResult,
  type SignupInput,
  type SignupResult,
} from "./service.js";
import { accessTokenLifetimeSeconds } from "./tokens.js";
import type { RotateRefreshResult } from "./refresh.js";

export type Signup = (input: SignupInput) => Promise<SignupResult>;
export type AuthDependencies = {
  signup: Signup;
  login: (input: LoginInput) => Promise<LoginResult>;
  issueAccessToken: (player: PublicPlayer) => string;
  issueRefreshToken: (playerId: string) => Promise<{ refreshToken: string; expiresIn: number }>;
  rotateRefreshToken: (token: string) => Promise<RotateRefreshResult>;
  revokeRefreshToken: (token: string) => Promise<void>;
};

const refreshRequestSchema = z.strictObject({
  refreshToken: z.string().min(1).max(512),
});

export function createAuthRouter({
  signup, login, issueAccessToken, issueRefreshToken, rotateRefreshToken, revokeRefreshToken,
}: AuthDependencies) {
  const router = Router();

  router.post("/signup", async (req, res) => {
    const body: unknown = req.body;
    const parsed = signupSchema.safeParse(body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_input" });
      return;
    }

    const result = await signup(parsed.data);
    if (!result.ok) {
      res.status(409).json({ error: result.reason });
      return;
    }

    res.status(201).json({ player: result.player });
  });

  router.post("/login", async (req, res) => {
    const body: unknown = req.body;
    const parsed = loginSchema.safeParse(body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_input" });
      return;
    }

    const result = await login(parsed.data);
    if (!result.ok) {
      res.status(401).json({ error: result.reason });
      return;
    }

    const accessToken = issueAccessToken(result.player);
    const refresh = await issueRefreshToken(result.player.id);
    res.set("Cache-Control", "no-store").status(200).json({
      accessToken,
      refreshToken: refresh.refreshToken,
      tokenType: "Bearer",
      expiresIn: accessTokenLifetimeSeconds,
      refreshExpiresIn: refresh.expiresIn,
      player: result.player,
    });
  });

  router.post("/refresh", async (req, res) => {
    const parsed = refreshRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_input" });
      return;
    }

    const result = await rotateRefreshToken(parsed.data.refreshToken);
    if (!result.ok) {
      res.status(401).json({ error: result.reason });
      return;
    }

    const accessToken = issueAccessToken(result.player);
    res.set("Cache-Control", "no-store").status(200).json({
      accessToken,
      refreshToken: result.refreshToken,
      tokenType: "Bearer",
      expiresIn: accessTokenLifetimeSeconds,
      refreshExpiresIn: result.expiresIn,
      player: result.player,
    });
  });

  router.post("/logout", async (req, res) => {
    const parsed = refreshRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_input" });
      return;
    }
    await revokeRefreshToken(parsed.data.refreshToken);
    res.status(204).end();
  });

  return router;
}
