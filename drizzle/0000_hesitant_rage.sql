CREATE TYPE "public"."player_role" AS ENUM('player', 'admin');--> statement-breakpoint
CREATE TABLE "player_resources" (
	"player_id" uuid PRIMARY KEY NOT NULL,
	"gold" numeric(30, 6) DEFAULT '0' NOT NULL,
	"gold_per_second" numeric(30, 6) DEFAULT '1' NOT NULL,
	"last_collected_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "gold_nonnegative" CHECK ("player_resources"."gold" >= 0 AND "player_resources"."gold" <> 'NaN'::numeric),
	CONSTRAINT "gold_rate_nonnegative" CHECK ("player_resources"."gold_per_second" >= 0 AND "player_resources"."gold_per_second" <> 'NaN'::numeric)
);
--> statement-breakpoint
CREATE TABLE "players" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"password_hash" text NOT NULL,
	"role" "player_role" DEFAULT 'player' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "players_email_unique" UNIQUE("email")
);
--> statement-breakpoint
ALTER TABLE "player_resources" ADD CONSTRAINT "player_resources_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE cascade ON UPDATE no action;