import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type { Database } from "../../src/db/client.js";
import { playerResources, players, type PlayerRole } from "../../src/db/schema.js";
import { issueAccessToken } from "../../src/auth/tokens.js";
import { signup } from "../../src/auth/service.js";
import { testJwtSecret } from "./env.js";

export type TestPlayer = {
  id: string;
  email: string;
  role: PlayerRole;
  token: string;
};

export type CreatePlayerOptions = {
  role?: PlayerRole;
  gold?: string;
  lifetime?: string;
  rate?: string;
  lastCollectedAt?: Date;
};

export async function createPlayer(
  db: Database,
  options: CreatePlayerOptions = {},
): Promise<TestPlayer> {
  const id = randomUUID();
  const email = `player-${id}@example.com`;
  const role = options.role ?? "player";
  await db.insert(players).values({ id, email, passwordHash: "not-a-real-hash", role });
  await db.insert(playerResources).values({
    playerId: id,
    gold: options.gold ?? "0",
    lifetimeGoldEarned: options.lifetime ?? "0",
    goldPerSecond: options.rate ?? "1.000000",
    ...(options.lastCollectedAt === undefined ? {} : { lastCollectedAt: options.lastCollectedAt }),
  });
  return { id, email, role, token: issueAccessToken({ id, role }, testJwtSecret) };
}

export async function createAccount(db: Database, password = "test-password-123") {
  const email = `account-${randomUUID()}@example.com`;
  const result = await signup(db, { email, password });
  if (!result.ok) throw new Error("Test signup failed");
  return { ...result.player, password };
}

export async function setLastCollectedAt(
  db: Database,
  playerId: string,
  secondsAgo: number,
): Promise<void> {
  await db.execute(sql`
    UPDATE player_resources
    SET last_collected_at = clock_timestamp() - (${secondsAgo}::int * interval '1 second')
    WHERE player_id = ${playerId}::uuid
  `);
}

export async function setGold(db: Database, playerId: string, gold: string): Promise<void> {
  await db.execute(sql`
    UPDATE player_resources SET gold = ${gold}::numeric WHERE player_id = ${playerId}::uuid
  `);
}
