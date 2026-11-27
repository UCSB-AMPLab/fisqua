/**
 * Vitest Configuration — Node Pool for Script Tests
 *
 * The operator scripts under `scripts/` (`scripts/fisqua.ts`, its
 * commands and libs, and the standalone scripts beside it) run as plain
 * Node programs that talk to D1 through `wrangler d1 execute`. They do
 * not run inside the Worker, so their tests mock the wrangler
 * subprocess or use an in-memory SQLite database and drive the scripts'
 * argument parsing, planning and SQL writers directly under Node. This
 * config routes those tests away from the Workers pool to the standard
 * Node pool.
 *
 * The Django round import is retired, and the tests of its row
 * builders, tenant clear and orchestrator were removed with it.
 *
 * Keep this config narrow — only `tests/import/**` should be included.
 * Anything that exercises the live Worker belongs with `vitest.config.ts`.
 *
 * @version v0.9.0
 */

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The development machine is shared; cap the worker pool.
    maxWorkers: 2,
    include: ["tests/import/**/*.test.ts"],
    // Production reads in these tests reach a fake exec: no read lock in the cache directory, no pacing (the cap still holds).
    env: { FISQUA_D1_PRODUCTION_GUARD: "off" },
  },
});
