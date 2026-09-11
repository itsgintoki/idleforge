import jwt from "jsonwebtoken";
import type { RequestHandler } from "express";
import { z } from "zod";
import { roleSchema, type PublicPlayer } from "../db/schema.js";

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

declare module "express-serve-static-core" {
  interface Request {
    auth?: AccessTokenClaims;
  }
}

export type VerifyAccessToken = (token: string) => AccessTokenClaims | null;

export function createAuthentication(verifyToken: VerifyAccessToken): RequestHandler {
  return (req, res, next) => {
    const match = /^Bearer ([^\s]+)$/i.exec(req.get("authorization") ?? "");
    const token = match?.[1];
    if (!token) {
      res.set("WWW-Authenticate", "Bearer").status(401).json({ error: "unauthorized" });
      return;
    }

    const claims = verifyToken(token);
    if (claims === null) {
      res.set("WWW-Authenticate", "Bearer").status(401).json({ error: "unauthorized" });
      return;
    }

    req.auth = claims;
    next();
  };
}
