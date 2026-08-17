/**
 * Handlists — the working sets a person keeps
 *
 * This module owns everything a handlist does on the server: making
 * one, naming it, filling it, ordering it, sharing it, handing it on,
 * and — the part with all the difficulty in it — telling the truth
 * about what it still holds.
 *
 * WHAT A HANDLIST IS. An ordered, named, persistent set of REFERENCES,
 * owned by one person inside one workspace and holding one kind of
 * thing. The archival word is exact and it carries the governing rule:
 * a handlist is true of its material at the moment it was drawn up. So
 * it is a SNAPSHOT — it never grows on its own, and nothing here
 * re-runs the search that built it — and it references rather than
 * contains: `removeMember` touches no record and `deleteHandlist`
 * affects none.
 *
 * TYPED, BY ITS FIRST MEMBER. `recordType` is one of records /
 * entities / places, in the vocabulary the search tabs use ('records'
 * for descriptions). It is NULL until the first add and immutable
 * afterwards, because a mixed handlist has no single export scope,
 * form or format. Member ids are polymorphic, so every add says what
 * kind of thing it is adding rather than leaving this module to guess;
 * an add whose type disagrees with a fixed one is a 400, which is what
 * keeps the add menu (which only offers matching handlists) and the
 * server saying the same thing.
 *
 * WHO MAY SEE IT. Owner, sharee, or workspace-visible — and always
 * inside the tenant, written into the SAME statement as the read, so
 * the boundary is visible at the point of the read rather than in a
 * later filter. An absent handlist, another workspace's, and one this
 * person may not see are all the same 404: a different status would
 * answer a question nobody is entitled to ask.
 *
 * WHO MAY CHANGE IT. viewer reads; editor adds, removes and reorders;
 * the OWNER alone renames, shares, sets workspace visibility and
 * deletes. Ownership transfer is the owner's or a tenant admin's —
 * people leave teams, and `handlists.owner_id` RESTRICTs precisely so
 * that a departure has to be handled rather than silently cascading
 * someone's shared working sets away.
 *
 * THE ADMIN GATE ON AUTHORITY HANDLISTS. Entities and places live
 * behind `requireAdmin` on their own surfaces, so a handlist of them is
 * openable only by an admin — the same helper, not a second permission
 * system. Two consequences the surfaces depend on. A share with a
 * non-admin is REFUSED with a 400 naming the reason, so the dialog's
 * dimming and the server agree rather than the dialog merely being
 * polite. And a handlist someone was shared before losing the flag is
 * still LISTED for them, carrying `locked`, never silently absent —
 * residue is explained, not hidden.
 *
 * COUNTS MAY NOT LIE. `getWithMembers` resolves every member against
 * the workspace as it is now, at READ time and never stored:
 *
 *   - merged away (entities/places) → the chain to the survivor is
 *     followed and the row notes it; if the survivor is already a
 *     member the two collapse into one and the count visibly drops;
 *   - split → the row cannot be chosen for, so it is flagged for
 *     review with its successors offered, detected against the
 *     `authority_operations` ledger for an operation LATER than the
 *     membership's own stamp (an earlier one is history, not drift);
 *   - deleted from the workspace → a tombstone row, shown but left out
 *     of the exportable count;
 *   - anything else — edited, re-described, moved in the hierarchy —
 *     is no change at all, because membership is not positional.
 *
 * RECORDS DRIFT ONLY ONE WAY. Descriptions carry no `merged_into`
 * column and the authority ledger's `record_type` admits only entity,
 * place and vocabulary_term — so a records-typed handlist can only ever
 * meet the tombstone case, and its integrity read is a single left
 * join rather than a chain walk.
 *
 * REVIEW IS RESOLVED BY MOVING THE MEMBERSHIP, NOT BY STORING A FLAG.
 * Since drift is computed rather than stored, a review clears by
 * changing what the membership says: acknowledging a merge repoints the
 * row at the survivor (or drops it, when the survivor is already in),
 * and resolving a split re-stamps the membership so the ledger entry is
 * no longer later than it, adding whichever successors were kept. The
 * cost is that `created_at` becomes the review stamp rather than the
 * original arrival — deliberate, and the honest reading of a row that
 * has just been re-affirmed against the workspace.
 *
 * THE CEILING IS A DESIGN INTENT. Past a few thousand members a
 * handlist is a worse way of saying "the whole collection": adds warn
 * past HANDLIST_WARN_MEMBERS and are refused past HANDLIST_MAX_MEMBERS
 * with a 400 that names the number and points at a branch or the
 * workspace scope instead.
 *
 * NO ID LISTS TRAVEL AS BINDINGS. Every read keys on the handlist id —
 * one binding — and joins `handlist_members` rather than inlining
 * member ids, so a ten-thousand-member handlist reads in the same
 * number of parameters as an empty one. Writes chunk under D1's
 * hundred-binding cap.
 *
 * @version v0.7.0
 */

import { and, eq, sql } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import {
  HANDLIST_RECORD_TYPES,
  HANDLIST_SHARE_ROLES,
  handlistMembers,
  handlistShares,
  handlists,
  users,
} from "../db/schema";
import { authorityScopeSql } from "./authority-ownership.server";
import { requireAdmin } from "./permissions.server";
import type { Tenant, User } from "../context";

/** records · entities · places, in the vocabulary the search tabs use. */
export type HandlistRecordType = (typeof HANDLIST_RECORD_TYPES)[number];
/** viewer reads; editor adds, removes and reorders. */
export type HandlistShareRole = (typeof HANDLIST_SHARE_ROLES)[number];

/**
 * How the caller reaches this handlist. `workspace` is the
 * workspace-visible arm: reachable, readable, and no more.
 */
export type HandlistRole = "owner" | "editor" | "viewer" | "workspace";

/** What a member has become since it was added. */
export type HandlistMemberState = "present" | "merged" | "split" | "missing";

/** Why a listed handlist cannot be opened by this person. */
export type HandlistLockReason = "authorities-admin-only";

/** Warn past this many members; the add still lands. */
export const HANDLIST_WARN_MEMBERS = 1_000;
/** Refuse past this many members; the add does not land. */
export const HANDLIST_MAX_MEMBERS = 10_000;

/**
 * How far a merge chain is followed before the read gives up. Chains
 * are one or two links in practice; the bound is what stops a cycle
 * introduced by a bad merge from running the recursive read forever.
 */
const MERGE_FOLLOW_LIMIT = 16;

/** Rows per INSERT batch — 6 columns each, well under D1's 100 binds. */
const MEMBER_INSERT_CHUNK = 15;
/** Ids per membership probe — one binding each, under D1's 100 binds. */
const MEMBERSHIP_PROBE_CHUNK = 90;
/** Rows per UPDATE batch during a reorder — 3 bindings each. */
const MEMBER_UPDATE_CHUNK = 30;

/** Which authority ledger record type a handlist type corresponds to. */
const LEDGER_RECORD_TYPE: Record<HandlistRecordType, "entity" | "place" | null> =
  {
    records: null,
    entities: "entity",
    places: "place",
  };

// ---------------------------------------------------------------------------
// Shapes the surfaces read
// ---------------------------------------------------------------------------

