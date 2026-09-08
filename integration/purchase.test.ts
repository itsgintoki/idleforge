import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { afterAll, beforeAll, expect, it } from "vitest";
import request from "supertest";
import { createDatabase } from "../src/db/client.js";
import { envSchema } from "../src/config.js";
import { players, playerResources, playerBuildings, purchaseCommands } from "../src/db/schema.js";
import { purchase } from "../src/players/purchase.js";
import { collect } from "../src/players/collect.js";
import { findPlayerState } from "../src/players/queries.js";
import { createApp } from "../src/app.js";
import { issueAccessToken, verifyAccessToken } from "../src/auth/tokens.js";
import { unusedLoginDependencies } from "../tests/helpers.js";

// Existing Part 1 scenarios are intentional NEW commands unless a key is supplied.
const buy = (id: string, input: Parameters<typeof purchase>[2], key: string = randomUUID()) => purchase(db, id, input, key);

const config = envSchema.parse(process.env);
const admin = createDatabase(config.DATABASE_URL);
const databaseName = `idleforge_purchase_${randomUUID().replaceAll("-", "")}`;
const testUrl = new URL(config.DATABASE_URL);
testUrl.pathname = `/${databaseName}`;
const { db, pool } = createDatabase(testUrl.toString());
beforeAll(async () => {
  await admin.pool.query(`CREATE DATABASE "${databaseName}"`);
  await migrate(db, { migrationsFolder: "./drizzle" });
}, 20_000);
afterAll(async () => {
  await pool.end();
  try { await admin.pool.query(`DROP DATABASE IF EXISTS "${databaseName}"`); }
  finally { await admin.pool.end(); }
});
async function fixture(gold = "1000") {
  const [player] = await db.insert(players).values({ email: `${randomUUID()}@example.test`, passwordHash: "unused" }).returning();
  if (!player) throw new Error("Missing player fixture");
  await db.insert(playerResources).values({ playerId: player.id, gold, lifetimeGoldEarned: gold,
    // Future checkpoint freezes earnings deterministically; no wall-clock sleeps.
    lastCollectedAt: sql`date_trunc('milliseconds', clock_timestamp()) + interval '1 day'`,
  });
  return player;
}
async function state(id: string) {
  const result = await findPlayerState(db, id);
  if (!result) throw new Error("Missing player state");
  return result;
}
function units(value: string): bigint {
  const [whole = "0", fraction = ""] = value.split(".");
  return BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, "0"));
}
// Force an overlap on the real database before allowing either operation to proceed.
async function overlapping<T>(id: string, start: () => Promise<T>[]) {
  const blocker = await pool.connect();
  let pending: Promise<T[]> | undefined;
  try {
    await blocker.query("BEGIN");
    await blocker.query("SELECT 1 FROM player_resources WHERE player_id = $1 FOR UPDATE", [id]);
    pending = Promise.all(start());
    await expect.poll(async () => {
      const result = await pool.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'",
      );
      return result.rows[0]?.count;
    }, { timeout: 5000, interval: 20 }).toBe(2);
    await blocker.query("COMMIT");
    return await pending;
  } finally {
    await blocker.query("ROLLBACK");
    blocker.release();
    await pending;
  }
}

