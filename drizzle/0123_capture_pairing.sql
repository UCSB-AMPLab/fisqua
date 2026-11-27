-- Pairing a Captua unit with its workspace by a six-character code.
--
-- This migration adds the three tables behind the pairing handshake
-- (contract 1.11) and two columns on `capture_scanners`.
--
-- `capture_pairing_codes` holds one row per code issued by a unit. Only
-- the SHA-256 of the code (`code_sha256`, unique) and of the secret the
-- unit collects with (`collect_secret_sha256`) are kept. A code is
-- `waiting` until a manager of a workspace approves it, `approved` until
-- the unit collects, `collected` after, and `void` when it is withdrawn
-- or expires. `expires_at` is the end of the current step. `tenant_id`,
-- `approved_by` and `approved_at` are set on approval; `collect_by` is
-- the end of the collection window; `scanner_revision_seen` and
-- `keys_revision_seen` are the revisions the approver saw, which are
-- checked at collection. `poll_window_start` and `poll_window_calls` are the
-- code's fixed one-minute poll counter.
--
-- `capture_scanner_keys` holds the storage key sealed for a workspace's
-- unit, one row per tenant: the appliance id, the bucket, the sealed
-- key, its age recipient, a `revision` raised by every write and the
-- time it was stored. An erased row has `sealed` null and records
-- `erased_at` and `erased_by`; `erased_by` is plain text, not a key to
-- users.
--
-- `capture_pairing_limits` is the counter for the rate limits that no
-- other table holds: one row per limit key, with the start of its
-- window and its count.
--
-- `expires_at` and `window_start` are indexed: the count of live codes
-- reads a range of `expires_at`, and each code request deletes a few
-- code rows and limit rows more than a day old.
--
-- `capture_scanners` gains `unit_name` and `device_id`, the unit's name
-- and device id as reported when it paired; both are null for a scanner
-- registered before pairing.
--
-- Version: v0.9.0

CREATE TABLE capture_pairing_codes (
  id TEXT PRIMARY KEY NOT NULL,
  code_sha256 TEXT NOT NULL,
  collect_secret_sha256 TEXT NOT NULL,
  unit_name TEXT NOT NULL,
  device_id TEXT NOT NULL,
  current_tenant TEXT,
  state TEXT NOT NULL CHECK (state IN ('waiting','approved','collected','void')),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  tenant_id TEXT REFERENCES tenants(id) ON DELETE RESTRICT,
  approved_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  approved_at INTEGER,
  collect_by INTEGER,
  scanner_revision_seen INTEGER,
  keys_revision_seen INTEGER,
  collected_at INTEGER,
  poll_window_start INTEGER,
  poll_window_calls INTEGER NOT NULL DEFAULT 0
);
--> statement-breakpoint
CREATE UNIQUE INDEX capture_pairing_codes_code_idx ON capture_pairing_codes (code_sha256);
--> statement-breakpoint
CREATE INDEX capture_pairing_codes_expires_idx ON capture_pairing_codes (expires_at);
--> statement-breakpoint
CREATE TABLE capture_scanner_keys (
  tenant_id TEXT PRIMARY KEY NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  appliance_id TEXT NOT NULL,
  bucket TEXT NOT NULL,
  sealed TEXT,
  age_recipient TEXT NOT NULL,
  revision INTEGER NOT NULL,
  stored_at INTEGER NOT NULL,
  erased_at INTEGER,
  erased_by TEXT
);
--> statement-breakpoint
CREATE TABLE capture_pairing_limits (
  key TEXT PRIMARY KEY NOT NULL,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL
);
--> statement-breakpoint
CREATE INDEX capture_pairing_limits_window_idx ON capture_pairing_limits (window_start);
--> statement-breakpoint
ALTER TABLE capture_scanners ADD COLUMN unit_name TEXT;
--> statement-breakpoint
ALTER TABLE capture_scanners ADD COLUMN device_id TEXT;
