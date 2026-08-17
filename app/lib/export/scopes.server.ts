/**
 * Export scopes — the four What doors, resolved to what will leave
 *
 * This module deals with turning a person's answer to "which records?"
 * into an ordered list of ids and the counts the confirm bar states.
 * Four doors arrive here — the whole workspace, one branch of the
 * hierarchy, a scope carried from the search page, a saved handlist —
 * and one shape leaves, so nothing downstream has to know which door it
 * came through.
 *
 * ORDER IS PART OF THE ANSWER. Each door has its own order and the
 * artifact keeps it: the hierarchy walks in preorder (a container, then
 * what is inside it, by position), a carried scope keeps the order the
 * search page showed, and a handlist keeps the order the person dragged
 * it into — which is the one thing a handlist offers that no query can.
 * Sorting them into a common order here would throw away the only part
 * of a handlist that is not reproducible.
 *
 * THE SCOPE IS FIXED AT RESOLUTION AND NEVER RE-ASKED. The run stores a
 * descriptor in the ledger's own words, not a query, so renaming the
 * branch or editing the handlist afterwards cannot rewrite what a
 * recorded run says it took. This is the same commitment carried scopes
 * make for the same reason (see `app/lib/carried-scopes.server.ts`).
 *
 * TENANT SCOPE IS SPELLED IN EVERY STATEMENT. Every read here names the
 * request tenant in the same statement that names the table — including
 * the recursive branch walk, whose both arms carry it — so a lost
 * predicate is a visible deletion rather than a silent widening. The
 * authority reads go through `authorityScope()` and never through a
 * bare federation filter, because an authority may be federation-shared
 * or tenant-owned and only that helper knows the difference.
 *
 * TWO DOORS HAND US IDS WE DID NOT PRODUCE, and both are re-read here.
 * A carried scope's members were resolved on the search page and stored
 * UNREVALIDATED (the 4a contract) — records can be deleted between the
 * carry and the export — so the ids are re-read under this tenant and
 * only the survivors leave. A handlist's members are resolved through
 * its own integrity read: tombstones are excluded from the export, and
 * a handlist with anything waiting on a decision REFUSES to export at
 * all, which is the same gate its own page applies to its own button.
 *
 * AN AUTHORITY SCOPE IS A DIFFERENT KIND OF THING, not a variant. Its
 * members are entities or places; the include-authorities toggle is Not
 * applicable to it; and what it carries besides its members is its
 * description LINKS — "14 entities and their 212 description links" —
 * not the descriptions themselves.
 *
 * @version v0.7.0
 */

import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import {
  descriptionEntities,
  descriptionPlaces,
  descriptions,
  entities,
  places,
} from "../../db/schema";
import { authorityScope } from "../authority-ownership.server";
import { getCarriedScope } from "../carried-scopes.server";
import { carriedScopes } from "../../db/schema";
import { getWithMembers } from "../handlists.server";
import type { Tenant, User } from "../../context";
import type { ExportRecordClass } from "./matrix";

/**
 * D1 caps bound parameters at roughly 100 per statement, so every read
 * over a caller-supplied id list is chunked. 90 leaves room for the
 * scope predicates riding in the same statement.
 */
export const ID_CHUNK = 90;

/** The four doors. Mirrors `workspace_export_runs.scope_kind`. */
export type ExportScopeKind = "workspace" | "branch" | "carried" | "handlist";

/** What the surface asks for; one variant per door. */
export type ExportScopeRequest =
  | { kind: "workspace" }
  | { kind: "branch"; descriptionId: string }
  | { kind: "carried"; carriedScopeId: string }
  | { kind: "handlist"; handlistId: string };

/**
 * The ledger row's own words about this scope — display and re-run
 * provenance, stored as `scope_descriptor` JSON and never re-resolved.
 */
