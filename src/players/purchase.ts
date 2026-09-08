import { and, eq, gte, sql } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { playerBuildings, playerResources, players, purchaseCommands } from "../db/schema.js";
import { buildingCatalogue, maximumBuildingLevel, priceForLevel, purchaseKeySchema, type BuildingKey, type PurchaseInput } from "../buildings/catalogue.js";
import { collect } from "./collect.js";

import { purchaseResultSchema, type PurchaseResult } from "./purchase-result.js";
export type { PurchaseResult } from "./purchase-result.js";

// All economy commands lock the resource row first. This also serializes
// purchases of different building types that spend the same player's gold.
async function preparePurchase(tx: Database, playerId: string, building: BuildingKey) {
  const [resource] = await tx.select({ id: playerResources.playerId }).from(playerResources)
    .where(eq(playerResources.playerId, playerId)).for("update");
  if (!resource) {
    const [player] = await tx.select({ id: players.id }).from(players).where(eq(players.id, playerId));
    return { ok: false, reason: player ? "resource_not_found" : "player_not_found" } as const;
  }
  const [owned] = await tx.select({ level: playerBuildings.level }).from(playerBuildings)
    .where(and(eq(playerBuildings.playerId, playerId), eq(playerBuildings.building, building)));
  const level = (owned?.level ?? 0) + 1;
  if (level > maximumBuildingLevel) return { ok: false, reason: "max_level_reached" } as const;
  const spent = priceForLevel(building, level);
  const [paid] = await tx.update(playerResources).set({ gold: sql`${playerResources.gold} - ${spent}::numeric` })
    .where(and(eq(playerResources.playerId, playerId), gte(playerResources.gold, spent)))
    .returning({ id: playerResources.playerId });
  if (!paid) return { ok: false, reason: "insufficient_funds" } as const;
  return { ok: true, level, spent } as const;
}

async function executePurchase(tx: Database, playerId: string, input: PurchaseInput): Promise<PurchaseResult> {
  const prepared = await preparePurchase(tx, playerId, input.building);
  if (!prepared.ok) return prepared;

  // Settle elapsed time at the OLD rate in this same transaction. Spending
  // requires already-collected gold; an unsuccessful purchase never collects.
  const settlement = await collect(tx, playerId);
  if (!settlement.ok) throw new Error("Locked purchase resource disappeared");
  await tx.insert(playerBuildings).values({ playerId, building: input.building, level: prepared.level })
    .onConflictDoUpdate({ target: [playerBuildings.playerId, playerBuildings.building], set: { level: prepared.level } });
  const [resource] = await tx.update(playerResources).set({
    goldPerSecond: sql`${playerResources.goldPerSecond} + ${buildingCatalogue[input.building].rateIncrease}::numeric`,
  }).where(eq(playerResources.playerId, playerId)).returning();
  if (!resource) throw new Error("Locked purchase resource disappeared");
  return {
    ok: true, building: input.building, level: prepared.level, spent: prepared.spent,
    credited: settlement.credited, balance: resource.gold, lifetimeEarned: resource.lifetimeGoldEarned,
    rate: resource.goldPerSecond, collectedAt: resource.lastCollectedAt,
  };
}

async function replayPurchase(tx: Database, playerId: string, key: string, input: PurchaseInput): Promise<PurchaseResult> {
  // A new statement gets a fresh READ COMMITTED snapshot after a conflicting
  // insert finishes waiting. The first command's result is now visible.
  const [command] = await tx.select().from(purchaseCommands)
    .where(and(eq(purchaseCommands.playerId, playerId), eq(purchaseCommands.key, key)));
  if (!command) throw new Error("Reserved purchase command disappeared");
  if (command.building !== input.building) return { ok: false, reason: "idempotency_key_reused" };
  return purchaseResultSchema.parse(command.result);
}

export async function purchase(
  db: Database, playerId: string, input: PurchaseInput, idempotencyKey: string,
): Promise<PurchaseResult> {
  const key = purchaseKeySchema.parse(idempotencyKey);
  return db.transaction(async (tx): Promise<PurchaseResult> => {
    // Keep the owner alive while reserving a command; compatible key-share locks
    // allow purchases for the same player to proceed to command/resource locking.
    const [player] = await tx.select({ id: players.id }).from(players)
      .where(eq(players.id, playerId)).for("key share");
    if (!player) return { ok: false, reason: "player_not_found" };
    const [reserved] = await tx.insert(purchaseCommands).values({ playerId, key, building: input.building })
      .onConflictDoNothing({ target: [purchaseCommands.playerId, purchaseCommands.key] })
      .returning({ key: purchaseCommands.key });
    if (!reserved) return replayPurchase(tx, playerId, key, input);

    const result = purchaseResultSchema.parse(await executePurchase(tx, playerId, input));
    const [saved] = await tx.update(purchaseCommands).set({ result })
      .where(and(eq(purchaseCommands.playerId, playerId), eq(purchaseCommands.key, key)))
      .returning({ key: purchaseCommands.key });
    if (!saved) throw new Error("Reserved purchase command disappeared");
    return result;
  });
}
