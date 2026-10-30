-- Capture QC: approvals carried across a retake, and the unit's fetches
-- of a decision set.
--
-- This migration records the approvals carried across a retake and the
-- unit's fetches of a decision set. A retake arrives as a new delivery
-- that supersedes the older one. Each opening of the new delivery whose
-- images are the older delivery's (the same capture ids, roles and
-- sha256 digests) keeps the approval it had there, with its rotations,
-- its decider and its time; only openings with new or changed images are
-- reviewed again. The registration batch writes that carried set.
-- `capture_qc_sets.carried_from` names the delivery a set's approvals
-- were carried from, and is null for a set written by a reviewer from
-- nothing. A set keeps the value through later writes, so the queue can
-- tell the openings still to review on a retake from a first review.
--
-- The comparison reads only the images of each delivery's openings
-- (records `in_review` or `approved`), so `capture_images` gains
-- `record_status`, the status of the image's record in the manifest.
-- Existing rows take it from their delivery's records where those are
-- stored as plain JSON and name the record id once; rows of packed
-- records, or of a record id the manifest repeats, keep null. An image
-- with a null status is never compared, so no approval is carried from
-- or to it.
--
-- `capture_qc_decisions.set_revision` is the set's revision as of the
-- write that last wrote the decision. A set's revision is counted inside
-- each write's batch, so revisions follow the order in which writes
-- commit, which the clock read before a batch does not. Existing
-- decisions take their set's current revision.
--
-- `capture_qc_fetches` records each decision set the unit read from the
-- decisions endpoint, one row per `decisions_id`, with the revision it
-- was answered at (`set_revision`), when the unit first read it and when
-- it last did. A rejection has reached the unit once a fetch of its
-- delivery answered a revision at or after the rejection's own; the
-- Retakes screen shows such an opening as sent to the scanner.
--
-- `capture_images_record_idx` serves the comparison of an opening's
-- images between two deliveries, which reads them by record.
--
-- Every table carries its tenant, and every key and foreign key within
-- the module includes it.
--
-- Version: v0.8.0

ALTER TABLE capture_qc_sets ADD COLUMN carried_from TEXT;
--> statement-breakpoint
ALTER TABLE capture_images ADD COLUMN record_status TEXT
  CHECK (record_status IS NULL OR record_status IN ('captured','in_review','approved','rejected'));
--> statement-breakpoint
UPDATE capture_images SET record_status = (
  SELECT json_extract(r.value, '$.status')
  FROM capture_deliveries d,
    json_each(CASE WHEN json_type(d.records) = 'array' THEN d.records ELSE '[]' END) r
  WHERE d.tenant_id = capture_images.tenant_id AND d.id = capture_images.delivery_id
    AND json_extract(r.value, '$.captuaRecordId') = capture_images.captua_record_id)
WHERE (
  SELECT COUNT(*)
  FROM capture_deliveries d,
    json_each(CASE WHEN json_type(d.records) = 'array' THEN d.records ELSE '[]' END) r
  WHERE d.tenant_id = capture_images.tenant_id AND d.id = capture_images.delivery_id
    AND json_extract(r.value, '$.captuaRecordId') = capture_images.captua_record_id) = 1;
--> statement-breakpoint
ALTER TABLE capture_qc_decisions ADD COLUMN set_revision INTEGER NOT NULL DEFAULT 0;
--> statement-breakpoint
UPDATE capture_qc_decisions SET set_revision = (
  SELECT s.revision FROM capture_qc_sets s
  WHERE s.tenant_id = capture_qc_decisions.tenant_id AND s.delivery_id = capture_qc_decisions.delivery_id);
--> statement-breakpoint
CREATE TABLE capture_qc_fetches (
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  delivery_id TEXT NOT NULL,
  decisions_id TEXT NOT NULL,
  set_revision INTEGER NOT NULL,
  first_fetched_at INTEGER NOT NULL,
  last_fetched_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, decisions_id),
  FOREIGN KEY (tenant_id, delivery_id) REFERENCES capture_deliveries(tenant_id, id) ON DELETE RESTRICT,
  CHECK (last_fetched_at >= first_fetched_at)
);
--> statement-breakpoint
CREATE INDEX capture_qc_fetches_delivery_idx ON capture_qc_fetches (tenant_id, delivery_id, set_revision);
--> statement-breakpoint
CREATE INDEX capture_images_record_idx ON capture_images (tenant_id, delivery_id, captua_record_id);
