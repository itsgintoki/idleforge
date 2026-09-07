import type { ErrorRequestHandler } from "express";
import { z } from "zod";

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
