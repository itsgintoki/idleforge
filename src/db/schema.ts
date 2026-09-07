import { sql } from "drizzle-orm";
import { check, numeric, pgEnum, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
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
  goldPerSecond: numeric("gold_per_second", { precision: 30, scale: 6 }).notNull().default("1"),
  lastCollectedAt: timestamp("last_collected_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  check("gold_nonnegative", sql`${table.gold} >= 0 AND ${table.gold} <> 'NaN'::numeric`),
  check("gold_rate_nonnegative", sql`${table.goldPerSecond} >= 0 AND ${table.goldPerSecond} <> 'NaN'::numeric`),
]);

export type Player = typeof players.$inferSelect;
export type NewPlayer = typeof players.$inferInsert;
export type PlayerResource = typeof playerResources.$inferSelect;
