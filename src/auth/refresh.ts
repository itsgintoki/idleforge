import { createHash, randomBytes, randomUUID } from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { players, refreshTokens, type PublicPlayer } from "../db/schema.js";

export const refreshTokenLifetimeSeconds = 30 * 24 * 60 * 60;

export type IssuedRefreshToken = {
  refreshToken: string;
  familyId: string;
  expiresAt: Date;
};

export type RotateRefreshResult =
  | { ok: true; player: PublicPlayer; refreshToken: string; expiresIn: number }
  | { ok: false; reason: "invalid_refresh_token" };

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function generateToken(): string {
  return randomBytes(32).toString("base64url");
}

export async function issueRefreshToken(
  db: Database,
  playerId: string,
  ttlSeconds = refreshTokenLifetimeSeconds,
): Promise<IssuedRefreshToken> {
  const refreshToken = generateToken();
  const familyId = randomUUID();
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000);
  await db.insert(refreshTokens).values({
    playerId, familyId, tokenHash: hashToken(refreshToken), expiresAt,
  });
  return { refreshToken, familyId, expiresAt };
}

async function revokeFamily(
  tx: Database,
  familyId: string,
): Promise<void> {
  await tx.update(refreshTokens).set({ revokedAt: sql`clock_timestamp()` })
    .where(and(eq(refreshTokens.familyId, familyId), isNull(refreshTokens.revokedAt)));
}

export async function rotateRefreshToken(
  db: Database,
  token: string,
  ttlSeconds = refreshTokenLifetimeSeconds,
): Promise<RotateRefreshResult> {
  const tokenHash = hashToken(token);

  return db.transaction(async (tx): Promise<RotateRefreshResult> => {
    const [row] = await tx.select().from(refreshTokens)
      .where(eq(refreshTokens.tokenHash, tokenHash)).for("update");
    if (row === undefined) return { ok: false, reason: "invalid_refresh_token" };

    if (row.revokedAt !== null) {
      await revokeFamily(tx, row.familyId);
      return { ok: false, reason: "invalid_refresh_token" };
    }
    if (row.expiresAt.getTime() <= Date.now()) {
      return { ok: false, reason: "invalid_refresh_token" };
    }

    const [player] = await tx.select({
      id: players.id, email: players.email, role: players.role, createdAt: players.createdAt,
    }).from(players).where(eq(players.id, row.playerId));
    if (player === undefined) return { ok: false, reason: "invalid_refresh_token" };

    const refreshToken = generateToken();
    const [replacement] = await tx.insert(refreshTokens).values({
      playerId: row.playerId,
      familyId: row.familyId,
      tokenHash: hashToken(refreshToken),
      expiresAt: new Date(Date.now() + ttlSeconds * 1000),
    }).returning({ id: refreshTokens.id });

    await tx.update(refreshTokens).set({
      revokedAt: sql`clock_timestamp()`,
      replacedBy: replacement?.id ?? null,
    }).where(eq(refreshTokens.id, row.id));

    return { ok: true, player, refreshToken, expiresIn: ttlSeconds };
  });
}

export async function revokeRefreshToken(db: Database, token: string): Promise<void> {
  const [row] = await db.select({ familyId: refreshTokens.familyId }).from(refreshTokens)
    .where(eq(refreshTokens.tokenHash, hashToken(token)));
  if (row === undefined) return;
  await db.update(refreshTokens).set({ revokedAt: sql`clock_timestamp()` })
    .where(and(eq(refreshTokens.familyId, row.familyId), isNull(refreshTokens.revokedAt)));
}