/** One handlist as the index lists it. */
export interface HandlistSummary {
  id: string;
  name: string;
  description: string | null;
  recordType: HandlistRecordType | null;
  workspaceVisible: boolean;
  ownerId: string;
  ownerName: string | null;
  ownerEmail: string;
  /** Members HELD — the tombstones included, as the index shows them. */
  memberCount: number;
  /** How many people it is shared with. */
  shareCount: number;
  role: HandlistRole;
  /** True when this person may see the row but not open it. */
  locked: boolean;
  lockedReason: HandlistLockReason | null;
  createdAt: number;
  updatedAt: number;
}

/**
 * A handlist the add menu offers, with how many of the members about
 * to be added it already holds. Zero when the caller asked without
 * naming any members.
 */
export interface HandlistAddTarget extends HandlistSummary {
  alreadyIn: number;
}

/** A member of a split, offered as a choice at review time. */
export interface HandlistSuccessor {
  id: string;
  title: string | null;
  code: string | null;
}

/** One member row, resolved against the workspace as it is now. */
export interface HandlistMemberRow {
  /** The reference as stored — the id the membership row carries. */
  memberId: string;
  position: number;
  /** Arrival stamp, or the review stamp once the row was resolved. */
  addedAt: number;
  addedBy: string | null;
  /** What the reference resolves to now; null when nothing does. */
  resolvedId: string | null;
  title: string | null;
  code: string | null;
  /** Description level, entity type or place type. */
  kind: string | null;
  /** Records only. */
  dateExpression: string | null;
  state: HandlistMemberState;
  /** Members that resolved to this same survivor and folded into it. */
  collapsedFrom: string[];
  /** Both sides of a split, the retained original first. */
  successors: HandlistSuccessor[];
  /** True while the row is waiting on a decision. */
  needsReview: boolean;
  /** Whether this row is counted in `exportable`. */
  exportable: boolean;
}

/** Someone a handlist is shared with. */
export interface HandlistShareRow {
  userId: string;
  name: string | null;
  email: string;
  role: HandlistShareRole;
  createdAt: number;
}

/** A workspace member the share dialog offers, and whether it may. */
export interface HandlistShareCandidate {
  userId: string;
  name: string | null;
  email: string;
  /** The share they already hold, or null. */
  role: HandlistShareRole | null;
  isOwner: boolean;
  eligible: boolean;
  ineligibleReason: HandlistLockReason | null;
}

/** A handlist and its resolved membership — the detail page's read. */
export interface HandlistDetail {
  id: string;
  name: string;
  description: string | null;
  recordType: HandlistRecordType | null;
  workspaceVisible: boolean;
  ownerId: string;
  ownerName: string | null;
  ownerEmail: string;
  role: HandlistRole;
  /** Owner or editor: may add, remove and reorder. */
  canEdit: boolean;
  /** Owner: may rename, share, set visibility, delete and transfer. */
  canManage: boolean;
  members: HandlistMemberRow[];
  /** Members held, after merge collapses — tombstones included. */
  total: number;
  /** Members that would leave in an export. */
  exportable: number;
  /** Rows waiting on a decision. */
  needsReviewCount: number;
  /** Tombstoned rows. */
  missingCount: number;
  /** True when anything is waiting on a decision. */
  needsReview: boolean;
  /** Populated for the owner, who is the only one who may share. */
  shares: HandlistShareRow[];
  createdAt: number;
  updatedAt: number;
}

export interface CreateHandlistInput {
  name: string;
  description?: string | null;
  /** Required when `memberIds` is non-empty; ignored when it is not. */
  recordType?: HandlistRecordType | null;
  /** The first members, which fix the type. */
  memberIds?: string[];
  workspaceVisible?: boolean;
}

/** What an add reports back — never a bare "Added". */
export interface AddMembersResult {
  id: string;
  recordType: HandlistRecordType;
  /** How many arrived that were not already in. */
  added: number;
  /** How many were already in — a duplicate add is a no-op. */
  alreadyIn: number;
  /** Members held afterwards; the number every confirmation states. */
  total: number;
  /** True past HANDLIST_WARN_MEMBERS. The add still landed. */
  warn: boolean;
}

/** How a drifted row is resolved. */
export type HandlistReviewResolution =
  /** A followed merge, accepted: the membership moves to the survivor. */
  | { memberId: string; action: "acknowledge" }
  /** A split, both sides kept. */
  | { memberId: string; action: "keep-both" }
  /** A split, one side kept — the original or a successor. */
  | { memberId: string; action: "keep"; successorId: string }
  /** Neither side belongs here. */
  | { memberId: string; action: "remove" };

// ---------------------------------------------------------------------------
// Access
// ---------------------------------------------------------------------------

/** The handlist row plus how the caller reaches it. */
interface HandlistAccess {
  id: string;
  name: string;
  description: string | null;
  recordType: HandlistRecordType | null;
  workspaceVisible: boolean;
  ownerId: string;
  ownerName: string | null;
  ownerEmail: string;
  role: HandlistRole;
  createdAt: number;
  updatedAt: number;
}

interface RawAccessRow {
  id: string;
  name: string;
  description: string | null;
  record_type: HandlistRecordType | null;
  workspace_visible: number;
  owner_id: string;
  owner_name: string | null;
  owner_email: string;
  share_role: HandlistShareRole | null;
  created_at: number;
  updated_at: number;
}

/**
 * Read one handlist under the visibility rule, in one statement: the
 * tenant, then owner OR an explicit share OR workspace-visible. Anything
 * that does not answer is a 404 — absent, foreign and unreachable are
 * deliberately indistinguishable.
 *
 * An authority-typed handlist additionally takes the admin gate the
 * entities and places surfaces take, through the same helper, so
 * reaching one without the flag is the 403 those surfaces give.
 */
