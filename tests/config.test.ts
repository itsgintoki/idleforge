import { describe, expect, it } from "vitest";
import { envSchema } from "../src/config.js";

const databaseUrl = "postgresql://idleforge:idleforge_local@127.0.0.1:5434/idleforge";
const baseEnv = { DATABASE_URL: databaseUrl, JWT_SECRET: "test-secret-".repeat(8) };

describe("environment configuration", () => {
  it("defaults to port 3000 when PORT is missing", () => {
    expect(envSchema.parse(baseEnv).PORT).toBe(3000);
  });

  it("converts a supplied port string to a number", () => {
    expect(envSchema.parse({ ...baseEnv, PORT: "4000" }).PORT).toBe(4000);
  });

  it.each(["1", "65535"])("accepts boundary port %s", (port) => {
    expect(envSchema.parse({ ...baseEnv, PORT: port }).PORT).toBe(Number(port));
  });

  it.each(["banana", "", " ", "0", "-1", "65536", "3000.5"])(
    "rejects invalid port %j",
    (port) => {
      expect(envSchema.safeParse({ ...baseEnv, PORT: port }).success).toBe(false);
    },
  );
});


describe("database configuration", () => {
  it("accepts a PostgreSQL connection URL", () => {
    expect(envSchema.parse(baseEnv).DATABASE_URL).toBe(databaseUrl);
  });

  it("requires DATABASE_URL", () => {
    expect(envSchema.safeParse({ JWT_SECRET: baseEnv.JWT_SECRET }).success).toBe(false);
  });

  it.each(["", "not-a-url", "https://example.com/db"])(
    "rejects invalid database URL %j",
    (url) => {
      expect(envSchema.safeParse({ ...baseEnv, DATABASE_URL: url }).success).toBe(false);
    },
  );
});


describe("JWT configuration", () => {
  it("requires a signing secret", () => {
    expect(envSchema.safeParse({ DATABASE_URL: databaseUrl }).success).toBe(false);
  });
  it.each(["", "short", "a".repeat(63)])("rejects insufficient secret length case %#", (secret) => {
    expect(envSchema.safeParse({ ...baseEnv, JWT_SECRET: secret }).success).toBe(false);
  });
});
