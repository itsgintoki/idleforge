import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Redis } from "ioredis";
import type { Pool } from "pg";
import { createApp, type RateLimitName } from "../../src/app.js";
import { createAppDependencies } from "../../src/dependencies.js";
import type { Database } from "../../src/db/client.js";
import { createBonusQueue } from "../../src/world-events/queue.js";
import { createLeaderboardClient, type LeaderboardClient } from "../../src/leaderboard/client.js";
import { createRateLimitClient, type RateLimitOptions } from "../../src/rate-limit.js";
import { createTestDatabase, type TestDatabase } from "./database.js";
import { testJwtSecret, testRedisUrl } from "./env.js";
import { cleanupRedisPrefix, createRedisClient, createTestPrefix } from "./redis.js";

export type TestStackOptions = {
  limits?: Partial<Record<RateLimitName, RateLimitOptions>>;
  rateLimitRedisUrl?: string;
  secondInstance?: boolean;
};

export type TestStack = {
  database: TestDatabase;
  db: Database;
  pool: Pool;
  prefix: string;
  queue: ReturnType<typeof createBonusQueue>;
  leaderboard: LeaderboardClient;
  redis: Redis;
  rateLimitRedis: Redis;
  baseUrl: string;
  secondBaseUrl?: string;
  close: () => Promise<void>;
};

async function startServer(app: ReturnType<typeof createApp>): Promise<{ server: Server; baseUrl: string }> {
  const server = createServer(app);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address() as AddressInfo;
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

function closeServer(server: Server | undefined): Promise<void> {
  return new Promise<void>((resolve) => {
    if (server === undefined) {
      resolve();
      return;
    }
    server.close(() => resolve());
  });
}

export async function createTestStack(options: TestStackOptions = {}): Promise<TestStack> {
  const database = await createTestDatabase();
  const prefix = createTestPrefix();
  const queue = createBonusQueue(testRedisUrl, prefix);
  const leaderboard = createLeaderboardClient(testRedisUrl, prefix);
  const redis = createRedisClient();
  const rateLimitRedis = createRateLimitClient(options.rateLimitRedisUrl ?? testRedisUrl);
  let primary: { server: Server; baseUrl: string } | undefined;
  let secondary: { server: Server; baseUrl: string } | undefined;

  try {
    await queue.waitUntilReady();
    const dependencies = createAppDependencies({
      db: database.db,
      pool: database.pool,
      bonusQueue: queue,
      leaderboard,
      jwtSecret: testJwtSecret,
      refreshTokenTtlSeconds: 30 * 24 * 60 * 60,
    });
    const buildApp = () => createApp({
      ...dependencies,
      rateLimit: { client: rateLimitRedis, prefix, ...(options.limits === undefined ? {} : { limits: options.limits }) },
    });

    primary = await startServer(buildApp());
    if (options.secondInstance === true) secondary = await startServer(buildApp());

    let closed = false;
    return {
      database,
      db: database.db,
      pool: database.pool,
      prefix,
      queue,
      leaderboard,
      redis,
      rateLimitRedis,
      baseUrl: primary.baseUrl,
      ...(secondary === undefined ? {} : { secondBaseUrl: secondary.baseUrl }),
      async close() {
        if (closed) return;
        closed = true;
        await Promise.all([closeServer(primary?.server), closeServer(secondary?.server)]);
        rateLimitRedis.disconnect();
        leaderboard.redis.disconnect();
        await queue.close().catch(() => undefined);
        await cleanupRedisPrefix(redis, prefix).catch(() => undefined);
        redis.disconnect();
        await database.drop();
      },
    };
  } catch (error) {
    await Promise.all([closeServer(primary?.server), closeServer(secondary?.server)]);
    rateLimitRedis.disconnect();
    leaderboard.redis.disconnect();
    await queue.close().catch(() => undefined);
    redis.disconnect();
    await database.drop().catch(() => undefined);
    throw error;
  }
}
