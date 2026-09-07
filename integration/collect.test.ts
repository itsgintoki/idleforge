import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { createDatabase } from "../src/db/client.js";
import { envSchema } from "../src/config.js";
import { players, playerResources } from "../src/db/schema.js";
import { collect, maximumOfflineSeconds } from "../src/players/collect.js";
import { findPlayerState } from "../src/players/queries.js";
import { createApp } from "../src/app.js";
import { issueAccessToken, verifyAccessToken } from "../src/auth/tokens.js";
import { unusedLoginDependencies } from "../tests/helpers.js";

const config = envSchema.parse(process.env);
const admin = createDatabase(config.DATABASE_URL);
const databaseName = `idleforge_collect_${randomUUID().replaceAll("-", "")}`;
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

async function fixture() {
  const [player] = await db.insert(players).values({
    email: `${randomUUID()}@example.test`, passwordHash: "unused-in-collection-tests",
  }).returning();
  if (!player) throw new Error("Missing fixture player");
  await db.insert(playerResources).values({ playerId: player.id });
  return player;
}
async function state(id: string) {
  const [resource] = await db.select().from(playerResources).where(eq(playerResources.playerId, id));
  if (!resource) throw new Error("Missing fixture resources");
  return resource;
}
// Test-side exact arithmetic, independent of the SQL implementation.
function units(value: string): bigint {
  const [whole = "0", fraction = ""] = value.split(".");
  return BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, "0"));
}
function decimal(value: bigint): string {
  return `${value / 1_000_000n}.${(value % 1_000_000n).toString().padStart(6, "0")}`;
}

