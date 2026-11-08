import { randomUUID } from "node:crypto";
import jwt from "jsonwebtoken";
import { describe, expect, it } from "vitest";
import {
  accessTokenLifetimeSeconds,
  issueAccessToken,
  tokenAudience,
  tokenIssuer,
  verifyAccessToken,
} from "../../src/auth/tokens.js";

const secret = "x".repeat(64);
const player = { id: randomUUID(), role: "player" as const };

describe("access tokens", () => {
  it("issues verifiable claims with the expected lifetime and identity", () => {
    const token = issueAccessToken(player, secret);
    const claims = verifyAccessToken(token, secret);
    expect(claims).not.toBeNull();
    expect(claims?.sub).toBe(player.id);
    expect(claims?.role).toBe("player");
    expect(claims?.iss).toBe(tokenIssuer);
    expect(claims?.aud).toBe(tokenAudience);
    expect(claims?.exp).toBeGreaterThan(claims?.iat ?? 0);
    expect((claims?.exp ?? 0) - (claims?.iat ?? 0)).toBe(accessTokenLifetimeSeconds);
  });

  it("returns null for a wrong secret or a tampered token", () => {
    const token = issueAccessToken(player, secret);
    expect(verifyAccessToken(token, "y".repeat(64))).toBeNull();
    expect(verifyAccessToken(`${token}x`, secret)).toBeNull();
    expect(verifyAccessToken("not-a-token", secret)).toBeNull();
  });

  it("returns null for expired, wrong-issuer, and wrong-audience tokens", () => {
    const base = { algorithm: "HS256" as const, subject: player.id, issuer: tokenIssuer, audience: tokenAudience };
    const expired = jwt.sign({ role: "player" }, secret, { ...base, expiresIn: -10 });
    const wrongIssuer = jwt.sign({ role: "player" }, secret, { ...base, issuer: "someone-else", expiresIn: 60 });
    const wrongAudience = jwt.sign({ role: "player" }, secret, { ...base, audience: "other-api", expiresIn: 60 });
    expect(verifyAccessToken(expired, secret)).toBeNull();
    expect(verifyAccessToken(wrongIssuer, secret)).toBeNull();
    expect(verifyAccessToken(wrongAudience, secret)).toBeNull();
  });

  it("rejects tokens whose claims do not match the schema", () => {
    const token = jwt.sign({ role: "superuser" }, secret, {
      algorithm: "HS256", subject: player.id, issuer: tokenIssuer, audience: tokenAudience, expiresIn: 60,
    });
    expect(verifyAccessToken(token, secret)).toBeNull();
  });
});
