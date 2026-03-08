import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "../../app/db/schema";

/**
 * Creates a Drizzle instance bound to the test D1 database.
 */
export function getTestDb() {
  return drizzle(env.DB, { schema });
}

/**
 * Applies the schema to the test D1 database.
 * Uses D1 batch API (prepare + run) for each statement.
 */
export async function applyMigrations() {
  const db = env.DB;

  await db.exec("CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY NOT NULL, email TEXT NOT NULL UNIQUE, name TEXT, is_admin INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)");

  await db.exec("CREATE TABLE IF NOT EXISTS magic_links (id TEXT PRIMARY KEY NOT NULL, token TEXT NOT NULL UNIQUE, user_id TEXT NOT NULL REFERENCES users(id), expires_at INTEGER NOT NULL, used_at INTEGER, created_at INTEGER NOT NULL)");
  await db.exec("CREATE INDEX IF NOT EXISTS magic_links_token_idx ON magic_links(token)");
  await db.exec("CREATE INDEX IF NOT EXISTS magic_links_expires_idx ON magic_links(expires_at)");

  await db.exec("CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, description TEXT, conventions TEXT, settings TEXT, created_by TEXT NOT NULL REFERENCES users(id), created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)");

  await db.exec("CREATE TABLE IF NOT EXISTS project_members (id TEXT PRIMARY KEY NOT NULL, project_id TEXT NOT NULL REFERENCES projects(id), user_id TEXT NOT NULL REFERENCES users(id), role TEXT NOT NULL CHECK(role IN ('lead', 'cataloguer', 'reviewer')), created_at INTEGER NOT NULL)");
  await db.exec("CREATE INDEX IF NOT EXISTS pm_project_idx ON project_members(project_id)");
  await db.exec("CREATE INDEX IF NOT EXISTS pm_user_idx ON project_members(user_id)");
  await db.exec("CREATE INDEX IF NOT EXISTS pm_project_user_idx ON project_members(project_id, user_id)");

  await db.exec("CREATE TABLE IF NOT EXISTS project_invites (id TEXT PRIMARY KEY NOT NULL, project_id TEXT NOT NULL REFERENCES projects(id), email TEXT NOT NULL, roles TEXT NOT NULL, invited_by TEXT NOT NULL REFERENCES users(id), token TEXT NOT NULL UNIQUE, expires_at INTEGER NOT NULL, accepted_at INTEGER, created_at INTEGER NOT NULL)");

  await db.exec("CREATE TABLE IF NOT EXISTS volumes (id TEXT PRIMARY KEY NOT NULL, project_id TEXT NOT NULL REFERENCES projects(id), name TEXT NOT NULL, reference_code TEXT NOT NULL, manifest_url TEXT NOT NULL, page_count INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'unstarted' CHECK(status IN ('unstarted', 'in_progress', 'segmented', 'reviewed', 'approved')), assigned_to TEXT REFERENCES users(id), assigned_reviewer TEXT REFERENCES users(id), created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)");
  await db.exec("CREATE INDEX IF NOT EXISTS vol_project_idx ON volumes(project_id)");
  await db.exec("CREATE INDEX IF NOT EXISTS vol_status_idx ON volumes(project_id, status)");

  await db.exec("CREATE TABLE IF NOT EXISTS volume_pages (id TEXT PRIMARY KEY NOT NULL, volume_id TEXT NOT NULL REFERENCES volumes(id) ON DELETE CASCADE, position INTEGER NOT NULL, image_url TEXT NOT NULL, width INTEGER NOT NULL, height INTEGER NOT NULL, label TEXT, created_at INTEGER NOT NULL)");
  await db.exec("CREATE INDEX IF NOT EXISTS vp_volume_idx ON volume_pages(volume_id)");
  await db.exec("CREATE INDEX IF NOT EXISTS vp_volume_pos_idx ON volume_pages(volume_id, position)");
}

/**
 * Cleans all data from tables (order matters due to foreign keys).
 */
export async function cleanDatabase() {
  const db = env.DB;
  const tables = [
    "volume_pages",
    "volumes",
    "project_invites",
    "project_members",
    "projects",
    "magic_links",
    "users",
  ];

  for (const table of tables) {
    await db.exec(`DELETE FROM ${table}`);
  }
}
