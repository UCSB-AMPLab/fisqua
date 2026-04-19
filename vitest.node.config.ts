/**
 * Vitest Configuration — Node Pool for Schema Migrations
 *
 * Schema-migration tests can't run under the Workers pool because they need
 * to spin up an in-memory SQLite database and replay every migration file
 * in order to verify the resulting schema. The Workers miniflare sandbox
 * only exposes D1 through its own binding surface, which doesn't accept
 * raw SQLite files. So this config routes the migration suite to the
 * standard Node test pool where `better-sqlite3` is available.
 *
 * Keep this config narrow — only `tests/schema/migrations.test.ts` should
 * be included. Anything else belongs with the main `vitest.config.ts`.
 *
 * @version v0.3.0
 */

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/schema/migrations.test.ts"],
  },
});
