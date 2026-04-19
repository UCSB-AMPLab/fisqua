-- One-time wipe of project-scoped data
--
-- Resets every row in the project-scoped tables so the app can switch
-- from 36-character UUID project identifiers to the shorter
-- 8-character alphanumeric identifiers produced by
-- `generateProjectId` in `app/lib/projects.server.ts`. The testing
-- site only ever held throwaway cataloguing data, so rather than
-- building a backfill that rewrites every foreign-key reference to
-- the new id shape, this migration wipes the lot and lets new
-- projects come in under the short-id format.
--
-- Delete order matters. Child tables go first so that foreign-key
-- references never dangle while a parent row is still present.
-- `activity_log` has to be cleared before `volumes` and `projects`
-- because it references both; the WHERE clause keeps non-project
-- activity rows intact.
--
-- Version: v0.3.0

DELETE FROM comments;
DELETE FROM resegmentation_flags;
DELETE FROM entries;
DELETE FROM volume_pages;
DELETE FROM activity_log WHERE project_id IS NOT NULL OR volume_id IS NOT NULL;
DELETE FROM volumes;
DELETE FROM project_invites;
DELETE FROM project_members;
DELETE FROM projects;
