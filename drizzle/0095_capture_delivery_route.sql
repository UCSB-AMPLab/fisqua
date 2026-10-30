-- Capture deliveries by route: the link, or a manifest file.
--
-- This migration records the route each capture delivery came by. A
-- capture manifest reaches Fisqua by one of two routes: a Captua unit
-- delivers it over the link with its token, or an operator registers it
-- from a file with the registration command, for a unit without a
-- token. Both record a delivery, so a volume from either route goes
-- through capture QC and is held from processing until every opening is
-- approved.
--
-- `capture_deliveries.route` says which: `link` or `file`. A link
-- delivery names the scanner that sent it; a file delivery has no
-- scanner, so `scanner_id` becomes nullable, and a CHECK keeps the two
-- columns in step. Every existing row came over the link and is
-- written as `link`.
--
-- `capture_deliveries.openings` is the number of openings an accepted
-- manifest has, its records `in_review` or `approved`, the ones capture
-- QC decides; 0 for a refusal. The processing hold reads it: a delivery
-- with no openings does not hold its volume. It is a column because
-- `records` past 64 KiB is stored packed (`{"$gzip": ...}`), which SQL
-- cannot read. Existing rows are counted from their records where SQL
-- can read them, and a refusal (no records) gets 0. A packed row gets 1,
-- since its records cannot be counted here: it holds as it held before
-- this migration, until a newer delivery replaces it.
--
-- SQLite cannot drop a NOT NULL in place, so the table is rebuilt.
-- `capture_images` and `capture_qc_sets` reference it with ON DELETE
-- RESTRICT, which acts at once and is not deferred by
-- `defer_foreign_keys`, so dropping the table under populated children
-- would fail. The children are therefore rebuilt with it: every table of
-- the module that references a delivery, directly or through another
-- (`capture_images`, `capture_qc_sets`, `capture_qc_decisions`,
-- `capture_qc_rotations`), is copied to a plain holding table, dropped
-- child first, created again with its definition from 0093 and 0094
-- unchanged, parent first, filled from its holding table with explicit
-- column lists, and the holding tables are dropped. Every index is
-- created again under its own name. `capture_qc_reviewers` references no
-- delivery and is left alone. The file runs as one D1 transaction, so a
-- failure leaves the tables as they were.
--
-- Version: v0.8.0

CREATE TABLE capture_deliveries_hold AS SELECT * FROM capture_deliveries;
--> statement-breakpoint
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
DROP TABLE capture_deliveries;
--> statement-breakpoint
CREATE TABLE capture_deliveries (
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  id TEXT NOT NULL,
  route TEXT NOT NULL CHECK (route IN ('link','file')),
  scanner_id TEXT REFERENCES capture_scanners(id) ON DELETE RESTRICT,
  reference_code TEXT,
  pipeline_volume_id TEXT REFERENCES pipeline_volumes(id) ON DELETE RESTRICT,
  body_sha256 TEXT NOT NULL CHECK (length(body_sha256) = 64 AND body_sha256 NOT GLOB '*[^0-9a-f]*'),
  state TEXT NOT NULL CHECK (state IN ('received','registered','refused','superseded')),
  problems TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(problems)),
  answer_status INTEGER NOT NULL,
  answer_body TEXT NOT NULL CHECK (json_valid(answer_body)),
  records TEXT CHECK (records IS NULL OR json_valid(records)),
  openings INTEGER NOT NULL CHECK (openings >= 0),
  received_at INTEGER NOT NULL,
  superseded_by TEXT,
  superseded_at INTEGER,
  seq INTEGER NOT NULL,
  write_id TEXT,
  PRIMARY KEY (tenant_id, id),
  CHECK ((route = 'link') = (scanner_id IS NOT NULL)),
  CHECK ((state = 'superseded') = (superseded_by IS NOT NULL)),
  CHECK (state NOT IN ('registered','superseded') OR pipeline_volume_id IS NOT NULL)
);
--> statement-breakpoint
CREATE INDEX capture_deliveries_ref_idx ON capture_deliveries (tenant_id, reference_code, received_at);
--> statement-breakpoint
CREATE UNIQUE INDEX capture_deliveries_seq_idx ON capture_deliveries (tenant_id, seq);
--> statement-breakpoint
CREATE UNIQUE INDEX capture_deliveries_holder_idx ON capture_deliveries (tenant_id, pipeline_volume_id)
  WHERE state = 'registered';
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
  FOREIGN KEY (tenant_id, delivery_id) REFERENCES capture_deliveries(tenant_id, id) ON DELETE RESTRICT,
  CHECK ((preview_key IS NULL) = (preview_sha256 IS NULL))
);
--> statement-breakpoint
CREATE INDEX capture_images_delivery_idx ON capture_images (tenant_id, delivery_id);
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
INSERT INTO capture_deliveries (tenant_id, id, route, scanner_id, reference_code, pipeline_volume_id, body_sha256,
  state, problems, answer_status, answer_body, records, openings, received_at, superseded_by, superseded_at, seq, write_id)
SELECT tenant_id, id, 'link', scanner_id, reference_code, pipeline_volume_id, body_sha256,
  state, problems, answer_status, answer_body, records,
  CASE
    WHEN records IS NULL THEN 0
    WHEN json_type(records) = 'object' THEN 1
    ELSE (SELECT COUNT(*) FROM json_each(records) r WHERE json_extract(r.value, '$.status') IN ('in_review', 'approved'))
  END,
  received_at, superseded_by, superseded_at, seq, write_id
FROM capture_deliveries_hold;
--> statement-breakpoint
INSERT INTO capture_images (id, tenant_id, delivery_id, captua_record_id, capture_id, pair_id, role, page_key,
  capture_key, capture_sha256, capture_bytes, preview_key, preview_sha256, preview_bytes)
SELECT id, tenant_id, delivery_id, captua_record_id, capture_id, pair_id, role, page_key,
  capture_key, capture_sha256, capture_bytes, preview_key, preview_sha256, preview_bytes
FROM capture_images_hold;
--> statement-breakpoint
INSERT INTO capture_qc_sets (tenant_id, delivery_id, pipeline_volume_id, decisions_id, decided_at, revision,
  opening_count, decided_count, approved_count, rejected_count, notes_bytes, state, state_entered_at, write_id)
SELECT tenant_id, delivery_id, pipeline_volume_id, decisions_id, decided_at, revision,
  opening_count, decided_count, approved_count, rejected_count, notes_bytes, state, state_entered_at, write_id
FROM capture_qc_sets_hold;
--> statement-breakpoint
INSERT INTO capture_qc_decisions (tenant_id, delivery_id, captua_record_id, decision, reason, note,
  decided_by, decided_by_name, decided_at)
SELECT tenant_id, delivery_id, captua_record_id, decision, reason, note,
  decided_by, decided_by_name, decided_at
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
--> statement-breakpoint
DROP TABLE capture_deliveries_hold;
