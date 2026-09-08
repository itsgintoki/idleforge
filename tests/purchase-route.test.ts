import { afterEach, expect, it, vi } from "vitest";
import request from "supertest";
import { createApp } from "../src/app.js";
import { unusedLoginDependencies } from "./helpers.js";
import type { PlayerDependencies } from "../src/players/routes.js";
import { priceForLevel, purchaseSchema } from "../src/buildings/catalogue.js";

const id = "c8be0c82-e2b2-47af-8ebc-fc98e034a1db";
function setup() {
  const purchase = vi.fn<PlayerDependencies["purchase"]>().mockResolvedValue({
    ok: true, building: "mine", level: 1, spent: "100.000000", credited: "0.000000",
    balance: "200.000000", lifetimeEarned: "300.000000", rate: "2.000000",
    collectedAt: new Date("2026-09-08T00:00:00Z"),
  });
  const app = createApp({ ...unusedLoginDependencies,
    signup: async () => { throw new Error("Unexpected signup"); },
    verifyAccessToken: (token) => token === "valid" ? {
      sub: id, role: "player", iat: 1, exp: 901, iss: "idleforge", aud: "idleforge-api",
    } : null, purchase,
  });
  return { app, purchase };
}
afterEach(() => vi.restoreAllMocks());
it("accepts a known building and uses the verified player ID", async () => {
  const { app, purchase } = setup();
  const response = await request(app).post("/player/purchases?playerId=another-player")
    .set("Authorization", "Bearer valid").set("Idempotency-Key", "test-key").send({ building: "mine" });
  expect(response.status).toBe(200);
  expect(response.headers["cache-control"]).toBe("no-store");
  expect(response.body).toEqual({ building: "mine", level: 1, spent: "100.000000", credited: "0.000000",
    balance: "200.000000", lifetimeEarned: "300.000000", rate: "2.000000", collectedAt: "2026-09-08T00:00:00.000Z" });
  expect(purchase).toHaveBeenCalledExactlyOnceWith(id, { building: "mine" }, "test-key");
});
it.each([undefined, "Bearer invalid"])("requires authentication (%s)", async (header) => {
  const { app, purchase } = setup();
  const req = request(app).post("/player/purchases").send({ building: "mine" });
  if (header) req.set("Authorization", header);
  expect((await req).status).toBe(401);
  expect(purchase).not.toHaveBeenCalled();
});
it.each([{}, { building: "castle" }, { building: 1 }, { building: "mine", price: "0" },
  { building: "mine", playerId: id }, { building: "mine", level: 100 }, [], { building: "toString" }])(
  "rejects invalid or client-controlled purchase data %#", async (body) => {
    const { app, purchase } = setup();
    const response = await request(app).post("/player/purchases").set("Authorization", "Bearer valid").set("Idempotency-Key", "test-key").send(body);
    expect(response.status).toBe(400);
    expect(purchase).not.toHaveBeenCalled();
  },
);
it.each([
  ["player_not_found", 404], ["resource_not_found", 404],
  ["insufficient_funds", 409], ["max_level_reached", 409], ["idempotency_key_reused", 409],
] as const)("maps %s to %i", async (reason, status) => {
  const { app, purchase } = setup();
  purchase.mockResolvedValue({ ok: false, reason });
  const response = await request(app).post("/player/purchases").set("Authorization", "Bearer valid").set("Idempotency-Key", "test-key").send({ building: "mine" });
  expect(response.status).toBe(status);
  expect(response.body).toEqual({ error: reason });
});
it("returns a generic 500 when a transaction fails", async () => {
  const { app, purchase } = setup();
  vi.spyOn(console, "error").mockImplementation(() => {});
  purchase.mockRejectedValue(new Error("private database details"));
  const response = await request(app).post("/player/purchases").set("Authorization", "Bearer valid").set("Idempotency-Key", "test-key").send({ building: "mine" });
  expect(response.status).toBe(500);
  expect(response.body).toEqual({ error: "internal_error" });
});
it("derives both building keys and increasing prices from the catalogue", () => {
  expect(purchaseSchema.parse({ building: "forge" })).toEqual({ building: "forge" });
  expect(priceForLevel("mine", 1)).toBe("100.000000");
  expect(priceForLevel("mine", 2)).toBe("200.000000");
  expect(priceForLevel("forge", 2)).toBe("1000.000000");
  expect(priceForLevel("forge", 100)).toBe("50000.000000");
  expect(() => priceForLevel("mine", 0)).toThrow();
  expect(() => priceForLevel("mine", 101)).toThrow();
});

it.each([undefined, "bad key", "bad,key", "a".repeat(129)])("rejects a missing or invalid command key %#", async (key) => {
  const { app, purchase } = setup();
  const req = request(app).post("/player/purchases").set("Authorization", "Bearer valid").send({ building: "mine" });
  if (key !== undefined) req.set("Idempotency-Key", key);
  const response = await req;
  expect(response.status).toBe(400);
  expect(response.body).toEqual({ error: "invalid_input" });
  expect(purchase).not.toHaveBeenCalled();
});
it("preserves the exact case-sensitive key passed by the client", async () => {
  const { app, purchase } = setup();
  const key = "Purchase_ABC-123";
  expect((await request(app).post("/player/purchases").set("Authorization", "Bearer valid")
    .set("Idempotency-Key", key).send({ building: "mine" })).status).toBe(200);
  expect(purchase).toHaveBeenCalledExactlyOnceWith(id, { building: "mine" }, key);
});
