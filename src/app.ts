import express from "express";
import { createAuthRouter, type AuthDependencies } from "./auth/routes.js";
import { handleError } from "./errors.js";
import { createPlayerRouter, type PlayerDependencies } from "./players/routes.js";

export type AppDependencies = AuthDependencies & PlayerDependencies;

export function createApp(dependencies: AppDependencies) {
  const app = express();
  app.use(express.json({ limit: "16kb" }));

  app.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  app.get("/", (_req, res) => {
    res.json({ name: "IdleForge", version: "0.1.0" });
  });

  app.use("/auth", createAuthRouter(dependencies));
  app.use("/player", createPlayerRouter(dependencies));
  app.use(handleError);
  return app;
}
