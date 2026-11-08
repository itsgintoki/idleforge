import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPlayer } from "../harness/factories.js";
import { api } from "../harness/http.js";
import { createTestStack, type TestStack } from "../harness/stack.js";

describe("Redis rate limiting", () => {
  let stack: TestStack;

  beforeAll(async () => {
    stack = await createTestStack({
      limits: { player: { windowMs: 60_000, max: 2 } },
      secondInstance: true,
    });
  }, 60_000);

  afterAll(async () => {
    await stack.close();
  });

  it("shares one budget across two API instances", async () => {
    if (stack.secondBaseUrl === undefined) throw new Error("second instance missing");
    const player = await createPlayer(stack.db);

    const first = await api(stack.baseUrl, "/player/me", { token: player.token });
    const second = await api(stack.secondBaseUrl, "/player/me", { token: player.token });
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);

    const third = await api(stack.baseUrl, "/player/me", { token: player.token });
    expect(third.status).toBe(429);
    expect(third.body).toEqual({ error: "rate_limited" });
    expect(Number(third.headers.get("retry-after"))).toBeGreaterThan(0);
  });

  it("buckets by authenticated player rather than by IP", async () => {
    const player = await createPlayer(stack.db);
    const response = await api(stack.baseUrl, "/player/me", { token: player.token });
    expect(response.status).toBe(200);
  });
});

describe("rate limiting degrades open", () => {
  let stack: TestStack;

  beforeAll(async () => {
    stack = await createTestStack({
      limits: { player: { windowMs: 60_000, max: 1 } },
      rateLimitRedisUrl: "redis://127.0.0.1:1",
    });
  }, 60_000);

  afterAll(async () => {
    await stack.close();
  });

  it("serves database-backed routes when the limiter Redis is unavailable", async () => {
    const player = await createPlayer(stack.db);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const response = await api(stack.baseUrl, "/player/me", { token: player.token });
      expect(response.status).toBe(200);
    }
  });
});
