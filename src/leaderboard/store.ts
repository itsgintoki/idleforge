import type { Redis } from "ioredis";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { logEvent } from "../world-events/service.js";
import { toLeaderboardScore } from "./score.js";

export const leaderboardRefreshMs = 60_000;
export const leaderboardMaxAgeMs = 90_000;
export const leaderboardSnapshotBatchSize = 1000;
export const leaderboardPublishBatchSize = 500;

export type LeaderboardStore = {
  redis: Redis;
  key: string;
  exactKey: string;
  readyKey: string;
};
export type LeaderboardEntry = { rank: number; playerId: string; lifetimeGoldEarned: string };
export type LeaderboardPage = {
  entries: LeaderboardEntry[];
  me: LeaderboardEntry | null;
  lastReconciledAt: string;
};
export type PreparedScore = { playerId: string; lifetimeGoldEarned: string };

const goldSchema = z.string().regex(/^\d{1,24}\.\d{6}$/);
const metadataSchema = z.object({
  startedAtMs: z.number().int().nonnegative(),
  playerCount: z.number().int().nonnegative(),
});
const readResultsSchema = z.tuple([
  z.string().nullable(), z.array(z.string()), z.number().int().nonnegative().nullable(),
  z.string().nullable(), z.number().int().nonnegative(), z.number().int().nonnegative(),
]);

function checkedResults(results: [Error | null, unknown][] | null): unknown[] {
  if (!results || results.some(([error]) => error !== null)) {
    throw new Error("Leaderboard Redis transaction failed");
  }
  return results.map(([, value]) => value);
}

const writeScoreScript = `
local existing = redis.call('HGET', KEYS[2], ARGV[1])
if existing then
  local existingInteger = string.match(existing, '^(%d+)%.')
  local incomingInteger = string.match(ARGV[2], '^(%d+)%.')
  if #incomingInteger < #existingInteger then return 0 end
  if #incomingInteger == #existingInteger and ARGV[2] <= existing then return 0 end
end
redis.call('HSET', KEYS[2], ARGV[1], ARGV[2])
redis.call('ZADD', KEYS[1], ARGV[3], ARGV[1])
return 1
`;

export async function writeLeaderboardScore(
  store: LeaderboardStore,
  playerId: string,
  lifetimeGoldEarned: string,
): Promise<boolean> {
  const score = toLeaderboardScore(lifetimeGoldEarned);
  const result = await store.redis.eval(
    writeScoreScript, 2, store.key, store.exactKey,
    playerId, lifetimeGoldEarned, String(score),
  );
  return z.union([z.literal(0), z.literal(1)]).parse(result) === 1;
}

