#!/bin/sh
# Repro: leaderboard reconciliation. Requires REDIS_URL and a player TOKEN.
# Usage: TOKEN=<accessToken> [BASE_URL=.. REDIS_URL=..] sh scripts/repro-reconciliation.sh
set -eu
BASE_URL="${BASE_URL:-http://127.0.0.1:3000}"
REDIS_URL="${REDIS_URL:-redis://127.0.0.1:6384}"
: "${TOKEN:?Set TOKEN to a player access token}"
echo "--- leaderboard before (200 expected once worker reconciled) ---"
curl -sS -w '\nHTTP %{http_code}\n' "$BASE_URL/leaderboard?limit=5" -H "Authorization: Bearer $TOKEN"
echo "--- drop leaderboard keys to simulate Redis loss ---"
node -e "
import('ioredis').then(async ({ Redis }) => {
  const redis = new Redis(process.env.REDIS_URL ?? 'redis://127.0.0.1:6384');
  const keys = await redis.keys('*:leaderboard:*');
  if (keys.length > 0) await redis.del(...keys);
  console.log('deleted:', keys.length);
  redis.disconnect();
});"
echo "--- leaderboard during outage (503 expected) ---"
curl -sS -w '\nHTTP %{http_code}\n' "$BASE_URL/leaderboard?limit=5" -H "Authorization: Bearer $TOKEN" || true
echo "--- rebuild from PostgreSQL ---"
npm run leaderboard:rebuild
echo "--- leaderboard after rebuild (200 expected) ---"
curl -sS -w '\nHTTP %{http_code}\n' "$BASE_URL/leaderboard?limit=5" -H "Authorization: Bearer $TOKEN"
