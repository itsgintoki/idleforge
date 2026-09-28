#!/bin/sh
# Repro: concurrent collects do not double-credit.
# Usage: TOKEN=<accessToken> [BASE_URL=..] sh scripts/repro-concurrency.sh
set -eu
BASE_URL="${BASE_URL:-http://127.0.0.1:3000}"
: "${TOKEN:?Set TOKEN to a player access token}"
echo "--- 10 parallel collects ---"
for i in $(seq 1 10); do
  curl -sS -X POST "$BASE_URL/player/collect" -H "Authorization: Bearer $TOKEN" \
    -H 'Content-Type: application/json' -d '{}' > "/tmp/repro-collect-$i.json" &
done
wait
cat /tmp/repro-collect-*.json | head -c 2000
echo
echo "Only the first response(s) in the same millisecond window earn; the rest credit ~0."
echo "Compare lifetimeEarned across files: no interval is paid twice."
