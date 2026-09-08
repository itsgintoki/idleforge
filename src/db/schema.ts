import { buildingKeySchema, maximumBuildingLevel, purchaseKeyPattern } from "../buildings/catalogue.js";
import { sql } from "drizzle-orm";
import { check, jsonb, integer, primaryKey, numeric, pgEnum, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { playerRoles } from "../roles.js";

export const playerRole = pgEnum("player_role", playerRoles);

export const players = pgTable("players", {
  id: uuid("id").defaultRandom().primaryKey(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  role: playerRole("role").notNull().default("player"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const playerResources = pgTable("player_resources", {
  playerId: uuid("player_id").primaryKey().references(() => players.id, { onDelete: "cascade" }),
  gold: numeric("gold", { precision: 30, scale: 6 }).notNull().default("0"),
  lifetimeGoldEarned: numeric("lifetime_gold_earned", { precision: 30, scale: 6 }).notNull().default("0"),
  goldPerSecond: numeric("gold_per_second", { precision: 30, scale: 6 }).notNull().default("1"),
  lastCollectedAt: timestamp("last_collected_at", { withTimezone: true, precision: 3 }).notNull().defaultNow(),
}, (table) => [
  check("gold_nonnegative", sql`${table.gold} >= 0 AND ${table.gold} <> 'NaN'::numeric`),
  check("lifetime_gold_nonnegative", sql`${table.lifetimeGoldEarned} >= 0 AND ${table.lifetimeGoldEarned} <> 'NaN'::numeric`),
  check("gold_rate_nonnegative", sql`${table.goldPerSecond} >= 0 AND ${table.goldPerSecond} <> 'NaN'::numeric`),
]);

export type Player = typeof players.$inferSelect;
export type NewPlayer = typeof players.$inferInsert;
export type PlayerResource = typeof playerResources.$inferSelect;

export const buildingKey = pgEnum("building_key", buildingKeySchema.enum);
export const playerBuildings = pgTable("player_buildings", {
  playerId: uuid("player_id").notNull().references(() => players.id, { onDelete: "cascade" }),
  building: buildingKey("building_key").notNull(),
  level: integer("level").notNull(),
}, (table) => [
  primaryKey({ columns: [table.playerId, table.building] }),
  check("building_level_range", sql`${table.level} >= 1 AND ${table.level} <= ${sql.raw(String(maximumBuildingLevel))}`),
]);

// The row is reserved and its result filled in within the SAME transaction.
export const purchaseCommands = pgTable("purchase_commands", {
  playerId: uuid("player_id").notNull().references(() => players.id, { onDelete: "cascade" }),
  key: text("idempotency_key").notNull(),
  building: buildingKey("building_key").notNull(),
  result: jsonb("result").$type<unknown>(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  primaryKey({ columns: [table.playerId, table.key] }),
  check("purchase_key_format", sql`${table.key} ~ ${sql.raw("'" + purchaseKeyPattern + "'")}`),
  check("purchase_result_object", sql`${table.result} IS NULL OR jsonb_typeof(${table.result}) = 'object'`),
]);
