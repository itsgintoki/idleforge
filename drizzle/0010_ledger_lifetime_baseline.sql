INSERT INTO "ledger_entries" ("player_id", "amount", "kind", "reference_id")
SELECT "player_id", "lifetime_gold_earned", 'baseline', 'migration:lifetime-baseline'
FROM "player_resources" WHERE "lifetime_gold_earned" <> 0;
