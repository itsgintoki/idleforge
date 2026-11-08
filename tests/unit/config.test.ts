import { describe, expect, it } from "vitest";
import { envSchema, workerEnvSchema } from "../../src/config.js";

const base = {
  DATABASE_URL: "postgresql://user:pass@127.0.0.1:5432/idleforge",
  JWT_SECRET: "x".repeat(64),
};

describe("environment schema", () => {
  it("applies defaults and coerces the port", () => {
    const parsed = envSchema.parse(base);
    expect(parsed.PORT).toBe(3000);
    expect(parsed.REDIS_URL).toBe("redis://127.0.0.1:6384");
    expect(parsed.QUEUE_PREFIX).toBe("idleforge");
    expect(envSchema.parse({ ...base, PORT: "8080" }).PORT).toBe(8080);
  });

  it("rejects invalid settings and allows a worker without JWT_SECRET", () => {
    expect(envSchema.safeParse({ ...base, JWT_SECRET: "short" }).success).toBe(false);
    expect(envSchema.safeParse({ ...base, DATABASE_URL: "mysql://localhost/db" }).success).toBe(false);
    expect(envSchema.safeParse({ ...base, PORT: "0" }).success).toBe(false);
    expect(envSchema.safeParse({ ...base, QUEUE_PREFIX: "bad prefix" }).success).toBe(false);
    expect(envSchema.safeParse({ ...base, REDIS_URL: "http://localhost:6379" }).success).toBe(false);
    expect(workerEnvSchema.safeParse({ DATABASE_URL: base.DATABASE_URL }).success).toBe(true);
  });
});