it("buys then upgrades one building row using the next level's price", async () => {
  const player = await fixture();
  const before = await state(player.id);
  expect(await buy(player.id, { building: "mine" })).toEqual({
    ok: true, building: "mine", level: 1, spent: "100.000000", credited: "0.000000",
    balance: "900.000000", lifetimeEarned: "1000.000000", rate: "2.000000",
    collectedAt: before.resources.lastCollectedAt,
  });
  expect(await buy(player.id, { building: "mine" })).toMatchObject({
    ok: true, level: 2, spent: "200.000000", balance: "700.000000", rate: "3.000000",
  });
  expect((await state(player.id)).buildings).toEqual([{ building: "mine", level: 2 }]);
});
it("supports the second building and adds both production effects", async () => {
  const player = await fixture();
  await buy(player.id, { building: "mine" });
  expect(await buy(player.id, { building: "forge" })).toMatchObject({
    ok: true, building: "forge", level: 1, spent: "500.000000", balance: "400.000000", rate: "7.000000",
  });
  expect((await state(player.id)).buildings).toEqual([{ building: "mine", level: 1 }, { building: "forge", level: 1 }]);
});
it("insufficient funds changes nothing, including pending earnings and checkpoint", async () => {
  const player = await fixture("99.999999");
  await db.update(playerResources).set({ lastCollectedAt: sql`clock_timestamp() - interval '1 day'` })
    .where(eq(playerResources.playerId, player.id));
  const before = await state(player.id);
  expect(await buy(player.id, { building: "mine" })).toEqual({ ok: false, reason: "insufficient_funds" });
  expect(await state(player.id)).toEqual(before);
});
it("preserves a very large balance and lifetime total exactly", async () => {
  const player = await fixture("900719925474099312345678.123456");
  expect(await buy(player.id, { building: "mine" })).toMatchObject({
    ok: true, balance: "900719925474099312345578.123456", lifetimeEarned: "900719925474099312345678.123456",
  });
});
it("settles old earnings before increasing the rate and returns the stored state", async () => {
  const player = await fixture();
  await db.update(playerResources).set({ lastCollectedAt: sql`date_trunc('milliseconds', clock_timestamp()) - interval '60 seconds'` })
    .where(eq(playerResources.playerId, player.id));
  const before = await state(player.id);
  const result = await buy(player.id, { building: "forge" });
  if (!result.ok) throw new Error(result.reason);
  const earned = BigInt(result.collectedAt.getTime() - before.resources.lastCollectedAt.getTime()) * 1000n;
  expect(units(result.credited)).toBe(earned); // old rate 1, not new rate 6
  expect(units(result.balance)).toBe(500_000_000n + earned);
  expect(units(result.lifetimeEarned)).toBe(1_000_000_000n + earned);
  expect(result.rate).toBe("6.000000");
  expect((await state(player.id)).resources).toEqual({ gold: result.balance, lifetimeGoldEarned: result.lifetimeEarned,
    goldPerSecond: result.rate, lastCollectedAt: result.collectedAt });
});
it("applies the existing offline cap to purchase settlement", async () => {
  const player = await fixture();
  await db.update(playerResources).set({ lastCollectedAt: sql`clock_timestamp() - interval '1 day'` })
    .where(eq(playerResources.playerId, player.id));
  expect(await buy(player.id, { building: "mine" })).toMatchObject({
    ok: true, credited: "28800.000000", balance: "29700.000000", lifetimeEarned: "29800.000000",
  });
});
it("distinguishes missing players from missing resources", async () => {
  expect(await buy(randomUUID(), { building: "mine" })).toEqual({ ok: false, reason: "player_not_found" });
  const player = await fixture();
  await db.delete(playerResources).where(eq(playerResources.playerId, player.id));
  expect(await buy(player.id, { building: "mine" })).toEqual({ ok: false, reason: "resource_not_found" });
});
it("rejects purchases at the level cap without changing anything", async () => {
  const player = await fixture("100000");
  await db.insert(playerBuildings).values({ playerId: player.id, building: "mine", level: 100 });
  const before = await state(player.id);
  expect(await buy(player.id, { building: "mine" })).toEqual({ ok: false, reason: "max_level_reached" });
  expect(await state(player.id)).toEqual(before);
});
it("rolls back spending and accrued earnings when the building write fails", async () => {
  const player = await fixture();
  await db.update(playerResources).set({ lastCollectedAt: sql`clock_timestamp() - interval '1 day'` })
    .where(eq(playerResources.playerId, player.id));
  const before = await state(player.id);
  await pool.query(`CREATE FUNCTION reject_purchase_building() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'simulated building failure'; END; $$;
    CREATE TRIGGER reject_purchase_building BEFORE INSERT ON player_buildings
    FOR EACH ROW EXECUTE FUNCTION reject_purchase_building();`);
  try {
    await expect(buy(player.id, { building: "mine" })).rejects.toThrow();
    expect(await state(player.id)).toEqual(before);
  } finally {
    await pool.query("DROP TRIGGER reject_purchase_building ON player_buildings; DROP FUNCTION reject_purchase_building();");
  }
});
it("rolls back the building write and debit if the final rate update overflows", async () => {
  const player = await fixture();
  await db.update(playerResources).set({ goldPerSecond: "999999999999999999999999.999999" })
    .where(eq(playerResources.playerId, player.id));
  const before = await state(player.id);
  await expect(buy(player.id, { building: "mine" })).rejects.toMatchObject({ cause: { code: "22003" } });
  expect(await state(player.id)).toEqual(before);
});
it("allows exactly one simultaneous purchase when only one is affordable", async () => {
  const player = await fixture("100");
  const results = await overlapping(player.id, () => [
    buy(player.id, { building: "mine" }), buy(player.id, { building: "mine" }),
  ]);
  expect(results.filter(result => result.ok)).toHaveLength(1);
  expect(results).toContainEqual({ ok: false, reason: "insufficient_funds" });
  expect((await state(player.id)).resources).toMatchObject({ gold: "0.000000", goldPerSecond: "2.000000", lifetimeGoldEarned: "100.000000" });
  expect((await state(player.id)).buildings).toEqual([{ building: "mine", level: 1 }]);
});
it("serializes purchases of different buildings spending the same balance", async () => {
  const player = await fixture("500");
  const results = await overlapping(player.id, () => [
    buy(player.id, { building: "mine" }), buy(player.id, { building: "forge" }),
  ]);
  expect(results.filter(result => result.ok)).toHaveLength(1);
  expect(results).toContainEqual({ ok: false, reason: "insufficient_funds" });
  expect((await state(player.id)).buildings).toHaveLength(1);
});
it("uses updated levels and prices for simultaneous affordable upgrades", async () => {
  const player = await fixture("300");
  const results = await overlapping(player.id, () => [
    buy(player.id, { building: "mine" }), buy(player.id, { building: "mine" }),
  ]);
  expect(results.map(result => result.ok && result.level).sort()).toEqual([1, 2]);
  expect((await state(player.id)).resources).toMatchObject({ gold: "0.000000", goldPerSecond: "3.000000" });
  expect((await state(player.id)).buildings).toEqual([{ building: "mine", level: 2 }]);
});
it("serializes collection with a purchase without paying the new rate for old time", async () => {
  const player = await fixture();
  await db.update(playerResources).set({ lastCollectedAt: sql`date_trunc('milliseconds', clock_timestamp()) - interval '60 seconds'` })
    .where(eq(playerResources.playerId, player.id));
  const before = await state(player.id);
  type Outcome = Awaited<ReturnType<typeof purchase>> | Awaited<ReturnType<typeof collect>>;
  const results = await overlapping<Outcome>(player.id, () => [buy(player.id, { building: "mine" }), collect(db, player.id)]);
  const bought = results.find(result => result.ok && "building" in result);
  if (!bought?.ok || !("building" in bought)) throw new Error("Expected purchase success");
  const after = await state(player.id);
  const oldRateCredit = BigInt(bought.collectedAt.getTime() - before.resources.lastCollectedAt.getTime()) * 1000n;
  const newRateCredit = BigInt(after.resources.lastCollectedAt.getTime() - bought.collectedAt.getTime()) * 2000n;
  expect(units(after.resources.gold)).toBe(900_000_000n + oldRateCredit + newRateCredit);
  expect(units(after.resources.lifetimeGoldEarned)).toBe(1_000_000_000n + oldRateCredit + newRateCredit);
});
it("enforces one building per type per player and cascades player deletion", async () => {
  const player = await fixture();
  await db.insert(playerBuildings).values({ playerId: player.id, building: "mine", level: 1 });
  await expect(db.insert(playerBuildings).values({ playerId: player.id, building: "mine", level: 1 }))
    .rejects.toMatchObject({ cause: { code: "23505" } });
  await db.delete(players).where(eq(players.id, player.id));
  expect(await db.select().from(playerBuildings).where(eq(playerBuildings.playerId, player.id))).toEqual([]);
});
it.each([0, 101])("rejects an invalid building level %i", async (level) => {
  const player = await fixture();
  await expect(db.insert(playerBuildings).values({ playerId: player.id, building: "mine", level }))
    .rejects.toMatchObject({ cause: { code: "23514" } });
});
it("performs a real authenticated HTTP purchase and exposes owned buildings", async () => {
  const owner = await fixture();
  const other = await fixture();
  const untouched = await state(other.id);
  const app = createApp({ ...unusedLoginDependencies,
    signup: async () => { throw new Error("Unexpected signup"); },
    verifyAccessToken: (token) => verifyAccessToken(token, config.JWT_SECRET),
    purchase: (id, input, key) => buy(id, input, key), findPlayerState: (id) => findPlayerState(db, id),
  });
  const token = issueAccessToken(owner, config.JWT_SECRET);
  const response = await request(app).post(`/player/purchases?playerId=${other.id}`)
    .set("Authorization", `Bearer ${token}`).set("Idempotency-Key", randomUUID()).send({ building: "mine" });
  expect(response.status).toBe(200);
  expect(response.body).toMatchObject({ building: "mine", level: 1, balance: "900.000000" });
  expect(await state(other.id)).toEqual(untouched);
  const read = await request(app).get("/player/me").set("Authorization", `Bearer ${token}`);
  expect(read.body.buildings).toEqual([{ building: "mine", level: 1 }]);
});