async function loadAccess(
  db: DrizzleD1Database<any>,
  tenant: Tenant,
  user: User,
  handlistId: string,
): Promise<HandlistAccess> {
  const rows = (await db.all(sql`
    SELECT h.id AS id,
           h.name AS name,
           h.description AS description,
           h.record_type AS record_type,
           h.workspace_visible AS workspace_visible,
           h.owner_id AS owner_id,
           u.name AS owner_name,
           u.email AS owner_email,
           s.role AS share_role,
           h.created_at AS created_at,
           h.updated_at AS updated_at
    FROM handlists h
    INNER JOIN users u ON u.id = h.owner_id
    LEFT JOIN handlist_shares s ON s.handlist_id = h.id AND s.user_id = ${user.id}
    WHERE h.id = ${handlistId}
      AND h.tenant_id = ${tenant.id}
      AND (h.owner_id = ${user.id} OR s.user_id IS NOT NULL OR h.workspace_visible = 1)
  `)) as RawAccessRow[];

  const row = rows[0];
  if (!row) {
    throw new Response("Not found", { status: 404 });
  }
  if (isAuthorityType(row.record_type)) {
    // The same gate the entities and places surfaces take — including
    // for the owner, who may have been demoted since making it.
    requireAdmin(user);
  }
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    recordType: row.record_type,
    workspaceVisible: row.workspace_visible === 1,
    ownerId: row.owner_id,
    ownerName: row.owner_name,
    ownerEmail: row.owner_email,
    role:
      row.owner_id === user.id ? "owner" : (row.share_role ?? "workspace"),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function isAuthorityType(
  recordType: HandlistRecordType | null,
): recordType is "entities" | "places" {
  return recordType === "entities" || recordType === "places";
}

/** Owner only: rename, share, visibility, delete, transfer. */
function requireOwner(access: HandlistAccess): void {
  if (access.role !== "owner") {
    throw new Response("Forbidden", { status: 403 });
  }
}

/** Owner or editor: add, remove, reorder, resolve a review. */
function requireEditor(access: HandlistAccess): void {
  if (access.role !== "owner" && access.role !== "editor") {
    throw new Response("Forbidden", { status: 403 });
  }
}

// ---------------------------------------------------------------------------
// Naming, creating, retiring
// ---------------------------------------------------------------------------

/**
 * A name this person is already using in this workspace is refused
 * (409), because export history names the handlist a run was taken
 * from and two runs must be tellable apart. The check is scoped to the
 * OWNER's own handlists: two colleagues may each keep a "Padrones".
 */
async function refuseDuplicateName(
  db: DrizzleD1Database<any>,
  tenant: Tenant,
  ownerId: string,
  name: string,
  exceptId: string | null,
): Promise<void> {
  const rows = (await db.all(sql`
    SELECT h.id AS id
    FROM handlists h
    WHERE h.tenant_id = ${tenant.id}
      AND h.owner_id = ${ownerId}
      AND h.name = ${name}
    LIMIT 2
  `)) as { id: string }[];
  const clash = rows.find((row) => row.id !== exceptId);
  if (clash) {
    throw new Response(
      `A handlist called "${name}" is already yours. Names must differ so exports can be told apart in history.`,
      { status: 409 },
    );
  }
}

/** A name is required — an "Untitled" handlist is one nobody reopens. */
function requireName(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length === 0) {
    throw new Response("A handlist needs a name.", { status: 400 });
  }
  return trimmed;
}

/**
 * Make a handlist, optionally with the members that fix its type.
 *
 * Created empty, `recordType` stays NULL and the first add settles it.
 * Created from a selection, the caller states what the selection was
 * made of: member ids are polymorphic and nothing here could tell a
 * description id from a place id by looking at it.
 */
export async function createHandlist(
  db: DrizzleD1Database<any>,
  tenant: Tenant,
  user: User,
  input: CreateHandlistInput,
  now: number = Date.now(),
): Promise<AddMembersResult> {
  const name = requireName(input.name);
  const memberIds = dedupe(input.memberIds ?? []);
  const recordType = input.recordType ?? null;

  if (memberIds.length > 0 && recordType === null) {
    throw new Response(
      "A handlist created with members must say what kind of thing they are.",
      { status: 400 },
    );
  }
  if (recordType !== null && isAuthorityType(recordType)) {
    requireAdmin(user);
  }
  refuseOversized(memberIds.length);
  await refuseDuplicateName(db, tenant, user.id, name, null);

  const id = crypto.randomUUID();
  await db.insert(handlists).values({
    id,
    tenantId: tenant.id,
    ownerId: user.id,
    name,
    description: input.description?.trim() || null,
    // The type is only fixed by members; an empty handlist has none.
    recordType: memberIds.length > 0 ? recordType : null,
    workspaceVisible: input.workspaceVisible ?? false,
    createdAt: now,
    updatedAt: now,
  });

  await insertMembers(db, id, user, memberIds, 0, now);

  return {
    id,
    recordType: (memberIds.length > 0 ? recordType : null) as HandlistRecordType,
    added: memberIds.length,
    alreadyIn: 0,
    total: memberIds.length,
    warn: memberIds.length > HANDLIST_WARN_MEMBERS,
  };
}

/** Rename, and optionally re-describe. Owner only; no consequence. */
export async function renameHandlist(
  db: DrizzleD1Database<any>,
  tenant: Tenant,
  user: User,
  handlistId: string,
  input: { name: string; description?: string | null },
  now: number = Date.now(),
): Promise<void> {
  const access = await loadAccess(db, tenant, user, handlistId);
  requireOwner(access);
  const name = requireName(input.name);
  await refuseDuplicateName(db, tenant, access.ownerId, name, handlistId);

  await db
    .update(handlists)
    .set({
      name,
      description:
        input.description === undefined
          ? access.description
          : input.description?.trim() || null,
      updatedAt: now,
    })
    .where(and(eq(handlists.id, handlistId), eq(handlists.tenantId, tenant.id)));
}

/**
 * Delete the handlist. Its members and shares go with it through the
 * CASCADE; no record is touched, which is what the confirm copy says.
 * Named `deleteHandlist` because `delete` is spoken for.
 */
export async function deleteHandlist(
  db: DrizzleD1Database<any>,
  tenant: Tenant,
  user: User,
  handlistId: string,
): Promise<void> {
  const access = await loadAccess(db, tenant, user, handlistId);
  requireOwner(access);
  await db
    .delete(handlists)
    .where(and(eq(handlists.id, handlistId), eq(handlists.tenantId, tenant.id)));
}

/** The workspace-visible toggle — owner only, like every other grant. */
export async function setWorkspaceVisible(
  db: DrizzleD1Database<any>,
  tenant: Tenant,
  user: User,
  handlistId: string,
  visible: boolean,
  now: number = Date.now(),
): Promise<void> {
  const access = await loadAccess(db, tenant, user, handlistId);
  requireOwner(access);
  await db
    .update(handlists)
    .set({ workspaceVisible: visible, updatedAt: now })
    .where(and(eq(handlists.id, handlistId), eq(handlists.tenantId, tenant.id)));
}

// ---------------------------------------------------------------------------
// Sharing
// ---------------------------------------------------------------------------

/**
 * The person a share names, read inside the tenant. Someone outside the
 * workspace is a 400 rather than a 404: the owner picked from a list
 * this module produced, so a miss is a bad request, not a secret.
 */
async function loadShareTarget(
  db: DrizzleD1Database<any>,
  tenant: Tenant,
  targetUserId: string,
): Promise<{ id: string; email: string; isAdmin: boolean }> {
  const row = await db
    .select({ id: users.id, email: users.email, isAdmin: users.isAdmin })
    .from(users)
    .where(and(eq(users.id, targetUserId), eq(users.tenantId, tenant.id)))
    .get();
  if (!row) {
    throw new Response("That person is not in this workspace.", { status: 400 });
  }
  return { id: row.id, email: row.email, isAdmin: row.isAdmin };
}

/**
 * A share that could never be opened is refused rather than stored, so
 * the dialog's dimming and the server say the same thing. The reason
 * travels in the message: a handlist of authority records is admin-only
 * because its module is.
 */
function refuseIneligibleShare(
  access: HandlistAccess,
  target: { email: string; isAdmin: boolean },
): void {
  if (isAuthorityType(access.recordType) && !target.isAdmin) {
    throw new Response(
      `This handlist holds ${access.recordType}, which only workspace administrators can open, so it cannot be shared with ${target.email}.`,
      { status: 400 },
    );
  }
}

