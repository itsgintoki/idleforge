// Zero-dependency load harness: measures /health, optionally authed reads.
// Usage: node scripts/load-test.mjs [--base-url URL] [--requests N] [--concurrency C]
const args = process.argv.slice(2);
function flag(name, fallback) {
  const i = args.indexOf(name);
  if (i === -1) return fallback;
  return args[i + 1] ?? fallback;
}

const baseUrl = (flag("--base-url", process.env.BASE_URL ?? "http://127.0.0.1:3000") ?? "").replace(/\/$/, "");
const total = Number(flag("--requests", "500") ?? "500");
const concurrency = Math.max(1, Number(flag("--concurrency", "25") ?? "25"));
const token = process.env.TOKEN ?? "";

const paths = ["/health"];
if (token !== "") paths.push("/player/me", "/leaderboard?limit=20");

async function one(path) {
  const headers = token !== "" && path !== "/health" ? { authorization: `Bearer ${token}` } : {};
  const start = performance.now();
  try {
    const res = await fetch(`${baseUrl}${path}`, { headers });
    await res.arrayBuffer().catch(() => {});
    return { ms: performance.now() - start, status: res.status };
  } catch {
    return { ms: performance.now() - start, status: 0 };
  }
}

const latencies = [];
const counts = new Map();
let completed = 0;
const startedAt = performance.now();

async function worker() {
  while (completed < total) {
    const path = paths[completed % paths.length];
    completed += 1;
    const r = await one(path);
    latencies.push(r.ms);
    counts.set(r.status, (counts.get(r.status) ?? 0) + 1);
  }
}

await Promise.all(Array.from({ length: Math.min(concurrency, total) }, () => worker()));
const elapsedSec = (performance.now() - startedAt) / 1000;
latencies.sort((a, b) => a - b);
const pct = (p) => latencies[Math.min(latencies.length - 1, Math.floor((p / 100) * latencies.length))] ?? 0;

console.log(JSON.stringify({
  baseUrl, requests: total, concurrency,
  elapsedSec: Number(elapsedSec.toFixed(2)),
  rps: Number((total / elapsedSec).toFixed(1)),
  p50Ms: Number(pct(50).toFixed(2)),
  p95Ms: Number(pct(95).toFixed(2)),
  p99Ms: Number(pct(99).toFixed(2)),
  statusCounts: Object.fromEntries(counts),
}, null, 2));
