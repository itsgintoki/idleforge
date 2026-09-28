import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { NextFunction, Request, Response } from "express";

type RequestContext = { requestId: string };

const storage = new AsyncLocalStorage<RequestContext>();

export function getRequestId(): string | undefined {
  return storage.getStore()?.requestId;
}

declare module "express-serve-static-core" {
  interface Request {
    requestId?: string;
  }
}

export function requestIdMiddleware(req: Request, res: Response, next: NextFunction): void {
  const incoming = req.get("X-Request-ID");
  const requestId = incoming !== undefined && incoming.length >= 1 && incoming.length <= 128
    ? incoming
    : randomUUID();
  req.requestId = requestId;
  res.set("X-Request-ID", requestId);
  storage.run({ requestId }, () => next());
}

export function requestLoggerMiddleware(req: Request, res: Response, next: NextFunction): void {
  const startedAt = Date.now();
  res.on("finish", () => {
    const requestId = req.requestId ?? getRequestId();
    console.log(JSON.stringify({
      time: new Date().toISOString(),
      level: "info",
      event: "http_request",
      ...(requestId === undefined ? {} : { requestId }),
      method: req.method,
      path: req.path,
      status: res.statusCode,
      durationMs: Date.now() - startedAt,
    }));
  });
  next();
}
