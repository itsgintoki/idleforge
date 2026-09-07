import type { RequestHandler } from "express";
import type { AccessTokenClaims } from "./tokens.js";

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
