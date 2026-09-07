import { afterEach, describe, expect, it, vi } from "vitest";
import jwt from "jsonwebtoken";
import { issueAccessToken, accessTokenClaimsSchema, tokenIssuer, tokenAudience } from "../src/auth/tokens.js";

const secret = "unit-test-secret-".repeat(8);
const player = { id: "c8be0c82-e2b2-47af-8ebc-fc98e034a1db", role: "player" as const };
const now = 1_800_000_000;
afterEach(() => vi.restoreAllMocks());

function makeToken() {
  vi.spyOn(Date, "now").mockReturnValue(now * 1000);
  return issueAccessToken(player, secret);
}

const verification = {
  algorithms: ["HS256"] as jwt.Algorithm[],
  issuer: tokenIssuer,
  audience: tokenAudience,
  clockTimestamp: now,
};

describe("access token issuance", () => {
  it("signs only the intended claims with a 15-minute lifetime", () => {
    const payload: unknown = jwt.verify(makeToken(), secret, verification);
    expect(payload).toEqual({
      sub: player.id, role: "player", iat: now, exp: now + 900,
      iss: tokenIssuer, aud: tokenAudience,
    });
    expect(accessTokenClaimsSchema.parse(payload).sub).toBe(player.id);
  });

  it("expires at the expiry timestamp", () => {
    const token = makeToken();
    expect(() => jwt.verify(token, secret, { ...verification, clockTimestamp: now + 899 })).not.toThrow();
    expect(() => jwt.verify(token, secret, { ...verification, clockTimestamp: now + 900 }))
      .toThrow(jwt.TokenExpiredError);
  });

  it("cannot be verified with a different secret", () => {
    expect(() => jwt.verify(makeToken(), "other-secret-".repeat(8), verification)).toThrow();
  });

  it("fails verification for an unexpected audience", () => {
    expect(() => jwt.verify(makeToken(), secret, { ...verification, audience: "another-app" })).toThrow();
  });
});
