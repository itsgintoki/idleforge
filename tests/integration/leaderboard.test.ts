import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLeaderboardClient, type LeaderboardClient } from "../../src/leaderboard/client.js";
import { reconcileLeaderboard, syncPlayerLeaderboard } from "../../src/leaderboard/service.js";
import { readLeaderboard, writeLeaderboardScore } from "../../src/leaderboard/store.js";
import { playerResources, players } from "../../src/db/schema.js";
import { createTestDatabase, type TestDatabase } from "../harness/database.js";
import { testRedisUrl } from "../harness/env.js";
import { createPlayer, type TestPlayer } from "../harness/factories.js";
import { cleanupRedisPrefix, createRedisClient, createTestPrefix } from "../harness/redis.js";
import type { Redis } from "ioredis";

let database: TestDatabase;
let redis: Redis;
let leaderboard: LeaderboardClient;
let prefix: string;

beforeAll(async () => {
  database = await createTestDatabase();
  redis = createRedisClient();
  prefix = createTestPrefix();
  leaderboard = createLeaderboardClient(testRedisUrl, prefix);
});

afterAll(async () => {
  leaderboard.redis.disconnect();
  await cleanupRedisPrefix(redis, prefix);
  redis.disconnect();
  await database.drop();
});

async function countResources(): Promise<number> {
  const result = await database.db.execute(sql`SELECT count(*)::int AS count FROM player_resources`);
  return Number((result.rows[0] as { count: number } | undefined)?.count ?? 0);
}