/** Share with one person, at one role. Owner only. */
export async function shareHandlist(
  db: DrizzleD1Database<any>,
  tenant: Tenant,
  user: User,
  handlistId: string,
  input: { userId: string; role: HandlistShareRole },
  now: number = Date.now(),
): Promise<void> {
  const access = await loadAccess(db, tenant, user, handlistId);
  requireOwner(access);
  if (input.userId === access.ownerId) {
    throw new Response("The owner already holds this handlist.", {
      status: 400,
    });
  }
  const target = await loadShareTarget(db, tenant, input.userId);
  refuseIneligibleShare(access, target);

  await db
    .insert(handlistShares)
    .values({
      id: crypto.randomUUID(),
      handlistId,
      userId: target.id,
      role: input.role,
      createdAt: now,
    })
    .onConflictDoUpdate({
      target: [handlistShares.handlistId, handlistShares.userId],
      set: { role: input.role },
    });

  await touch(db, tenant, handlistId, now);
}

/** Change an existing share's role. Owner only. */
export async function setShareRole(
  db: DrizzleD1Database<any>,
  tenant: Tenant,
  user: User,
  handlistId: string,
  targetUserId: string,
  role: HandlistShareRole,
  now: number = Date.now(),
): Promise<void> {
  const access = await loadAccess(db, tenant, user, handlistId);
  requireOwner(access);
  const target = await loadShareTarget(db, tenant, targetUserId);
  refuseIneligibleShare(access, target);

  await db
    .update(handlistShares)
    .set({ role })
    .where(
      and(
        eq(handlistShares.handlistId, handlistId),
        eq(handlistShares.userId, targetUserId),
      ),
    );
  await touch(db, tenant, handlistId, now);
}

/** Withdraw a share. Owner only; a share that was not there is a no-op. */
export async function unshareHandlist(
  db: DrizzleD1Database<any>,
  tenant: Tenant,
  user: User,
  handlistId: string,
  targetUserId: string,
  now: number = Date.now(),
): Promise<void> {
  const access = await loadAccess(db, tenant, user, handlistId);
  requireOwner(access);
  await db
    .delete(handlistShares)
    .where(
      and(
        eq(handlistShares.handlistId, handlistId),
        eq(handlistShares.userId, targetUserId),
      ),
    );
  await touch(db, tenant, handlistId, now);
}

interface RawCandidateRow {
  id: string;
  name: string | null;
  email: string;
  is_admin: number;
  share_role: HandlistShareRole | null;
}

/**
 * Everyone in the workspace the share dialog can offer, with the share
 * they already hold and whether they may hold one at all. Ineligible
 * people are RETURNED, not filtered out: the dialog dims them and names
 * the reason, because a list that quietly omits a colleague teaches
 * nothing about why.
 */
export async function listShareCandidates(
  db: DrizzleD1Database<any>,
  tenant: Tenant,
  user: User,
  handlistId: string,
): Promise<HandlistShareCandidate[]> {
  const access = await loadAccess(db, tenant, user, handlistId);
  requireOwner(access);

  const rows = (await db.all(sql`
    SELECT u.id AS id,
           u.name AS name,
           u.email AS email,
           u.is_admin AS is_admin,
           s.role AS share_role
    FROM users u
    LEFT JOIN handlist_shares s ON s.user_id = u.id AND s.handlist_id = ${handlistId}
    WHERE u.tenant_id = ${tenant.id}
    ORDER BY COALESCE(u.name, u.email) ASC
  `)) as RawCandidateRow[];

  const authority = isAuthorityType(access.recordType);
  return rows.map((row) => {
    const eligible = !authority || row.is_admin === 1;
    return {
      userId: row.id,
      name: row.name,
      email: row.email,
      role: row.share_role,
      isOwner: row.id === access.ownerId,
      eligible,
      ineligibleReason: eligible
        ? null
        : ("authorities-admin-only" as HandlistLockReason),
    };
  });
}

/**
 * Hand the handlist on. The owner may give it away; a tenant admin may
 * move it, which is what makes a departure something the workspace can
 * settle rather than something that blocks a user delete forever. Any
 * share the new owner held is withdrawn — owning supersedes it.
 */
export async function transferOwnership(
  db: DrizzleD1Database<any>,
  tenant: Tenant,
  user: User,
  handlistId: string,
  newOwnerId: string,
  now: number = Date.now(),
): Promise<void> {
  const access = await loadAccess(db, tenant, user, handlistId);
  if (access.role !== "owner" && !user.isAdmin) {
    throw new Response("Forbidden", { status: 403 });
  }
  if (newOwnerId === access.ownerId) return;

  const target = await loadShareTarget(db, tenant, newOwnerId);
  refuseIneligibleShare(access, target);

  await db.batch([
    db
      .update(handlists)
      .set({ ownerId: target.id, updatedAt: now })
      .where(
        and(eq(handlists.id, handlistId), eq(handlists.tenantId, tenant.id)),
      ),
    db
      .delete(handlistShares)
      .where(
        and(
          eq(handlistShares.handlistId, handlistId),
          eq(handlistShares.userId, target.id),
        ),
      ),
  ] as any);
}

// ---------------------------------------------------------------------------
// Membership
// ---------------------------------------------------------------------------

/** Stated in the refusal, so the number is not a mystery. */
function refuseOversized(count: number): void {
  if (count > HANDLIST_MAX_MEMBERS) {
    throw new Response(
      `A handlist holds at most ${HANDLIST_MAX_MEMBERS} members; this one would hold ${count}. Export a branch or the whole workspace instead.`,
      { status: 400 },
    );
  }
}

function dedupe(ids: string[]): string[] {
  return [...new Set(ids.filter((id) => typeof id === "string" && id !== ""))];
}

/** Bump the handlist's own clock — the index sorts and shows it. */
async function touch(
  db: DrizzleD1Database<any>,
  tenant: Tenant,
  handlistId: string,
  now: number,
): Promise<void> {
  await db
    .update(handlists)
    .set({ updatedAt: now })
    .where(and(eq(handlists.id, handlistId), eq(handlists.tenantId, tenant.id)));
}

/** Every member id currently held, in position order. One binding. */
async function currentMemberIds(
  db: DrizzleD1Database<any>,
  handlistId: string,
): Promise<string[]> {
  const rows = (await db.all(sql`
    SELECT m.member_id AS member_id
    FROM handlist_members m
    WHERE m.handlist_id = ${handlistId}
    ORDER BY m.position ASC, m.created_at ASC
  `)) as { member_id: string }[];
  return rows.map((row) => row.member_id);
}

/** Append members from `startPosition`, chunked under the binding cap. */
async function insertMembers(
  db: DrizzleD1Database<any>,
  handlistId: string,
  user: User,
  memberIds: string[],
  startPosition: number,
  now: number,
): Promise<void> {
  for (let i = 0; i < memberIds.length; i += MEMBER_INSERT_CHUNK) {
    const chunk = memberIds.slice(i, i + MEMBER_INSERT_CHUNK);
    await db.insert(handlistMembers).values(
      chunk.map((memberId, j) => ({
        id: crypto.randomUUID(),
        handlistId,
        memberId,
        position: startPosition + i + j,
        addedBy: user.id,
        createdAt: now,
      })),
    );
  }
}

