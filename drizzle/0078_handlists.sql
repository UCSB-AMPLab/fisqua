-- Handlists: an ordered, named, persistent set of references a person
-- keeps and works from (the handlist model ruled in the workspace
-- repo's exports-handlists design handoff, 2026-08-15).
--
-- WHAT A HANDLIST IS
-- ------------------
-- The archival term is exact and it carries the rule: a handlist is a
-- brief working enumeration of holdings, true of its material at the
-- moment it was drawn up. So this is a SNAPSHOT, not a saved search --
-- it holds the members it holds and never grows on its own -- and it
-- REFERENCES rather than contains: removing a member touches no record,
-- deleting a handlist affects none.
--
-- TYPED, AND THE TYPE IS LOAD-BEARING
-- -----------------------------------
-- record_type is one of records / entities / places, in the vocabulary
-- the search tabs use ('records' for descriptions), and it is what makes
-- a handlist a coherent export scope: an authority handlist exports
-- differently from a handlist of records, and a mixed one would have no
-- single form or format at all. It is NULL until the first member
-- arrives and immutable afterwards -- the app fixes it on the first add,
-- which is why the CHECK admits NULL rather than the column being NOT
-- NULL with a placeholder value.
--
-- OWNERSHIP AND SCOPE
-- -------------------
-- A handlist belongs to one person inside one workspace. tenant_id is
-- RESTRICT for the reason every tenant FK is. owner_id is RESTRICT
-- rather than CASCADE on purpose: a person leaving the team must not
-- take their colleagues' shared working sets with them, so the delete is
-- blocked until ownership is transferred -- which is the whole reason
-- ownership transfer exists in the surface.
--
-- workspace_visible is the third visibility arm beside owner and share:
-- a handlist anyone in the workspace may open, without naming them one
-- by one.
--
-- MEMBERS
-- -------
-- member_id carries NO foreign key. record_type spans three tables
-- (descriptions, entities, places), which SQLite cannot express as one
-- constraint, and the polymorphic shape is precedent in
-- external_authority_links (0076) and carried_scopes (0077). The absence
-- is also semantic: a member that has been deleted from the workspace
-- must stay in the handlist as a tombstone -- shown, uncounted for
-- export -- because the governing rule of the model is that a handlist
-- may never lie about its count. An FK would silently drop the row and
-- with it the truth about what was gathered.
--
-- position is explicit rather than derived from created_at, because the
-- order is carried into the exported artifact and a person may drag it
-- into whatever sequence they mean to read. created_at is kept beside it
-- as the arrival stamp, and it is what the integrity read compares an
-- authority split against: an operation later than the membership is a
-- change UNDER the handlist, one earlier is simply history.
--
-- UNIQUE (handlist_id, member_id) is what makes a repeat add a no-op:
-- bulk adds overlap constantly, and a member counted twice would corrupt
-- every count downstream.
--
-- SHARES
-- ------
-- viewer reads; editor adds, removes and reorders. The owner alone
-- renames, shares, deletes and transfers. Both FKs are CASCADE: a share
-- is meaningless once its handlist or its person is gone, and nothing
-- references it. Sharing conveys no module access and no export right --
-- that stays a workspace-level grant.
--
-- Version: v0.7.0

CREATE TABLE IF NOT EXISTS handlists (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  name TEXT NOT NULL,
  description TEXT,
  record_type TEXT CHECK (record_type IS NULL OR record_type IN ('records','entities','places')),
  workspace_visible INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS handlists_owner_idx
  ON handlists (tenant_id, owner_id);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS handlist_members (
  id TEXT PRIMARY KEY,
  handlist_id TEXT NOT NULL REFERENCES handlists(id) ON DELETE CASCADE,
  member_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  added_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL
);
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS handlist_members_member_idx
  ON handlist_members (handlist_id, member_id);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS handlist_members_position_idx
  ON handlist_members (handlist_id, position);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS handlist_shares (
  id TEXT PRIMARY KEY,
  handlist_id TEXT NOT NULL REFERENCES handlists(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('viewer','editor')),
  created_at INTEGER NOT NULL
);
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS handlist_shares_user_idx
  ON handlist_shares (handlist_id, user_id);
