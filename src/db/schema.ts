import { buildingKeySchema, maximumBuildingLevel, purchaseKeyPattern } from "../buildings/catalogue.js";
import { sql } from "drizzle-orm";
import { check, index, jsonb, integer, bigint, primaryKey, numeric, pgEnum, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { z } from "zod";

export const playerRoles = ["player", "admin"] as const;
export const roleSchema = z.enum(playerRoles);
export type PlayerRole = z.infer<typeof roleSchema>;

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
export type PublicPlayer = Pick<Player, "id" | "email" | "role" | "createdAt">;
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
  index("purchase_commands_created_at_idx").on(table.createdAt),
]);

export const worldEvents = pgTable("world_events", {
  occurrenceId: text("occurrence_id").primaryKey(),
  bonus: numeric("bonus", { precision: 30, scale: 6 }).notNull(),
  playersRewarded: integer("players_rewarded").notNull().default(0),
  lastPlayerId: uuid("last_player_id"),
  appliedAt: timestamp("applied_at", { withTimezone: true, precision: 3 }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  check("world_bonus_positive", sql`${table.bonus} > 0 AND ${table.bonus} <> 'NaN'::numeric`),
  check("players_rewarded_nonnegative", sql`${table.playersRewarded} >= 0`),
]);

export const eventOutbox = pgTable("event_outbox", {
  id: uuid("id").defaultRandom().primaryKey(),
  occurrenceId: text("occurrence_id").notNull().unique(),
  kind: text("kind").notNull(),
  payload: jsonb("payload").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  dispatchedAt: timestamp("dispatched_at", { withTimezone: true }),
  dispatchAttempts: integer("dispatch_attempts").notNull().default(0),
  lastError: text("last_error"),
  completedAt: timestamp("completed_at", { withTimezone: true }),
}, (table) => [
  check("event_outbox_kind", sql`${table.kind} = 'world_event_gold_bonus'`),
  index("event_outbox_pending_idx").on(table.completedAt, table.dispatchedAt),
]);

export const refreshTokens = pgTable("refresh_tokens", {
  id: uuid("id").defaultRandom().primaryKey(),
  playerId: uuid("player_id").notNull().references(() => players.id, { onDelete: "cascade" }),
  familyId: uuid("family_id").notNull(),
  tokenHash: text("token_hash").notNull().unique(),
  issuedAt: timestamp("issued_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  replacedBy: uuid("replaced_by"),
}, (table) => [
  index("refresh_tokens_player_idx").on(table.playerId),
  index("refresh_tokens_family_idx").on(table.familyId),
]);

export const ledgerEntries = pgTable("ledger_entries", {
  id: bigint("id", { mode: "bigint" }).generatedAlwaysAsIdentity().primaryKey(),
  playerId: uuid("player_id").notNull().references(() => players.id, { onDelete: "cascade" }),
  amount: numeric("amount", { precision: 30, scale: 6 }).notNull(),
  kind: text("kind").notNull(),
  referenceId: text("reference_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("ledger_entries_player_idx").on(table.playerId, table.id),
  index("ledger_entries_created_at_idx").on(table.createdAt),
  check("ledger_amount_nonzero", sql`${table.amount} <> 0 AND ${table.amount} <> 'NaN'::numeric`),
  check("ledger_kind", sql`${table.kind} IN ('collect','purchase','bonus','baseline')`),
]);
