import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { issueAccessToken } from "../../src/auth/tokens.js";
import { eventOutbox } from "../../src/db/schema.js";
import { reconcileLeaderboard } from "../../src/leaderboard/service.js";
import { testJwtSecret } from "../harness/env.js";
import { createPlayer, setGold, setLastCollectedAt } from "../harness/factories.js";
import { api } from "../harness/http.js";
import { createTestStack, type TestStack } from "../harness/stack.js";

let stack: TestStack;
const password = "test-password-123";

beforeAll(async () => {
  stack = await createTestStack();
}, 60_000);

afterAll(async () => {
  await stack.close();
});

describe("HTTP contract", () => {
  it("serves liveness, readiness, and service metadata", async () => {
    const health = await api(stack.baseUrl, "/health");
    expect(health.status).toBe(200);
    expect(health.body).toEqual({ status: "ok" });

    const ready = await api(stack.baseUrl, "/ready");
    expect(ready.status).toBe(200);
    expect(ready.body).toMatchObject({ status: "ready", checks: { db: true, redis: true } });

    const root = await api(stack.baseUrl, "/");
    expect(root.status).toBe(200);
    expect(root.body).toMatchObject({ name: "IdleForge" });
  });

  it("signs up, logs in, and reads player state without leaking secrets", async () => {
    const email = `http-${randomUUID()}@example.com`;
    const signup = await api(stack.baseUrl, "/auth/signup", { body: { email, password } });
    expect(signup.status).toBe(201);
    const signupBody = signup.body as { player: { id: string; email: string; role: string } };
    expect(signupBody.player.email).toBe(email);
    expect(signupBody.player).toMatchObject({ role: "player" });
    expect(JSON.stringify(signup.body)).not.toContain("passwordHash");

    const login = await api(stack.baseUrl, "/auth/login", { body: { email, password } });
    expect(login.status).toBe(200);
    expect(login.headers.get("cache-control")).toBe("no-store");
    const loginBody = login.body as {
      accessToken: string; refreshToken: string; tokenType: string;
      expiresIn: number; refreshExpiresIn: number;
    };
    expect(loginBody.accessToken).toBeTruthy();
    expect(loginBody.refreshToken).toBeTruthy();
    expect(loginBody.tokenType).toBe("Bearer");
    expect(loginBody.expiresIn).toBe(900);
    expect(loginBody.refreshExpiresIn).toBe(30 * 24 * 60 * 60);

    const me = await api(stack.baseUrl, "/player/me", { token: loginBody.accessToken });
    expect(me.status).toBe(200);
    expect(me.headers.get("cache-control")).toBe("no-store");
    expect(me.body).toMatchObject({
      player: { id: signupBody.player.id, email, role: "player" },
      resources: { gold: "0.000000", lifetimeGoldEarned: "0.000000", goldPerSecond: "1.000000" },
      buildings: [],
    });

    const wrongPassword = await api(stack.baseUrl, "/auth/login", {
      body: { email, password: "wrong-password-123" },
    });
    expect(wrongPassword.status).toBe(401);
    expect(wrongPassword.body).toEqual({ error: "invalid_credentials" });

    const duplicate = await api(stack.baseUrl, "/auth/signup", { body: { email, password } });
    expect(duplicate.status).toBe(409);
    expect(duplicate.body).toEqual({ error: "email_taken" });
  });

  it("collects and purchases through the authenticated routes", async () => {
    const player = await createPlayer(stack.db, { gold: "1000.000000", rate: "1.000000" });
    await setLastCollectedAt(stack.db, player.id, 3);

    const collect = await api(stack.baseUrl, "/player/collect", {
      token: player.token, body: {},
    });
    expect(collect.status).toBe(200);
    expect(collect.headers.get("cache-control")).toBe("no-store");
    const collected = collect.body as { credited: string; balance: string; rate: string };
    expect(Number(collected.credited)).toBeGreaterThanOrEqual(3);
    expect(Number(collected.credited)).toBeLessThan(4);
    expect(collected.rate).toBe("1.000000");

    await setGold(stack.db, player.id, "1000.000000");
    const key = `http-purchase-${randomUUID()}`;
    const purchase = await api(stack.baseUrl, "/player/purchases", {
      token: player.token, body: { building: "mine" }, headers: { "Idempotency-Key": key },
    });
    expect(purchase.status).toBe(200);
    expect(purchase.body).toMatchObject({ building: "mine", level: 1, spent: "100.000000", rate: "2.000000" });

    const replay = await api(stack.baseUrl, "/player/purchases", {
      token: player.token, body: { building: "mine" }, headers: { "Idempotency-Key": key },
    });
    expect(replay.status).toBe(200);
    expect(replay.body).toEqual(purchase.body);

    const reused = await api(stack.baseUrl, "/player/purchases", {
      token: player.token, body: { building: "forge" }, headers: { "Idempotency-Key": key },
    });
    expect(reused.status).toBe(409);
    expect(reused.body).toEqual({ error: "idempotency_key_reused" });
  });

  it("rotates refresh tokens and revokes the family on reuse", async () => {
    const email = `refresh-${randomUUID()}@example.com`;
    await api(stack.baseUrl, "/auth/signup", { body: { email, password } });
    const login = await api(stack.baseUrl, "/auth/login", { body: { email, password } });
    const first = (login.body as { refreshToken: string }).refreshToken;

    const refreshed = await api(stack.baseUrl, "/auth/refresh", { body: { refreshToken: first } });
    expect(refreshed.status).toBe(200);
    expect(refreshed.headers.get("cache-control")).toBe("no-store");
    const rotated = refreshed.body as { accessToken: string; refreshToken: string };
    expect(rotated.accessToken).toBeTruthy();
    expect(rotated.refreshToken).not.toBe(first);

    const replay = await api(stack.baseUrl, "/auth/refresh", { body: { refreshToken: first } });
    expect(replay.status).toBe(401);
    expect(replay.body).toEqual({ error: "invalid_refresh_token" });

    const familyRevoked = await api(stack.baseUrl, "/auth/refresh", {
      body: { refreshToken: rotated.refreshToken },
    });
    expect(familyRevoked.status).toBe(401);

    const secondLogin = await api(stack.baseUrl, "/auth/login", { body: { email, password } });
    const fresh = (secondLogin.body as { refreshToken: string }).refreshToken;
    const logout = await api(stack.baseUrl, "/auth/logout", { body: { refreshToken: fresh } });
    expect(logout.status).toBe(204);

    const afterLogout = await api(stack.baseUrl, "/auth/refresh", {
      body: { refreshToken: fresh },
    });
    expect(afterLogout.status).toBe(401);

    const invalid = await api(stack.baseUrl, "/auth/refresh", { body: {} });
    expect(invalid.status).toBe(400);
    expect(invalid.body).toEqual({ error: "invalid_input" });
  });

  it("rejects invalid input at the HTTP boundary before touching the economy", async () => {
    const player = await createPlayer(stack.db, { gold: "1000.000000" });

    const invalidSignup = await api(stack.baseUrl, "/auth/signup", { body: { email: "nope" } });
    expect(invalidSignup.status).toBe(400);
    expect(invalidSignup.body).toEqual({ error: "invalid_input" });

    const extraCollectField = await api(stack.baseUrl, "/player/collect", {
      token: player.token, body: { amount: "1000000" },
    });
    expect(extraCollectField.status).toBe(400);
    expect(extraCollectField.body).toEqual({ error: "invalid_input" });

    const missingKey = await api(stack.baseUrl, "/player/purchases", {
      token: player.token, body: { building: "mine" },
    });
    expect(missingKey.status).toBe(400);

    const badKey = await api(stack.baseUrl, "/player/purchases", {
      token: player.token, body: { building: "mine" }, headers: { "Idempotency-Key": "bad key!" },
    });
    expect(badKey.status).toBe(400);

    const extraPurchaseField = await api(stack.baseUrl, "/player/purchases", {
      token: player.token, body: { building: "mine", price: 1 },
      headers: { "Idempotency-Key": `extra-${randomUUID()}` },
    });
    expect(extraPurchaseField.status).toBe(400);

    const unknownBuilding = await api(stack.baseUrl, "/player/purchases", {
      token: player.token, body: { building: "farm" },
      headers: { "Idempotency-Key": `unknown-${randomUUID()}` },
    });
    expect(unknownBuilding.status).toBe(400);

    const badLimit = await api(stack.baseUrl, "/leaderboard?limit=0", { token: player.token });
    expect(badLimit.status).toBe(400);
  });

  it("requires authentication and refuses foreign or stale identities", async () => {
    const missing = await api(stack.baseUrl, "/player/me");
    expect(missing.status).toBe(401);
    expect(missing.headers.get("www-authenticate")).toBe("Bearer");

    const unknownIdentity = issueAccessToken(
      { id: randomUUID(), role: "player" }, testJwtSecret,
    );
    const unknown = await api(stack.baseUrl, "/player/me", { token: unknownIdentity });
    expect(unknown.status).toBe(404);
    expect(unknown.body).toEqual({ error: "player_state_not_found" });

    const nonAdmin = await createPlayer(stack.db);
    const forbidden = await api(stack.baseUrl, "/admin/world-events/gold-bonus", {
      token: nonAdmin.token, body: { occurrenceId: randomUUID() },
    });
    expect(forbidden.status).toBe(403);
  });

  it("exposes the admin bonus trigger and failed-job inspection", async () => {
    const admin = await createPlayer(stack.db, { role: "admin" });
    const occurrenceId = randomUUID();

    const queued = await api(stack.baseUrl, "/admin/world-events/gold-bonus", {
      token: admin.token, body: { occurrenceId },
    });
    expect(queued.status).toBe(202);
    expect(queued.body).toEqual({
      jobId: `manual-${occurrenceId}`,
      occurrenceId: `manual-${occurrenceId}`,
      status: "accepted",
    });

    const [outbox] = await stack.db.select().from(eventOutbox)
      .where(eq(eventOutbox.occurrenceId, `manual-${occurrenceId}`));
    expect(outbox?.dispatchedAt).not.toBeNull();

    const failed = await api(stack.baseUrl, "/admin/world-events/jobs/failed?limit=5", {
      token: admin.token,
    });
    expect(failed.status).toBe(200);
    expect(failed.body).toEqual({ jobs: [] });

    const badBody = await api(stack.baseUrl, "/admin/world-events/gold-bonus", {
      token: admin.token, body: { occurrenceId: "not-a-uuid" },
    });
    expect(badBody.status).toBe(400);
  });

  it("serves the leaderboard only after a complete snapshot exists", async () => {
    const player = await createPlayer(stack.db, { lifetime: "75.000000" });
    await stack.redis.del(
      stack.leaderboard.key, stack.leaderboard.exactKey, stack.leaderboard.readyKey,
    );

    const unavailable = await api(stack.baseUrl, "/leaderboard?limit=10", { token: player.token });
    expect(unavailable.status).toBe(503);
    expect(unavailable.body).toEqual({ error: "leaderboard_unavailable" });

    const reconciled = await reconcileLeaderboard(stack.db, stack.leaderboard);
    expect(reconciled.ok).toBe(true);

    const page = await api(stack.baseUrl, "/leaderboard?limit=10", { token: player.token });
    expect(page.status).toBe(200);
    expect(page.headers.get("cache-control")).toBe("no-store");
    const body = page.body as { entries: { playerId: string }[]; me: { playerId: string } | null };
    expect(body.entries.some((entry) => entry.playerId === player.id)).toBe(true);
    expect(body.me?.playerId).toBe(player.id);
  });

  it("echoes caller request IDs and generates one when absent", async () => {
    const supplied = await api(stack.baseUrl, "/health", { headers: { "X-Request-ID": "caller-supplied-id" } });
    expect(supplied.headers.get("x-request-id")).toBe("caller-supplied-id");

    const generated = await api(stack.baseUrl, "/health");
    const id = generated.headers.get("x-request-id");
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("returns structured errors for malformed and oversized bodies", async () => {
    const malformed = await api(stack.baseUrl, "/auth/signup", {
      headers: { "content-type": "application/json" },
      body: "{not-json",
    });
    expect(malformed.status).toBe(400);
    expect(malformed.body).toEqual({ error: "invalid_request_body" });

    const oversized = await api(stack.baseUrl, "/auth/signup", {
      body: { email: `${"a".repeat(17_000)}@example.com`, password },
    });
    expect(oversized.status).toBe(413);
    expect(oversized.body).toEqual({ error: "invalid_request_body" });
  });
});
