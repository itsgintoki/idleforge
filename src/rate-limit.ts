import type { NextFunction, Request, RequestHandler, Response } from "express";
import { Redis } from "ioredis";
import { rateLimitDegradedTotal } from "./metrics.js";
import { logEvent } from "./world-events/service.js";

export type RateLimitOptions = {
  windowMs: number;
  max: number;
};

export type RedisRateLimiterOptions = RateLimitOptions & {
  client: Redis;
  prefix: string;
  name: string;
  key: (req: Request) => string;
};

const fixedWindowScript = `
local current = redis.call('INCR', KEYS[1])
if current == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
return { current, redis.call('PTTL', KEYS[1]) }
`;

export function createRateLimitClient(redisUrl: string): Redis {
  const client = new Redis(redisUrl, {
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    connectTimeout: 2000,
    commandTimeout: 500,
  });
  client.on("error", () => logEvent("rate_limit_redis_error"));
  return client;
}

export function createRateLimiter(options: RedisRateLimiterOptions): RequestHandler {
  const { client, prefix, name, windowMs, max, key } = options;
  let lastDegradedLog = 0;

  return function rateLimiter(req: Request, res: Response, next: NextFunction): void {
    const bucketKey = `${prefix}:ratelimit:${name}:${key(req)}`;
    void client.eval(fixedWindowScript, 1, bucketKey, String(windowMs))
      .then((raw) => {
        const [count = 0, ttl = 0] = raw as [number | string, number | string];
        if (Number(count) > max) {
          const retryAfterSeconds = Math.max(1, Math.ceil(Number(ttl) / 1000));
          res.set("Retry-After", String(retryAfterSeconds));
          res.status(429).json({ error: "rate_limited" });
          return;
        }
        next();
      })
      .catch(() => {
        rateLimitDegradedTotal.inc({ name });
        const now = Date.now();
        if (now - lastDegradedLog > 10_000) {
          lastDegradedLog = now;
          logEvent("rate_limit_degraded", { name }, "error");
        }
        next();
      });
  };
}

export function ipKey(req: Request): string {
  return req.ip ?? "unknown";
}

export function playerOrIpKey(req: Request): string {
  return req.auth?.sub ?? req.ip ?? "unknown";
}
