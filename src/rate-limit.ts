import type { NextFunction, Request, Response } from "express";

export type RateLimitOptions = {
  windowMs: number;
  max: number;
};

type Bucket = { count: number; resetAt: number };

export function createRateLimiter(options: RateLimitOptions, key: (req: Request) => string) {
  const buckets = new Map<string, Bucket>();
  const windowMs = options.windowMs;
  const max = options.max;

  function prune(now: number): void {
    if (buckets.size < 1000) return;
    for (const [k, bucket] of buckets) {
      if (bucket.resetAt <= now) buckets.delete(k);
    }
  }

  return function rateLimiter(req: Request, res: Response, next: NextFunction): void {
    const now = Date.now();
    prune(now);
    const bucketKey = key(req);
    const existing = buckets.get(bucketKey);
    if (existing === undefined || existing.resetAt <= now) {
      buckets.set(bucketKey, { count: 1, resetAt: now + windowMs });
      next();
      return;
    }
    existing.count += 1;
    if (existing.count > max) {
      const retryAfterSeconds = Math.max(1, Math.ceil((existing.resetAt - now) / 1000));
      res.set("Retry-After", String(retryAfterSeconds));
      res.status(429).json({ error: "rate_limited" });
      return;
    }
    next();
  };
}

export function ipKey(req: Request): string {
  return req.ip ?? "unknown";
}

export function playerOrIpKey(req: Request): string {
  return req.auth?.sub ?? req.ip ?? "unknown";
}
