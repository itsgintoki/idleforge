import { createWorldEventRouter, type WorldEventDependencies } from "./world-events/routes.js";
import express, { type ErrorRequestHandler } from "express";
import { z } from "zod";
import { createAuthRouter, type AuthDependencies } from "./auth/routes.js";
import { createPlayerRouter, type PlayerDependencies } from "./players/routes.js";

export type AppDependencies = AuthDependencies & PlayerDependencies & WorldEventDependencies;

const bodyErrorSchema = z.object({
  type: z.enum(["entity.parse.failed", "entity.too.large"]),
});

export const handleError: ErrorRequestHandler = (error: unknown, _req, res, _next) => {
  const parsed = bodyErrorSchema.safeParse(error);
  if (parsed.success) {
    const status = parsed.data.type === "entity.too.large" ? 413 : 400;
    res.status(status).json({ error: "invalid_request_body" });
    return;
  }

  // Raw errors can contain SQL parameters, credentials, or password hashes.
  console.error("Unexpected request failure");
  res.status(500).json({ error: "internal_error" });
};

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
  app.use("/admin/world-events", createWorldEventRouter(dependencies));
  app.use(handleError);
  return app;
}