export type ExportScopeDescriptor =
  | { kind: "workspace" }
  | {
      kind: "branch";
      descriptionId: string;
      referenceCode: string;
      title: string;
      /** Root first, this node last — the chain the row prints. */
      titleChain: string[];
    }
  | {
      kind: "carried";
      carriedScopeId: string;
      /** The pills as they read when the carry was made. */
      pills: string[];
      /**
       * The browse surface it was ticked on, when there was no query
       * to name it by. Null for a carry made from a search.
       */
      origin: string | null;
      /** The arithmetic the tile shows: found − unticked → will export. */
      found: number;
      unticked: number;
      willExport: number;
      /** When the search ran; a query is a claim about that moment. */
      carriedAt: number;
    }
  | {
      kind: "handlist";
      handlistId: string;
      name: string;
      /** Members held, tombstones included. */
      total: number;
      /** Members that will actually leave. */
      exportable: number;
    };

/** The consequence line: counts as the confirm bar states them. */
export interface ExportScopeCounts {
  records: number;
  entities: number;
  places: number;
  /** Description↔authority link rows the artifact will carry. */
  links: number;
}

export interface ResolvedExportScope {
  kind: ExportScopeKind;
  recordClass: ExportRecordClass;
  /** The scope's own members, ordered: descriptions, entities or places. */
  memberIds: string[];
  /**
   * Entity ids the artifact carries. For a records scope these are the
   * authorities the records cite (empty when the toggle is off); for an
   * entity scope they are the members themselves.
   */
  entityIds: string[];
  /** Place ids, on the same rule as `entityIds`. */
  placeIds: string[];
  counts: ExportScopeCounts;
  descriptor: ExportScopeDescriptor;
}

export interface ResolveExportScopeOptions {
  /**
   * Whether to carry the linked authorities. Ignored for an authority
   * scope, where the toggle is Not applicable — its members ARE the
   * authorities and its links are always named.
   */
  includeAuthorities: boolean;
}

/**
 * A door that cannot be opened, with a machine code the surface maps to
 * the card's own sentence.
 *
 *   - `handlist-needs-review` — a member is waiting on a decision. The
 *     handlist page disables its own export button on the same flag.
 *   - `handlist-empty` / `scope-empty` — nothing would leave.
 *   - `handlist-untyped` — a handlist with no members yet has no type,
 *     and an untyped scope has no legal form.
 *   - `branch-not-found` — no such node in this workspace. Deliberately
 *     the same answer for another tenant's node.
 */
export type ExportScopeErrorCode =
  | "handlist-needs-review"
  | "handlist-empty"
  | "handlist-untyped"
  | "branch-not-found"
  | "scope-empty";

export class ExportScopeError extends Error {
  readonly code: ExportScopeErrorCode;
  constructor(code: ExportScopeErrorCode, message: string) {
    super(message);
    this.name = "ExportScopeError";
    this.code = code;
  }
}

