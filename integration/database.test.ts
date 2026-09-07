import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import type { PoolClient } from "pg";
import { envSchema } from "../src/config.js";
import { createDatabase } from "../src/db/client.js";
import * as schema from "../src/db/schema.js";
import { findPlayerById } from "../src/players/queries.js";

const config = envSchema.parse(process.env);
const { pool } = createDatabase(config.DATABASE_URL);
let client: PoolClient;
let db: NodePgDatabase<typeof schema>;
let playerId: string;

beforeEach(async () => {
  client = await pool.connect();
  await client.query("BEGIN");
  db = drizzle({ client, schema });
  playerId = randomUUID();
  await db.insert(schema.players).values({
    id: playerId,
    email: `${playerId}@example.test`,
    passwordHash: "test-fixture-not-a-real-hash",
  });
});

afterEach(async () => {
  await client.query("ROLLBACK");
  client.release();
});

afterAll(async () => {
  await pool.end();
});

describe("PostgreSQL schema", () => {
  it("returns resource defaults with exact string amounts", async () => {
    const [resource] = await db.insert(schema.playerResources)
      .values({ playerId }).returning();
    expect(resource).toMatchObject({
      playerId, gold: "0.000000", goldPerSecond: "1.000000",
      lastCollectedAt: expect.any(Date),
    });
  });

  it("preserves values larger than JavaScript's safe integer range", async () => {
    const gold = "9007199254740993.123456";
    const [resource] = await db.insert(schema.playerResources)
      .values({ playerId, gold }).returning();
    expect(resource?.gold).toBe(gold);
  });

  it("rejects duplicate emails", async () => {
    await expect(client.query(
      "INSERT INTO players (email, password_hash) VALUES ($1, $2)",
      [`${playerId}@example.test`, "fixture"],
    )).rejects.toMatchObject({ code: "23505" });
  });

  it("rejects a second resource row for the same player", async () => {
    await db.insert(schema.playerResources).values({ playerId });
    await expect(client.query(
      "INSERT INTO player_resources (player_id) VALUES ($1)", [playerId],
    )).rejects.toMatchObject({ code: "23505" });
  });

  it("rejects a resource row without a player", async () => {
    await expect(client.query(
      "INSERT INTO player_resources (player_id) VALUES ($1)", [randomUUID()],
    )).rejects.toMatchObject({ code: "23503" });
  });

  it.each(["-1", "NaN"])("rejects invalid gold %s", async (gold) => {
    await expect(client.query(
      "INSERT INTO player_resources (player_id, gold) VALUES ($1, $2)",
      [playerId, gold],
    )).rejects.toMatchObject({ code: "23514" });
  });

  it("rejects a negative production rate", async () => {
    await expect(client.query(
      "INSERT INTO player_resources (player_id, gold_per_second) VALUES ($1, -1)",
      [playerId],
    )).rejects.toMatchObject({ code: "23514" });
  });

  it("rejects an unsupported role even through direct SQL", async () => {
    await expect(client.query(
      "UPDATE players SET role = $1 WHERE id = $2", ["owner", playerId],
    )).rejects.toMatchObject({ code: "22P02" });
  });
});

describe("findPlayerById", () => {
  it("returns the requested player when multiple players exist", async () => {
    const otherId = randomUUID();
    await db.insert(schema.players).values({
      id: otherId,
      email: `${otherId}@example.test`,
      passwordHash: "another-test-fixture",
    });

    const player = await findPlayerById(db, otherId);

    expect(player).toEqual({
      id: otherId,
      email: `${otherId}@example.test`,
      passwordHash: "another-test-fixture",
      role: "player",
      createdAt: expect.any(Date),
    });
  });

  it("returns null for a missing player even when other players exist", async () => {
    const player = await findPlayerById(db, randomUUID());

    expect(player).toBeNull();
  });
});
