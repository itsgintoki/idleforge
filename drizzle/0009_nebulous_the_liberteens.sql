CREATE TABLE "ledger_entries" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "ledger_entries_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"player_id" uuid NOT NULL,
	"amount" numeric(30, 6) NOT NULL,
	"kind" text NOT NULL,
	"reference_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ledger_amount_nonzero" CHECK ("ledger_entries"."amount" <> 0 AND "ledger_entries"."amount" <> 'NaN'::numeric),
	CONSTRAINT "ledger_kind" CHECK ("ledger_entries"."kind" IN ('collect','purchase','bonus','baseline'))
);
--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ledger_entries_player_idx" ON "ledger_entries" USING btree ("player_id","id");--> statement-breakpoint
CREATE INDEX "ledger_entries_created_at_idx" ON "ledger_entries" USING btree ("created_at");--> statement-breakpoint
INSERT INTO "ledger_entries" ("player_id", "amount", "kind", "reference_id")
SELECT "player_id", "gold", 'baseline', 'migration:ledger-baseline'
FROM "player_resources" WHERE "gold" <> 0;