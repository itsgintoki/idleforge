// Demo: signup -> login -> collect -> purchase -> me -> leaderboard.
// Usage: BASE_URL=http://127.0.0.1:3000 [ADMIN_TOKEN=.. OCCURRENCE_ID=..] npm run demo
const baseUrl = (process.env.BASE_URL ?? "http://127.0.0.1:3000").replace(/\/$/, "");

async function call(path, { method = "GET", token, body, idempotencyKey } = {}) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
      ...(idempotencyKey === undefined ? {} : { "idempotency-key": idempotencyKey }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, requestId: res.headers.get("x-request-id"), json };
}

const email = `demo-${Date.now()}@example.com`;
console.log("baseUrl:", baseUrl);

const signup = await call("/auth/signup", { method: "POST", body: { email, password: "demo-password-123" } });
console.log("signup:", signup.status, JSON.stringify(signup.json));

const login = await call("/auth/login", { method: "POST", body: { email, password: "demo-password-123" } });
console.log("login:", login.status);
const token = login.json?.accessToken;
if (typeof token !== "string" || token.length === 0) {
  console.error("demo failed: no access token");
  process.exit(1);
}

console.log("collect:", JSON.stringify(await call("/player/collect", { method: "POST", token })));
console.log("purchase:", JSON.stringify(await call("/player/purchases", {
  method: "POST", token, idempotencyKey: crypto.randomUUID(), body: { building: "mine" },
})));
console.log("me:", JSON.stringify(await call("/player/me", { token })));
console.log("leaderboard:", JSON.stringify(await call("/leaderboard?limit=5", { token })));
console.log("health:", JSON.stringify(await call("/health")));
console.log("ready:", JSON.stringify(await call("/ready")));

const adminToken = process.env.ADMIN_TOKEN;
const occurrenceId = process.env.OCCURRENCE_ID;
if (adminToken !== undefined && occurrenceId !== undefined) {
  console.log("bonus:", JSON.stringify(await call("/admin/world-events/gold-bonus", {
    method: "POST", token: adminToken, body: { occurrenceId },
  })));
  console.log("failed-jobs:", JSON.stringify(await call("/admin/world-events/jobs/failed?limit=5", { token: adminToken })));
} else {
  console.log("admin demo skipped (set ADMIN_TOKEN and OCCURRENCE_ID to include it)");
}