/**
 * Add members, in arrival order, and report what actually happened.
 *
 * The type is checked against the handlist's, or FIXED by this add when
 * the handlist is still empty. Duplicates are no-ops and are counted
 * rather than swallowed: bulk adds overlap constantly, and "6 already
 * in" is the difference between a count a person trusts and one they
 * do not. The result carries the total the confirmation states.
 *
 * Membership is a reference, so nothing here checks that the ids
 * resolve — that is a read-time question, and the answer to "it no
 * longer does" is a tombstone rather than a refusal.
 */
export async function addMembers(
  db: DrizzleD1Database<any>,
  tenant: Tenant,
  user: User,
  handlistId: string,
  input: { recordType: HandlistRecordType; memberIds: string[] },
  now: number = Date.now(),
): Promise<AddMembersResult> {
  const access = await loadAccess(db, tenant, user, handlistId);
  requireEditor(access);

  if (access.recordType !== null && access.recordType !== input.recordType) {
    throw new Response(
      `This handlist holds ${access.recordType}, so ${input.recordType} cannot be added to it.`,
      { status: 400 },
    );
  }
  if (access.recordType === null && isAuthorityType(input.recordType)) {
    // Fixing the type to an authority one puts the handlist behind the
    // admin gate, so it takes that gate now rather than at the next read.
    requireAdmin(user);
  }

  const arriving = dedupe(input.memberIds);
  const held = await currentMemberIds(db, handlistId);
  const heldSet = new Set(held);
  const fresh = arriving.filter((id) => !heldSet.has(id));
  const total = held.length + fresh.length;
  refuseOversized(total);

  if (fresh.length > 0) {
    await insertMembers(db, handlistId, user, fresh, held.length, now);
  }

  const recordType = access.recordType ?? input.recordType;
  await db
    .update(handlists)
    .set({ recordType, updatedAt: now })
    .where(and(eq(handlists.id, handlistId), eq(handlists.tenantId, tenant.id)));

  return {
    id: handlistId,
    recordType,
    added: fresh.length,
    alreadyIn: arriving.length - fresh.length,
    total,
    warn: total > HANDLIST_WARN_MEMBERS,
  };
}

/**
 * Take a member out. The record is untouched — the confirm copy says
 * so, and this is why it can. Positions are left as they are: they
 * order the rows, and a gap orders them identically.
 */
export async function removeMember(
  db: DrizzleD1Database<any>,
  tenant: Tenant,
  user: User,
  handlistId: string,
  memberId: string,
  now: number = Date.now(),
): Promise<void> {
  const access = await loadAccess(db, tenant, user, handlistId);
  requireEditor(access);
  await db
    .delete(handlistMembers)
    .where(
      and(
        eq(handlistMembers.handlistId, handlistId),
        eq(handlistMembers.memberId, memberId),
      ),
    );
  await touch(db, tenant, handlistId, now);
}

/**
 * Set the order explicitly, from the list the drag produced. Ids that
 * are not members are ignored rather than refused — a stale row in a
 * dragged list is a race, not an attack — and members the caller left
 * out keep their relative order after the named ones, so a partial list
 * can never silently drop anybody out of the sequence.
 */
export async function reorderMembers(
  db: DrizzleD1Database<any>,
  tenant: Tenant,
  user: User,
  handlistId: string,
  orderedMemberIds: string[],
  now: number = Date.now(),
): Promise<void> {
  const access = await loadAccess(db, tenant, user, handlistId);
  requireEditor(access);

  const held = await currentMemberIds(db, handlistId);
  const heldSet = new Set(held);
  const named = dedupe(orderedMemberIds).filter((id) => heldSet.has(id));
  const namedSet = new Set(named);
  const order = [...named, ...held.filter((id) => !namedSet.has(id))];

  for (let i = 0; i < order.length; i += MEMBER_UPDATE_CHUNK) {
    const chunk = order.slice(i, i + MEMBER_UPDATE_CHUNK);
    await db.batch(
      chunk.map((memberId, j) =>
        db
          .update(handlistMembers)
          .set({ position: i + j })
          .where(
            and(
              eq(handlistMembers.handlistId, handlistId),
              eq(handlistMembers.memberId, memberId),
            ),
          ),
      ) as any,
    );
  }
  await touch(db, tenant, handlistId, now);
}

// ---------------------------------------------------------------------------
// The index
// ---------------------------------------------------------------------------

interface RawSummaryRow extends RawAccessRow {
  member_count: number;
  share_count: number;
}

/**
 * The handlists this person can reach, as the index's three tabs read
 * them: their own, the ones shared with them, or both plus everything
 * the workspace has been shown.
 *
 * An authority-typed handlist a non-admin cannot open is still LISTED
 * when they own it or were shared it, carrying `locked` and its reason
 * — that row is the residue of a demotion, and residue is explained
 * rather than hidden. One reached only through workspace visibility is
 * omitted: nothing was ever said to this person about it.
 */
export async function listForUser(
  db: DrizzleD1Database<any>,
  tenant: Tenant,
  user: User,
  filter: "mine" | "shared" | "all" = "all",
): Promise<HandlistSummary[]> {
  const scope =
    filter === "mine"
      ? sql` AND h.owner_id = ${user.id}`
      : filter === "shared"
        ? sql` AND s.user_id IS NOT NULL AND h.owner_id <> ${user.id}`
        : sql``;

  const rows = (await db.all(sql`
    SELECT h.id AS id,
           h.name AS name,
           h.description AS description,
           h.record_type AS record_type,
           h.workspace_visible AS workspace_visible,
           h.owner_id AS owner_id,
           u.name AS owner_name,
           u.email AS owner_email,
           s.role AS share_role,
           h.created_at AS created_at,
           h.updated_at AS updated_at,
           (SELECT count(*) FROM handlist_members m WHERE m.handlist_id = h.id) AS member_count,
           (SELECT count(*) FROM handlist_shares x WHERE x.handlist_id = h.id) AS share_count
    FROM handlists h
    INNER JOIN users u ON u.id = h.owner_id
    LEFT JOIN handlist_shares s ON s.handlist_id = h.id AND s.user_id = ${user.id}
    WHERE h.tenant_id = ${tenant.id}
      AND (h.owner_id = ${user.id} OR s.user_id IS NOT NULL OR h.workspace_visible = 1)${scope}
    ORDER BY h.updated_at DESC, h.name ASC
  `)) as RawSummaryRow[];

  const summaries: HandlistSummary[] = [];
  for (const row of rows) {
    const role: HandlistRole =
      row.owner_id === user.id ? "owner" : (row.share_role ?? "workspace");
    const locked = isAuthorityType(row.record_type) && !user.isAdmin;
    if (locked && role === "workspace") continue;
    summaries.push({
      id: row.id,
      name: row.name,
      description: row.description,
      recordType: row.record_type,
      workspaceVisible: row.workspace_visible === 1,
      ownerId: row.owner_id,
      ownerName: row.owner_name,
      ownerEmail: row.owner_email,
      memberCount: Number(row.member_count ?? 0),
      shareCount: Number(row.share_count ?? 0),
      role,
      locked,
      lockedReason: locked ? "authorities-admin-only" : null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    });
  }
  return summaries;
}

