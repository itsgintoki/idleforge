import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema.js";

export type Database = NodePgDatabase<typeof schema>;

export function createDatabase(connectionString: string) {
  const pool = new Pool({ connectionString, connectionTimeoutMillis: 5000 });
  const db = drizzle({ client: pool, schema });
  return { db, pool };
}
