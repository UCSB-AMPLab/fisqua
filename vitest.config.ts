/**
 * Vitest Configuration — Workers Pool
 *
 * This is the default vitest config for tests that run inside Cloudflare's
 * Workers runtime via `@cloudflare/vitest-pool-workers`. Using the Workers
 * pool means component, route, and server-module tests execute in an
 * environment that mirrors production — D1 bindings, R2 bindings, the
 * `request` object, and the runtime `fetch` all behave as they do on the
 * edge.
 *
 * Two test suites are deliberately excluded and run under separate configs:
 * schema migration tests live in `vitest.node.config.ts` because they spin
 * up an in-memory SQLite database the Workers pool can't host, and the
 * bulk-import test suite lives in `vitest.import.config.ts` because it
 * exercises the Node-side CLI entry points rather than Worker code.
 *
 * Test-only secrets are injected via miniflare bindings so route handlers
 * that check `env.SESSION_SECRET` or GitHub OAuth credentials can execute
 * without leaking real production values.
 *
 * @version v0.3.0
 */

import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  test: {
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "tests/schema/migrations.test.ts",
      "tests/import/**",
    ],
    testTimeout: 15000,
    hookTimeout: 30000,
    poolOptions: {
      workers: {
        wrangler: {
          configPath: "./wrangler.jsonc",
        },
        miniflare: {
          bindings: {
            SESSION_SECRET: "test-session-secret",
            GITHUB_CLIENT_ID: "test-github-id",
            GITHUB_CLIENT_SECRET: "test-github-secret",
          },
          d1Databases: {
            DB: "my-app-db",
          },
        },
      },
    },
  },
});
