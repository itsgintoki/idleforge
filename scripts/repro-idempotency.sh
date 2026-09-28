#!/bin/sh
# Repro: idempotent purchases. Same key twice -> identical body; reused key -> 409.
# Usage: TOKEN=<accessToken> [BASE_URL=http://127.0.0.1:3000] sh scripts/repro-idempotency.sh
set -eu
BASE_URL="${BASE_URL:-http://127.0.0.1:3000}"
: "${TOKEN:?Set TOKEN to a player access token}"
KEY="repro-$(node -e "console.log(crypto.randomUUID())")"
echo "key: $KEY"
echo "--- first purchase (mine) ---"
curl -sS -w '\nHTTP %{http_code}\n' -X POST "$BASE_URL/player/purchases" \
  -H "Authorization: Bearer $TOKEN" -H "Idempotency-Key: $KEY" \
  -H 'Content-Type: application/json' -d '{"building":"mine"}' | tee /tmp/repro-first.json
echo "--- replay same key+building (must match, no new charge) ---"
curl -sS -w '\nHTTP %{http_code}\n' -X POST "$BASE_URL/player/purchases" \
  -H "Authorization: Bearer $TOKEN" -H "Idempotency-Key: $KEY" \
  -H 'Content-Type: application/json' -d '{"building":"mine"}'
echo "--- same key, different building (must be 409 idempotency_key_reused) ---"
curl -sS -w '\nHTTP %{http_code}\n' -X POST "$BASE_URL/player/purchases" \
  -H "Authorization: Bearer $TOKEN" -H "Idempotency-Key: $KEY" \
  -H 'Content-Type: application/json' -d '{"building":"forge"}'
