ALTER TABLE "world_events" DROP CONSTRAINT "world_event_completed";--> statement-breakpoint
UPDATE "world_events" SET "players_rewarded" = 0 WHERE "players_rewarded" IS NULL;--> statement-breakpoint
ALTER TABLE "world_events" ALTER COLUMN "players_rewarded" SET DEFAULT 0;--> statement-breakpoint
ALTER TABLE "world_events" ALTER COLUMN "players_rewarded" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "world_events" ADD COLUMN "last_player_id" uuid;--> statement-breakpoint
ALTER TABLE "world_events" ADD COLUMN "created_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "world_events" ADD CONSTRAINT "players_rewarded_nonnegative" CHECK ("world_events"."players_rewarded" >= 0);