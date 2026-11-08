import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Client, Pool } from "pg";
import * as schema from "../../src/db/schema.js";
import { adminDatabaseUrl, testDatabaseUrl, withDatabaseName } from "./env.js";

export type TestDatabase = {
  db: NodePgDatabase<typeof schema>;
  pool: Pool;
  name: string;
  drop: () => Promise<void>;
};

export async function createTestDatabase(): Promise<TestDatabase> {
  const name = `idleforge_test_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
  const admin = new Client({ connectionString: adminDatabaseUrl() });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE "${name}"`);
  } finally {
    await admin.end();
  }

  const pool = new Pool({
    connectionString: withDatabaseName(testDatabaseUrl, name),
    connectionTimeoutMillis: 5000,
  });
  const db = drizzle({ client: pool, schema });

  try {
    await migrate(db, { migrationsFolder: resolve("drizzle") });
  } catch (error) {
    await pool.end();
    throw error;
  }

  return {
    db,
    pool,
    name,
    async drop() {
      await pool.end();
      const cleanup = new Client({ connectionString: adminDatabaseUrl() });
      await cleanup.connect();
      try {
        await cleanup.query(
          "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1",
          [name],
        );
        await cleanup.query(`DROP DATABASE IF EXISTS "${name}"`);
      } finally {
        await cleanup.end();
      }
    },
  };
}
