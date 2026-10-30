-- Media pipeline: recipe declarations, pipeline volumes and their pages.
--
-- This migration adds three tables that describe what the media pipeline
-- works on, before any run exists.
--
-- `pipeline_recipe_declarations` holds the processing recipe a
-- collection declares: platen, background, output class, OCR and its
-- language, tone preset and advanced parameters. A declaration family
-- is the set of rows sharing one (tenant_id, scope_description_id). A
-- row is immutable: amending a declaration inserts `version + 1` in the
-- same family. OCR is allowed only on bilevel output, and needs a
-- language.
--
-- `pipeline_volumes` is a third volume-shaped table. It alters neither
-- `descriptions` nor `volumes`; it holds a unit's production state
-- (received, prepared, ready, published), where its masters live, how
-- many images are expected, and which recipe family it belongs to.
-- `reference_code` is copied when the volume is registered and read
-- verbatim by the spec builder, never re-derived. The tile root is the
-- reference code, so no separate tile root is stored before a run;
-- `current_tile_root` records the root a callback reported.
-- `recipe_scope_description_id` links the volume to its declaration
-- family, set at registration. No volume row changes when a
-- declaration is amended: a run resolves the family's latest version
-- when it is dispatched and records that exact row on the run volume.
-- `restricted` is set from the description's access conditions each
-- time a run is requested, and a flagged volume never enters a spec.
-- A volume run reads a prefix of master images; an item PDF reads one
-- master object. `last_run_id` and `held_by_run_id` carry no foreign
-- key, so this migration does not depend on the runs table.
-- `held_by_run_id` names the run that last claimed the volume; whether
-- that run still holds it is decided from the run row at the time of
-- asking, so a stale value never needs clearing.
--
-- `pipeline_volume_pages` holds the canonical page key for every page,
-- written at registration and supplied to the runner explicitly, so no
-- stage derives a page key. A page row names either the master object
-- (`master_key`, a volume run) or the page of the item's PDF
-- (`pdf_page`, an item PDF), never both. The `page_key` CHECK states
-- the run spec's page-key pattern, ^[A-Za-z0-9_-][A-Za-z0-9._-]*$, in
-- SQLite's GLOB form. Which of the two page kinds a volume may hold
-- depends on the volume's kind, which a CHECK cannot read across
-- tables; the spec checks enforce it before any run is written.
--
-- Version: v0.8.0

CREATE TABLE IF NOT EXISTS pipeline_recipe_declarations (
  id TEXT PRIMARY KEY NOT NULL,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  scope_description_id TEXT NOT NULL REFERENCES descriptions(id) ON DELETE RESTRICT,
  version INTEGER NOT NULL CHECK (version >= 1),
  platen TEXT NOT NULL CHECK (platen IN ('v','none')),
  background TEXT NOT NULL CHECK (background IN ('dark','light')),
  output_class TEXT NOT NULL CHECK (output_class IN ('tonal','bilevel')),
  ocr INTEGER NOT NULL DEFAULT 0,
  ocr_lang TEXT,
  tone_preset TEXT NOT NULL,
  advanced_params TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(advanced_params)),
  created_by TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at INTEGER NOT NULL,
  CHECK (ocr = 0 OR output_class = 'bilevel'),
  CHECK (ocr = 0 OR ocr_lang IS NOT NULL),
  UNIQUE (tenant_id, scope_description_id, version)
);

CREATE TABLE IF NOT EXISTS pipeline_volumes (
  id TEXT PRIMARY KEY NOT NULL,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  description_id TEXT NOT NULL REFERENCES descriptions(id) ON DELETE RESTRICT,
  reference_code TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('volume_run','item_pdf')),
  state TEXT NOT NULL DEFAULT 'received' CHECK (state IN ('received','prepared','ready','published')),
  masters_backend TEXT NOT NULL CHECK (masters_backend IN ('b2','r2')),
  masters_endpoint TEXT NOT NULL,
  masters_bucket TEXT NOT NULL,
  masters_prefix TEXT,
  masters_key TEXT,
  checksums_key TEXT,
  expected_count INTEGER NOT NULL CHECK (expected_count >= 1),
  recipe_scope_description_id TEXT NOT NULL REFERENCES descriptions(id) ON DELETE RESTRICT,
  restricted INTEGER NOT NULL DEFAULT 0 CHECK (restricted IN (0,1)),
  restriction_checked_at INTEGER,
  current_tile_root TEXT,
  open_review_count INTEGER NOT NULL DEFAULT 0,
  last_run_id TEXT,
  held_by_run_id TEXT,
  last_error TEXT CHECK (last_error IS NULL OR json_valid(last_error)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK ((kind = 'volume_run' AND masters_prefix IS NOT NULL AND masters_key IS NULL)
      OR (kind = 'item_pdf'   AND masters_key IS NOT NULL AND masters_prefix IS NULL)),
  UNIQUE (tenant_id, reference_code),
  UNIQUE (tenant_id, description_id)
);
CREATE INDEX IF NOT EXISTS pipeline_volumes_state_idx ON pipeline_volumes (tenant_id, state);
CREATE INDEX IF NOT EXISTS pipeline_volumes_held_idx ON pipeline_volumes (tenant_id, held_by_run_id);

CREATE TABLE IF NOT EXISTS pipeline_volume_pages (
  id TEXT PRIMARY KEY NOT NULL,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  pipeline_volume_id TEXT NOT NULL REFERENCES pipeline_volumes(id) ON DELETE RESTRICT,
  seq INTEGER NOT NULL CHECK (seq >= 1),
  page_key TEXT NOT NULL CHECK (
    length(page_key) > 0
    AND substr(page_key, 1, 1) GLOB '[A-Za-z0-9_-]'
    AND page_key NOT GLOB '*[^A-Za-z0-9._-]*'),
  master_key TEXT CHECK (master_key IS NULL OR length(master_key) > 0),
  pdf_page INTEGER CHECK (pdf_page IS NULL OR pdf_page >= 1),
  CHECK ((master_key IS NOT NULL AND pdf_page IS NULL)
      OR (master_key IS NULL AND pdf_page IS NOT NULL)),
  UNIQUE (pipeline_volume_id, seq),
  UNIQUE (pipeline_volume_id, page_key)
);
