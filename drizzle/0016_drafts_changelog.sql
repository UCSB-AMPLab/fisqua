-- Drafts and changelog for description editing
--
-- Adds two tables that together give the description editor a safe
-- autosave-and-audit cycle. `drafts` stores the in-progress snapshot of
-- a record as a JSON blob so that a cataloguer's unsaved edits survive a
-- page reload, a session timeout, or a switch to another machine -- the
-- editor writes a draft every few seconds while the user types, and
-- clears it once the user explicitly commits. `changelog` records a
-- timestamped diff of every committed change, so that reviewers can see
-- who edited what and when, and so that a bad edit can be investigated
-- after the fact without relying on database backups.
--
-- A unique constraint on (record_id, record_type) in `drafts` ensures
-- only one draft exists per record per type, which is what the editor
-- assumes when it reads back its autosave on page load.
--
-- Version: v0.3.0

CREATE TABLE drafts (
  id TEXT PRIMARY KEY,
  record_id TEXT NOT NULL,
  record_type TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id),
  snapshot TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(record_id, record_type)
);
CREATE INDEX drafts_user_idx ON drafts (user_id);

CREATE TABLE changelog (
  id TEXT PRIMARY KEY,
  record_id TEXT NOT NULL,
  record_type TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id),
  note TEXT,
  diff TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX changelog_record_idx ON changelog (record_id, record_type, created_at);
