import { afterEach, expect, it, vi } from "vitest";
import request from "supertest";
import { createApp } from "../src/app.js";
import { unusedLoginDependencies } from "./helpers.js";
import type { PlayerDependencies } from "../src/players/routes.js";

const id = "c8be0c82-e2b2-47af-8ebc-fc98e034a1db";
function setup() {
  const collect = vi.fn<PlayerDependencies["collect"]>().mockResolvedValue({
    ok: true, credited: "10.000000", balance: "20.000000", lifetimeEarned: "30.000000",
    rate: "1.000000", collectedAt: new Date("2026-09-08T00:00:00Z"),
  });
  const app = createApp({ ...unusedLoginDependencies,
    signup: async () => { throw new Error("Unexpected signup"); },
    verifyAccessToken: (token) => token === "valid" ? {
      sub: id, role: "player", iat: 1, exp: 901, iss: "idleforge", aud: "idleforge-api",
    } : null,
    collect,
  });
  return { app, collect };
}
afterEach(() => vi.restoreAllMocks());
it("returns collection data with no cache and uses the verified subject", async () => {
  const { app, collect } = setup();
  const response = await request(app).post("/player/collect?playerId=another-player")
    .set("Authorization", "Bearer valid");
  expect(response.status).toBe(200);
  expect(response.headers["cache-control"]).toBe("no-store");
  expect(response.body).toEqual({ credited: "10.000000", balance: "20.000000",
    lifetimeEarned: "30.000000", rate: "1.000000", collectedAt: "2026-09-08T00:00:00.000Z" });
  expect(collect).toHaveBeenCalledExactlyOnceWith(id);
});
it.each([undefined, "Bearer invalid"])("requires authentication (%s)", async (header) => {
  const { app, collect } = setup();
  const req = request(app).post("/player/collect");
  if (header) req.set("Authorization", header);
  expect((await req).status).toBe(401);
  expect(collect).not.toHaveBeenCalled();
});
it.each([{ amount: "999" }, { playerId: id }, { collectedAt: "2099-01-01" }, []])(
  "rejects client-controlled command data %#", async (body) => {
    const { app, collect } = setup();
    expect((await request(app).post("/player/collect").set("Authorization", "Bearer valid").send(body)).status).toBe(400);
    expect(collect).not.toHaveBeenCalled();
  },
);
it.each(["player_not_found", "resource_not_found"] as const)("maps %s to 404", async (reason) => {
  const { app, collect } = setup();
  collect.mockResolvedValue({ ok: false, reason });
  const response = await request(app).post("/player/collect").set("Authorization", "Bearer valid").send({});
  expect(response.status).toBe(404);
  expect(response.body).toEqual({ error: reason });
});
it("maps unexpected database failures to a generic 500", async () => {
  const { app, collect } = setup();
  vi.spyOn(console, "error").mockImplementation(() => {});
  collect.mockRejectedValue(new Error("private SQL connection details"));
  const response = await request(app).post("/player/collect").set("Authorization", "Bearer valid");
  expect(response.status).toBe(500);
  expect(response.body).toEqual({ error: "internal_error" });
});