it("replays the saved result even after later purchases changed the player's state", async () => {
  const player = await fixture();
  const key = randomUUID();
  const first = await buy(player.id, { building: "mine" }, key);
  await buy(player.id, { building: "mine" });
  const beforeReplay = await state(player.id);
  // A fresh connection proves the result survives outside this API client's memory.
  const another = createDatabase(testUrl.toString());
  try {
    expect(await purchase(another.db, player.id, { building: "mine" }, key)).toEqual(first);
  } finally { await another.pool.end(); }
  expect(await state(player.id)).toEqual(beforeReplay);
  const commands = await db.select().from(purchaseCommands).where(eq(purchaseCommands.playerId, player.id));
  expect(commands).toHaveLength(2);
  expect(commands.every(command => command.result !== null)).toBe(true);
});
it("returns identical results for simultaneous requests using the same key", async () => {
  const player = await fixture("100");
  const key = randomUUID();
  const results = await overlapping(player.id, () => [
    buy(player.id, { building: "mine" }, key), buy(player.id, { building: "mine" }, key),
  ]);
  expect(results[0]).toMatchObject({ ok: true, level: 1, balance: "0.000000" });
  expect(results[1]).toEqual(results[0]);
  expect((await state(player.id)).buildings).toEqual([{ building: "mine", level: 1 }]);
  expect((await state(player.id)).resources).toMatchObject({ gold: "0.000000", goldPerSecond: "2.000000" });
  expect(await db.select().from(purchaseCommands).where(eq(purchaseCommands.playerId, player.id))).toHaveLength(1);
});
it("rejects using a committed key for different purchase details", async () => {
  const player = await fixture();
  const key = randomUUID();
  const original = await buy(player.id, { building: "mine" }, key);
  const before = await state(player.id);
  expect(await buy(player.id, { building: "forge" }, key)).toEqual({ ok: false, reason: "idempotency_key_reused" });
  expect(await state(player.id)).toEqual(before);
  expect(await buy(player.id, { building: "mine" }, key)).toEqual(original);
});
it("allows only one payload to claim a key when conflicting requests overlap", async () => {
  const player = await fixture();
  const key = randomUUID();
  const results = await overlapping(player.id, () => [
    buy(player.id, { building: "mine" }, key), buy(player.id, { building: "forge" }, key),
  ]);
  expect(results.filter(result => result.ok)).toHaveLength(1);
  expect(results).toContainEqual({ ok: false, reason: "idempotency_key_reused" });
  expect((await state(player.id)).buildings).toHaveLength(1);
});
it("scopes command keys to the authenticated player", async () => {
  const sam = await fixture();
  const alex = await fixture();
  const key = randomUUID();
  expect(await buy(sam.id, { building: "mine" }, key)).toMatchObject({ ok: true, building: "mine" });
  expect(await buy(alex.id, { building: "forge" }, key)).toMatchObject({ ok: true, building: "forge" });
});
it("keeps an insufficient-funds result stable after the balance increases", async () => {
  const player = await fixture("0");
  const key = randomUUID();
  const failed = await buy(player.id, { building: "mine" }, key);
  expect(failed).toEqual({ ok: false, reason: "insufficient_funds" });
  await db.update(playerResources).set({ gold: "1000" }).where(eq(playerResources.playerId, player.id));
  const before = await state(player.id);
  expect(await buy(player.id, { building: "mine" }, key)).toEqual(failed);
  expect(await state(player.id)).toEqual(before);
  expect(await buy(player.id, { building: "mine" })).toMatchObject({ ok: true, level: 1 });
});
it("rolls back all changes and releases the key if saving the command result fails", async () => {
  const player = await fixture();
  const key = randomUUID();
  const before = await state(player.id);
  await pool.query(`CREATE FUNCTION reject_purchase_result() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'simulated result persistence failure'; END; $$;
    CREATE TRIGGER reject_purchase_result BEFORE UPDATE ON purchase_commands
    FOR EACH ROW EXECUTE FUNCTION reject_purchase_result();`);
  try {
    await expect(buy(player.id, { building: "mine" }, key)).rejects.toThrow();
    expect(await state(player.id)).toEqual(before);
    expect(await db.select().from(purchaseCommands).where(eq(purchaseCommands.playerId, player.id))).toEqual([]);
  } finally {
    await pool.query("DROP TRIGGER reject_purchase_result ON purchase_commands; DROP FUNCTION reject_purchase_result();");
  }
  const retried = await buy(player.id, { building: "mine" }, key);
  expect(retried).toMatchObject({ ok: true, level: 1, balance: "900.000000" });
  expect(await buy(player.id, { building: "mine" }, key)).toEqual(retried);
});
it("rejects corrupt persisted results rather than executing the purchase again", async () => {
  const player = await fixture();
  const key = randomUUID();
  await buy(player.id, { building: "mine" }, key);
  await db.update(purchaseCommands).set({ result: { ok: true, balance: 123 } })
    .where(eq(purchaseCommands.playerId, player.id));
  const before = await state(player.id);
  await expect(buy(player.id, { building: "mine" }, key)).rejects.toThrow();
  expect(await state(player.id)).toEqual(before);
});
it("does not leave a reserved command behind when the rate update fails", async () => {
  const player = await fixture();
  const key = randomUUID();
  await db.update(playerResources).set({ goldPerSecond: "999999999999999999999999.999999" })
    .where(eq(playerResources.playerId, player.id));
  await expect(buy(player.id, { building: "mine" }, key)).rejects.toMatchObject({ cause: { code: "22003" } });
  expect(await db.select().from(purchaseCommands).where(eq(purchaseCommands.playerId, player.id))).toEqual([]);
  await db.update(playerResources).set({ goldPerSecond: "1" }).where(eq(playerResources.playerId, player.id));
  expect(await buy(player.id, { building: "mine" }, key)).toMatchObject({ ok: true, level: 1 });
});
it("deletes command records with the owning player", async () => {
  const player = await fixture();
  await buy(player.id, { building: "mine" });
  await db.delete(players).where(eq(players.id, player.id));
  expect(await db.select().from(purchaseCommands).where(eq(purchaseCommands.playerId, player.id))).toEqual([]);
});
it("returns the identical HTTP response on retry and 409 for a changed payload", async () => {
  const owner = await fixture();
  const app = createApp({ ...unusedLoginDependencies,
    signup: async () => { throw new Error("Unexpected signup"); },
    verifyAccessToken: (token) => verifyAccessToken(token, config.JWT_SECRET),
    purchase: (id, input, key) => buy(id, input, key),
  });
  const token = issueAccessToken(owner, config.JWT_SECRET);
  const key = randomUUID();
  const send = (building: string) => request(app).post("/player/purchases")
    .set("Authorization", `Bearer ${token}`).set("Idempotency-Key", key).send({ building });
  const first = await send("mine");
  expect(first.status).toBe(200);
  const before = await state(owner.id);
  const again = await send("mine");
  expect(again.status).toBe(first.status);
  expect(again.body).toEqual(first.body);
  expect(again.headers["cache-control"]).toBe("no-store");
  const different = await send("forge");
  expect(different.status).toBe(409);
  expect(different.body).toEqual({ error: "idempotency_key_reused" });
  expect(await state(owner.id)).toEqual(before);
});

