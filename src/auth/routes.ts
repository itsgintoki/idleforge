import { Router } from "express";
import { signupSchema, loginSchema, type SignupInput, type LoginInput } from "./schemas.js";
import type { SignupResult } from "./signup.js";
import type { LoginResult } from "./login.js";
import type { PublicPlayer } from "./types.js";
import { accessTokenLifetimeSeconds } from "./tokens.js";

export type Signup = (input: SignupInput) => Promise<SignupResult>;
export type AuthDependencies = {
  signup: Signup;
  login: (input: LoginInput) => Promise<LoginResult>;
  issueAccessToken: (player: PublicPlayer) => string;
};

export function createAuthRouter({ signup, login, issueAccessToken }: AuthDependencies) {
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
    res.set("Cache-Control", "no-store").status(200).json({
      accessToken,
      tokenType: "Bearer",
      expiresIn: accessTokenLifetimeSeconds,
      player: result.player,
    });
  });

  return router;
}
