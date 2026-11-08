import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startHealthServer } from "../../src/health-server.js";
import { api } from "../harness/http.js";
import { createTestStack, type TestStack } from "../harness/stack.js";

let stack: TestStack;

beforeAll(async () => {
  stack = await createTestStack();
}, 60_000);

afterAll(async () => {
  await stack.close();
});

describe("metrics", () => {
  it("exposes request metrics on the API", async () => {
    await api(stack.baseUrl, "/health");

    const response = await api(stack.baseUrl, "/metrics");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/plain");
    expect(response.body).toContain("http_requests_total");
    expect(response.body).toContain("http_request_duration_seconds_bucket");
    expect(response.body).toContain('route="/health"');
    expect(response.body).toContain("db_pool_connections");
  });

  it("serves worker liveness and metrics", async () => {
    const health = startHealthServer({
      port: 0,
      pool: stack.pool,
      checkReady: async () => ({ db: true, redis: true }),
    });

    try {
      await health.ready;
      const address = health.server.address() as AddressInfo;
      const baseUrl = `http://127.0.0.1:${address.port}`;

      const live = await api(baseUrl, "/healthz");
      expect(live.status).toBe(200);
      expect(live.body).toEqual({ status: "ok" });

      const metrics = await api(baseUrl, "/metrics");
      expect(metrics.status).toBe(200);
      expect(metrics.body).toContain("process_cpu_user_seconds_total");
      expect(metrics.body).toContain("db_pool_connections");

      const missing = await api(baseUrl, "/nope");
      expect(missing.status).toBe(404);
    } finally {
      await health.close();
    }
  });
});
