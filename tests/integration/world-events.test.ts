import { randomUUID } from "node:crypto";
import { eq, inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createBonusQueue } from "../../src/world-events/queue.js";
import { applyScheduledHour, drainOutbox, recordBonusIntent } from "../../src/world-events/outbox.js";
import { createBonusWorker } from "../../src/world-events/worker.js";
import {
  applyGoldBonus,
  scheduledHourStart,
  scheduledOccurrenceId,
} from "../../src/world-events/service.js";
import { eventOutbox, playerResources, players, worldEvents } from "../../src/db/schema.js";
import { createTestDatabase, type TestDatabase } from "../harness/database.js";
import { testRedisUrl } from "../harness/env.js";
import { createPlayer } from "../harness/factories.js";
import { cleanupRedisPrefix, createRedisClient, createTestPrefix } from "../harness/redis.js";
import { waitFor } from "../harness/wait.js";
import type { Redis } from "ioredis";

let database: TestDatabase;
let redis: Redis;
let prefix: string;
let queue: ReturnType<typeof createBonusQueue>;

beforeAll(async () => {
  database = await createTestDatabase();
  redis = createRedisClient();
  prefix = createTestPrefix();
  queue = createBonusQueue(testRedisUrl, prefix);
  await queue.waitUntilReady();
});

afterAll(async () => {
  await queue.close();
  await cleanupRedisPrefix(redis, prefix);
  redis.disconnect();
  await database.drop();
});

function micros(value: string): bigint {
  const [whole = "0", fraction = "0"] = value.split(".");
  return BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, "0"));
}

function manualOccurrence(): string {
  return `manual-${randomUUID()}`;
}

async function readResource(playerId: string) {
  const [resource] = await database.db.select().from(playerResources)
    .where(eq(playerResources.playerId, playerId));
  if (!resource) throw new Error("resource missing");
  return resource;
}

async function readOutbox(occurrenceId: string) {
  const [row] = await database.db.select().from(eventOutbox)
    .where(eq(eventOutbox.occurrenceId, occurrenceId));
  return row;
}

describe("world event bonuses", () => {
  it("records a zero-recipient occurrence", async () => {
    const result = await applyGoldBonus(database.db, manualOccurrence());
    expect(result.replayed).toBe(false);
    expect(result.playersRewarded).toBe(0);
    expect(result.bonus).toBe("100.000000");
  });

  it("credits every resource row once and replays duplicates", async () => {
    const recipients = await Promise.all([
      createPlayer(database.db), createPlayer(database.db), createPlayer(database.db),
    ]);
    const occurrenceId = manualOccurrence();

    const first = await applyGoldBonus(database.db, occurrenceId);
    expect(first.replayed).toBe(false);
    expect(first.playersRewarded).toBe(3);

    for (const player of recipients) {
      const resource = await readResource(player.id);
      expect(resource.gold).toBe("100.000000");
      expect(resource.lifetimeGoldEarned).toBe("100.000000");
    }

    const replay = await applyGoldBonus(database.db, occurrenceId);
    expect(replay.replayed).toBe(true);
    expect(replay.playersRewarded).toBe(3);
    expect(replay.appliedAt).toEqual(first.appliedAt);

    for (const player of recipients) {
      const resource = await readResource(player.id);
      expect(resource.gold).toBe("100.000000");
      expect(resource.lifetimeGoldEarned).toBe("100.000000");
    }
  });

  it("serializes concurrent duplicate deliveries", async () => {
    const recipients = await Promise.all([createPlayer(database.db), createPlayer(database.db)]);
    const occurrenceId = manualOccurrence();

    const results = await Promise.all([
      applyGoldBonus(database.db, occurrenceId),
      applyGoldBonus(database.db, occurrenceId),
    ]);

    expect(results.map((result) => result.replayed).sort()).toEqual([false, true]);
    for (const player of recipients) {
      const resource = await readResource(player.id);
      expect(resource.gold).toBe("100.000000");
      expect(resource.lifetimeGoldEarned).toBe("100.000000");
    }
  });

  it("rejects malformed occurrence ids", async () => {
    await expect(applyGoldBonus(database.db, "manual-not-a-uuid")).rejects.toThrow();
  });

  it("applies batches with a persisted cursor and cumulative count", async () => {
    await database.db.delete(players);
    const recipients = await Promise.all(
      Array.from({ length: 5 }, () => createPlayer(database.db)),
    );
    const occurrenceId = manualOccurrence();

    const result = await applyGoldBonus(database.db, occurrenceId, { batchSize: 2 });
    expect(result.replayed).toBe(false);
    expect(result.playersRewarded).toBe(5);

    for (const player of recipients) {
      const resource = await readResource(player.id);
      expect(resource.gold).toBe("100.000000");
      expect(resource.lifetimeGoldEarned).toBe("100.000000");
    }

    const [row] = await database.db.select().from(worldEvents)
      .where(eq(worldEvents.occurrenceId, occurrenceId));
    expect(row?.playersRewarded).toBe(5);
    expect(row?.lastPlayerId).not.toBeNull();
    expect(row?.appliedAt).not.toBeNull();
  });

  it("resumes from persisted progress without recrediting earlier batches", async () => {
    await database.db.delete(players);
    const recipients = await Promise.all(
      Array.from({ length: 5 }, () => createPlayer(database.db)),
    );
    const sortedIds = recipients.map((player) => player.id).sort();
    const firstBatch = sortedIds.slice(0, 2);
    const cursor = firstBatch.at(1);
    if (cursor === undefined) throw new Error("missing cursor");

    const occurrenceId = manualOccurrence();
    await database.db.update(playerResources).set({
      gold: sql`${playerResources.gold} + 100::numeric`,
      lifetimeGoldEarned: sql`${playerResources.lifetimeGoldEarned} + 100::numeric`,
    }).where(inArray(playerResources.playerId, firstBatch));
    await database.db.insert(worldEvents).values({
      occurrenceId,
      bonus: "100.000000",
      playersRewarded: 2,
      lastPlayerId: cursor,
      appliedAt: null,
    });

    const result = await applyGoldBonus(database.db, occurrenceId, { batchSize: 2 });
    expect(result.replayed).toBe(false);
    expect(result.playersRewarded).toBe(5);

    for (const player of recipients) {
      const resource = await readResource(player.id);
      expect(resource.gold).toBe("100.000000");
      expect(resource.lifetimeGoldEarned).toBe("100.000000");
    }

    const [row] = await database.db.select().from(worldEvents)
      .where(eq(worldEvents.occurrenceId, occurrenceId));
    expect(row?.playersRewarded).toBe(5);
    expect(row?.appliedAt).not.toBeNull();
  });
});

