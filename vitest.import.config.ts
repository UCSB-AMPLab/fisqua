/**
 * Vitest Configuration — Node Pool for Bulk Import Tests
 *
 * The bulk-import CLI (entities, places, descriptions, junctions) runs as
 * a plain Node script that talks to D1 via `wrangler d1 execute --file`.
 * It does not run inside the Worker — so its tests mock the wrangler
 * subprocess and drive the CLI's argument parsing, transform helpers, and
 * SQL writers directly under Node. This config routes those tests away
 * from the Workers pool to the standard Node pool.
 *
 * Keep this config narrow — only `tests/import/**` should be included.
 * Anything that exercises the live Worker belongs with `vitest.config.ts`.
 *
 * @version v0.8.0
 */

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The development machine is shared; cap the worker pool.
    maxWorkers: 2,
    include: ["tests/import/**/*.test.ts"],
  },
});