describe("leaderboard projection", () => {
  it("publishes a complete snapshot and serves ranked reads", async () => {
    const first = await createPlayer(database.db, { lifetime: "300.000000" });
    const second = await createPlayer(database.db, { lifetime: "200.000000" });
    const third = await createPlayer(database.db, { lifetime: "100.000000" });

    const reconciled = await reconcileLeaderboard(database.db, leaderboard);
    expect(reconciled).toEqual({ ok: true, players: 3, published: true });

    const page = await readLeaderboard(leaderboard, first.id, 10);
    expect(page.entries).toEqual([
      { rank: 1, playerId: first.id, lifetimeGoldEarned: "300.000000" },
      { rank: 2, playerId: second.id, lifetimeGoldEarned: "200.000000" },
      { rank: 3, playerId: third.id, lifetimeGoldEarned: "100.000000" },
    ]);
    expect(page.me).toEqual({ rank: 1, playerId: first.id, lifetimeGoldEarned: "300.000000" });
    expect(Number.isNaN(Date.parse(page.lastReconciledAt))).toBe(false);
  });

  it("keeps the exact hash and ranking set consistent for delayed smaller writes", async () => {
    const first = await createPlayer(database.db, { lifetime: "250.000000" });
    await reconcileLeaderboard(database.db, leaderboard);

    await writeLeaderboardScore(leaderboard, first.id, "500.000000");
    const raised = await readLeaderboard(leaderboard, first.id, 10);
    expect(raised.me?.lifetimeGoldEarned).toBe("500.000000");

    const ignored = await writeLeaderboardScore(leaderboard, first.id, "1.000000");
    expect(ignored).toBe(false);
    const unchanged = await readLeaderboard(leaderboard, first.id, 10);
    expect(unchanged.me?.lifetimeGoldEarned).toBe("500.000000");
    expect(await redis.hget(leaderboard.exactKey, first.id)).toBe("500.000000");
    expect(Number(await redis.zscore(leaderboard.key, first.id))).toBe(500);
  });

  it("removes deleted players from both projection structures", async () => {
    const doomed = await createPlayer(database.db, { lifetime: "50.000000" });
    await syncPlayerLeaderboard(database.db, leaderboard, doomed.id);
    expect(await redis.zscore(leaderboard.key, doomed.id)).not.toBeNull();
    expect(await redis.hget(leaderboard.exactKey, doomed.id)).not.toBeNull();

    await database.db.delete(players).where(eq(players.id, doomed.id));
    await syncPlayerLeaderboard(database.db, leaderboard, doomed.id);
    expect(await redis.zscore(leaderboard.key, doomed.id)).toBeNull();
    expect(await redis.hget(leaderboard.exactKey, doomed.id)).toBeNull();
  });

  it("returns 503-equivalent failure for a missing or stale projection, then rebuilds", async () => {
    await redis.del(leaderboard.key, leaderboard.exactKey, leaderboard.readyKey);
    await expect(readLeaderboard(leaderboard, "00000000-0000-4000-8000-000000000000", 10))
      .rejects.toThrow();

    const rebuilt = await reconcileLeaderboard(database.db, leaderboard);
    expect(rebuilt.ok).toBe(true);
    const page = await readLeaderboard(leaderboard, "00000000-0000-4000-8000-000000000000", 10);
    expect(page.entries.length).toBeGreaterThan(0);
    expect(page.me).toBeNull();

    await redis.set(
      leaderboard.readyKey,
      JSON.stringify({ startedAtMs: Date.now() - 120_000, playerCount: 0 }),
    );
    await expect(readLeaderboard(leaderboard, "00000000-0000-4000-8000-000000000000", 10))
      .rejects.toThrow();

    await reconcileLeaderboard(database.db, leaderboard);
    const afterStale = await readLeaderboard(
      leaderboard, "00000000-0000-4000-8000-000000000000", 10,
    );
    expect(afterStale.entries.length).toBeGreaterThan(0);
  });

  it("gives tied scores distinct ranks in member order", async () => {
    const tiedA: TestPlayer = await createPlayer(database.db, { lifetime: "42.000000" });
    const tiedB = await createPlayer(database.db, { lifetime: "42.000000" });
    await reconcileLeaderboard(database.db, leaderboard);

    const page = await readLeaderboard(leaderboard, tiedA.id, 100);
    const entries = page.entries.filter((entry) => entry.playerId === tiedA.id || entry.playerId === tiedB.id);
    expect(entries).toHaveLength(2);
    expect(new Set(entries.map((entry) => entry.rank)).size).toBe(2);
    expect(entries.every((entry) => entry.lifetimeGoldEarned === "42.000000")).toBe(true);
  });

  it("serves exact scores beyond the old nine-billion ceiling", async () => {
    const wide = await createPlayer(database.db, { lifetime: "10000000000.123456" });
    const oldCeiling = await createPlayer(database.db, { lifetime: "9007199254.740991" });
    const reconciled = await reconcileLeaderboard(database.db, leaderboard);
    expect(reconciled.ok).toBe(true);

    const page = await readLeaderboard(leaderboard, wide.id, 100);
    const wideEntry = page.entries.find((entry) => entry.playerId === wide.id);
    const ceilingEntry = page.entries.find((entry) => entry.playerId === oldCeiling.id);
    expect(wideEntry?.lifetimeGoldEarned).toBe("10000000000.123456");
    expect(ceilingEntry?.lifetimeGoldEarned).toBe("9007199254.740991");
    expect(wideEntry?.rank).toBeLessThan(ceilingEntry?.rank ?? Number.MAX_SAFE_INTEGER);
    expect(page.me?.lifetimeGoldEarned).toBe("10000000000.123456");
  });

  it("rebuilds a multi-page snapshot completely", async () => {
    const ids = Array.from({ length: 1001 }, () => randomUUID());
    await database.db.insert(players).values(ids.map((id) => ({
      id, email: `bulk-${id}@example.com`, passwordHash: "unused",
    })));
    await database.db.insert(playerResources).values(ids.map((id) => ({
      playerId: id, lifetimeGoldEarned: "1.000000",
    })));

    const total = await countResources();
    const reconciled = await reconcileLeaderboard(database.db, leaderboard);
    expect(reconciled).toEqual({ ok: true, players: total, published: true });

    expect(await redis.zcard(leaderboard.key)).toBe(total);
    expect(await redis.hlen(leaderboard.exactKey)).toBe(total);

    const lowPlayer = ids[0] as string;
    const page = await readLeaderboard(leaderboard, lowPlayer, 5);
    expect(page.entries).toHaveLength(5);
    expect(page.me?.playerId).toBe(lowPlayer);
    expect(page.me?.lifetimeGoldEarned).toBe("1.000000");
  });
});