export async function readLeaderboard(
  store: LeaderboardStore,
  playerId: string,
  limit: number,
): Promise<LeaderboardPage> {
  const results = await store.redis.multi()
    .get(store.readyKey)
    .zrange(store.key, 0, String(limit - 1), "REV", "WITHSCORES")
    .zrevrank(store.key, playerId)
    .zscore(store.key, playerId)
    .zcard(store.key)
    .hlen(store.exactKey)
    .exec();
  const [rawMetadata, pairs, ownRank, ownScore, cardinality, exactCardinality] =
    readResultsSchema.parse(checkedResults(results));

  if (rawMetadata === null) throw new Error("Leaderboard has no complete snapshot");
  const metadata = metadataSchema.parse(JSON.parse(rawMetadata));
  const age = Date.now() - metadata.startedAtMs;
  if (age < 0 || age >= leaderboardMaxAgeMs || cardinality < metadata.playerCount
    || exactCardinality < metadata.playerCount) {
    throw new Error("Leaderboard snapshot is stale or incomplete");
  }
  if (pairs.length !== Math.min(limit, cardinality) * 2) {
    throw new Error("Invalid leaderboard page");
  }
  if ((ownRank === null) !== (ownScore === null) || (ownRank !== null && ownRank >= cardinality)) {
    throw new Error("Invalid leaderboard rank");
  }

  const members: string[] = [];
  for (let index = 0; index < pairs.length; index += 2) {
    members.push(z.uuid().parse(pairs[index]));
  }
  const fields = ownRank === null ? members : [...members, playerId];
  const exactValues = fields.length === 0
    ? []
    : await store.redis.hmget(store.exactKey, ...fields);

  const entries: LeaderboardEntry[] = [];
  for (let index = 0; index < members.length; index += 1) {
    const exact = goldSchema.parse(exactValues[index]);
    const rawScore = z.string().parse(pairs[index * 2 + 1]);
    if (toLeaderboardScore(exact) !== Number(rawScore)) {
      throw new Error("Leaderboard score and exact value disagree");
    }
    entries.push({ rank: index + 1, playerId: members[index] as string, lifetimeGoldEarned: exact });
  }

  let me: LeaderboardEntry | null = null;
  if (ownRank !== null && ownScore !== null) {
    const exact = goldSchema.parse(exactValues[members.length]);
    if (toLeaderboardScore(exact) !== Number(ownScore)) {
      throw new Error("Leaderboard score and exact value disagree");
    }
    me = { rank: ownRank + 1, playerId, lifetimeGoldEarned: exact };
  }

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

if redis.call('TYPE', KEYS[5]).ok == 'string' then
  local ok, previous = pcall(cjson.decode, redis.call('GET', KEYS[5]))
  if ok and type(previous) == 'table' and type(previous.startedAtMs) == 'number'
    and previous.startedAtMs <= now and previous.startedAtMs > startedAt then
    return 0
  end
end
if count > 0 then
  if redis.call('TYPE', KEYS[1]).ok ~= 'zset' or redis.call('ZCARD', KEYS[1]) ~= count then
    return redis.error_reply('Leaderboard staging set is incomplete')
  end
  if redis.call('TYPE', KEYS[3]).ok ~= 'hash' or redis.call('HLEN', KEYS[3]) ~= count then
    return redis.error_reply('Leaderboard staging hash is incomplete')
  end
end

redis.call('DEL', KEYS[5])
if count == 0 then
  redis.call('DEL', KEYS[2], KEYS[4])
else
  redis.call('RENAME', KEYS[1], KEYS[2])
  redis.call('PERSIST', KEYS[2])
  redis.call('RENAME', KEYS[3], KEYS[4])
  redis.call('PERSIST', KEYS[4])
end
redis.call('SET', KEYS[5], ARGV[4], 'PXAT', ARGV[2])
return 1
`;

export async function publishLeaderboardSnapshot(
  store: LeaderboardStore,
  source: AsyncIterable<PreparedScore[]>,
  startedAt: string,
): Promise<{ published: boolean; players: number }> {
  const startedAtMs = Date.parse(z.iso.datetime().parse(startedAt));
  const stagingKey = `${store.key}:build:${randomUUID()}`;
  const stagingExactKey = `${store.exactKey}:build:${randomUUID()}`;
  let players = 0;

  try {
    let batch: PreparedScore[] = [];
    const flush = async (): Promise<void> => {
      if (batch.length === 0) return;
      const scores = batch.flatMap((entry) => [
        toLeaderboardScore(entry.lifetimeGoldEarned), entry.playerId,
      ]);
      const exact = batch.flatMap((entry) => [entry.playerId, entry.lifetimeGoldEarned]);
      checkedResults(await store.redis.multi()
        .zadd(stagingKey, ...scores)
        .hset(stagingExactKey, ...exact)
        .pexpire(stagingKey, 300_000)
        .pexpire(stagingExactKey, 300_000)
        .exec());
      players += batch.length;
      batch = [];
    };

    for await (const page of source) {
      for (const entry of page) {
        batch.push(entry);
        if (batch.length >= leaderboardPublishBatchSize) await flush();
      }
    }
    await flush();

    const metadata = { startedAtMs, playerCount: players };
    const published = await store.redis.eval(
      publishSnapshotScript, 5,
      stagingKey, store.key, stagingExactKey, store.exactKey, store.readyKey,
      startedAtMs, startedAtMs + leaderboardMaxAgeMs, players, JSON.stringify(metadata),
    );
    return {
      published: z.union([z.literal(0), z.literal(1)]).parse(published) === 1,
      players,
    };
  } finally {
    // Cleanup is best-effort: staging keys are written with a 5-minute TTL, and a
    // failure here must be logged, not thrown, so it cannot mask the original error.
    try {
      await store.redis.del(stagingKey, stagingExactKey);
    } catch (error) {
      logEvent("leaderboard_staging_cleanup_failed", {
        stagingKey, stagingExactKey,
        error: error instanceof Error ? error.message : String(error),
      }, "error");
    }
  }
}
