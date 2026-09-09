import { z } from "zod";

export const workerEnvSchema = z.object({
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
  REDIS_URL: z.url({ protocol: /^rediss?$/ }).default("redis://127.0.0.1:6384"),
  QUEUE_PREFIX: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/).default("idleforge"),
});
export const envSchema = workerEnvSchema.extend({
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  JWT_SECRET: z.string().min(64),
});
