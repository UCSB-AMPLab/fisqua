-- Media pipeline: review items and gate passes.
--
-- This migration adds two tables that record what people decided about
-- the pipeline's output.
--
-- `pipeline_review_items` holds one row per flag a run raised on a page
-- of a volume, at a stage, with a code and a summary. An open item has
-- no verdict; a verdict is accept, amend, or accept with a record. The
-- verdict attaches to the recipe that produced the output: each item
-- carries the declaration row (`declaration_id`), that row's version
-- (`declaration_version`, kept beside the id for display and audit) and
-- the runner's script version. A run raises a given flag on a given
-- page at most once.
--
-- `pipeline_gate_passes` records that one declaration row passed its
-- sample gate with one script version. Every `declaration_id` names one
-- declaration row, that is one version of a family, so a gate pass
-- covers exactly one version with one script version. Amending a
-- declaration inserts a new row, which needs a new gate pass.
-- `sample_run_id` carries no foreign key.
--
-- Version: v0.8.0

CREATE TABLE IF NOT EXISTS pipeline_review_items (
  id TEXT PRIMARY KEY NOT NULL,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  pipeline_volume_id TEXT NOT NULL REFERENCES pipeline_volumes(id) ON DELETE RESTRICT,
  run_id TEXT NOT NULL REFERENCES pipeline_runs(id) ON DELETE RESTRICT,
  page_key TEXT NOT NULL,
  stage TEXT NOT NULL CHECK (stage IN ('preprocess','render','ocr','tile')),
  code TEXT NOT NULL,
  summary TEXT NOT NULL,
  declaration_id TEXT NOT NULL,
  declaration_version INTEGER NOT NULL,
  script_version TEXT NOT NULL,
  verdict TEXT CHECK (verdict IS NULL OR verdict IN ('accept','amend','accept_with_record')),
  verdict_note TEXT,
  verdict_by TEXT REFERENCES users(id) ON DELETE RESTRICT,
  verdict_at INTEGER,
  created_at INTEGER NOT NULL,
  UNIQUE (run_id, pipeline_volume_id, page_key, stage, code)
);
CREATE INDEX IF NOT EXISTS pipeline_review_items_open_idx
  ON pipeline_review_items (tenant_id, pipeline_volume_id) WHERE verdict IS NULL;

CREATE TABLE IF NOT EXISTS pipeline_gate_passes (
  id TEXT PRIMARY KEY NOT NULL,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  declaration_id TEXT NOT NULL REFERENCES pipeline_recipe_declarations(id) ON DELETE RESTRICT,
  script_version TEXT NOT NULL,
  sample_run_id TEXT,
  passed_by TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  passed_at INTEGER NOT NULL,
  UNIQUE (declaration_id, script_version)
);
