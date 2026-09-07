import { Router } from "express";
import { signupSchema, type SignupInput } from "./schemas.js";
import type { SignupResult } from "./signup.js";

export type Signup = (input: SignupInput) => Promise<SignupResult>;

export function createAuthRouter(signup: Signup) {
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

  return router;
}
