import { cpSync, mkdtempSync, readFileSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

// Mutate an isolated source copy, never the working tree or production database.
const root = fileURLToPath(new URL("../", import.meta.url));
const temporary = mkdtempSync(join(tmpdir(), "idleforge-race-proof-"));
const testName = "does not double-credit two simultaneous collectors";
function run() {
  const child = spawnSync(process.execPath, [
    `--env-file=${resolve(root, ".env")}`,
    join(root, "node_modules/vitest/vitest.mjs"), "run", "integration/collect.test.ts",
    "-t", testName, "--reporter=json", "--outputFile=report.json",
  ], { cwd: temporary, encoding: "utf8", timeout: 30_000 });
  if (child.error) throw child.error;
  let report;
  try { report = JSON.parse(readFileSync(join(temporary, "report.json"), "utf8")); }
  catch { throw new Error(`Test runner did not produce a report:\n${child.stdout}\n${child.stderr}`); }
  const test = report.testResults.flatMap((suite) => suite.assertionResults)
    .find((assertion) => assertion.fullName.includes(testName));
  return { status: child.status, report, test };
}
try {
  for (const name of ["src", "tests", "integration", "drizzle", "package.json", "tsconfig.json"]) {
    cpSync(join(root, name), join(temporary, name), { recursive: true });
  }
  symlinkSync(join(root, "node_modules"), join(temporary, "node_modules"), "dir");
  const control = run();
  if (control.status !== 0 || control.test?.status !== "passed") {
    throw new Error(`Safe implementation failed the control run: ${JSON.stringify(control)}`);
  }
  const path = join(temporary, "src/players/collect.ts");
  let source = readFileSync(path, "utf8");
  const lockedRead = "SELECT * FROM player_resources WHERE player_id = ${playerId}::uuid FOR UPDATE";
  if (!source.includes(lockedRead)) throw new Error("Collection implementation changed; update the mutation fixture");
  source = source.replace('import { players }', 'import { players, playerResources }');
  source = source.replace("  const result = await db.execute(sql`", `
  // Deliberately unsafe: read outside the update, without a row lock.
  const [stale] = await db.select().from(playerResources)
    .where(eq(playerResources.playerId, playerId));
  if (!stale) return { ok: false, reason: "resource_not_found" };
  const result = await db.execute(sql\``);
  source = source.replace(lockedRead, `SELECT
      \${stale.playerId}::uuid AS player_id,
      \${stale.gold}::numeric AS gold,
      \${stale.lifetimeGoldEarned}::numeric AS lifetime_gold_earned,
      \${stale.goldPerSecond}::numeric AS gold_per_second,
      \${stale.lastCollectedAt.toISOString()}::timestamptz AS last_collected_at`);
  writeFileSync(path, source);
  const mutant = run();
  const messages = mutant.test?.failureMessages.join("\n") ?? "";
  if (mutant.status === 0 || mutant.report.numFailedTests !== 1 ||
      mutant.test?.status !== "failed" || !messages.includes("AssertionError: expected")) {
    throw new Error(`Expected the concurrency invariant to reject unsafe read-modify-write: ${JSON.stringify(mutant)}`);
  }
  console.log("Safe collection: concurrency test passed.");
  console.log("Unsafe read-modify-write: the same test failed its credited-total assertion, as required.");
  console.log(messages.split("\n")[0]);
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
