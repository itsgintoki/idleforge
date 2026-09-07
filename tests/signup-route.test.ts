import { afterEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { createApp } from "../src/app.js";
import type { Signup } from "../src/auth/routes.js";

const input = { email: "sam@example.com", password: "a long test passphrase" };
afterEach(() => vi.restoreAllMocks());

describe("POST /auth/signup", () => {
  it("validates and normalizes input before calling signup", async () => {
    const player = { id: "test-id", email: input.email, role: "player" as const, createdAt: new Date() };
    const signup = vi.fn<Signup>().mockResolvedValue({ ok: true, player });
    const response = await request(createApp({ signup })).post("/auth/signup")
      .send({ ...input, email: " Sam@EXAMPLE.com " });
    expect(response.status).toBe(201);
    expect(signup).toHaveBeenCalledWith(input);
    expect(response.body).toEqual({ player: { ...player, createdAt: player.createdAt.toISOString() } });
  });

  it("rejects extra role input before calling the service", async () => {
    const signup = vi.fn<Signup>();
    const response = await request(createApp({ signup })).post("/auth/signup")
      .send({ ...input, role: "admin" });
    expect(response.status).toBe(400);
    expect(signup).not.toHaveBeenCalled();
  });

  it("maps duplicate emails to conflict", async () => {
    const signup = vi.fn<Signup>().mockResolvedValue({ ok: false, reason: "email_taken" });
    const response = await request(createApp({ signup })).post("/auth/signup").send(input);
    expect(response.status).toBe(409);
    expect(response.body).toEqual({ error: "email_taken" });
  });

  it("does not expose internal errors", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const signup = vi.fn<Signup>().mockRejectedValue(new Error("secret database details"));
    const response = await request(createApp({ signup })).post("/auth/signup").send(input);
    expect(response.status).toBe(500);
    expect(response.body).toEqual({ error: "internal_error" });
  });

  it("returns JSON for malformed request JSON", async () => {
    const signup = vi.fn<Signup>();
    const response = await request(createApp({ signup })).post("/auth/signup")
      .set("Content-Type", "application/json").send('{"email":');
    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: "invalid_request_body" });
    expect(signup).not.toHaveBeenCalled();
  });

  it("rejects oversized bodies before invoking signup", async () => {
    const signup = vi.fn<Signup>();
    const response = await request(createApp({ signup })).post("/auth/signup")
      .send({ ...input, password: "a".repeat(20_000) });
    expect(response.status).toBe(413);
    expect(signup).not.toHaveBeenCalled();
  });
});
