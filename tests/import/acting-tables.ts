/**
 * Tests — the tables who acts is read from, for the standalone commands
 *
 * This module deals with the tables that the standalone commands' suites
 * read who acts from. `seedActing` adds to an in-memory `node:sqlite`
 * database the columns `resolveActor` and `readScope`
 * (`scripts/lib/authority-links.ts`) read: federation `fed-1`, led by
 * `neogranadina` (`t-lead`), with the member `ahr` (`t-1`), both with
 * authorities on; and `user_001` (`lead@example.org`), the lead's
 * workspace admin, with no membership. A test adds a steward membership
 * with `stewardMembership`.
 *
 * Every value here is a test value.
 *
 * @version v0.9.0
 */
import type { DatabaseSync } from "node:sqlite";

export function seedActing(db: DatabaseSync): void {
  db.exec(`CREATE TABLE federations (id TEXT PRIMARY KEY, slug TEXT, status TEXT, lead_tenant_id TEXT, shared_authorities_enabled INTEGER);
    CREATE TABLE tenants (id TEXT PRIMARY KEY, slug TEXT, kind TEXT NOT NULL DEFAULT 'tenant', status TEXT, federation_id TEXT, disabled_at INTEGER,
      authorities_enabled INTEGER);
    CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT, name TEXT, tenant_id TEXT, is_admin INTEGER DEFAULT 0, is_super_admin INTEGER DEFAULT 0,
      is_records_admin INTEGER DEFAULT 0, is_authorities_admin INTEGER DEFAULT 0, is_imports_admin INTEGER DEFAULT 0,
      is_digitization_admin INTEGER DEFAULT 0, is_platform_admin INTEGER DEFAULT 0);
    CREATE TABLE federation_memberships (id TEXT PRIMARY KEY, user_id TEXT, federation_id TEXT, role TEXT);
    INSERT INTO federations VALUES ('fed-1', 'neogranadina', 'active', 't-lead', 1);
    INSERT INTO tenants (id, slug, federation_id, authorities_enabled) VALUES ('t-lead', 'neogranadina', 'fed-1', 1), ('t-1', 'ahr', 'fed-1', 1);
    INSERT INTO users (id, email, name, tenant_id, is_admin) VALUES ('user_001', 'lead@example.org', 'Lead', 't-lead', 1);`);
}

export function stewardMembership(db: DatabaseSync): void {
  db.exec("INSERT INTO federation_memberships VALUES ('m-1', 'user_001', 'fed-1', 'steward')");
}

export const reader = (db: DatabaseSync) => async (sql: string) => db.prepare(sql).all() as Record<string, unknown>[];

// @version v0.9.0
