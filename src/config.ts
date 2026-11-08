import { z } from "zod";

export const workerEnvSchema = z.object({
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
  REDIS_URL: z.url({ protocol: /^rediss?$/ }).default("redis://127.0.0.1:6384"),
  QUEUE_PREFIX: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/).default("idleforge"),
  BONUS_BATCH_SIZE: z.coerce.number().int().min(1).max(10_000).default(1000),
  PURCHASE_COMMAND_RETENTION_DAYS: z.coerce.number().int().min(1).max(3650).default(30),
  WORLD_EVENT_STALE_RESERVATION_HOURS: z.coerce.number().int().min(1).max(720).default(24),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().min(1).max(3650).default(30),
  METRICS_PORT: z.coerce.number().int().min(1).max(65535).default(9464),
});
export const envSchema = workerEnvSchema.extend({
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  JWT_SECRET: z.string().min(64),
});