function chunk<T>(items: readonly T[], size = ID_CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

// ---------------------------------------------------------------------------
// The workspace door
// ---------------------------------------------------------------------------

/**
 * The headline counts the whole-workspace tile shows before anything is
 * chosen ("5,602 records · 1,094 entities · 176 places"). Three counting
 * reads rather than a resolution: the tile is a label, and materialising
 * every id to print a number would make the page pay for a scope nobody
 * picked yet.
 */
export async function countWorkspaceTotals(
  db: DrizzleD1Database<any>,
  tenant: Tenant,
): Promise<{ records: number; entities: number; places: number }> {
  const records = await db
    .select({ n: sql<number>`count(*)` })
    .from(descriptions)
    .where(eq(descriptions.tenantId, tenant.id))
    .get();

  const entityCount = await db
    .select({ n: sql<number>`count(*)` })
    .from(entities)
    .where(
      and(
        authorityScope(entities, tenant.federationId, tenant.id),
        isNull(entities.mergedInto),
      ),
    )
    .get();

  const placeCount = await db
    .select({ n: sql<number>`count(*)` })
    .from(places)
    .where(
      and(
        authorityScope(places, tenant.federationId, tenant.id),
        isNull(places.mergedInto),
      ),
    )
    .get();

  return {
    records: records?.n ?? 0,
    entities: entityCount?.n ?? 0,
    places: placeCount?.n ?? 0,
  };
}

/**
 * Every description in the workspace, in hierarchy preorder. The rows
 * come back flat and the order is built here rather than in SQL: a
 * preorder is a walk, and SQLite would need the same recursive CTE plus
 * a synthesised sort path to express it.
 */
async function workspaceMembers(
  db: DrizzleD1Database<any>,
  tenant: Tenant,
): Promise<string[]> {
  const rows = await db
    .select({
      id: descriptions.id,
      parentId: descriptions.parentId,
      position: descriptions.position,
    })
    .from(descriptions)
    .where(eq(descriptions.tenantId, tenant.id))
    .all();
  return preorder(rows, null);
}

// ---------------------------------------------------------------------------
// The branch door
// ---------------------------------------------------------------------------

/**
 * A node and everything under it, in preorder. The descendant walk is a
 * recursive CTE — the same shape the descriptions surface already uses
 * for its subtree updates — because the adjacency list has no closure
 * table and `path_cache` is a denormalised convenience rather than a
 * guaranteed index. BOTH arms of the CTE carry the tenant predicate:
 * the anchor because it is the whole gate on the node itself, and the
 * recursive arm because a child row is read on its own terms.
 *
 * `children.server.ts` and `fonds-list.server.ts` were read first and
 * neither answers this question — the former groups an already-fetched
 * flat list into the published JSON's children maps, the latter lists
 * root reference codes for the publish selector. Nothing existed to
 * reuse, so this is the one new piece of hierarchy SQL.
 */
async function branchMembers(
  db: DrizzleD1Database<any>,
  tenant: Tenant,
  descriptionId: string,
): Promise<{ ids: string[]; descriptor: ExportScopeDescriptor }> {
  const root = await db
    .select({
      id: descriptions.id,
      parentId: descriptions.parentId,
      referenceCode: descriptions.referenceCode,
      title: descriptions.title,
    })
    .from(descriptions)
    .where(
      and(eq(descriptions.tenantId, tenant.id), eq(descriptions.id, descriptionId)),
    )
    .get();
  if (!root) {
    throw new ExportScopeError(
      "branch-not-found",
      "No such description in this workspace",
    );
  }

  const walked = await db.all<{
    id: string;
    parent_id: string | null;
    position: number;
  }>(sql`
    WITH RECURSIVE branch AS (
      SELECT id, parent_id, position
        FROM descriptions
       WHERE tenant_id = ${tenant.id} AND id = ${descriptionId}
      UNION ALL
      SELECT d.id, d.parent_id, d.position
        FROM descriptions d
        JOIN branch b ON d.parent_id = b.id
       WHERE d.tenant_id = ${tenant.id}
    )
    SELECT id, parent_id, position FROM branch
  `);

  const rows = walked.map((r) => ({
    id: r.id,
    parentId: r.parent_id,
    position: r.position,
  }));
  // The walk is rooted at the chosen node, so preorder starts from its
  // own parent link rather than from null.
  const ids = preorder(rows, root.parentId, descriptionId);

  return {
    ids,
    descriptor: {
      kind: "branch",
      descriptionId,
      referenceCode: root.referenceCode,
      title: root.title,
      titleChain: await ancestorTitles(db, tenant, root.parentId, root.title),
    },
  };
}

/** How deep a title chain may climb before we stop trusting the tree. */
const MAX_ANCESTOR_WALK = 24;

/**
 * The titles from the root down to this node, for the ledger row's
 * scope line. Walked one statement per level — the chain is a handful
 * of rows and a recursive CTE would cost more to read than it saves.
 */
async function ancestorTitles(
  db: DrizzleD1Database<any>,
  tenant: Tenant,
  parentId: string | null,
  ownTitle: string,
): Promise<string[]> {
  const chain: string[] = [ownTitle];
  let cursor = parentId;
  for (let i = 0; cursor !== null && i < MAX_ANCESTOR_WALK; i++) {
    const row: { parentId: string | null; title: string } | undefined = await db
      .select({ parentId: descriptions.parentId, title: descriptions.title })
      .from(descriptions)
      .where(and(eq(descriptions.tenantId, tenant.id), eq(descriptions.id, cursor)))
      .get();
    if (!row) break;
    chain.unshift(row.title);
    cursor = row.parentId;
  }
  return chain;
}

/**
 * Depth-first order over an adjacency list: each node, then its
 * children by position. Orphans — rows whose parent is outside the set
 * — are appended in position order rather than dropped, because a
 * broken parent link must never silently shrink an export.
 */
function preorder(
  rows: { id: string; parentId: string | null; position: number }[],
  rootParentId: string | null,
  rootId?: string,
): string[] {
  const byParent = new Map<string | null, typeof rows>();
  const present = new Set(rows.map((r) => r.id));
  for (const row of rows) {
    const key = row.parentId;
    const list = byParent.get(key) ?? [];
    list.push(row);
    byParent.set(key, list);
  }
  for (const list of byParent.values()) {
    list.sort((a, b) => a.position - b.position || a.id.localeCompare(b.id));
  }

  const out: string[] = [];
  const seen = new Set<string>();
  const visit = (id: string): void => {
    if (seen.has(id)) return;
    seen.add(id);
    out.push(id);
    for (const child of byParent.get(id) ?? []) visit(child.id);
  };

  if (rootId !== undefined) {
    visit(rootId);
  } else {
    for (const row of byParent.get(rootParentId) ?? []) visit(row.id);
  }

  // Anything the walk never reached: a row whose parent is not in the
  // set (a partially-migrated tree, or a parent in another tenant).
  for (const row of rows) {
    if (!seen.has(row.id) && present.has(row.id)) {
      seen.add(row.id);
      out.push(row.id);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// The carried door
// ---------------------------------------------------------------------------

/**
 * A scope carried from the search page. `getCarriedScope` is owner-only
 * and 404s anything that is not this person's in this workspace, so the
 * read gate is settled before we get here; what this adds is the
 * re-read the 4a contract requires, because the stored ids were never
 * revalidated and a record can be deleted between the carry and the
 * export. Survivors keep the carried order.
 */
async function carriedMembers(
  db: DrizzleD1Database<any>,
  tenant: Tenant,
  user: User,
  carriedScopeId: string,
): Promise<{
  ids: string[];
  recordClass: ExportRecordClass;
  descriptor: ExportScopeDescriptor;
}> {
  const scope = await getCarriedScope(db, tenant, user, carriedScopeId);
  const recordClass = scope.recordType as ExportRecordClass;
  const ids = await revalidate(db, tenant, recordClass, scope.memberIds);

  return {
    ids,
    recordClass,
    descriptor: {
      kind: "carried",
      carriedScopeId,
      pills: scope.constraints.map((c) => c.label),
      // Where it was ticked, when it was not asked as a question.
      origin: scope.origin,
      // The faceted total at carry time, not the ticked count — the
      // pruned arithmetic's left-hand side. Equal when nothing was
      // unticked, which is what renders "all matches included".
      found: scope.found,
      unticked: Math.max(0, scope.found - scope.memberIds.length),
      willExport: ids.length,
      carriedAt: scope.createdAt,
    },
  };
}

/**
 * Spend a carried scope. Stamped when a RUN STARTS from it, never on
 * arrival at the export page: opening the page and changing your mind
 * must leave the selection where it was, and the recent-searches list
 * is precisely the unconsumed ones.
 */
export async function consumeCarriedScope(
  db: DrizzleD1Database<any>,
  tenant: Tenant,
  user: User,
  carriedScopeId: string,
  now: number = Date.now(),
): Promise<void> {
  await db
    .update(carriedScopes)
    .set({ consumedAt: now })
    .where(
      and(
        eq(carriedScopes.id, carriedScopeId),
        eq(carriedScopes.tenantId, tenant.id),
        eq(carriedScopes.userId, user.id),
      ),
    );
}

/**
 * Re-read a caller-supplied id list under this tenant, keeping the
 * caller's order. Descriptions key on the tenant; authorities go
 * through `authorityScope` and drop anything merged away, because a
 * merged record is not a record any more.
 */
async function revalidate(
  db: DrizzleD1Database<any>,
  tenant: Tenant,
  recordClass: ExportRecordClass,
  ids: string[],
): Promise<string[]> {
  if (ids.length === 0) return [];
  const alive = new Set<string>();

  for (const part of chunk(ids)) {
    if (recordClass === "records") {
      const rows = await db
        .select({ id: descriptions.id })
        .from(descriptions)
        .where(
          and(eq(descriptions.tenantId, tenant.id), inArray(descriptions.id, part)),
        )
        .all();
      for (const row of rows) alive.add(row.id);
    } else {
      const table = recordClass === "entities" ? entities : places;
      const rows = await db
        .select({ id: table.id })
        .from(table)
        .where(
          and(
            authorityScope(table, tenant.federationId, tenant.id),
            isNull(table.mergedInto),
            inArray(table.id, part),
          ),
        )
        .all();
      for (const row of rows) alive.add(row.id);
    }
  }

  return ids.filter((id) => alive.has(id));
}

// ---------------------------------------------------------------------------
// The handlist door
// ---------------------------------------------------------------------------

/**
 * A saved handlist, read through its own integrity pass. `getWithMembers`
 * resolves every member against the workspace as it stands now — merges
 * followed, splits flagged, deletions tombstoned — and answers the two
 * questions separately: what the handlist HOLDS and what would LEAVE.
 * The export takes the second, in handlist order.
 *
 * `listMemberIds` is the lighter read for a caller that only needs the
 * set, but it returns the membership as stored — tombstones included
 * and drift unresolved — so it is not the read an export can use. The
 * integrity pass is the gate, not an extra.
 *
 * A handlist with anything waiting on a decision refuses outright. The
 * handlist page disables its own export button on the same flag; this
 * is the server-side half of that gate, and it exists separately
 * because the export surface can be reached without passing the page.
 */
async function handlistMembersFor(
  db: DrizzleD1Database<any>,
  tenant: Tenant,
  user: User,
  handlistId: string,
): Promise<{
  ids: string[];
  recordClass: ExportRecordClass;
  descriptor: ExportScopeDescriptor;
}> {
  const detail = await getWithMembers(db, tenant, user, handlistId);

  if (detail.recordType === null) {
    throw new ExportScopeError(
      "handlist-untyped",
      "This handlist has no members yet, so it has no type to export as",
    );
  }
  if (detail.needsReview) {
    throw new ExportScopeError(
      "handlist-needs-review",
      "This handlist has members waiting on a decision",
    );
  }

  const ids = detail.members
    .filter((m) => m.exportable && m.resolvedId !== null)
    .map((m) => m.resolvedId as string);

  if (ids.length === 0) {
    throw new ExportScopeError("handlist-empty", "Nothing in this handlist would export");
  }

  return {
    ids,
    recordClass: detail.recordType as ExportRecordClass,
    descriptor: {
      kind: "handlist",
      handlistId,
      name: detail.name,
      total: detail.total,
      exportable: detail.exportable,
    },
  };
}

// ---------------------------------------------------------------------------
// Linked authorities and links
// ---------------------------------------------------------------------------

/**
 * The authorities a set of descriptions cites, and how many link rows
 * bind them. Merged-away authorities are excluded: a link to a record
 * that no longer stands is not something to hand a partner.
 *
 * Ordered by sort name / label so the artifact's authority block reads
 * as a list rather than as insertion noise.
 */
async function linkedAuthorities(
  db: DrizzleD1Database<any>,
  tenant: Tenant,
  descriptionIds: string[] | null,
): Promise<{ entityIds: string[]; placeIds: string[]; links: number }> {
  const entityIds = new Map<string, string>();
  const placeIds = new Map<string, string>();
  let links = 0;

  const parts = descriptionIds === null ? [null] : chunk(descriptionIds);
  for (const part of parts) {
    const entityRows = await db
      .selectDistinct({ id: entities.id, sortName: entities.sortName })
      .from(entities)
      .innerJoin(descriptionEntities, eq(descriptionEntities.entityId, entities.id))
      .innerJoin(descriptions, eq(descriptions.id, descriptionEntities.descriptionId))
      .where(
        and(
          eq(descriptions.tenantId, tenant.id),
          authorityScope(entities, tenant.federationId, tenant.id),
          isNull(entities.mergedInto),
          ...(part === null ? [] : [inArray(descriptions.id, part)]),
        ),
      )
      .all();
    for (const row of entityRows) entityIds.set(row.id, row.sortName);

    const placeRows = await db
      .selectDistinct({ id: places.id, label: places.label })
      .from(places)
      .innerJoin(descriptionPlaces, eq(descriptionPlaces.placeId, places.id))
      .innerJoin(descriptions, eq(descriptions.id, descriptionPlaces.descriptionId))
      .where(
        and(
          eq(descriptions.tenantId, tenant.id),
          authorityScope(places, tenant.federationId, tenant.id),
          isNull(places.mergedInto),
          ...(part === null ? [] : [inArray(descriptions.id, part)]),
        ),
      )
      .all();
    for (const row of placeRows) placeIds.set(row.id, row.label);

    links += await countLinksForDescriptions(db, tenant, part);
  }

  return {
    entityIds: sortedByValue(entityIds),
    placeIds: sortedByValue(placeIds),
    links,
  };
}

/** Link rows bound to a set of descriptions (or to all of them). */
async function countLinksForDescriptions(
  db: DrizzleD1Database<any>,
  tenant: Tenant,
  descriptionIds: string[] | null,
): Promise<number> {
  const entityLinks = await db
    .select({ n: sql<number>`count(*)` })
    .from(descriptionEntities)
    .innerJoin(descriptions, eq(descriptions.id, descriptionEntities.descriptionId))
    .innerJoin(entities, eq(entities.id, descriptionEntities.entityId))
    .where(
      and(
        eq(descriptions.tenantId, tenant.id),
        authorityScope(entities, tenant.federationId, tenant.id),
        isNull(entities.mergedInto),
        ...(descriptionIds === null ? [] : [inArray(descriptions.id, descriptionIds)]),
      ),
    )
    .get();

  const placeLinks = await db
    .select({ n: sql<number>`count(*)` })
    .from(descriptionPlaces)
    .innerJoin(descriptions, eq(descriptions.id, descriptionPlaces.descriptionId))
    .innerJoin(places, eq(places.id, descriptionPlaces.placeId))
    .where(
      and(
        eq(descriptions.tenantId, tenant.id),
        authorityScope(places, tenant.federationId, tenant.id),
        isNull(places.mergedInto),
        ...(descriptionIds === null ? [] : [inArray(descriptions.id, descriptionIds)]),
      ),
    )
    .get();

  return (entityLinks?.n ?? 0) + (placeLinks?.n ?? 0);
}

/**
 * How many description links an authority scope carries — the card's
 * "and their 212 description links". Only links whose description
 * belongs to this workspace count: an authority may be federation-
 * shared, but another tenant's use of it is not this export's business.
 */
async function countLinksForAuthorities(
  db: DrizzleD1Database<any>,
  tenant: Tenant,
  recordClass: ExportRecordClass,
  authorityIds: string[],
): Promise<number> {
  let total = 0;
  for (const part of chunk(authorityIds)) {
    if (recordClass === "entities") {
      const row = await db
        .select({ n: sql<number>`count(*)` })
        .from(descriptionEntities)
        .innerJoin(descriptions, eq(descriptions.id, descriptionEntities.descriptionId))
        .where(
          and(
            eq(descriptions.tenantId, tenant.id),
            inArray(descriptionEntities.entityId, part),
          ),
        )
        .get();
      total += row?.n ?? 0;
    } else {
      const row = await db
        .select({ n: sql<number>`count(*)` })
        .from(descriptionPlaces)
        .innerJoin(descriptions, eq(descriptions.id, descriptionPlaces.descriptionId))
        .where(
          and(
            eq(descriptions.tenantId, tenant.id),
            inArray(descriptionPlaces.placeId, part),
          ),
        )
        .get();
      total += row?.n ?? 0;
    }
  }
  return total;
}

function sortedByValue(map: Map<string, string>): string[] {
  return [...map.entries()]
    .sort((a, b) => a[1].localeCompare(b[1]) || a[0].localeCompare(b[0]))
    .map(([id]) => id);
}

// ---------------------------------------------------------------------------
// The one entry point
// ---------------------------------------------------------------------------

/**
 * Resolve a door to what will leave: ordered member ids, the authority
 * sets the artifact carries, the counts the confirm bar states, and the
 * descriptor the ledger row keeps.
 *
 * The four doors differ only in how the member list is produced. What
 * happens afterwards — which authorities ride along, how the links are
 * counted — is one rule, keyed on the record class, so an authority
 * handlist and an authority carry behave identically.
 */
export async function resolveExportScope(
  db: DrizzleD1Database<any>,
  tenant: Tenant,
  user: User,
  request: ExportScopeRequest,
  options: ResolveExportScopeOptions,
): Promise<ResolvedExportScope> {
  let memberIds: string[];
  let recordClass: ExportRecordClass = "records";
  let descriptor: ExportScopeDescriptor;

  switch (request.kind) {
    case "workspace": {
      memberIds = await workspaceMembers(db, tenant);
      descriptor = { kind: "workspace" };
      break;
    }
    case "branch": {
      const branch = await branchMembers(db, tenant, request.descriptionId);
      memberIds = branch.ids;
      descriptor = branch.descriptor;
      break;
    }
    case "carried": {
      const carried = await carriedMembers(db, tenant, user, request.carriedScopeId);
      memberIds = carried.ids;
      recordClass = carried.recordClass;
      descriptor = carried.descriptor;
      break;
    }
    case "handlist": {
      const handlist = await handlistMembersFor(db, tenant, user, request.handlistId);
      memberIds = handlist.ids;
      recordClass = handlist.recordClass;
      descriptor = handlist.descriptor;
      break;
    }
  }

  if (memberIds.length === 0) {
    throw new ExportScopeError("scope-empty", "This scope holds nothing to export");
  }

  if (recordClass === "records") {
    // The whole workspace needs no id list: the tenant predicate alone
    // is the set, and handing 5,602 ids to a join it could reach
    // without them would cost sixty statements to say the same thing.
    const scoped = request.kind === "workspace" ? null : memberIds;
    const linked = options.includeAuthorities
      ? await linkedAuthorities(db, tenant, scoped)
      : { entityIds: [], placeIds: [], links: 0 };
    return {
      kind: request.kind,
      recordClass,
      memberIds,
      entityIds: linked.entityIds,
      placeIds: linked.placeIds,
      counts: {
        records: memberIds.length,
        entities: linked.entityIds.length,
        places: linked.placeIds.length,
        links: linked.links,
      },
      descriptor,
    };
  }

  // An authority scope: the members are the authorities, the toggle is
  // Not applicable, and the links are always named.
  const links = await countLinksForAuthorities(db, tenant, recordClass, memberIds);
  const isEntities = recordClass === "entities";
  return {
    kind: request.kind,
    recordClass,
    memberIds,
    entityIds: isEntities ? memberIds : [],
    placeIds: isEntities ? [] : memberIds,
    counts: {
      records: 0,
      entities: isEntities ? memberIds.length : 0,
      places: isEntities ? 0 : memberIds.length,
      links,
    },
    descriptor,
  };
}

/* @version v0.7.0 */