describe("world event outbox", () => {
  it("records a manual intent once and dispatches it", async () => {
    const occurrenceId = manualOccurrence();
    expect(await recordBonusIntent(database.db, occurrenceId)).toEqual({ created: true });
    expect(await recordBonusIntent(database.db, occurrenceId)).toEqual({ created: false });

    const drained = await drainOutbox(database.db, queue, 10);
    expect(drained.dispatched).toBe(1);

    const row = await readOutbox(occurrenceId);
    expect(row?.dispatchedAt).not.toBeNull();
    expect(row?.dispatchAttempts).toBe(1);
    expect(row?.lastError).toBeNull();
  });

  it("keeps the intent durable while Redis is unavailable, then delivers after recovery", async () => {
    const occurrenceId = manualOccurrence();
    await recordBonusIntent(database.db, occurrenceId);

    const deadQueue = createBonusQueue("redis://127.0.0.1:1", prefix);
    try {
      const failed = await drainOutbox(database.db, deadQueue, 10);
      expect(failed.dispatched).toBe(0);
      const pending = await readOutbox(occurrenceId);
      expect(pending?.dispatchedAt).toBeNull();
      expect(pending?.lastError).toBe("queue_unavailable");
    } finally {
      await deadQueue.close();
    }

    const recovered = await drainOutbox(database.db, queue, 10);
    expect(recovered.dispatched).toBe(1);
    expect((await readOutbox(occurrenceId))?.dispatchedAt).not.toBeNull();
  });

  it("applies a dispatched intent once and completes the outbox row", async () => {
    await queue.queue.obliterate({ force: true });
    const occurrenceId = manualOccurrence();
    const player = await createPlayer(database.db);
    const before = (await readResource(player.id)).lifetimeGoldEarned;

    await recordBonusIntent(database.db, occurrenceId);
    await drainOutbox(database.db, queue, 10);

    const worker = createBonusWorker(database.db, testRedisUrl, prefix, async () => undefined);
    await worker.worker.waitUntilReady();
    try {
      await waitFor(async () => {
        const [row] = await database.db.select().from(worldEvents)
          .where(eq(worldEvents.occurrenceId, occurrenceId));
        return row?.appliedAt ?? null;
      }, "bonus application");

      await waitFor(async () => {
        const row = await readOutbox(occurrenceId);
        return row?.completedAt ?? null;
      }, "outbox completion");

      const after = (await readResource(player.id)).lifetimeGoldEarned;
      expect(micros(after) - micros(before)).toBe(100_000_000n);

      const settled = await drainOutbox(database.db, queue, 10);
      expect(settled.candidates).toBe(0);
    } finally {
      await worker.close();
    }
  });

  it("does not double-apply an hour recorded under the legacy job-id scheme", async () => {
    const legacyOccurrence = `scheduled-${"b".repeat(64)}`;
    const hour = new Date("2026-01-01T05:00:00.000Z");
    await database.db.insert(worldEvents).values({
      occurrenceId: legacyOccurrence,
      bonus: "100.000000",
      playersRewarded: 3,
      appliedAt: new Date(hour.getTime() + 60_000),
    });

    const result = await applyScheduledHour(database.db, new Date(hour.getTime() + 30 * 60_000));
    expect(result.replayed).toBe(true);
    expect(result.occurrenceId).toBe(legacyOccurrence);
  });

  it("applies the current UTC hour once without a queue trigger", async () => {
    const player = await createPlayer(database.db);
    const before = (await readResource(player.id)).lifetimeGoldEarned;
    const at = new Date();

    const first = await applyScheduledHour(database.db, at);
    expect(first.replayed).toBe(false);
    expect(first.occurrenceId).toBe(scheduledOccurrenceId(at));
    expect(scheduledHourStart(at).getTime()).toBeLessThanOrEqual(at.getTime());

    const second = await applyScheduledHour(database.db, at);
    expect(second.replayed).toBe(true);
    expect(second.occurrenceId).toBe(first.occurrenceId);
    const after = (await readResource(player.id)).lifetimeGoldEarned;
    expect(micros(after) - micros(before)).toBe(100_000_000n);
  });
});
