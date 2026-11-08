import type { Pool, PoolClient } from "pg";

export type RetentionOptions = {
  purchaseCommandRetentionDays: number;
  staleReservationHours: number;
  batchSize?: number;
};

export type RetentionResult = {
  skipped: boolean;
  purchaseCommands: number;
  staleWorldEvents: number;
};

const retentionLockKey = "idleforge:retention";

async function deleteInBatches(
  client: PoolClient,
  statement: string,
  params: unknown[],
  batchSize: number,
): Promise<number> {
  let total = 0;
  for (;;) {
    const result = await client.query(statement, [...params, batchSize]);
    const deleted = result.rowCount ?? 0;
    total += deleted;
    if (deleted < batchSize) return total;
  }
}

export async function runRetention(
  pool: Pool,
  options: RetentionOptions,
): Promise<RetentionResult> {
  const batchSize = options.batchSize ?? 5000;
  const client = await pool.connect();
  let locked = false;
  try {
    const lock = await client.query<{ locked: boolean }>(
      "SELECT pg_try_advisory_lock(hashtext($1)::bigint) AS locked",
      [retentionLockKey],
    );
    locked = lock.rows[0]?.locked === true;
    if (!locked) return { skipped: true, purchaseCommands: 0, staleWorldEvents: 0 };

    const purchaseCommands = await deleteInBatches(client, `
      DELETE FROM purchase_commands
      WHERE ctid IN (
        SELECT ctid FROM purchase_commands
        WHERE created_at < clock_timestamp() - ($1::int * interval '1 day')
        LIMIT $2
      )
    `, [options.purchaseCommandRetentionDays], batchSize);

    const staleWorldEvents = await deleteInBatches(client, `
      DELETE FROM world_events
      WHERE ctid IN (
        SELECT ctid FROM world_events
        WHERE applied_at IS NULL
          AND players_rewarded = 0
          AND created_at < clock_timestamp() - ($1::int * interval '1 hour')
        LIMIT $2
      )
    `, [options.staleReservationHours], batchSize);

    return { skipped: false, purchaseCommands, staleWorldEvents };
  } finally {
    if (locked) {
      await client.query("SELECT pg_advisory_unlock(hashtext($1)::bigint)", [retentionLockKey])
        .catch(() => undefined);
    }
    client.release();
  }
}
