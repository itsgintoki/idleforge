import express from "express";
import { createAuthRouter, type Signup } from "./auth/routes.js";
import { handleError } from "./errors.js";

export function createApp(dependencies: { signup: Signup }) {
  const app = express();
  app.use(express.json({ limit: "16kb" }));

  app.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  app.get("/", (_req, res) => {
    res.json({ name: "IdleForge", version: "0.1.0" });
  });

  app.use("/auth", createAuthRouter(dependencies.signup));
  app.use(handleError);
  return app;
}
