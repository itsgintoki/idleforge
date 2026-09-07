import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import jwt from "jsonwebtoken";
import { createApp } from "../src/app.js";
import { verifyAccessToken, tokenIssuer, tokenAudience } from "../src/auth/tokens.js";
import type { PlayerDependencies } from "../src/players/routes.js";

const secret = "authentication-test-secret-".repeat(4);
const now = 1_800_000_000;
const id = "c8be0c82-e2b2-47af-8ebc-fc98e034a1db";
const claims = { sub: id, role: "player", iat: now, exp: now + 900, iss: tokenIssuer, aud: tokenAudience };

// Sign raw test claims so we can test malformed registered claims that jwt.sign rejects.
function signPayload(payload: unknown) {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const data = `${header}.${body}`;
  return `${data}.${createHmac("sha256", secret).update(data).digest("base64url")}`;
}

function setup() {
  const state = {
    player: { id, email: "sam@example.com", role: "player" as const, createdAt: new Date() },
    resources: { lifetimeGoldEarned: "0.000000", gold: "0.000000", goldPerSecond: "1.000000", lastCollectedAt: new Date() },
  };
  const findPlayerState = vi.fn<PlayerDependencies["findPlayerState"]>().mockResolvedValue(state);
  const app = createApp({
    signup: async () => { throw new Error("Unexpected signup"); },
    login: async () => { throw new Error("Unexpected login"); },
    issueAccessToken: () => { throw new Error("Unexpected token issuance"); },
    verifyAccessToken: (token) => verifyAccessToken(token, secret),
    collect: async () => { throw new Error("Unexpected collection"); },
    findPlayerState,
  });
  return { app, findPlayerState, state };
}

beforeEach(() => vi.spyOn(Date, "now").mockReturnValue(now * 1000));
afterEach(() => vi.restoreAllMocks());

describe("protected player route", () => {
  it("accepts a valid token and uses its subject for the database lookup", async () => {
    const { app, findPlayerState, state } = setup();
    const response = await request(app).get("/player/me?playerId=someone-else")
      .set("Authorization", `Bearer ${signPayload(claims)}`);
    expect(response.status).toBe(200);
    expect(response.body).toEqual(JSON.parse(JSON.stringify(state)));
    expect(findPlayerState).toHaveBeenCalledWith(id);
    expect(response.headers["cache-control"]).toBe("no-store");
  });

  it("rejects a missing authorization header", async () => {
    const { app, findPlayerState } = setup();
    const response = await request(app).get("/player/me");
    expect(response.status).toBe(401);
    expect(response.headers["www-authenticate"]).toBe("Bearer");
    expect(findPlayerState).not.toHaveBeenCalled();
  });

  it.each(["Basic abc", "Bearer", "Bearer one two", "Bearer broken-token"])(
    "rejects malformed authorization case %#", async (header) => {
      const { app, findPlayerState } = setup();
      const response = await request(app).get("/player/me").set("Authorization", header);
      expect(response.status).toBe(401);
      expect(findPlayerState).not.toHaveBeenCalled();
    },
  );

  const invalidClaims: Array<[string, Record<string, unknown>]> = [
    ["expired", { ...claims, exp: now }],
    ["future not-before", { ...claims, nbf: now + 60 }],
    ["missing subject", { ...claims, sub: undefined }],
    ["wrong subject type", { ...claims, sub: 123 }],
    ["invalid UUID", { ...claims, sub: "not-a-uuid" }],
    ["missing role", { ...claims, role: undefined }],
    ["wrong role type", { ...claims, role: 123 }],
    ["unsupported role", { ...claims, role: "owner" }],
    ["missing expiry", { ...claims, exp: undefined }],
    ["wrong expiry type", { ...claims, exp: "tomorrow" }],
    ["missing issue time", { ...claims, iat: undefined }],
    ["wrong issue time type", { ...claims, iat: "yesterday" }],
    ["wrong issuer", { ...claims, iss: "other-issuer" }],
    ["wrong audience", { ...claims, aud: "other-api" }],
  ];
  it.each(invalidClaims)("rejects correctly signed claims with %s", async (_label, payload) => {
    const { app, findPlayerState } = setup();
    const response = await request(app).get("/player/me").set("Authorization", `Bearer ${signPayload(payload)}`);
    expect(response.status).toBe(401);
    expect(response.body).toEqual({ error: "unauthorized" });
    expect(findPlayerState).not.toHaveBeenCalled();
  });

  it("rejects a changed role without a new valid signature", async () => {
    const { app, findPlayerState } = setup();
    const token = signPayload(claims);
    const parts = token.split(".");
    parts[1] = Buffer.from(JSON.stringify({ ...claims, role: "admin" })).toString("base64url");
    const response = await request(app).get("/player/me").set("Authorization", `Bearer ${parts.join(".")}`);
    expect(response.status).toBe(401);
    expect(findPlayerState).not.toHaveBeenCalled();
  });

  it("rejects a token signed with a different key", async () => {
    const { app } = setup();
    const token = jwt.sign(claims, "another-test-secret-".repeat(4));
    expect((await request(app).get("/player/me").set("Authorization", `Bearer ${token}`)).status).toBe(401);
  });

  it.each(["HS384", "none"] as const)("rejects the %s algorithm", async (algorithm) => {
    const { app } = setup();
    const token = jwt.sign(claims, secret, { algorithm });
    expect((await request(app).get("/player/me").set("Authorization", `Bearer ${token}`)).status).toBe(401);
  });

  it("returns 404 when the authenticated player's state is missing", async () => {
    const { app, findPlayerState } = setup();
    findPlayerState.mockResolvedValue(null);
    const response = await request(app).get("/player/me").set("Authorization", `Bearer ${signPayload(claims)}`);
    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: "player_state_not_found" });
  });

  it("returns 500 for a database failure", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { app, findPlayerState } = setup();
    findPlayerState.mockRejectedValue(new Error("database unavailable"));
    const response = await request(app).get("/player/me").set("Authorization", `Bearer ${signPayload(claims)}`);
    expect(response.status).toBe(500);
    expect(response.body).toEqual({ error: "internal_error" });
  });
});
