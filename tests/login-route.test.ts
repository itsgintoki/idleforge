import { unusedPlayerDependencies } from "./helpers.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { createApp } from "../src/app.js";
import type { AuthDependencies } from "../src/auth/routes.js";

const input = { email: "sam@example.com", password: "a long test passphrase" };
const player = { id: "test-id", email: input.email, role: "player" as const, createdAt: new Date() };
function setup() {
  const signup = vi.fn<AuthDependencies["signup"]>();
  const login = vi.fn<AuthDependencies["login"]>().mockResolvedValue({ ok: true, player });
  const issueAccessToken = vi.fn<AuthDependencies["issueAccessToken"]>().mockReturnValue("signed-token");
  return { app: createApp({ ...unusedPlayerDependencies, signup, login, issueAccessToken }), login, issueAccessToken };
}
afterEach(() => vi.restoreAllMocks());

describe("POST /auth/login", () => {
  it("validates credentials before issuing a token for the authenticated player", async () => {
    const { app, login, issueAccessToken } = setup();
    const response = await request(app).post("/auth/login").send({ ...input, email: " Sam@EXAMPLE.com " });
    expect(response.status).toBe(200);
    expect(login).toHaveBeenCalledWith(input);
    expect(issueAccessToken).toHaveBeenCalledWith(player);
    expect(response.body.accessToken).toBe("signed-token");
    expect(response.headers["cache-control"]).toBe("no-store");
  });

  it("rejects role input before checking credentials or issuing a token", async () => {
    const { app, login, issueAccessToken } = setup();
    const response = await request(app).post("/auth/login").send({ ...input, role: "admin" });
    expect(response.status).toBe(400);
    expect(login).not.toHaveBeenCalled();
    expect(issueAccessToken).not.toHaveBeenCalled();
  });

  it("never issues a token for invalid credentials", async () => {
    const { app, login, issueAccessToken } = setup();
    login.mockResolvedValue({ ok: false, reason: "invalid_credentials" });
    const response = await request(app).post("/auth/login").send(input);
    expect(response.status).toBe(401);
    expect(response.body).toEqual({ error: "invalid_credentials" });
    expect(issueAccessToken).not.toHaveBeenCalled();
  });

  it("reports a database failure as 500 rather than invalid credentials", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { app, login, issueAccessToken } = setup();
    login.mockRejectedValue(new Error("internal database details"));
    const response = await request(app).post("/auth/login").send(input);
    expect(response.status).toBe(500);
    expect(response.body).toEqual({ error: "internal_error" });
    expect(issueAccessToken).not.toHaveBeenCalled();
  });

  it("does not report success if token signing fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { app, issueAccessToken } = setup();
    issueAccessToken.mockImplementation(() => { throw new Error("signing failure"); });
    const response = await request(app).post("/auth/login").send(input);
    expect(response.status).toBe(500);
    expect(response.body).toEqual({ error: "internal_error" });
  });
});
