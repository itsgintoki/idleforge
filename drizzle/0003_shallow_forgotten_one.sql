CREATE TABLE "purchase_commands" (
	"player_id" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"building_key" "building_key" NOT NULL,
	"result" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "purchase_commands_player_id_idempotency_key_pk" PRIMARY KEY("player_id","idempotency_key"),
	CONSTRAINT "purchase_key_format" CHECK ("purchase_commands"."idempotency_key" ~ '^[A-Za-z0-9_-]{1,128}$'),
	CONSTRAINT "purchase_result_object" CHECK ("purchase_commands"."result" IS NULL OR jsonb_typeof("purchase_commands"."result") = 'object')
);
--> statement-breakpoint
ALTER TABLE "purchase_commands" ADD CONSTRAINT "purchase_commands_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE cascade ON UPDATE no action;