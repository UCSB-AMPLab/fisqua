#!/usr/bin/env npx tsx
/**
 * Seed Dev Tenant
 *
 * This script is a one-shot job that inserts a `test-archive` tenant row
 * into the LOCAL `wrangler dev` D1 database, so local development can resolve
 * at least two seeded subdomains end-to-end without re-using the test
 * pool's `second-tenant` fixture (which lives only in the
 * cloudflare:test workers pool's in-memory D1 via
 * tests/helpers/db.ts:seedTenants()).
 *
 * Usage:
 *   npm run seed:dev-tenant
 *
 * After this script completes, `wrangler dev` resolves both
 * `neogranadina.localhost:8788` (the canonical production tenant
 * back-fill) and `test-archive.localhost:8788` (the dev-only fixture
 * this script seeds). Both load the staff app.
 *
 * Idempotent. Uses `INSERT OR IGNORE`, so re-running has no effect on
 * a populated table.
 *
 * The UUID `33333333-3333-4333-8333-333333333333` is intentionally a
 * debug-pattern literal so an operator inspecting the local DB
 * recognises it as a non-production fixture immediately. The slug is
 * `test-archive` -- NOT `second-tenant` (which is reserved for the
 * test pool) and NOT a name resembling a real institution.
 *
 * Prerequisites: `wrangler dev` must have been run at least once so
 * the local D1 sqlite file and the `tenants` table exist (the table
 * is created by drizzle migrations on first wrangler dev startup).
 * If the table is missing this script will fail loudly with the
 * wrangler CLI error -- run `npm run dev` once first, then re-run
 * `npm run seed:dev-tenant`.
 *
 * This script targets `--local` D1 only; it is not safe to point at
 * staging or production. The wrangler invocation below explicitly
 * passes `--local`.
 *
 * @version v0.9.0
 */
import { runD1 } from "./lib/d1-cli";

const TEST_ARCHIVE_TENANT_ID = "33333333-3333-4333-8333-333333333333";
const TEST_ARCHIVE_SLUG = "test-archive";
const TEST_ARCHIVE_NAME = "Test Archive";

function wrangler(args: string[]): string {
  return runD1(args, { maxBuffer: 50 * 1024 * 1024 });
}

function main(): void {
  const now = Date.now();
  // Match tests/helpers/db.ts:seedTenants() column order verbatim.
  // All values are static literals, and the SQL reaches wrangler as one
  // argument with no shell in between.
  const sql =
    `INSERT OR IGNORE INTO tenants ` +
    `(id, slug, name, kind, descriptive_standard, status, ` +
    ` crowdsourcing_enabled, vocabulary_hub_enabled, publish_pipeline_enabled, multi_repository_enabled, authorities_enabled, ` +
    ` quota_storage_bytes, created_at, updated_at) ` +
    `VALUES ('${TEST_ARCHIVE_TENANT_ID}', '${TEST_ARCHIVE_SLUG}', '${TEST_ARCHIVE_NAME}', ` +
    `'tenant', 'isadg', 'active', 1, 1, 1, 1, 1, NULL, ${now}, ${now});`;

  console.log(`Seeding ${TEST_ARCHIVE_SLUG} tenant into local D1...`);
  const output = wrangler(["wrangler", "d1", "execute", "fisqua-db", "--local", "--command", sql]);
  console.log(output);
  console.log(
    `Done. Now run \`npm run dev\` and visit ` +
      `http://${TEST_ARCHIVE_SLUG}.localhost:8788/`,
  );
}

main();
