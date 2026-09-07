import { defineConfig } from "drizzle-kit";
import { envSchema } from "./src/config.js";

const config = envSchema.parse(process.env);

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dbCredentials: { url: config.DATABASE_URL },
});