/**
 * How many of `memberIds` each of the given handlists already holds.
 * Keyed by handlist id; a handlist holding none of them is absent.
 *
 * Tenant-scoped in the same statement as the membership read, through
 * the join to `handlists` — a membership row carries no tenant of its
 * own, so the scope has to come from its handlist.
 */
async function countAlreadyIn(
  db: DrizzleD1Database<any>,
  tenant: Tenant,
  handlistIds: string[],
  memberIds: string[],
): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  if (handlistIds.length === 0 || memberIds.length === 0) return counts;

  // Both lists are chunked: the probe binds one parameter per id on
  // each side, and a bulk selection can carry thousands.
  for (let h = 0; h < handlistIds.length; h += MEMBERSHIP_PROBE_CHUNK) {
    const hChunk = handlistIds.slice(h, h + MEMBERSHIP_PROBE_CHUNK);
    for (let m = 0; m < memberIds.length; m += MEMBERSHIP_PROBE_CHUNK) {
      const mChunk = memberIds.slice(m, m + MEMBERSHIP_PROBE_CHUNK);
      const rows = (await db.all(sql`
        SELECT m.handlist_id AS handlist_id, COUNT(*) AS held
        FROM handlist_members m
        INNER JOIN handlists h ON h.id = m.handlist_id
        WHERE h.tenant_id = ${tenant.id}
          AND m.handlist_id IN (${sql.join(
            hChunk.map((id) => sql`${id}`),
            sql`, `,
          )})
          AND m.member_id IN (${sql.join(
            mChunk.map((id) => sql`${id}`),
            sql`, `,
          )})
        GROUP BY m.handlist_id
      `)) as { handlist_id: string; held: number }[];
      for (const row of rows) {
        counts.set(
          row.handlist_id,
          (counts.get(row.handlist_id) ?? 0) + Number(row.held),
        );
      }
    }
  }
  return counts;
}

/**
 * The handlists an add menu may offer for one kind of thing: the ones
 * this person can actually write to, whose type matches or is not yet
 * fixed. Offering a mismatched handlist and erroring on submit is the
 * failure the type rule exists to prevent.
 *
 * When `memberIds` is given, each row also reports how many of them it
 * already holds, so the menu can say "6 already in" where the card
 * says it. Duplicates are no-ops, so this changes nothing about what
 * an add does — it stops the reader from having to guess.
 */
export async function listAddTargets(
  db: DrizzleD1Database<any>,
  tenant: Tenant,
  user: User,
  recordType: HandlistRecordType,
  memberIds?: string[],
): Promise<HandlistAddTarget[]> {
  const all = await listForUser(db, tenant, user, "all");
  const writable = all.filter(
    (row) =>
      !row.locked &&
      (row.role === "owner" || row.role === "editor") &&
      (row.recordType === null || row.recordType === recordType),
  );
  if (!memberIds || memberIds.length === 0) {
    return writable.map((row) => ({ ...row, alreadyIn: 0 }));
  }
  const counts = await countAlreadyIn(
    db,
    tenant,
    writable.map((row) => row.id),
    memberIds,
  );
  return writable.map((row) => ({
    ...row,
    alreadyIn: counts.get(row.id) ?? 0,
  }));
}

/**
 * How many handlists this person can reach already hold this record —
 * the number the "In 2 handlists" affordance states on a record's own
 * page. Wider than the add menu on purpose: a handlist shared with you
 * read-only still holds the record, and saying otherwise would make
 * the count a lie about where the record is.
 */
export async function countHoldingHandlists(
  db: DrizzleD1Database<any>,
  tenant: Tenant,
  user: User,
  memberId: string,
): Promise<number> {
  const reachable = await listForUser(db, tenant, user, "all");
  const counts = await countAlreadyIn(
    db,
    tenant,
    reachable.filter((row) => !row.locked).map((row) => row.id),
    [memberId],
  );
  return counts.size;
}

// ---------------------------------------------------------------------------
// Membership integrity — computed at read
// ---------------------------------------------------------------------------

/** One row of the member read, before the drift rules are applied. */
interface RawMemberRow {
  member_id: string;
  position: number;
  created_at: number;
  added_by: string | null;
  depth?: number;
  resolved_id?: string | null;
  found_id: string | null;
  title: string | null;
  code: string | null;
  kind: string | null;
  date_expression?: string | null;
}

interface RawSplitRow {
  source_id: string;
  target_id: string | null;
  target_title: string | null;
  target_code: string | null;
}

/**
 * Records: one left join, and the only drift a description can suffer
 * is disappearing. The tenant predicate rides in the same statement as
 * the FROM, and the join — not an id list — is what keeps a
 * ten-thousand-member read to two bindings.
 */
async function readRecordMembers(
  db: DrizzleD1Database<any>,
  tenant: Tenant,
  handlistId: string,
): Promise<RawMemberRow[]> {
  return (await db.all(sql`
    SELECT m.member_id AS member_id,
           m.position AS position,
           m.created_at AS created_at,
           m.added_by AS added_by,
           d.id AS found_id,
           d.title AS title,
           d.reference_code AS code,
           d.description_level AS kind,
           d.date_expression AS date_expression
    FROM handlist_members m
    LEFT JOIN descriptions d ON d.id = m.member_id AND d.tenant_id = ${tenant.id}
    WHERE m.handlist_id = ${handlistId}
    ORDER BY m.position ASC, m.created_at ASC
  `)) as RawMemberRow[];
}

/**
 * Entities and places: the same read, with the merge chain walked in
 * SQL. Each step follows `merged_into` to the next record IN SCOPE, so
 * a chain that leaves the reader's authority scope stops there and the
 * row resolves to nothing — a tombstone, which is the honest answer for
 * a reader who cannot see the survivor. `MERGE_FOLLOW_LIMIT` bounds a
 * cycle a bad merge could otherwise introduce.
 *
 * Every depth of the walk comes back; the caller keeps the deepest row
 * per member, which is the end of that member's chain.
 */
