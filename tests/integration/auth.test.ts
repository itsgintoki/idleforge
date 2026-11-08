import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { signup } from "../../src/auth/service.js";
import {
  issueRefreshToken,
  revokeRefreshToken,
  rotateRefreshToken,
} from "../../src/auth/refresh.js";
import { playerResources, players } from "../../src/db/schema.js";
import { createTestDatabase, type TestDatabase } from "../harness/database.js";
import { createPlayer } from "../harness/factories.js";

let database: TestDatabase;

beforeAll(async () => {
  database = await createTestDatabase();
});

afterAll(async () => {
  await database.drop();
});

describe("signup", () => {
  it("creates a player with a zero balance and an Argon2id hash", async () => {
    const email = `signup-${randomUUID()}@example.com`;
    const result = await signup(database.db, { email, password: "test-password-123" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const [resource] = await database.db.select().from(playerResources)
      .where(eq(playerResources.playerId, result.player.id));
    expect(resource?.gold).toBe("0.000000");
    expect(resource?.lifetimeGoldEarned).toBe("0.000000");
    expect(resource?.goldPerSecond).toBe("1.000000");

    const [player] = await database.db.select().from(players)
      .where(eq(players.id, result.player.id));
    expect(player?.passwordHash.startsWith("$argon2id$")).toBe(true);
    expect(player?.passwordHash).not.toContain("test-password-123");
    expect(Object.keys(result.player).sort()).toEqual(["createdAt", "email", "id", "role"]);
  });

  it("allows exactly one of several concurrent duplicate signups", async () => {
    const email = `race-${randomUUID()}@example.com`;
    const attempts = await Promise.all(
      Array.from({ length: 5 }, () =>
        signup(database.db, { email, password: "test-password-123" })),
    );

    expect(attempts.filter((attempt) => attempt.ok)).toHaveLength(1);
    expect(attempts.filter((attempt) => !attempt.ok)).toHaveLength(4);
    expect(attempts.every((attempt) => attempt.ok || attempt.reason === "email_taken")).toBe(true);

    const rows = await database.db.select().from(players).where(eq(players.email, email));
    expect(rows).toHaveLength(1);
  });
});

describe("refresh token rotation", () => {
  it("rotates a token and revokes the family when the old token is replayed", async () => {
    const player = await createPlayer(database.db);
    const issued = await issueRefreshToken(database.db, player.id, 3600);

    const rotated = await rotateRefreshToken(database.db, issued.refreshToken, 3600);
    expect(rotated.ok).toBe(true);
    if (!rotated.ok) return;
    expect(rotated.player.id).toBe(player.id);
    expect(rotated.refreshToken).not.toBe(issued.refreshToken);

    const replay = await rotateRefreshToken(database.db, issued.refreshToken, 3600);
    expect(replay).toEqual({ ok: false, reason: "invalid_refresh_token" });

    const family = await rotateRefreshToken(database.db, rotated.refreshToken, 3600);
    expect(family).toEqual({ ok: false, reason: "invalid_refresh_token" });
  });

  it("rejects expired and unknown tokens", async () => {
    const player = await createPlayer(database.db);
    const expired = await issueRefreshToken(database.db, player.id, -10);
    expect(await rotateRefreshToken(database.db, expired.refreshToken, 3600))
      .toEqual({ ok: false, reason: "invalid_refresh_token" });
    expect(await rotateRefreshToken(database.db, "unknown-token", 3600))
      .toEqual({ ok: false, reason: "invalid_refresh_token" });
  });

  it("revokes the whole family on logout", async () => {
    const player = await createPlayer(database.db);
    const issued = await issueRefreshToken(database.db, player.id, 3600);
    const rotated = await rotateRefreshToken(database.db, issued.refreshToken, 3600);
    expect(rotated.ok).toBe(true);
    if (!rotated.ok) return;

    await revokeRefreshToken(database.db, rotated.refreshToken);
    expect(await rotateRefreshToken(database.db, rotated.refreshToken, 3600))
      .toEqual({ ok: false, reason: "invalid_refresh_token" });
  });
});
