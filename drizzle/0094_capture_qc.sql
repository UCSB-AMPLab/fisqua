-- Capture QC: the decisions Fisqua makes on each opening a Captua unit
-- delivered, and who makes them.
--
-- This migration adds the tables for capture QC's decisions and for who
-- makes them. Capture QC looks again, in Fisqua, at what a unit's
-- operator reviewed on the device, as the Captua exchange contract
-- provides. The unit of decision is an opening, one Captua record:
-- approved, or rejected for retake with one reason. A reviewer may also
-- correct the rotation of individual images. A volume goes to
-- processing only when every opening of its current delivery is
-- approved. These four tables hold that.
--
-- `capture_qc_sets` is the decision set of one delivery (one capture
-- manifest), keyed by tenant and delivery. Decisions belong to the
-- delivery they were made on: a retake arrives as a new manifest, which
-- supersedes the older delivery, and the new delivery starts with no
-- set. A set row is written with its first decision. `decisions_id`
-- names the set as it stands and changes with every write to it, as
-- does `decided_at`; `revision` counts those writes from 1.
-- `opening_count` is the number of openings the delivery has, the
-- records `in_review` or `approved` in its manifest, which are the
-- records that became pages; it never changes, since a delivery's
-- records do not. `decided_count`, `approved_count` and
-- `rejected_count` are recounted from the decisions in the same batch
-- as every write, and `state` follows from them: `retakes_requested`
-- when any opening is rejected, `approved` when every one is approved,
-- `in_capture_qc` otherwise. `state_entered_at` is when the set last
-- changed state. `notes_bytes` is the bytes of every note of the set
-- together, recounted with the rest; its cap keeps the decisions answer
-- of a volume bounded, and a write past it fails whole. `write_id`
-- names the request that last wrote the set, so the request can tell
-- whether its batch landed.
--
-- `capture_qc_decisions` holds one decision per opening of a set, keyed
-- by the opening's Captua record id. `reason` is set exactly when the
-- opening is rejected; `note` is optional, except for `other`, and at
-- most 2,000 characters, the cap Captua puts on its own notes.
-- `decided_by` is the user who made the decision and `decided_by_name`
-- their display name at that time, which is what the unit is told.
-- Changing a decision replaces the row.
--
-- `capture_qc_rotations` holds the rotation corrections of a decision's
-- images, in quarter-turns clockwise, 1 to 3, one row per corrected
-- image (its capture id, with the role it has in the manifest). They
-- are stored for processing to apply; nothing applies them yet.
--
-- `capture_qc_reviewers` is the reviewer assigned to a pipeline volume
-- for capture QC, one per volume. It belongs to the volume, so it holds
-- across retakes. No row means no reviewer.
--
-- Every table carries its tenant, and every key and foreign key within
-- the module includes it.
--
-- Version: v0.8.0

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
  notes_bytes INTEGER NOT NULL DEFAULT 0 CHECK (notes_bytes <= 1000000),
  state TEXT NOT NULL CHECK (state IN ('in_capture_qc','retakes_requested','approved')),
  state_entered_at INTEGER NOT NULL,
  write_id TEXT NOT NULL,
  PRIMARY KEY (tenant_id, delivery_id),
  FOREIGN KEY (tenant_id, delivery_id) REFERENCES capture_deliveries(tenant_id, id) ON DELETE RESTRICT,
  CHECK (approved_count + rejected_count = decided_count AND decided_count <= opening_count)
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
  decision TEXT NOT NULL CHECK (decision IN ('approved','rejected')),
  reason TEXT CHECK (reason IS NULL OR reason IN ('blur','glare','shadow','focus','exposure','dirt','framing','obstruction','other')),
  note TEXT CHECK (note IS NULL OR length(note) BETWEEN 1 AND 2000),
  decided_by TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  decided_by_name TEXT NOT NULL CHECK (length(decided_by_name) BETWEEN 1 AND 256),
  decided_at INTEGER NOT NULL,
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
  PRIMARY KEY (tenant_id, delivery_id, captua_record_id, capture_id),
  FOREIGN KEY (tenant_id, delivery_id, captua_record_id)
    REFERENCES capture_qc_decisions(tenant_id, delivery_id, captua_record_id) ON DELETE RESTRICT
);
--> statement-breakpoint
CREATE TABLE capture_qc_reviewers (
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  pipeline_volume_id TEXT NOT NULL REFERENCES pipeline_volumes(id) ON DELETE RESTRICT,
  reviewer_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  assigned_by TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  assigned_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, pipeline_volume_id)
);
--> statement-breakpoint
CREATE INDEX capture_qc_reviewers_reviewer_idx ON capture_qc_reviewers (tenant_id, reviewer_id);
