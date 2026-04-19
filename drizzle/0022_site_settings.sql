-- Site-wide key/value settings table
--
-- A simple `(key, value)` store for settings that are edited by
-- superadmins rather than developers -- site announcements, flags
-- that gate experimental features, default copy for landing pages.
-- Keys are plain strings; values are stored as text (typically JSON
-- when structured). `updated_by` records which user last wrote each
-- row so the admin UI can show provenance.
--
-- Version: v0.3.0

CREATE TABLE IF NOT EXISTS site_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  updated_by TEXT REFERENCES users(id)
);
