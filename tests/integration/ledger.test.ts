import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyGoldBonus } from "../../src/world-events/service.js";
import { collect } from "../../src/players/collect.js";
import { purchase } from "../../src/players/purchase.js";
import { ledgerEntries } from "../../src/db/schema.js";
import { verifyLedger } from "../../src/ledger/verify.js";
import { createTestDatabase, type TestDatabase } from "../harness/database.js";
import { createPlayer, setLastCollectedAt } from "../harness/factories.js";

let database: TestDatabase;

beforeAll(async () => {
  database = await createTestDatabase();
});

afterAll(async () => {
  await database.drop();
});

async function ledgerFor(playerId: string) {
  return database.db.select().from(ledgerEntries)
    .where(eq(ledgerEntries.playerId, playerId))
    .orderBy(ledgerEntries.id);
}

describe("gold ledger", () => {
  it("records collection and keeps the balance invariant", async () => {
    const player = await createPlayer(database.db);
    await setLastCollectedAt(database.db, player.id, 60);

    const result = await collect(database.db, player.id);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const rows = await ledgerFor(player.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "collect", referenceId: null });
    expect(rows[0]?.amount).toBe(result.credited);

    const verification = await verifyLedger(database.db);
    expect(verification.ok).toBe(true);
  });

  it("records the purchase debit and old-rate settlement in one transaction", async () => {
    const player = await createPlayer(database.db);
    await setLastCollectedAt(database.db, player.id, 200);
    await collect(database.db, player.id);
    await setLastCollectedAt(database.db, player.id, 10);

    const key = `ledger-purchase-${randomUUID()}`;
    const result = await purchase(database.db, player.id, { building: "mine" }, key);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const rows = await ledgerFor(player.id);
    expect(rows.map((row) => row.kind)).toEqual(["collect", "purchase", "collect"]);
    expect(rows[1]?.amount).toBe("-100.000000");
    expect(rows[1]?.referenceId).toBe(key);
    expect(rows[2]?.amount).toBe(result.credited);
    expect(rows[2]?.referenceId).toBe(`purchase:${key}`);

    const verification = await verifyLedger(database.db);
    expect(verification.ok).toBe(true);
  });

  it("records exactly one bonus entry per player per occurrence", async () => {
    const player = await createPlayer(database.db);
    const occurrenceId = `manual-${randomUUID()}`;

    const first = await applyGoldBonus(database.db, occurrenceId);
    expect(first.replayed).toBe(false);

    const rows = (await ledgerFor(player.id)).filter(
      (row) => row.kind === "bonus" && row.referenceId === occurrenceId,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.amount).toBe("100.000000");

    const replay = await applyGoldBonus(database.db, occurrenceId);
    expect(replay.replayed).toBe(true);
    const afterReplay = (await ledgerFor(player.id)).filter(
      (row) => row.kind === "bonus" && row.referenceId === occurrenceId,
    );
    expect(afterReplay).toHaveLength(1);

    const verification = await verifyLedger(database.db);
    expect(verification.ok).toBe(true);
  });

  it("keeps the invariant under concurrent collections", async () => {
    const player = await createPlayer(database.db);
    await setLastCollectedAt(database.db, player.id, 30);
    await Promise.all(Array.from({ length: 10 }, () => collect(database.db, player.id)));

    const verification = await verifyLedger(database.db);
    expect(verification.ok).toBe(true);
  });

  it("detects a balance that has no matching ledger history", async () => {
    const player = await createPlayer(database.db, {
      gold: "5.000000",
      lifetime: "5.000000",
    });

    const verification = await verifyLedger(database.db);
    expect(verification.ok).toBe(false);
    if (verification.ok) return;
    expect(verification.mismatches).toBeGreaterThanOrEqual(1);
    expect(verification.sample.some((mismatch) => mismatch.playerId === player.id)).toBe(true);
  });
});
