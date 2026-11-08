const defaultDatabaseUrl = "postgresql://idleforge:idleforge_local@127.0.0.1:5434/idleforge";

export const testDatabaseUrl = process.env.TEST_DATABASE_URL ?? defaultDatabaseUrl;
export const testRedisUrl = process.env.TEST_REDIS_URL ?? "redis://127.0.0.1:6384";

export const testJwtSecret =
  "idleforge-test-secret-0123456789abcdef0123456789abcdef0123456789abcdef";

export function withDatabaseName(connectionString: string, name: string): string {
  const url = new URL(connectionString);
  url.pathname = `/${name}`;
  return url.toString();
}

export function adminDatabaseUrl(): string {
  const url = new URL(testDatabaseUrl);
  url.pathname = "/postgres";
  return url.toString();
}