async function readAuthorityMembers(
  db: DrizzleD1Database<any>,
  tenant: Tenant,
  handlistId: string,
  kind: "entities" | "places",
): Promise<RawMemberRow[]> {
  if (kind === "entities") {
    return (await db.all(sql`
      WITH RECURSIVE chain(member_id, position, created_at, added_by, current_id, depth) AS (
        SELECT m.member_id, m.position, m.created_at, m.added_by, m.member_id, 0
        FROM handlist_members m
        WHERE m.handlist_id = ${handlistId}
        UNION ALL
        SELECT c.member_id, c.position, c.created_at, c.added_by, e.merged_into, c.depth + 1
        FROM chain c
        INNER JOIN entities e
          ON e.id = c.current_id
          AND ${authorityScopeSql("e", tenant.federationId, tenant.id)}
        WHERE e.merged_into IS NOT NULL AND c.depth < ${MERGE_FOLLOW_LIMIT}
      )
      SELECT c.member_id AS member_id,
             c.position AS position,
             c.created_at AS created_at,
             c.added_by AS added_by,
             c.depth AS depth,
             c.current_id AS resolved_id,
             e.id AS found_id,
             e.display_name AS title,
             e.entity_code AS code,
             e.entity_type AS kind
      FROM chain c
      LEFT JOIN entities e
        ON e.id = c.current_id
        AND ${authorityScopeSql("e", tenant.federationId, tenant.id)}
      ORDER BY c.position ASC, c.depth ASC
    `)) as RawMemberRow[];
  }
  return (await db.all(sql`
    WITH RECURSIVE chain(member_id, position, created_at, added_by, current_id, depth) AS (
      SELECT m.member_id, m.position, m.created_at, m.added_by, m.member_id, 0
      FROM handlist_members m
      WHERE m.handlist_id = ${handlistId}
      UNION ALL
      SELECT c.member_id, c.position, c.created_at, c.added_by, p.merged_into, c.depth + 1
      FROM chain c
      INNER JOIN places p
        ON p.id = c.current_id
        AND ${authorityScopeSql("p", tenant.federationId, tenant.id)}
      WHERE p.merged_into IS NOT NULL AND c.depth < ${MERGE_FOLLOW_LIMIT}
    )
    SELECT c.member_id AS member_id,
           c.position AS position,
           c.created_at AS created_at,
           c.added_by AS added_by,
           c.depth AS depth,
           c.current_id AS resolved_id,
           p.id AS found_id,
           p.display_name AS title,
           p.place_code AS code,
           p.place_type AS kind
    FROM chain c
    LEFT JOIN places p
      ON p.id = c.current_id
      AND ${authorityScopeSql("p", tenant.federationId, tenant.id)}
    ORDER BY c.position ASC, c.depth ASC
  `)) as RawMemberRow[];
}

/**
 * Splits that happened UNDER this handlist: an `operation = 'split'`
 * whose source is a member and whose stamp is later than the
 * membership's own. An operation that predates the add is history — the
 * person added the record knowing what it already was.
 *
 * The successor named by the ledger is joined in scope so the review
 * affordance can offer it by name; the other successor is the retained
 * original, which is the member row itself.
 */
async function readSplits(
  db: DrizzleD1Database<any>,
  tenant: Tenant,
  handlistId: string,
  kind: "entities" | "places",
): Promise<RawSplitRow[]> {
  const ledgerType = LEDGER_RECORD_TYPE[kind];
  if (kind === "entities") {
    return (await db.all(sql`
      SELECT o.source_id AS source_id,
             o.target_id AS target_id,
             e.display_name AS target_title,
             e.entity_code AS target_code
      FROM authority_operations o
      INNER JOIN handlist_members m
        ON m.member_id = o.source_id AND m.handlist_id = ${handlistId}
      LEFT JOIN entities e
        ON e.id = o.target_id
        AND ${authorityScopeSql("e", tenant.federationId, tenant.id)}
      WHERE o.federation_id = ${tenant.federationId}
        AND o.record_type = ${ledgerType}
        AND o.operation = 'split'
        AND o.created_at > m.created_at
      ORDER BY o.created_at ASC
    `)) as RawSplitRow[];
  }
  return (await db.all(sql`
    SELECT o.source_id AS source_id,
           o.target_id AS target_id,
           p.display_name AS target_title,
           p.place_code AS target_code
    FROM authority_operations o
    INNER JOIN handlist_members m
      ON m.member_id = o.source_id AND m.handlist_id = ${handlistId}
    LEFT JOIN places p
      ON p.id = o.target_id
      AND ${authorityScopeSql("p", tenant.federationId, tenant.id)}
    WHERE o.federation_id = ${tenant.federationId}
      AND o.record_type = ${ledgerType}
      AND o.operation = 'split'
      AND o.created_at > m.created_at
    ORDER BY o.created_at ASC
  `)) as RawSplitRow[];
}

/** The deepest row per member — the end of that member's merge chain. */
function deepestPerMember(rows: RawMemberRow[]): RawMemberRow[] {
  const best = new Map<string, RawMemberRow>();
  for (const row of rows) {
    const seen = best.get(row.member_id);
    if (!seen || (row.depth ?? 0) > (seen.depth ?? 0)) {
      best.set(row.member_id, row);
    }
  }
  return [...best.values()].sort(
    (a, b) => a.position - b.position || a.created_at - b.created_at,
  );
}

/**
 * Read a handlist and resolve every member against the workspace as it
 * stands. Nothing here is stored: the merge follows, the collapses, the
 * split flags and the tombstones are all computed now, which is the
 * only way the numbers can be true now.
 *
 * `total` is what the handlist holds after collapses, tombstones
 * included; `exportable` is what would actually leave — the deleted and
 * the unresolved excluded. The two are reported separately because they
 * answer different questions, and a single number would have to lie
 * about one of them.
 */
export async function getWithMembers(
  db: DrizzleD1Database<any>,
  tenant: Tenant,
  user: User,
  handlistId: string,
): Promise<HandlistDetail> {
  const access = await loadAccess(db, tenant, user, handlistId);

  const raw =
    access.recordType === null
      ? []
      : access.recordType === "records"
        ? await readRecordMembers(db, tenant, handlistId)
        : await readAuthorityMembers(db, tenant, handlistId, access.recordType);

  const splits = isAuthorityType(access.recordType)
    ? await readSplits(db, tenant, handlistId, access.recordType)
    : [];
  const splitsBySource = new Map<string, RawSplitRow[]>();
  for (const split of splits) {
    const list = splitsBySource.get(split.source_id) ?? [];
    list.push(split);
    splitsBySource.set(split.source_id, list);
  }

  const members: HandlistMemberRow[] = [];
  // A survivor already in the handlist absorbs the members that
  // resolved to it: the rows collapse into one and the count drops,
  // which is the visible half of "followed a merge".
  const byResolved = new Map<string, HandlistMemberRow>();

  for (const row of deepestPerMember(raw)) {
    const followed = (row.depth ?? 0) > 0;
    const resolvedId = row.found_id;
    if (resolvedId !== null) {
      const existing = byResolved.get(resolvedId);
      if (existing) {
        existing.collapsedFrom.push(row.member_id);
        existing.state = "merged";
        continue;
      }
    }

    const splitRows = splitsBySource.get(row.member_id) ?? [];
    const state: HandlistMemberState =
      resolvedId === null
        ? "missing"
        : splitRows.length > 0
          ? "split"
          : followed
            ? "merged"
            : "present";

    const successors: HandlistSuccessor[] =
      state === "split"
        ? [
            { id: row.member_id, title: row.title, code: row.code },
            ...splitRows
              .filter((split) => split.target_id !== null)
              .map((split) => ({
                id: split.target_id as string,
                title: split.target_title,
                code: split.target_code,
              })),
          ]
        : [];

    const member: HandlistMemberRow = {
      memberId: row.member_id,
      position: row.position,
      addedAt: row.created_at,
      addedBy: row.added_by,
      resolvedId,
      title: row.title,
      code: row.code,
      kind: row.kind,
      dateExpression: row.date_expression ?? null,
      state,
      collapsedFrom: [],
      successors,
      needsReview: state === "split",
      exportable: state !== "missing" && state !== "split",
    };
    members.push(member);
    if (resolvedId !== null) byResolved.set(resolvedId, member);
  }

  const shares =
    access.role === "owner" ? await readShares(db, handlistId) : [];

  const needsReviewCount = members.filter((m) => m.needsReview).length;
  const missingCount = members.filter((m) => m.state === "missing").length;

  return {
    id: access.id,
    name: access.name,
    description: access.description,
    recordType: access.recordType,
    workspaceVisible: access.workspaceVisible,
    ownerId: access.ownerId,
    ownerName: access.ownerName,
    ownerEmail: access.ownerEmail,
    role: access.role,
    canEdit: access.role === "owner" || access.role === "editor",
    canManage: access.role === "owner",
    members,
    total: members.length,
    exportable: members.filter((m) => m.exportable).length,
    needsReviewCount,
    missingCount,
    needsReview: needsReviewCount > 0,
    shares,
    createdAt: access.createdAt,
    updatedAt: access.updatedAt,
  };
}

