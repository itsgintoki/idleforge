import jwt from "jsonwebtoken";
import { z } from "zod";
import { roleSchema } from "../roles.js";
import type { PublicPlayer } from "./types.js";

export const accessTokenLifetimeSeconds = 15 * 60;
export const tokenIssuer = "idleforge";
export const tokenAudience = "idleforge-api";

export const accessTokenClaimsSchema = z.object({
  sub: z.uuid(),
  role: roleSchema,
  iat: z.number().int().nonnegative(),
  exp: z.number().int().positive(),
  iss: z.literal(tokenIssuer),
  aud: z.literal(tokenAudience),
});

export type AccessTokenClaims = z.infer<typeof accessTokenClaimsSchema>;

export function issueAccessToken(
  player: Pick<PublicPlayer, "id" | "role">,
  secret: string,
): string {
  return jwt.sign({ role: player.role }, secret, {
    algorithm: "HS256",
    subject: player.id,
    issuer: tokenIssuer,
    audience: tokenAudience,
    expiresIn: accessTokenLifetimeSeconds,
  });
}

export function verifyAccessToken(token: string, secret: string): AccessTokenClaims | null {
  let payload: unknown;
  try {
    payload = jwt.verify(token, secret, {
      algorithms: ["HS256"],
      issuer: tokenIssuer,
      audience: tokenAudience,
      maxAge: accessTokenLifetimeSeconds,
    });
  } catch (error: unknown) {
    if (error instanceof jwt.JsonWebTokenError) return null;
    throw error;
  }

  const result = accessTokenClaimsSchema.safeParse(payload);
  return result.success ? result.data : null;
}
