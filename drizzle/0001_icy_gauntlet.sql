ALTER TABLE "player_resources" ALTER COLUMN "last_collected_at" SET DATA TYPE timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "player_resources" ALTER COLUMN "last_collected_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "player_resources" ADD COLUMN "lifetime_gold_earned" numeric(30, 6) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "player_resources" ADD CONSTRAINT "lifetime_gold_nonnegative" CHECK ("player_resources"."lifetime_gold_earned" >= 0 AND "player_resources"."lifetime_gold_earned" <> 'NaN'::numeric);