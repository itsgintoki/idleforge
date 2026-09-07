import { findPlayerState } from "../src/players/queries.js";
import { randomUUID } from "node:crypto";
import { verify } from "argon2";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { createApp } from "../src/app.js";
import { signup } from "../src/auth/signup.js";
import { login } from "../src/auth/login.js";
import { issueAccessToken, verifyAccessToken, accessTokenClaimsSchema, tokenIssuer, tokenAudience } from "../src/auth/tokens.js";
import jwt from "jsonwebtoken";
import { loginSchema } from "../src/auth/schemas.js";
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
const app = createApp({
  signup: (input) => signup(db, input),
  login: (input) => login(db, input),
  issueAccessToken: (player) => issueAccessToken(player, config.JWT_SECRET),
  verifyAccessToken: (token) => verifyAccessToken(token, config.JWT_SECRET),
  findPlayerState: (playerId) => findPlayerState(db, playerId),
});
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


describe("login credentials with PostgreSQL", () => {
  it("authenticates a signed-up player and returns only public fields", async () => {
    const email = `${randomUUID()}@example.test`;
    const created = await signup(db, { email, password });
    if (!created.ok) throw new Error("Expected fixture signup success");
    const input = loginSchema.parse({ email: ` ${email.toUpperCase()} `, password });
    expect(await login(db, input)).toEqual({ ok: true, player: created.player });
  });

  it("returns the same result for wrong passwords and unknown emails", async () => {
    const email = `${randomUUID()}@example.test`;
    await signup(db, { email, password });
    const wrong = await login(db, { email, password: "wrong" });
    const missing = await login(db, { email: `${randomUUID()}@example.test`, password });
    expect(wrong).toEqual({ ok: false, reason: "invalid_credentials" });
    expect(missing).toEqual(wrong);
  });

  it("does not authenticate a missing player even if the dummy hash matches", async () => {
    expect(await login(db, {
      email: `${randomUUID()}@example.test`,
      password: "dummy-verification-only-not-an-account",
    })).toEqual({ ok: false, reason: "invalid_credentials" });
  });

  it("preserves password spaces and case during verification", async () => {
    const email = `${randomUUID()}@example.test`;
    const exactPassword = " My Exact Passphrase ";
    await signup(db, { email, password: exactPassword });
    expect((await login(db, { email, password: exactPassword })).ok).toBe(true);
    expect((await login(db, { email, password: exactPassword.trim() })).ok).toBe(false);
    expect((await login(db, { email, password: exactPassword.toLowerCase() })).ok).toBe(false);
  });

  it("lets a corrupt stored hash surface as an internal failure", async () => {
    const email = `${randomUUID()}@example.test`;
    await db.insert(players).values({ email, passwordHash: "corrupt-hash" });
    await expect(login(db, { email, password })).rejects.toThrow();
  });
});


describe("POST /auth/login with PostgreSQL", () => {
  it("issues a signed token after signup and successful credential verification", async () => {
    const email = `${randomUUID()}@example.test`;
    const created = await request(app).post("/auth/signup").send({ email, password });
    expect(created.status).toBe(201);
    const response = await request(app).post("/auth/login")
      .send({ email: ` ${email.toUpperCase()} `, password });
    expect(response.status).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.body.player).toEqual(created.body.player);
    expect(response.body.tokenType).toBe("Bearer");
    expect(response.body.expiresIn).toBe(900);
    const claims = accessTokenClaimsSchema.parse(jwt.verify(response.body.accessToken, config.JWT_SECRET, {
      algorithms: ["HS256"], issuer: tokenIssuer, audience: tokenAudience,
    }));
    expect(claims.sub).toBe(created.body.player.id);
    expect(claims.role).toBe("player");
    expect(claims.exp - claims.iat).toBe(900);
  });

  it("returns identical 401 bodies for wrong passwords and unknown accounts", async () => {
    const email = `${randomUUID()}@example.test`;
    await signup(db, { email, password });
    const wrong = await request(app).post("/auth/login").send({ email, password: "wrong" });
    const missing = await request(app).post("/auth/login")
      .send({ email: `${randomUUID()}@example.test`, password });
    expect(wrong.status).toBe(401);
    expect(missing.status).toBe(401);
    expect(wrong.body).toEqual({ error: "invalid_credentials" });
    expect(missing.body).toEqual(wrong.body);
  });
});


describe("authenticated player state with PostgreSQL", () => {
  it("completes signup, login, and a protected read for only the token owner", async () => {
    const email = `${randomUUID()}@example.test`;
    const owner = await signup(db, { email, password });
    const other = await signup(db, { email: `${randomUUID()}@example.test`, password });
    if (!owner.ok || !other.ok) throw new Error("Expected fixture signups");
    const signedIn = await request(app).post("/auth/login").send({ email, password });
    expect(signedIn.status).toBe(200);
    const response = await request(app).get(`/player/me?playerId=${other.player.id}`)
      .set("Authorization", `Bearer ${signedIn.body.accessToken}`);
    expect(response.status).toBe(200);
    expect(response.body.player.id).toBe(owner.player.id);
    expect(Object.keys(response.body.player).sort()).toEqual(["createdAt", "email", "id", "role"]);
    expect(response.body.resources).toMatchObject({ gold: "0.000000", goldPerSecond: "1.000000" });
  });

  it("returns missing state for a player deleted after token issuance", async () => {
    const email = `${randomUUID()}@example.test`;
    const owner = await signup(db, { email, password });
    if (!owner.ok) throw new Error("Expected fixture signup");
    const token = issueAccessToken(owner.player, config.JWT_SECRET);
    await db.delete(players).where(eq(players.id, owner.player.id));
    const response = await request(app).get("/player/me").set("Authorization", `Bearer ${token}`);
    expect(response.status).toBe(404);
  });
});
