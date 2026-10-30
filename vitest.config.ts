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
 * without leaking real production values. The media pipeline's settings
 * get test values the same way, with the callback origin
 * `https://fisqua.test`, so no pipeline test reads a real credential.
 *
 * The `exclude` list spreads vitest's `configDefaults.exclude` first so the
 * built-in `**\/node_modules/**` exclusion stays in place — without that
 * spread, our explicit list silently replaces the defaults and vitest
 * descends into dependency packages that ship their own `*.test.ts` files
 * (notably `svix`, which dangles workerd isolates trying to resolve a
 * missing `mockttp` import).
 *
 * @version v0.8.0
 */

import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";
import { configDefaults } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineWorkersConfig({
  // Mirrors the `~/*` -> `./app/*` mapping in tsconfig.cloudflare.json.
  // The app build resolves it via vite-tsconfig-paths in vite.config.ts,
  // but this config never loads that plugin, so route modules that use
  // `~/` imports are untestable without this alias.
  resolve: {
    alias: {
      "~": fileURLToPath(new URL("./app", import.meta.url)),
    },
  },
  test: {
    exclude: [
      ...configDefaults.exclude,
      "tests/schema/migrations.test.ts",
      "tests/import/**",
      // EAD3, DACS, and DC schema-validation tests use `xmllint-wasm`
      // (which calls `node:fs` for its WASM blob) and read vendored
      // RNG fixtures from disk — neither works under the Workers pool
      // sandbox. They run under `vitest.node.config.ts`.
      "tests/export/ead/schema-*.test.ts",
      "tests/export/ead/dacs-*.test.ts",
      "tests/export/dc/**/*.test.ts",
      // The AST-based i18n guards import the `typescript` package,
      // whose Node system layer the Workers sandbox can't host. They
      // run under `vitest.node.config.ts`.
      "tests/i18n-coverage.test.ts",
      "tests/i18n-keys.test.ts",
      // The media pipeline's schema agreement checks run a JSON Schema
      // engine that compiles validators with `new Function`, which the
      // Workers runtime forbids. They run under `vitest.node.config.ts`.
      "tests/media-pipeline-node/**",
    ],
    testTimeout: 60000,
    hookTimeout: 60000,
    poolOptions: {
      workers: {
        singleWorker: true,
        wrangler: {
          configPath: "./wrangler.jsonc",
        },
        miniflare: {
          bindings: {
            SESSION_SECRET: "test-session-secret",
            GITHUB_CLIENT_ID: "test-github-id",
            GITHUB_CLIENT_SECRET: "test-github-secret",
            // Injected so the places-map loader tests never depend on a
            // real key being present in wrangler.jsonc vars.
            MAPTILER_KEY: "test-maptiler-key",
            // Media pipeline test values. No real repository, endpoint,
            // bucket or credential. The reader backend is set to "r2"
            // over the "b2" that wrangler.jsonc gives deployed
            // environments, so the reader reads through `BUCKET`.
            PIPELINE_READER_BACKEND: "r2",
            // The GitHub App's settings. The private key is a placeholder
            // that does not import; a test that dispatches generates a
            // key and passes it in, with a fetch stub that answers the
            // token exchange.
            PIPELINE_GITHUB_APP_ID: "123456",
            PIPELINE_GITHUB_APP_INSTALLATION_ID: "7654321",
            PIPELINE_GITHUB_APP_PRIVATE_KEY: "test-github-app-private-key",
            PIPELINE_DISPATCH_REPO: "test-owner/test-runner",
            PIPELINE_CALLBACK_ORIGIN: "https://fisqua.test",
            PIPELINE_SPEC_S3_ENDPOINT: "https://spec.r2.test.example",
            PIPELINE_SPEC_BUCKET: "test-spec-bucket",
            PIPELINE_SPEC_KEY_ID: "test-spec-key-id",
            PIPELINE_SPEC_SECRET_KEY: "test-spec-secret-key",
            PIPELINE_WORKING_S3_ENDPOINT: "https://s3.us-west-000.backblazeb2.test.example",
            PIPELINE_WORKING_BUCKET: "test-working-bucket",
            PIPELINE_WORKING_READ_KEY_ID: "test-working-key-id",
            PIPELINE_WORKING_READ_SECRET_KEY: "test-working-secret-key",
            // The four secrets of the test storage destination, whose
            // prefix is TEST_TENANT (tests/helpers/media-pipeline.ts).
            TEST_TENANT_DELIVERY_READ_KEY_ID: "test_tenant-delivery-key-id",
            TEST_TENANT_DELIVERY_READ_SECRET_KEY: "test_tenant-delivery-secret",
            TEST_TENANT_MANIFEST_WRITE_KEY_ID: "test_tenant-manifest-key-id",
            TEST_TENANT_MANIFEST_WRITE_SECRET_KEY: "test_tenant-manifest-secret",
            PIPELINE_RUNNER_IMAGE:
              "ghcr.io/example/runner@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
            PIPELINE_SCRIPT_VERSION: "v1.0.0",
          },
          d1Databases: {
            DB: "my-app-db",
          },
          // wrangler.jsonc binds SPEC_BUCKET and BUCKET to the same
          // production bucket. Here the spec binding gets a bucket of its
          // own, named as PIPELINE_SPEC_BUCKET above, so a test can tell
          // a pipeline write that went to BUCKET from one that went to
          // SPEC_BUCKET. The other R2 bindings come from wrangler.jsonc.
          r2Buckets: {
            SPEC_BUCKET: { id: "test-spec-bucket" },
          },
        },
      },
    },
  },
});
