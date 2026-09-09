CREATE TABLE "world_events" (
	"occurrence_id" text PRIMARY KEY NOT NULL,
	"bonus" numeric(30, 6) NOT NULL,
	"players_rewarded" integer,
	"applied_at" timestamp (3) with time zone,
	CONSTRAINT "world_bonus_positive" CHECK ("world_events"."bonus" > 0 AND "world_events"."bonus" <> 'NaN'::numeric),
	CONSTRAINT "world_event_completed" CHECK (("world_events"."players_rewarded" IS NULL AND "world_events"."applied_at" IS NULL)
    OR ("world_events"."players_rewarded" >= 0 AND "world_events"."applied_at" IS NOT NULL AND "world_events"."players_rewarded" IS NOT NULL))
);
