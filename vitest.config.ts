import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { defineConfig } from "vitest/config";

const resolveNodeNext = {
  name: "resolve-node-next-js-to-ts",
  enforce: "pre" as const,
  resolveId(source: string, importer: string | undefined) {
    if (importer === undefined || !source.startsWith(".") || !source.endsWith(".js")) {
      return null;
    }
    const candidate = resolve(dirname(importer), `${source.slice(0, -3)}.ts`);
    return existsSync(candidate) ? candidate : null;
  },
};

export default defineConfig({
  plugins: [resolveNodeNext],
  test: {
    include: ["tests/**/*.test.ts"],
    pool: "forks",
    fileParallelism: true,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
