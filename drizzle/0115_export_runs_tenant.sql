-- The workspace of a publish run.
--
-- This migration adds `tenant_id` to `export_runs`: the workspace the
-- publish was started in, which api.publish takes from the request
-- tenant when it inserts the run. Every reader of the runs (the
-- workflow's load-config, the in-flight guard and polling in
-- api.publish, the publish page, the run detail page and the publish
-- counts) scopes on this column. A platform admin's row is stored in
-- one workspace and publishes from others, so the triggering user's
-- stored workspace does not say where a run belongs.
--
-- Existing runs take the stored workspace of the user who triggered
-- them, which is what the readers scoped on until now. The column is
-- nullable at the database layer, as a run row is never written
-- without one by the app.
--
-- Version: v0.9.0
ALTER TABLE export_runs ADD COLUMN tenant_id TEXT REFERENCES tenants(id);
--> statement-breakpoint
UPDATE export_runs SET tenant_id = (SELECT tenant_id FROM users WHERE users.id = export_runs.triggered_by);
