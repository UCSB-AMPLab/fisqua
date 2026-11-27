-- Capture QC: an opening excluded as not a page.
--
-- This migration adds a third capture QC decision, `excluded`, for an
-- opening that is not a page of the volume: a test shot of the scanner
-- rig, or a duplicate. An excluded opening takes no reason and no side;
-- its note is optional. It asks for no retake, and its images are left
-- out of processing, so they are never processed or published; the
-- masters stay where they are. A volume whose openings are all approved
-- or excluded is fully decided.
--
-- `capture_qc_decisions.decision` takes `excluded` beside `approved` and
-- `rejected`. The rules already there are kept as they are: a reason
-- exactly when the decision is `rejected`, a note for `other`, and a
-- side only on a rejection, which also refuses one on an exclusion.
--
-- A unit on contract 1.6 gives such a record the status `excluded` in a
-- manifest it sends again. `capture_images.record_status` takes
-- `excluded` beside the four statuses it took, so the images of such a
-- record are kept as those of any other record are. Such a record is
-- not an opening and not a page.
--
-- `capture_qc_sets.excluded_count` counts a set's excluded openings, so
-- that its counts still add up: `approved_count + rejected_count +
-- excluded_count = decided_count`. It is recounted from the decisions
-- with the other counts on every write. Every existing set had no
-- exclusion and takes 0, which keeps its counts adding up.
--
-- SQLite cannot change a CHECK in place, so the three tables are
-- rebuilt, and with them `capture_qc_rotations`, which references
-- `capture_qc_decisions`. D1 enforces foreign keys, and their ON DELETE
-- RESTRICT acts at once and is not deferred by `defer_foreign_keys`, so
-- a parent cannot be dropped under populated children. As in 0095, each
-- of the four tables is copied to a plain holding table, dropped child
-- first, created again parent first with its definition from 0094, 0095,
-- 0096, 0100, 0106 and 0109 unchanged except for the changes above,
-- filled from its holding table with explicit column lists, and the
-- holding tables are dropped. `capture_images` and `capture_qc_sets`
-- reference only `capture_deliveries`, which is not touched, and
-- nothing else references the four tables.
-- Every index is created again under its own name. The file runs as one
-- D1 transaction, so a failure leaves the tables as they were.
--
-- Version: v0.9.0

