import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { purchaseCommands, worldEvents } from "../../src/db/schema.js";
import { runRetention } from "../../src/maintenance/retention.js";
import { createTestDatabase, type TestDatabase } from "../harness/database.js";
import { createPlayer } from "../harness/factories.js";

let database: TestDatabase;

beforeAll(async () => {
  database = await createTestDatabase();
});

afterAll(async () => {
  await database.drop();
});

const day = 24 * 60 * 60 * 1000;

describe("retention", () => {
  it("deletes stale purchase commands and zero-progress reservations only", async () => {
    const player = await createPlayer(database.db);
    const old = new Date(Date.now() - 40 * day);

    await database.db.insert(purchaseCommands).values([
      { playerId: player.id, key: "old-command", building: "mine", createdAt: old },
      { playerId: player.id, key: "fresh-command", building: "mine" },
    ]);

    const completedOld = `manual-${randomUUID()}`;
    const staleZeroProgress = `manual-${randomUUID()}`;
    const inProgress = `manual-${randomUUID()}`;
    const freshZeroProgress = `manual-${randomUUID()}`;

    await database.db.insert(worldEvents).values([
      {
        occurrenceId: completedOld, bonus: "100.000000", playersRewarded: 5,
        appliedAt: new Date(Date.now() - 90 * day), createdAt: old,
      },
      {
        occurrenceId: staleZeroProgress, bonus: "100.000000", playersRewarded: 0,
        appliedAt: null, createdAt: old,
      },
      {
        occurrenceId: inProgress, bonus: "100.000000", playersRewarded: 2,
        appliedAt: null, createdAt: old,
      },
      {
        occurrenceId: freshZeroProgress, bonus: "100.000000", playersRewarded: 0,
        appliedAt: null,
      },
    ]);

    const result = await runRetention(database.pool, {
      purchaseCommandRetentionDays: 30,
      staleReservationHours: 24,
    });

    expect(result).toEqual({ skipped: false, purchaseCommands: 1, staleWorldEvents: 1 });

    const remainingCommands = await database.db.select().from(purchaseCommands)
      .where(eq(purchaseCommands.playerId, player.id));
    expect(remainingCommands.map((command) => command.key)).toEqual(["fresh-command"]);

    const remainingEvents = new Set(
      (await database.db.select().from(worldEvents)).map((event) => event.occurrenceId),
    );
    expect(remainingEvents.has(completedOld)).toBe(true);
    expect(remainingEvents.has(staleZeroProgress)).toBe(false);
    expect(remainingEvents.has(inProgress)).toBe(true);
    expect(remainingEvents.has(freshZeroProgress)).toBe(true);
  });

  it("skips when another process holds the retention lock", async () => {
    const client = await database.pool.connect();
    try {
      await client.query("SELECT pg_advisory_lock(hashtext($1)::bigint)", ["idleforge:retention"]);
      const result = await runRetention(database.pool, {
        purchaseCommandRetentionDays: 30,
        staleReservationHours: 24,
      });
      expect(result).toEqual({ skipped: true, purchaseCommands: 0, staleWorldEvents: 0 });
    } finally {
      await client.query("SELECT pg_advisory_unlock(hashtext($1)::bigint)", ["idleforge:retention"]);
      client.release();
    }
  });
});
