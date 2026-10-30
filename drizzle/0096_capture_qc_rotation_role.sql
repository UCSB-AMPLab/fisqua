-- Capture QC: a rotation correction belongs to one image, named by its
-- capture id and its role together.
--
-- This migration ties a capture QC rotation correction to one image,
-- named by its capture id and its role together. In Captua a capture is
-- one trigger of the rig. A dual-camera capture writes two images, the
-- left (c0) and the right (c1), and both carry the same capture id; a
-- single-camera capture writes one image, whose role is `single`. An
-- image of a delivery is therefore identified by its Captua record, its
-- capture id and its role, and the two halves of a spread may need
-- different corrections.
--
-- `capture_qc_rotations` holds one row per corrected image, so its
-- primary key is (tenant_id, delivery_id, captua_record_id, capture_id,
-- role). SQLite cannot change a table's primary key in place, so the
-- table is rebuilt: a new table with the key, the same columns, CHECKs
-- and foreign key to the decision, every existing row copied across by
-- an explicit column list, the old table dropped and the new one
-- renamed. Every existing row keeps its place under the new key, which
-- is wider than the old one.
--
-- The table rebuilt here is the one 0094 created and 0095 rebuilt with
-- the same definition. The rebuild is safe inside D1's per-file
-- transaction because nothing references `capture_qc_rotations`: no
-- foreign key, trigger, view or index names it, so dropping the old
-- table fires no cascade. Its own
-- foreign key to `capture_qc_decisions` is unaffected by deleting rows
-- on its side.
--
-- Version: v0.8.0

CREATE TABLE capture_qc_rotations_new (
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
INSERT INTO capture_qc_rotations_new (tenant_id, delivery_id, captua_record_id, capture_id, role, quarter_turns)
  SELECT tenant_id, delivery_id, captua_record_id, capture_id, role, quarter_turns FROM capture_qc_rotations;
--> statement-breakpoint
DROP TABLE capture_qc_rotations;
--> statement-breakpoint
ALTER TABLE capture_qc_rotations_new RENAME TO capture_qc_rotations;