describe("atomic offline collection", () => {
  it("credits exact normal elapsed time and returns the persisted state", async () => {
    const player = await fixture();
    await db.update(playerResources).set({
      gold: "12.345678", lifetimeGoldEarned: "50.123456", goldPerSecond: "1.234567",
      lastCollectedAt: sql`date_trunc('milliseconds', clock_timestamp()) - interval '60 seconds'`,
    }).where(eq(playerResources.playerId, player.id));
    const before = await state(player.id);
    const result = await collect(db, player.id);
    if (!result.ok) throw new Error(result.reason);
    const milliseconds = result.collectedAt.getTime() - before.lastCollectedAt.getTime();
    expect(milliseconds).toBeGreaterThanOrEqual(60_000);
    expect(milliseconds).toBeLessThan(maximumOfflineSeconds * 1000);
    const earned = BigInt(milliseconds) * units(before.goldPerSecond) / 1000n;
    expect(result.credited).toBe(decimal(earned));
    expect(result.balance).toBe(decimal(units(before.gold) + earned));
    expect(result.lifetimeEarned).toBe(decimal(units(before.lifetimeGoldEarned) + earned));
    expect(result.rate).toBe(before.goldPerSecond);
    expect(await state(player.id)).toEqual({
      ...before, gold: result.balance, lifetimeGoldEarned: result.lifetimeEarned,
      lastCollectedAt: result.collectedAt,
    });
  });

  it("clamps negative elapsed time to zero and never moves the checkpoint backwards", async () => {
    const player = await fixture();
    await db.update(playerResources).set({
      gold: "3", lifetimeGoldEarned: "9",
      lastCollectedAt: sql`date_trunc('milliseconds', clock_timestamp()) + interval '1 day'`,
    }).where(eq(playerResources.playerId, player.id));
    const before = await state(player.id);
    const first = await collect(db, player.id);
    const second = await collect(db, player.id);
    expect(first).toEqual({ ok: true, credited: "0.000000", balance: "3.000000",
      lifetimeEarned: "9.000000", rate: "1.000000", collectedAt: before.lastCollectedAt });
    // Same checkpoint means zero effective elapsed time, including repeated requests.
    expect(second).toEqual(first);
    expect(await state(player.id)).toEqual(before);
  });

  it("caps offline earnings at eight hours and discards excess elapsed time", async () => {
    const player = await fixture();
    await db.update(playerResources).set({ goldPerSecond: "1.234567",
      lastCollectedAt: sql`clock_timestamp() - interval '2 days'`,
    }).where(eq(playerResources.playerId, player.id));
    const result = await collect(db, player.id);
    if (!result.ok) throw new Error(result.reason);
    expect(maximumOfflineSeconds).toBe(28_800);
    expect(result.credited).toBe("35555.529600");
    const next = await collect(db, player.id);
    if (!next.ok) throw new Error(next.reason);
    expect(units(next.credited)).toBeLessThan(units(result.credited));
    expect(next.collectedAt.getTime()).toBeGreaterThanOrEqual(result.collectedAt.getTime());
  });

  it("preserves very large balances and lifetime totals exactly", async () => {
    const player = await fixture();
    await db.update(playerResources).set({ gold: "900719925474099312345678.123456",
      lifetimeGoldEarned: "900719925474099312345679.654321", goldPerSecond: "0.000001",
      lastCollectedAt: sql`clock_timestamp() - interval '1 day'`,
    }).where(eq(playerResources.playerId, player.id));
    const result = await collect(db, player.id);
    expect(result).toMatchObject({ ok: true, credited: "0.028800",
      balance: "900719925474099312345678.152256",
      lifetimeEarned: "900719925474099312345679.683121" });
  });

  it("advances the checkpoint at a zero production rate without earning gold", async () => {
    const player = await fixture();
    await db.update(playerResources).set({ goldPerSecond: "0",
      lastCollectedAt: sql`clock_timestamp() - interval '1 day'`,
    }).where(eq(playerResources.playerId, player.id));
    const before = await state(player.id);
    const result = await collect(db, player.id);
    if (!result.ok) throw new Error(result.reason);
    expect(result.credited).toBe("0.000000");
    expect(result.collectedAt.getTime()).toBeGreaterThan(before.lastCollectedAt.getTime());
  });

  it("distinguishes missing players and missing resources", async () => {
    expect(await collect(db, randomUUID())).toEqual({ ok: false, reason: "player_not_found" });
    const player = await fixture();
    await db.delete(playerResources).where(eq(playerResources.playerId, player.id));
    expect(await collect(db, player.id)).toEqual({ ok: false, reason: "resource_not_found" });
  });

  it.each(["gold", "lifetimeGoldEarned"] as const)("rolls back every field on %s overflow", async (field) => {
    const player = await fixture();
    await db.update(playerResources).set({ [field]: "999999999999999999999999.999999",
      lastCollectedAt: sql`clock_timestamp() - interval '1 day'`,
    }).where(eq(playerResources.playerId, player.id));
    const before = await state(player.id);
    await expect(collect(db, player.id)).rejects.toMatchObject({ cause: { code: "22003" } });
    expect(await state(player.id)).toEqual(before);
  });

  it.each(["-1", "NaN"])("rejects invalid lifetime earnings %s at the database boundary", async (value) => {
    const player = await fixture();
    await expect(db.update(playerResources).set({ lifetimeGoldEarned: value })
      .where(eq(playerResources.playerId, player.id))).rejects.toMatchObject({ cause: { code: "23514" } });
    expect((await state(player.id)).lifetimeGoldEarned).toBe("0.000000");
  });

  it("does not double-credit two simultaneous collectors", async () => {
    const player = await fixture();
    await db.update(playerResources).set({
      lastCollectedAt: sql`date_trunc('milliseconds', clock_timestamp()) - interval '60 seconds'`,
    }).where(eq(playerResources.playerId, player.id));
    const before = await state(player.id);
    const blocker = await pool.connect();
    let pending: Promise<Awaited<ReturnType<typeof collect>>[]> | undefined;
    try {
      await blocker.query("BEGIN");
      await blocker.query("SELECT 1 FROM player_resources WHERE player_id = $1 FOR UPDATE", [player.id]);
      pending = Promise.all([collect(db, player.id), collect(db, player.id)]);
      // Confirm both operations overlap at the database; no timing-based sleep race.
      await expect.poll(async () => {
        const result = await pool.query<{ count: number }>(
          "SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'",
        );
        return result.rows[0]?.count;
      }, { timeout: 5000, interval: 20 }).toBe(2);
      await blocker.query("COMMIT");
      const results = await pending;
      const after = await state(player.id);
      let totalCredited = 0n;
      for (const result of results) {
        if (!result.ok) throw new Error(result.reason);
        totalCredited += units(result.credited);
      }
      const elapsed = BigInt(after.lastCollectedAt.getTime() - before.lastCollectedAt.getTime());
      expect(totalCredited).toBe(elapsed * 1000n); // rate=1, milliseconds -> millionths
      expect(after.gold).toBe(decimal(totalCredited));
      expect(after.lifetimeGoldEarned).toBe(after.gold);
      expect(results).toContainEqual({ ok: true, credited: expect.any(String),
        balance: after.gold, lifetimeEarned: after.lifetimeGoldEarned,
        rate: after.goldPerSecond, collectedAt: after.lastCollectedAt });
    } finally {
      await blocker.query("ROLLBACK");
      blocker.release();
      await pending;
    }
  }, 10_000);

  it("collects through HTTP for only the verified token owner", async () => {
    const owner = await fixture();
    const other = await fixture();
    const untouched = await state(other.id);
    const app = createApp({ ...unusedLoginDependencies,
      signup: async () => { throw new Error("Unexpected signup"); },
      verifyAccessToken: (token) => verifyAccessToken(token, config.JWT_SECRET),
      collect: (id) => collect(db, id), findPlayerState: (id) => findPlayerState(db, id),
    });
    const token = issueAccessToken(owner, config.JWT_SECRET);
    const response = await request(app).post(`/player/collect?playerId=${other.id}`)
      .set("Authorization", `Bearer ${token}`).send({});
    expect(response.status).toBe(200);
    const persisted = await state(owner.id);
    expect(response.body).toEqual({ credited: persisted.gold, balance: persisted.gold,
      lifetimeEarned: persisted.lifetimeGoldEarned, rate: persisted.goldPerSecond,
      collectedAt: persisted.lastCollectedAt.toISOString() });
    expect(await state(other.id)).toEqual(untouched);
    const read = await request(app).get("/player/me").set("Authorization", `Bearer ${token}`);
    expect(read.body.resources.lifetimeGoldEarned).toBe(response.body.lifetimeEarned);
  });
});
