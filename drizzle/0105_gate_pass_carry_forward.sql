-- Media pipeline: gate passes carried forward to runner v1.1.0.
--
-- A gate pass records that one recipe declaration passed its sample
-- gate with one script version (0084), and a wave needs a pass for the
-- exact declaration and the script version the deployment pins. Runner
-- v1.1.0 processes an unrotated page exactly as v1.0.0 did, and turns a
-- rotated page upright before the recipe's first stage, so a pass won on
-- v1.0.0 holds for v1.1.0. This migration records that, without anyone
-- passing the gate again:
--
--   - `pipeline_gate_passes.note` says why a pass exists when no sample
--     run won it; null for a pass won by its own sample run.
--   - `pipeline_gate_passes.carried_from` names the pass a carried pass
--     was copied from, by its id, so the pass, its sample run and who
--     passed it can be followed back; null for a pass won directly.
--
-- Every pass on v1.0.0 is then copied to v1.1.0, keeping its declaration,
-- tenant, sample run, `passed_by` and `passed_at`, with a new id, the
-- note below, and `carried_from` the original's id. The copy is
-- `INSERT OR IGNORE` on UNIQUE (declaration_id, script_version), so a
-- declaration that already has a v1.1.0 pass keeps it. A deployment
-- that still pins v1.0.0 (production until its own move) gains v1.1.0
-- rows that nothing reads until it pins v1.1.0. A pass won on v1.0.0
-- after this migration ran is copied by the operator command
-- `carry-gate-passes`, which runs the same statement and is run on each
-- environment's move to v1.1.0.
--
-- Version: v0.8.0

ALTER TABLE pipeline_gate_passes ADD COLUMN note TEXT;
--> statement-breakpoint
ALTER TABLE pipeline_gate_passes ADD COLUMN carried_from TEXT;
--> statement-breakpoint
INSERT OR IGNORE INTO pipeline_gate_passes
  (id, tenant_id, declaration_id, script_version, sample_run_id, passed_by, passed_at, note, carried_from)
SELECT
  lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' || substr(hex(randomblob(2)), 2) || '-'
    || substr('89ab', 1 + (abs(random()) % 4), 1) || substr(hex(randomblob(2)), 2) || '-' || hex(randomblob(6))),
  tenant_id, declaration_id, 'v1.1.0', sample_run_id, passed_by, passed_at,
  'Carried forward from v1.0.0. Unrotated pages are processed unchanged; a rotated page is turned upright before the recipe''s first stage.',
  id
FROM pipeline_gate_passes
WHERE script_version = 'v1.0.0';