interface RawShareRow {
  user_id: string;
  name: string | null;
  email: string;
  role: HandlistShareRole;
  created_at: number;
}

/** Who the handlist is shared with — read for the owner only. */
async function readShares(
  db: DrizzleD1Database<any>,
  handlistId: string,
): Promise<HandlistShareRow[]> {
  const rows = (await db.all(sql`
    SELECT s.user_id AS user_id,
           u.name AS name,
           u.email AS email,
           s.role AS role,
           s.created_at AS created_at
    FROM handlist_shares s
    INNER JOIN users u ON u.id = s.user_id
    WHERE s.handlist_id = ${handlistId}
    ORDER BY COALESCE(u.name, u.email) ASC
  `)) as RawShareRow[];
  return rows.map((row) => ({
    userId: row.user_id,
    name: row.name,
    email: row.email,
    role: row.role,
    createdAt: row.created_at,
  }));
}

/**
 * Resolve one drifted row.
 *
 * Because drift is computed rather than stored, a resolution has to
 * change what the membership SAYS, and each action does exactly that:
 *
 *   - `acknowledge` repoints a followed merge at its survivor, or drops
 *     the row when the survivor is already a member — the collapse,
 *     made durable;
 *   - `keep` keeps one side of a split, repointing the membership when
 *     the kept side is the new record;
 *   - `keep-both` appends the successors that are not members yet;
 *   - `remove` takes the row out.
 *
 * Every action but `remove` re-stamps the membership, which is what
 * clears a split flag: the ledger entry is no longer later than the
 * membership. The stamp therefore reads as "when this row was last
 * affirmed against the workspace" rather than as the original arrival,
 * which is the truer thing to show beside a row that has just been
 * reviewed.
 */
export async function resolveReview(
  db: DrizzleD1Database<any>,
  tenant: Tenant,
  user: User,
  handlistId: string,
  resolution: HandlistReviewResolution,
  now: number = Date.now(),
): Promise<void> {
  const access = await loadAccess(db, tenant, user, handlistId);
  requireEditor(access);

  if (resolution.action === "remove") {
    await removeMember(db, tenant, user, handlistId, resolution.memberId, now);
    return;
  }

  const detail = await getWithMembers(db, tenant, user, handlistId);
  const row = detail.members.find((m) => m.memberId === resolution.memberId);
  if (!row) {
    throw new Response("Not found", { status: 404 });
  }
  const held = new Set(detail.members.map((m) => m.memberId));

  if (resolution.action === "acknowledge") {
    // The survivor is what the handlist meant all along; point at it,
    // unless it is already held, in which case the row is redundant.
    const survivor = row.resolvedId;
    if (survivor === null || survivor === row.memberId) {
      await restamp(db, handlistId, row.memberId, now);
    } else if (held.has(survivor)) {
      await db
        .delete(handlistMembers)
        .where(
          and(
            eq(handlistMembers.handlistId, handlistId),
            eq(handlistMembers.memberId, row.memberId),
          ),
        );
    } else {
      await repoint(db, handlistId, row.memberId, survivor, now);
    }
    await touch(db, tenant, handlistId, now);
    return;
  }

  if (resolution.action === "keep") {
    const chosen = resolution.successorId;
    if (!row.successors.some((s) => s.id === chosen)) {
      throw new Response("That is not one of this member's successors.", {
        status: 400,
      });
    }
    if (chosen === row.memberId) {
      await restamp(db, handlistId, row.memberId, now);
    } else if (held.has(chosen)) {
      await db
        .delete(handlistMembers)
        .where(
          and(
            eq(handlistMembers.handlistId, handlistId),
            eq(handlistMembers.memberId, row.memberId),
          ),
        );
    } else {
      await repoint(db, handlistId, row.memberId, chosen, now);
    }
    await touch(db, tenant, handlistId, now);
    return;
  }

  // keep-both: the original stays where it is, and every successor that
  // is not already a member joins the end of the sequence.
  const missing = row.successors
    .map((s) => s.id)
    .filter((id) => id !== row.memberId && !held.has(id));
  refuseOversized(detail.total + missing.length);
  await restamp(db, handlistId, row.memberId, now);
  if (missing.length > 0) {
    const held_ = await currentMemberIds(db, handlistId);
    await insertMembers(db, handlistId, user, missing, held_.length, now);
  }
  await touch(db, tenant, handlistId, now);
}

/** Re-affirm a membership: the stamp moves, the reference does not. */
async function restamp(
  db: DrizzleD1Database<any>,
  handlistId: string,
  memberId: string,
  now: number,
): Promise<void> {
  await db
    .update(handlistMembers)
    .set({ createdAt: now })
    .where(
      and(
        eq(handlistMembers.handlistId, handlistId),
        eq(handlistMembers.memberId, memberId),
      ),
    );
}

/** Move a membership onto another record, keeping its place in the order. */
async function repoint(
  db: DrizzleD1Database<any>,
  handlistId: string,
  memberId: string,
  newMemberId: string,
  now: number,
): Promise<void> {
  await db
    .update(handlistMembers)
    .set({ memberId: newMemberId, createdAt: now })
    .where(
      and(
        eq(handlistMembers.handlistId, handlistId),
        eq(handlistMembers.memberId, memberId),
      ),
    );
}

/**
 * The member ids a handlist holds, for a caller that needs the set
 * rather than the rows — the export scope, which fixes what will leave.
 * Visibility is checked first, so this is never a way around the gate;
 * the ids come back in handlist order, because that order is the one
 * thing a handlist offers that no query can.
 */
export async function listMemberIds(
  db: DrizzleD1Database<any>,
  tenant: Tenant,
  user: User,
  handlistId: string,
): Promise<{ recordType: HandlistRecordType | null; memberIds: string[] }> {
  const access = await loadAccess(db, tenant, user, handlistId);
  return {
    recordType: access.recordType,
    memberIds: await currentMemberIds(db, handlistId),
  };
}
