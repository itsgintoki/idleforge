import { randomUUID } from "node:crypto";
import { Redis } from "ioredis";
import { testRedisUrl } from "./env.js";

export function createTestPrefix(): string {
  return `test-${randomUUID().replaceAll("-", "").slice(0, 12)}`;
}

export function createRedisClient(): Redis {
  return new Redis(testRedisUrl, {
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    connectTimeout: 2000,
    commandTimeout: 2000,
  });
}

export async function cleanupRedisPrefix(redis: Redis, prefix: string): Promise<void> {
  let cursor = "0";
  do {
    const [next, keys] = await redis.scan(cursor, "MATCH", `${prefix}:*`, "COUNT", "500");
    cursor = next;
    if (keys.length > 0) await redis.unlink(...keys);
  } while (cursor !== "0");
}
