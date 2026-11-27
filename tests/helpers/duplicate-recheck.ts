/**
 * Test helper — the duplicate-recheck marking triggers
 *
 * This module deals with installing the triggers of migration 0129 on
 * the test D1 database. The mirror in `db.ts` creates the migration's
 * tables and `entities.name_key` but not its triggers, so the rest of the
 * suite writes entity records without marks landing in
 * `duplicate_recheck`. A suite that tests the marking calls
 * `applyDuplicateRecheckTriggers()`, which runs only the CREATE TRIGGER
 * statements of the migration file, as the file words them.
 *
 * @version v0.9.0
 */
import { env } from "cloudflare:test";
import { migrationStatements } from "./migration-file";

export async function applyDuplicateRecheckTriggers(): Promise<void> {
  const triggers = migrationStatements("0129_duplicate_candidates.sql").filter((s) => /^CREATE TRIGGER\b/i.test(s));
  if (triggers.length === 0) throw new Error("0129 holds no CREATE TRIGGER statements");
  for (const statement of triggers) {
    await env.DB.prepare(statement).run();
  }
}