CREATE TABLE capture_images_hold AS SELECT * FROM capture_images;
--> statement-breakpoint
CREATE TABLE capture_qc_sets_hold AS SELECT * FROM capture_qc_sets;
--> statement-breakpoint
CREATE TABLE capture_qc_decisions_hold AS SELECT * FROM capture_qc_decisions;
--> statement-breakpoint
CREATE TABLE capture_qc_rotations_hold AS SELECT * FROM capture_qc_rotations;
--> statement-breakpoint
DROP TABLE capture_qc_rotations;
--> statement-breakpoint
DROP TABLE capture_qc_decisions;
--> statement-breakpoint
DROP TABLE capture_qc_sets;
--> statement-breakpoint
DROP TABLE capture_images;
--> statement-breakpoint
CREATE TABLE capture_images (
  id TEXT PRIMARY KEY NOT NULL,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  delivery_id TEXT NOT NULL,
  captua_record_id INTEGER NOT NULL,
  capture_id TEXT NOT NULL,
  pair_id TEXT,
  role TEXT NOT NULL CHECK (role IN ('left','right','single')),
  page_key TEXT NOT NULL,
  capture_key TEXT NOT NULL,
  capture_sha256 TEXT NOT NULL CHECK (length(capture_sha256) = 64 AND capture_sha256 NOT GLOB '*[^0-9a-f]*'),
  capture_bytes INTEGER,
  preview_key TEXT,
  preview_sha256 TEXT CHECK (preview_sha256 IS NULL OR (length(preview_sha256) = 64 AND preview_sha256 NOT GLOB '*[^0-9a-f]*')),
  preview_bytes INTEGER,
  record_status TEXT
    CHECK (record_status IS NULL OR record_status IN ('captured','in_review','approved','rejected','excluded')),
  rotate_deg INTEGER CHECK (rotate_deg IS NULL OR rotate_deg IN (0, 90, 180, 270)),
  FOREIGN KEY (tenant_id, delivery_id) REFERENCES capture_deliveries(tenant_id, id) ON DELETE RESTRICT,
  CHECK ((preview_key IS NULL) = (preview_sha256 IS NULL))
);
--> statement-breakpoint
CREATE INDEX capture_images_delivery_idx ON capture_images (tenant_id, delivery_id);
--> statement-breakpoint
CREATE INDEX capture_images_record_idx ON capture_images (tenant_id, delivery_id, captua_record_id);
--> statement-breakpoint
CREATE TABLE capture_qc_sets (
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  delivery_id TEXT NOT NULL,
  pipeline_volume_id TEXT NOT NULL REFERENCES pipeline_volumes(id) ON DELETE RESTRICT,
  decisions_id TEXT NOT NULL,
  decided_at INTEGER NOT NULL,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  opening_count INTEGER NOT NULL CHECK (opening_count >= 1),
  decided_count INTEGER NOT NULL DEFAULT 0,
  approved_count INTEGER NOT NULL DEFAULT 0,
  rejected_count INTEGER NOT NULL DEFAULT 0,
  excluded_count INTEGER NOT NULL DEFAULT 0,
  notes_bytes INTEGER NOT NULL DEFAULT 0 CHECK (notes_bytes <= 1000000),
  state TEXT NOT NULL CHECK (state IN ('in_capture_qc','retakes_requested','approved')),
  state_entered_at INTEGER NOT NULL,
  write_id TEXT NOT NULL,
  carried_from TEXT,
  PRIMARY KEY (tenant_id, delivery_id),
  FOREIGN KEY (tenant_id, delivery_id) REFERENCES capture_deliveries(tenant_id, id) ON DELETE RESTRICT,
  CHECK (approved_count + rejected_count + excluded_count = decided_count AND decided_count <= opening_count)
);
--> statement-breakpoint
CREATE UNIQUE INDEX capture_qc_sets_decisions_idx ON capture_qc_sets (tenant_id, decisions_id);
--> statement-breakpoint
CREATE INDEX capture_qc_sets_volume_idx ON capture_qc_sets (tenant_id, pipeline_volume_id);
--> statement-breakpoint
CREATE TABLE capture_qc_decisions (
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  delivery_id TEXT NOT NULL,
  captua_record_id INTEGER NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('approved','rejected','excluded')),
  reason TEXT CHECK (reason IS NULL OR reason IN ('blur','glare','shadow','focus','exposure','dirt','framing','obstruction','other')),
  note TEXT CHECK (note IS NULL OR length(note) BETWEEN 1 AND 2000),
  decided_by TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  decided_by_name TEXT NOT NULL CHECK (length(decided_by_name) BETWEEN 1 AND 256),
  decided_at INTEGER NOT NULL,
  set_revision INTEGER NOT NULL DEFAULT 0,
  side TEXT
    CHECK (side IS NULL OR side IN ('left','right','both'))
    CHECK (side IS NULL OR decision = 'rejected'),
  PRIMARY KEY (tenant_id, delivery_id, captua_record_id),
  FOREIGN KEY (tenant_id, delivery_id) REFERENCES capture_qc_sets(tenant_id, delivery_id) ON DELETE RESTRICT,
  CHECK ((decision = 'rejected') = (reason IS NOT NULL)),
  CHECK (reason IS NOT 'other' OR note IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE capture_qc_rotations (
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  delivery_id TEXT NOT NULL,
  captua_record_id INTEGER NOT NULL,
  capture_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('left','right','single')),
  quarter_turns INTEGER NOT NULL CHECK (quarter_turns BETWEEN 1 AND 3),
  PRIMARY KEY (tenant_id, delivery_id, captua_record_id, capture_id, role),
  FOREIGN KEY (tenant_id, delivery_id, captua_record_id)
    REFERENCES capture_qc_decisions(tenant_id, delivery_id, captua_record_id) ON DELETE RESTRICT
);
--> statement-breakpoint
INSERT INTO capture_images (id, tenant_id, delivery_id, captua_record_id, capture_id, pair_id, role, page_key,
  capture_key, capture_sha256, capture_bytes, preview_key, preview_sha256, preview_bytes, record_status, rotate_deg)
SELECT id, tenant_id, delivery_id, captua_record_id, capture_id, pair_id, role, page_key,
  capture_key, capture_sha256, capture_bytes, preview_key, preview_sha256, preview_bytes, record_status, rotate_deg
FROM capture_images_hold;
--> statement-breakpoint
INSERT INTO capture_qc_sets (tenant_id, delivery_id, pipeline_volume_id, decisions_id, decided_at, revision,
  opening_count, decided_count, approved_count, rejected_count, excluded_count, notes_bytes, state, state_entered_at,
  write_id, carried_from)
SELECT tenant_id, delivery_id, pipeline_volume_id, decisions_id, decided_at, revision,
  opening_count, decided_count, approved_count, rejected_count, 0, notes_bytes, state, state_entered_at,
  write_id, carried_from
FROM capture_qc_sets_hold;
--> statement-breakpoint
INSERT INTO capture_qc_decisions (tenant_id, delivery_id, captua_record_id, decision, reason, note,
  decided_by, decided_by_name, decided_at, set_revision, side)
SELECT tenant_id, delivery_id, captua_record_id, decision, reason, note,
  decided_by, decided_by_name, decided_at, set_revision, side
FROM capture_qc_decisions_hold;
--> statement-breakpoint
INSERT INTO capture_qc_rotations (tenant_id, delivery_id, captua_record_id, capture_id, role, quarter_turns)
SELECT tenant_id, delivery_id, captua_record_id, capture_id, role, quarter_turns
FROM capture_qc_rotations_hold;
--> statement-breakpoint
DROP TABLE capture_qc_rotations_hold;
--> statement-breakpoint
DROP TABLE capture_qc_decisions_hold;
--> statement-breakpoint
DROP TABLE capture_qc_sets_hold;
--> statement-breakpoint
DROP TABLE capture_images_hold;
