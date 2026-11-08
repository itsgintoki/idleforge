import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { collect } from "../../src/players/collect.js";
import { playerResources } from "../../src/db/schema.js";
import { createTestDatabase, type TestDatabase } from "../harness/database.js";
import { createPlayer, setLastCollectedAt } from "../harness/factories.js";

let database: TestDatabase;

beforeAll(async () => {
  database = await createTestDatabase();
});

afterAll(async () => {
  await database.drop();
});

function micros(value: string): bigint {
  const [whole = "0", fraction = "0"] = value.split(".");
  return BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, "0"));
}

async function readResource(playerId: string) {
  const [resource] = await database.db.select().from(playerResources)
    .where(eq(playerResources.playerId, playerId));
  if (!resource) throw new Error("resource missing");
  return resource;
}

describe("offline collection", () => {
  it("credits concurrent collectors exactly once for the elapsed interval", async () => {
    const player = await createPlayer(database.db, { rate: "1.000000" });
    await setLastCollectedAt(database.db, player.id, 60);

    const results = await Promise.all(
      Array.from({ length: 20 }, () => collect(database.db, player.id)),
    );

    expect(results.every((result) => result.ok)).toBe(true);
    const credited = results.flatMap((result) => result.ok ? [result.credited] : []);
    const total = credited.reduce((sum, value) => sum + micros(value), 0n);

    // One 60-second interval, not twenty. Allow a small wall-clock margin.
    expect(total >= 60_000_000n).toBe(true);
    expect(total < 62_000_000n).toBe(true);

    const resource = await readResource(player.id);
    expect(micros(resource.gold)).toBe(total);
    expect(micros(resource.lifetimeGoldEarned)).toBe(total);

    const timestamps = results.flatMap((result) => result.ok ? [result.collectedAt.getTime()] : []);
    expect(timestamps.length).toBe(20);
    const final = await readResource(player.id);
    expect(final.lastCollectedAt.getTime()).toBe(Math.max(...timestamps));
  });

  it("clamps offline time to eight hours", async () => {
    const player = await createPlayer(database.db, { rate: "1.000000" });
    await setLastCollectedAt(database.db, player.id, 24 * 60 * 60);

    const result = await collect(database.db, player.id);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.credited).toBe("28800.000000");
    expect(result.balance).toBe("28800.000000");
  });

  it("credits zero and preserves a future checkpoint", async () => {
    const player = await createPlayer(database.db, { rate: "1.000000" });
    await setLastCollectedAt(database.db, player.id, -600);
    const before = await readResource(player.id);

    const result = await collect(database.db, player.id);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.credited).toBe("0.000000");
    expect(result.balance).toBe("0.000000");

    const after = await readResource(player.id);
    expect(after.lastCollectedAt.getTime()).toBe(before.lastCollectedAt.getTime());
  });

  it("truncates fractional gold below one millionth", async () => {
    const player = await createPlayer(database.db, { rate: "0.000001" });
    await setLastCollectedAt(database.db, player.id, 1);

    const result = await collect(database.db, player.id);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.credited).toBe("0.000001");
  });

  it("distinguishes a missing player from a missing resource row", async () => {
    const playerId = crypto.randomUUID();
    const missingPlayer = await collect(database.db, playerId);
    expect(missingPlayer).toEqual({ ok: false, reason: "player_not_found" });

    await database.db.execute(sql`
      INSERT INTO players (id, email, password_hash)
      VALUES (${playerId}::uuid, ${`no-resource-${playerId}@example.com`}, 'unused')
    `);
    const missingResource = await collect(database.db, playerId);
    expect(missingResource).toEqual({ ok: false, reason: "resource_not_found" });
  });
});
