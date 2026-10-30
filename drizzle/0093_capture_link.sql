-- Capture link: the scanners that deliver capture manifests, and what
-- they delivered.
--
-- This migration adds the tables for the scanners that deliver capture
-- manifests and for what they delivered. Under the Captua exchange
-- contract a Captua unit delivers its capture manifest to Fisqua itself
-- and follows each volume's status, with a bearer token of its own.
-- These two tables hold what that needs.
--
-- `capture_scanners` is one unit of a tenant. Only the SHA-256 of its
-- token is kept, as 64 lowercase hex characters; the token itself is
-- shown once, when the operator's command makes it, and is never
-- stored. `token_sha256` is null for a scanner without a token, and
-- unique where set (a null is not compared). `revoked_at` refuses the
-- token from the next call; the hash stays, so a revoked token is told
-- apart from an unknown one. `last_seen_at` is the time of the last
-- authenticated call. `rate_window_start` and `rate_window_calls` count
-- the calls of the current one-minute window, the contract's rate
-- limit. The unique index on `tenant_id` allows one scanner per tenant,
-- as ruled for now; several per tenant later means dropping that index,
-- not changing the table. `name` is the unit's short id, the one its
-- bucket keys are named with: lowercase letters, digits and hyphens, 1
-- to 32 characters.
--
-- `capture_deliveries` holds one row per manifest id a tenant's scanner
-- delivered, keyed by tenant and the manifest's envelope `id`.
-- `body_sha256` is the SHA-256 of the parsed body in canonical form
-- (object keys sorted, no whitespace), since bodies are compared as
-- parsed JSON and not as bytes. `answer_status` and `answer_body` are
-- the answer given, returned verbatim when the same id comes again.
-- `answer_body`, `problems` and `records` past 64 KiB are kept as
-- `{"$gzip": "<base64>"}`, the JSON gzipped, so a row of a large volume
-- (a refusal naming every missing object, a registration noting
-- thousands of earlier objects left in the bucket) stays under D1's
-- 2 MB row limit; an answer is still returned byte for byte. A refusal's problems are kept only in
-- its answer; `problems` holds what an accepted delivery's
-- registration reported without refusing it.
-- `state` is `registered` once the manifest's volume holds it,
-- `refused` when a check failed (it then holds nothing), and
-- `superseded` once a newer manifest for the same volume replaced it
-- before any run started; `superseded_by` and `superseded_at` say by
-- which and when. `received` is the state of a row written before its
-- checks complete. `problems` is a JSON array of `{rule, message, ...}`:
-- why a manifest was refused, or what its registration reported without
-- refusing it. `records` is the accepted manifest's openings as a JSON
-- array (record id, sequence, status), which the QC
-- decisions of the link's second phase are
-- made against; it is null for a refused manifest. `seq` numbers the
-- tenant's deliveries in the order they were committed, taken inside
-- the statement that writes the row: `received_at` is when a request
-- arrived, before the masters bucket was listed, so two deliveries can
-- commit in the other order. At most one delivery per volume is
-- `registered` (`capture_deliveries_holder_idx`): it is the one that
-- holds the volume, and each accepted delivery supersedes the others in
-- the same batch.
--
-- `write_id` names the request that wrote an accepted delivery; its
-- images are written in the same batch only under the row that batch
-- wrote, so two copies of one manifest id accepted at once cannot add
-- their images to the same delivery. It is null on a refusal.
--
-- `capture_images` holds every image of an accepted manifest, whatever
-- its record's status, with every object it names: the capture as shot
-- (the RAW on a RAW rig, which Fisqua keeps track of for preservation
-- and never processes) and the preview extracted from it where there is
-- one, each by its full key in the masters bucket, with the digest the
-- manifest gives and the size the masters listing gave. The size is
-- nullable, though a manifest naming an object the bucket does not hold
-- is refused, so an accepted one always has it. `page_key` joins an image to its pipeline page
-- and `captua_record_id` to its opening in `records`; per-image QC
-- rotations of the link's second phase attach here.
--
-- `pipeline_volumes.pages_revision` is raised by every write that
-- replaces a volume's page list: a manifest delivered over the link, or
-- the registration command. Dispatch reads it with the pages it builds a
-- run's spec from and claims the volume only while it is unchanged, so a
-- manifest that replaces the pages between the read and the claim makes
-- the claim fail rather than send the runner the older pages. Every
-- existing row starts at 0.
--
-- Version: v0.8.0

ALTER TABLE pipeline_volumes ADD COLUMN pages_revision INTEGER NOT NULL DEFAULT 0;
--> statement-breakpoint

CREATE TABLE capture_scanners (
  id TEXT PRIMARY KEY NOT NULL,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 32 AND name NOT GLOB '*[^a-z0-9-]*'),
  token_sha256 TEXT CHECK (token_sha256 IS NULL OR (length(token_sha256) = 64 AND token_sha256 NOT GLOB '*[^0-9a-f]*')),
  token_created_at INTEGER,
  last_seen_at INTEGER,
  revoked_at INTEGER,
  rate_window_start INTEGER,
  rate_window_calls INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (token_sha256 IS NOT NULL OR revoked_at IS NULL)
);
--> statement-breakpoint
CREATE UNIQUE INDEX capture_scanners_tenant_idx ON capture_scanners (tenant_id);
--> statement-breakpoint
CREATE UNIQUE INDEX capture_scanners_token_idx ON capture_scanners (token_sha256);
--> statement-breakpoint
CREATE TABLE capture_deliveries (
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  id TEXT NOT NULL,
  scanner_id TEXT NOT NULL REFERENCES capture_scanners(id) ON DELETE RESTRICT,
  reference_code TEXT,
  pipeline_volume_id TEXT REFERENCES pipeline_volumes(id) ON DELETE RESTRICT,
  body_sha256 TEXT NOT NULL CHECK (length(body_sha256) = 64 AND body_sha256 NOT GLOB '*[^0-9a-f]*'),
  state TEXT NOT NULL CHECK (state IN ('received','registered','refused','superseded')),
  problems TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(problems)),
  answer_status INTEGER NOT NULL,
  answer_body TEXT NOT NULL CHECK (json_valid(answer_body)),
  records TEXT CHECK (records IS NULL OR json_valid(records)),
  received_at INTEGER NOT NULL,
  superseded_by TEXT,
  superseded_at INTEGER,
  seq INTEGER NOT NULL,
  write_id TEXT,
  PRIMARY KEY (tenant_id, id),
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
