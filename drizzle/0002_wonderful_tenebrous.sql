CREATE TYPE "public"."building_key" AS ENUM('mine', 'forge');--> statement-breakpoint
CREATE TABLE "player_buildings" (
	"player_id" uuid NOT NULL,
	"building_key" "building_key" NOT NULL,
	"level" integer NOT NULL,
	CONSTRAINT "player_buildings_player_id_building_key_pk" PRIMARY KEY("player_id","building_key"),
	CONSTRAINT "building_level_range" CHECK ("player_buildings"."level" >= 1 AND "player_buildings"."level" <= 100)
);
--> statement-breakpoint
ALTER TABLE "player_buildings" ADD CONSTRAINT "player_buildings_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE cascade ON UPDATE no action;