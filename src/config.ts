import { z } from "zod";

export const envSchema = z.object({
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
    JWT_SECRET: z.string().min(64),
});
