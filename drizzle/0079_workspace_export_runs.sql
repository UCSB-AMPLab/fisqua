-- Workspace export runs: the ledger behind the self-service export
-- surface — what left the workspace, in what shape, and when.
--
-- WHY A SECOND TABLE AND NOT `export_runs`
-- ----------------------------------------
-- `export_runs` belongs to the PUBLISH pipeline. Its attribution root is
-- the federation (a lead publishes every member), it has no tenant
-- scoping column at all, and its lifecycle is a Cloudflare Workflow with
-- per-step heartbeats. A self-service export is the opposite animal on
-- every axis: it belongs to ONE workspace and ONE person, it runs inside
-- a request's waitUntil rather than a Workflow, and what it records is a
-- three-axis choice (what / form / format) that the publish pipeline has
-- no concept of. Widening the publish table to carry both would leave
-- every column nullable for one of the two readings, and would put a
-- tenant-scoped read on a table whose whole point is that it is not
-- tenant-scoped. So: a new table, and `export_runs` is not touched.
--
-- THE SCOPE IS RECORDED IN ITS OWN WORDS, NOT RE-RESOLVED
-- ------------------------------------------------------
-- `scope_descriptor` is JSON holding what the ledger row SAYS: a
-- branch's reference code and title chain, a carried scope's pills and
-- its arithmetic (found / unticked / total), a handlist's id and name.
-- It is display and re-run provenance, never a query to run again. A
-- history row must stay readable and honest after the branch is renamed,
-- the handlist is edited, or the carried scope is spent — "editing the
-- handlist later does not change a run already recorded" is the rule the
-- handlist card states, and a descriptor that had to be re-resolved
-- could not keep it.
--
-- `record_class` is what kind of thing the scope holds — records,
-- entities or places — in the vocabulary the search tabs and handlists
-- already use. It is load-bearing rather than cosmetic: an authority
-- scope reshapes both of the other axes (most descriptive standards
-- have nothing to say about a person, and a finding aid is not a thing
-- an authority file can be encoded as), and the legality matrix keys on
-- it. `include_authorities` is meaningless for an authority scope; the
-- surface renders it Not applicable and the column keeps its default.
--
-- FORM AND FORMAT ARE INDEPENDENT AXES
-- -----------------------------------
-- form is the descriptive shape (the three descriptive standards, Dublin
-- Core, or Fisqua's canonical round-trippable projection); format is the
-- serialisation. Dublin Core is a FORM, not a format — it is a
-- fifteen-element crosswalk that CSV and JSON can both carry. Which
-- pairs are legal lives in app/lib/export/matrix.ts, not in a CHECK
-- here: legality depends on the record class too, and a DB constraint
-- that only knew half the inputs would be a second, weaker copy of the
-- rule.
--
-- LIFECYCLE
-- ---------
-- status is running → completed | failed | cancelled. `stage` is a
-- machine code for the working line the dialog shows (descriptions →
-- authorities → the serialisation) and is deliberately unconstrained:
-- new formats add stages, and a CHECK here would make an emitter change
-- a migration. progress_done / progress_total drive "800 of 1,204
-- records". The three count columns are the consequence line the confirm
-- bar and the history row both restate.
--
-- `failure` is JSON {code, detail} rather than a message string, because
-- the failed dialog and the failed history row must say something
-- actionable in the workspace's own words and in the reader's own
-- language: "Two records share the reference code CMD-SR-0441" is a
-- code plus two titles, not a sentence to store in English.
--
-- The artifact lives in R2 under exports/<tenant_id>/<run_id>/<file>;
-- r2_key is nulled by the 30-day read-time sweep once the object is
-- deleted, which is what lets a history row survive its own file.
--
-- tenant_id and user_id both RESTRICT: a run is a record of what left
-- the workspace, and the ledger must outlive neither its workspace nor
-- the person who took it.
--
-- Version: v0.7.0

CREATE TABLE IF NOT EXISTS workspace_export_runs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  scope_kind TEXT NOT NULL CHECK (scope_kind IN ('workspace','branch','carried','handlist')),
  scope_descriptor TEXT NOT NULL DEFAULT '{}',
  record_class TEXT CHECK (record_class IS NULL OR record_class IN ('records','entities','places')),
  include_authorities INTEGER NOT NULL DEFAULT 1,
  form TEXT CHECK (form IS NULL OR form IN ('isadg','dacs','rad','dc','canonical')),
  format TEXT CHECK (format IS NULL OR format IN ('csv','ead-xml','json','pdf')),
  status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running','completed','failed','cancelled')),
  stage TEXT,
  progress_done INTEGER,
  progress_total INTEGER,
  count_records INTEGER,
  count_entities INTEGER,
  count_places INTEGER,
  file_name TEXT,
  file_size INTEGER,
  r2_key TEXT,
  failure TEXT,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  created_at INTEGER NOT NULL
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS workspace_export_runs_tenant_idx
  ON workspace_export_runs (tenant_id, created_at DESC);