it("lets a waiting retry complete after the first transaction rolls back", async () => {
  const player = await fixture();
  const key = randomUUID();
  // Sequence increments survive rollback, so precisely the first save fails.
  await pool.query(`CREATE SEQUENCE purchase_failure_attempt;
    CREATE FUNCTION fail_first_purchase_save() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF nextval('purchase_failure_attempt') = 1 THEN RAISE EXCEPTION 'first attempt fails'; END IF;
      RETURN NEW;
    END; $$;
    CREATE TRIGGER fail_first_purchase_save BEFORE UPDATE ON purchase_commands
    FOR EACH ROW EXECUTE FUNCTION fail_first_purchase_save();`);
  const attempt = () => buy(player.id, { building: "mine" }, key).then(
    value => ({ ok: true as const, value }),
    () => ({ ok: false as const }),
  );
  try {
    const attempts = await overlapping(player.id, () => [attempt(), attempt()]);
    expect(attempts.filter(result => result.ok)).toHaveLength(1);
    expect(attempts).toContainEqual({ ok: false });
    expect(await buy(player.id, { building: "mine" }, key)).toMatchObject({ ok: true, level: 1, balance: "900.000000" });
    expect((await state(player.id)).buildings).toEqual([{ building: "mine", level: 1 }]);
    expect(await db.select().from(purchaseCommands).where(eq(purchaseCommands.playerId, player.id))).toHaveLength(1);
  } finally {
    await pool.query("DROP TRIGGER fail_first_purchase_save ON purchase_commands; DROP FUNCTION fail_first_purchase_save(); DROP SEQUENCE purchase_failure_attempt;");
  }
});
