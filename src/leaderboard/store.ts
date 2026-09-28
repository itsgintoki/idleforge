import type { Redis } from "ioredis";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { fromLeaderboardScore, toLeaderboardScore } from "./score.js";

export const leaderboardRefreshMs = 60_000;
export const leaderboardMaxAgeMs = 90_000;
export type LeaderboardEntry = { rank: number; playerId: string; lifetimeGoldEarned: string };
export type LeaderboardPage = {
  entries: LeaderboardEntry[];
  me: LeaderboardEntry | null;
  lastReconciledAt: string;
};
export type PreparedScore = { playerId: string; score: number };

const metadataSchema = z.object({
  startedAtMs: z.number().int().nonnegative(),
  playerCount: z.number().int().nonnegative(),
});
const readResultsSchema = z.tuple([
  z.string().nullable(), z.array(z.string()), z.number().int().nonnegative().nullable(),
  z.string().nullable(), z.number().int().nonnegative(),
]);

function checkedResults(results: [Error | null, unknown][] | null): unknown[] {
  if (!results || results.some(([error]) => error !== null)) {
    throw new Error("Leaderboard Redis transaction failed");
  }
  return results.map(([, value]) => value);
}

export async function writeLeaderboardScore(
  redis: Redis,
  key: string,
  playerId: string,
  lifetimeGoldEarned: string,
): Promise<void> {
  const score = toLeaderboardScore(lifetimeGoldEarned);
  await redis.zadd(key, "GT", score, playerId);
}

export async function readLeaderboard(
  redis: Redis, key: string, playerId: string, limit: number,
): Promise<LeaderboardPage> {
  const results = await redis.multi()
    .get(`${key}:ready`)
    .zrange(key, 0, String(limit - 1), "REV", "WITHSCORES")
    .zrevrank(key, playerId)
    .zscore(key, playerId)
    .zcard(key)
    .exec();
  const [rawMetadata, pairs, ownRank, ownScore, cardinality] = readResultsSchema.parse(checkedResults(results));
  if (rawMetadata === null) throw new Error("Leaderboard has no complete snapshot");
  const metadata = metadataSchema.parse(JSON.parse(rawMetadata));
  const age = Date.now() - metadata.startedAtMs;
  if (age < 0 || age >= leaderboardMaxAgeMs || cardinality < metadata.playerCount) {
    throw new Error("Leaderboard snapshot is stale or incomplete");
  }
  if (pairs.length !== Math.min(limit, cardinality) * 2) {
    throw new Error("Invalid leaderboard page");
  }

  const entries: LeaderboardEntry[] = [];
  for (let index = 0; index < pairs.length; index += 2) {
    entries.push({
      rank: index / 2 + 1,
      playerId: z.uuid().parse(pairs[index]),
      lifetimeGoldEarned: fromLeaderboardScore(z.string().parse(pairs[index + 1])),
    });
  }
  if ((ownRank === null) !== (ownScore === null) || (ownRank !== null && ownRank >= cardinality)) {
    throw new Error("Invalid leaderboard rank");
  }
  const me = ownRank === null || ownScore === null ? null : {
    rank: ownRank + 1, playerId, lifetimeGoldEarned: fromLeaderboardScore(ownScore),
  };
  return { entries, me, lastReconciledAt: new Date(metadata.startedAtMs).toISOString() };
}

const publishSnapshotScript = `
local startedAt = tonumber(ARGV[1])
local deadline = tonumber(ARGV[2])
local count = tonumber(ARGV[3])
local clock = redis.call('TIME')
local now = tonumber(clock[1]) * 1000 + math.floor(tonumber(clock[2]) / 1000)
if startedAt > now or deadline <= now then
  return redis.error_reply('Leaderboard snapshot expired or has a future timestamp')
end

if redis.call('TYPE', KEYS[3]).ok == 'string' then
  local ok, previous = pcall(cjson.decode, redis.call('GET', KEYS[3]))
  if ok and type(previous) == 'table' and type(previous.startedAtMs) == 'number'
    and previous.startedAtMs <= now and previous.startedAtMs > startedAt then
    return 0
  end
end
if count > 0 then
  if redis.call('TYPE', KEYS[1]).ok ~= 'zset' or redis.call('ZCARD', KEYS[1]) ~= count then
    return redis.error_reply('Leaderboard staging set is incomplete')
  end
end

redis.call('DEL', KEYS[3])
if count == 0 then
  redis.call('DEL', KEYS[2])
else
  redis.call('RENAME', KEYS[1], KEYS[2])
  redis.call('PERSIST', KEYS[2])
end
redis.call('SET', KEYS[3], ARGV[4], 'PXAT', ARGV[2])
return 1
`;

export async function publishLeaderboardSnapshot(
  redis: Redis, key: string, scores: PreparedScore[], startedAt: string,
): Promise<boolean> {
  const startedAtMs = Date.parse(z.iso.datetime().parse(startedAt));
  const metadata = { startedAtMs, playerCount: scores.length };
  const stagingKey = `${key}:build:${randomUUID()}`;
  try {
    for (let offset = 0; offset < scores.length; offset += 500) {
      const batch = scores.slice(offset, offset + 500).flatMap(({ score, playerId }) => [score, playerId]);
      checkedResults(await redis.multi().zadd(stagingKey, ...batch).pexpire(stagingKey, 300_000).exec());
    }
    const published = await redis.eval(
      publishSnapshotScript, 3, stagingKey, key, `${key}:ready`,
      startedAtMs, startedAtMs + leaderboardMaxAgeMs, scores.length, JSON.stringify(metadata),
    );
    return z.union([z.literal(0), z.literal(1)]).parse(published) === 1;
  } finally {
    await redis.del(stagingKey).catch(() => {});
  }
}
