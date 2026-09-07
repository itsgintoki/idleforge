import { randomUUID } from "node:crypto";
import { verify } from "argon2";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { createApp } from "../src/app.js";
import { signup } from "../src/auth/signup.js";
import { envSchema } from "../src/config.js";
import { createDatabase } from "../src/db/client.js";
import { players, playerResources } from "../src/db/schema.js";

// A uniquely named, disposable database lets the service commit real transactions.
const config = envSchema.parse(process.env);
const admin = createDatabase(config.DATABASE_URL);
const databaseName = `idleforge_test_${randomUUID().replaceAll("-", "")}`;
const testUrl = new URL(config.DATABASE_URL);
testUrl.pathname = `/${databaseName}`;
const { db, pool } = createDatabase(testUrl.toString());
const app = createApp({ signup: (input) => signup(db, input) });
const password = "a long test passphrase";

beforeAll(async () => {
  await admin.pool.query(`CREATE DATABASE "${databaseName}"`);
  await migrate(db, { migrationsFolder: "./drizzle" });
}, 20_000);

afterAll(async () => {
  await pool.end();
  try {
    await admin.pool.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
  } finally {
    await admin.pool.end();
  }
});

describe("signup with PostgreSQL", () => {
  it("creates both rows, hashes the password, and returns only public fields", async () => {
    const email = `${randomUUID()}@example.test`;
    const response = await request(app).post("/auth/signup").send({
      email: ` ${email.toUpperCase()} `, password,
    });
    expect(response.status).toBe(201);
    expect(Object.keys(response.body.player).sort()).toEqual(["createdAt", "email", "id", "role"]);
    expect(response.body.player.email).toBe(email);
    const [player] = await db.select().from(players).where(eq(players.email, email));
    if (!player) throw new Error("Expected the newly created player");
    expect(player.role).toBe("player");
    expect(player.passwordHash).toMatch(/^\$argon2id\$/);
    expect(await verify(player.passwordHash, password)).toBe(true);
    expect(await verify(player.passwordHash, "incorrect password")).toBe(false);
    const [resource] = await db.select().from(playerResources)
      .where(eq(playerResources.playerId, player.id));
    expect(resource).toMatchObject({ playerId: player.id, gold: "0.000000", goldPerSecond: "1.000000" });
  });

  it("rejects a duplicate email without changing the existing password", async () => {
    const email = `${randomUUID()}@example.test`;
    expect((await request(app).post("/auth/signup").send({ email, password })).status).toBe(201);
    const response = await request(app).post("/auth/signup")
      .send({ email: email.toUpperCase(), password: "a different long password" });
    expect(response.status).toBe(409);
    const rows = await db.select().from(players).where(eq(players.email, email));
    expect(rows).toHaveLength(1);
    const player = rows[0];
    if (!player) throw new Error("Expected the original player");
    expect(await verify(player.passwordHash, password)).toBe(true);
  });

  it("allows exactly one of two simultaneous signups for the same email", async () => {
    const email = `${randomUUID()}@example.test`;
    const responses = await Promise.all([
      request(app).post("/auth/signup").send({ email, password }),
      request(app).post("/auth/signup").send({ email, password }),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([201, 409]);
    const rows = await db.select().from(players)
      .innerJoin(playerResources, eq(players.id, playerResources.playerId))
      .where(eq(players.email, email));
    expect(rows).toHaveLength(1);
  });

  it("rolls back the player when the resource insert fails", async () => {
    const email = `${randomUUID()}@example.test`;
    await pool.query(`
      CREATE FUNCTION reject_test_resource() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'simulated resource failure'; END; $$;
      CREATE TRIGGER reject_test_resource BEFORE INSERT ON player_resources
      FOR EACH ROW EXECUTE FUNCTION reject_test_resource();
    `);
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const response = await request(app).post("/auth/signup").send({ email, password });
      expect(response.status).toBe(500);
      expect(response.body).toEqual({ error: "internal_error" });
      expect(await db.select().from(players).where(eq(players.email, email))).toEqual([]);
    } finally {
      log.mockRestore();
      await pool.query("DROP TRIGGER reject_test_resource ON player_resources; DROP FUNCTION reject_test_resource();");
    }
  });
});
