import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { purchase } from "../../src/players/purchase.js";
import { playerBuildings, playerResources } from "../../src/db/schema.js";
import { createTestDatabase, type TestDatabase } from "../harness/database.js";
import { createPlayer, setGold, setLastCollectedAt } from "../harness/factories.js";

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
  return resource;
}

async function readBuildings(playerId: string) {
  return database.db.select().from(playerBuildings)
    .where(eq(playerBuildings.playerId, playerId));
}

async function countCommands(playerId: string): Promise<number> {
  const result = await database.db.execute(sql`
    SELECT count(*)::int AS count FROM purchase_commands WHERE player_id = ${playerId}::uuid
  `);
  return Number((result.rows[0] as { count: number } | undefined)?.count ?? 0);
}

describe("building purchases", () => {
  it("executes a concurrent replay of one key exactly once", async () => {
    const player = await createPlayer(database.db, { gold: "1000.000000", lifetime: "1000.000000" });
    const key = `concurrent-${randomUUID()}`;

    const results = await Promise.all(
      Array.from({ length: 10 }, () => purchase(database.db, player.id, { building: "mine" }, key)),
    );

    expect(results.every((result) => result.ok)).toBe(true);
    const serialized = results.flatMap((result) => result.ok
      ? [JSON.stringify({ ...result, collectedAt: result.collectedAt.toISOString() })]
      : []);
    expect(new Set(serialized).size).toBe(1);

    const resource = await readResource(player.id);
    if (!resource) throw new Error("resource missing");
    const first = results[0];
    const credited = first?.ok ? first.credited : "0.000000";
    expect(micros(resource.gold)).toBe(1_000_000_000n - 100_000_000n + micros(credited));
    expect(resource.goldPerSecond).toBe("2.000000");
    expect(micros(resource.lifetimeGoldEarned)).toBe(1_000_000_000n + micros(credited));

    const buildings = await readBuildings(player.id);
    expect(buildings).toEqual([{ playerId: player.id, building: "mine", level: 1 }]);
    expect(await countCommands(player.id)).toBe(1);
  });

  it("rejects the same key for a different building without changing state", async () => {
    const player = await createPlayer(database.db, { gold: "1000.000000" });
    const key = `reuse-${randomUUID()}`;

    const first = await purchase(database.db, player.id, { building: "mine" }, key);
    expect(first.ok).toBe(true);
    const before = await readResource(player.id);

    const second = await purchase(database.db, player.id, { building: "forge" }, key);
    expect(second).toEqual({ ok: false, reason: "idempotency_key_reused" });

    const after = await readResource(player.id);
    expect(after?.gold).toBe(before?.gold);
    expect((await readBuildings(player.id)).map((row) => row.building)).toEqual(["mine"]);
  });

  it("persists expected domain failures and keeps them bound to the key", async () => {
    const player = await createPlayer(database.db, { gold: "0.000000" });
    const key = `failure-${randomUUID()}`;

    const first = await purchase(database.db, player.id, { building: "mine" }, key);
    expect(first).toEqual({ ok: false, reason: "insufficient_funds" });

    await setGold(database.db, player.id, "1000.000000");
    const replay = await purchase(database.db, player.id, { building: "mine" }, key);
    expect(replay).toEqual({ ok: false, reason: "insufficient_funds" });

    const fresh = await purchase(database.db, player.id, { building: "mine" }, `fresh-${randomUUID()}`);
    expect(fresh.ok).toBe(true);
    expect(await countCommands(player.id)).toBe(2);
  });

  it("settles elapsed time at the old rate before increasing production", async () => {
    const player = await createPlayer(database.db, { gold: "1000.000000", rate: "1.000000" });
    await setLastCollectedAt(database.db, player.id, 10);

    const result = await purchase(database.db, player.id, { building: "mine" }, `rate-${randomUUID()}`);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const credited = micros(result.credited);
    expect(credited >= 10_000_000n).toBe(true);
    expect(credited < 11_000_000n).toBe(true);
    expect(result.rate).toBe("2.000000");
    expect(micros(result.balance)).toBe(1_000_000_000n - 100_000_000n + credited);
    expect(micros(result.lifetimeEarned)).toBe(credited);
  });

  it("returns max_level_reached at level 100", async () => {
    const player = await createPlayer(database.db, { gold: "1000000.000000" });
    await database.db.insert(playerBuildings).values({
      playerId: player.id, building: "mine", level: 100,
    });

    const result = await purchase(database.db, player.id, { building: "mine" }, `max-${randomUUID()}`);
    expect(result).toEqual({ ok: false, reason: "max_level_reached" });
  });

  it("distinguishes a missing player from a missing resource row", async () => {
    const missingPlayer = await purchase(database.db, randomUUID(), { building: "mine" }, `missing-${randomUUID()}`);
    expect(missingPlayer).toEqual({ ok: false, reason: "player_not_found" });

    const playerId = randomUUID();
    const email = `no-resource-${playerId}@example.com`;
    await database.db.execute(sql`
      INSERT INTO players (id, email, password_hash)
      VALUES (${playerId}::uuid, ${email}, 'unused')
    `);
    const missingResource = await purchase(database.db, playerId, { building: "mine" }, `missing-${randomUUID()}`);
    expect(missingResource).toEqual({ ok: false, reason: "resource_not_found" });
  });
});
