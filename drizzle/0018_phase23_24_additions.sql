-- Superadmin flag and export-run bookkeeping
--
-- Adds two pieces of infrastructure that the publish pipeline relies
-- on. First, a boolean `is_super_admin` on `users` gates the publish
-- and promote surfaces behind a distinct role; regular admins cannot
-- trigger an export or promote a volume until a superadmin grants
-- them the flag. Second, the `export_runs` table records every
-- publish attempt with the triggering user, the selection filters
-- (which fonds, which description types), progress counters, and
-- final status -- so that the publish dashboard can show an audit
-- trail and the operator can diagnose a failed run without tailing
-- Worker logs.
--
-- The counts and current-step fields are updated as the pipeline
-- advances; the two timestamp indexes support the dashboard's
-- "recent runs" listing and the status filter.
--
-- Version: v0.3.0

ALTER TABLE users ADD COLUMN is_super_admin INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS export_runs (
  id TEXT PRIMARY KEY,
  triggered_by TEXT NOT NULL REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'pending',
  selected_fonds TEXT NOT NULL,
  selected_types TEXT NOT NULL,
  current_step TEXT,
  steps_completed INTEGER NOT NULL DEFAULT 0,
  total_steps INTEGER NOT NULL DEFAULT 0,
  record_counts TEXT,
  error_message TEXT,
  started_at INTEGER,
  completed_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS export_runs_status_idx ON export_runs(status);
CREATE INDEX IF NOT EXISTS export_runs_created_idx ON export_runs(created_at);
