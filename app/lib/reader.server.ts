/**
 * Reader — the read-only role and its published-records reads
 *
 * This module deals with the Reader role (the `isArchiveUser` flag)
 * and with every database read the Reader pages under `/records` make.
 * It has three jobs.
 *
 * WHO A MEMBER IS. `memberAccessFrom` sorts a signed-in member into one
 * of three kinds. `staff` holds a staff role flag (workspace admin,
 * super admin, collaborative cataloguing admin, user manager or
 * cataloguer) or an area-admin flag (records, authorities, imports or
 * digitization), a project membership in the request tenant, a capture QC
 * review assignment on one of its volumes, a federation membership in
 * its federation, or a federation grant into it; an operator inside an impersonation
 * envelope counts as staff too, so that path is unchanged. `reader`
 * holds the Reader flag and nothing else. `none` holds nothing at all.
 * `memberAccess` is the same rule with those reads done for it. A Reader who also holds a staff role is staff: the
 * Reader flag adds the `/records` pages and takes nothing away.
 *
 * WHERE A MEMBER MAY GO. `confineMemberAccess` is a middleware that
 * runs on the authenticated layout right after `authMiddleware`. Staff
 * pass untouched. A Reader may open `/records` and its pages and
 * `/configuracion` (their own settings); a member with no access may
 * open `/no-access` and `/configuracion`. On any other path a document
 * navigation is redirected to the member's landing (`/records` or
 * `/no-access`) and every other request is refused with 403: data
 * requests (`.data`), fetchers, resource routes fetched by script, and
 * writes. `isDocumentNavigation` tells the two apart. React Router
 * hands middleware a data request with `.data` already stripped from its
 * URL and the browser's headers copied over, so the URL cannot say which
 * kind it is; the headers can. The signal is `Sec-Fetch-Dest: document`,
 * which every current browser sends on a top-level navigation and never
 * on `fetch()`. A request with no fetch metadata at all (an old browser,
 * a script) counts as a navigation only when it is a GET or HEAD that
 * asks for `text/html`. A prefetch or prerender (a `Sec-Purpose` naming
 * either, or the older `Purpose: prefetch`) is never a navigation,
 * whatever else it carries: the browser is fetching ahead, not showing
 * a page, so it is refused rather than redirected. A navigation typed straight at a resource
 * route's address is still a document navigation and is redirected.
 * The confinement does not rest on
 * each route's own guard, because several surfaces are member-level by
 * design (search, handlists, exports, the dashboard) and would show a
 * Reader unpublished records.
 *
 * WHO MAY OPEN THE RECORDS PAGES. `canReadRecords` admits a Reader and
 * whoever passes the records area (`canAdministerArea`): a workspace
 * admin (`isAdmin`, which a federation steward's grant also carries), a
 * super admin or a records admin; `requireRecordsReader` throws 403 for
 * anyone else.
 *
 * PUBLISHED ONLY. Every read below filters on
 * `descriptions.is_published = 1` and on the request tenant, in the
 * same statement as the read, whoever is asking: the filter belongs to
 * the pages, not to the person, so a workspace admin on `/records`
 * sees exactly what a Reader sees. An unpublished record is a 404; an
 * unpublished child is neither listed nor counted; the ancestor trail
 * stops at the first unpublished ancestor, so its title is never read
 * out. A published record whose parent is unpublished therefore stands
 * at the top of the published tree, and `listPublishedEntryRecords`
 * lists it among the entry points beside the published records that
 * have no parent at all.
 *
 * EVERY STATEMENT CHECKS PUBLICATION ITSELF. The record is read first,
 * but none of the follow-up reads (its repository, its children, its
 * entity and place links) relies on that earlier read: each one repeats
 * the request tenant and `is_published = 1` for the record it hangs
 * from, in its own statement, so a record unpublished between two reads
 * shows nothing from the later ones. Each ancestor read checks the
 * ancestor's own publication the same way.
 *
 * AUTHORITIES BY VISIBILITY. Linked entities and places are read
 * through `authorityScope` with the request tenant's federation and the
 * request tenant as owner, as every other authority read is: a link to
 * another federation's authority, or to an authority another member
 * tenant owns, is not shown.
 *
 * REFERENCE CODES ARE SHOWN WHOLE. A published record's reference code
 * is shown as stored, including any prefix it shares with an
 * unpublished parent. The Zasqua export publishes a published record's
 * full reference code, so the Reader pages show nothing the public site
 * does not.
 *
 * The record handed to the page carries no internal column: the
 * finding aid's `NEVER_RENDERED` list is stripped from it (except `id`
 * and `repositoryId`, which the page needs to link and to name the
 * repository), and its `childCount` is replaced by the count of
 * published children.
 *
 * @version v0.8.0
 */

import { redirect } from "react-router";
import type { MiddlewareFunction } from "react-router";
import { and, asc, count, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import {
  descriptions,
  descriptionEntities,
  descriptionPlaces,
  entities,
  federationMemberships,
  captureQcReviewers,
  places,
  projectMembers,
  projects,
  repositories,
} from "../db/schema";
import {
  grantContext,
  impersonationContext,
  tenantContext,
  userContext,
  type User,
} from "../context";
import { NEVER_RENDERED } from "./export/finding-aid.server";
import { authorityScope } from "./authority-ownership.server";
import {
  AREA_ADMIN_FLAGS,
  canAdministerArea,
  type AccessUser,
  type AreaFlag,
} from "./user-access.server";

/** The three kinds of member, as `memberAccessFrom` sorts them. */
export type MemberAccess = "staff" | "reader" | "none";

/** Rows per page on the records list and on a record's contents. */
export const READER_PAGE_SIZE = 50;

/** Where a Reader with no other role lands. */
export const READER_LANDING = "/records";

/** Where a member with no access lands. */
export const NO_ACCESS_LANDING = "/no-access";

/** Deepest ancestor trail read, as on the admin description page. */
const MAX_ANCESTOR_DEPTH = 10;

/**
 * Sorts a member by what they hold. Pure: the caller supplies whether
 * the member has a project membership in the request tenant, a capture
 * QC review assignment on one of its volumes (counted only where the
 * tenant has the digitization capability), a federation membership in
 * its federation, a federation grant into it, or an impersonation
 * envelope. Each of these gives a member work without a role flag, so
 * each makes them staff.
 */
export function memberAccessFrom(
  user: Pick<
    User,
    | "isAdmin"
    | "isSuperAdmin"
    | "isCollabAdmin"
    | "isUserManager"
    | "isCataloguer"
    | "isArchiveUser"
    | AreaFlag
  >,
  held: {
    hasProjectMembership: boolean;
    isCaptureReviewer: boolean;
    hasFederationMembership: boolean;
    hasGrant: boolean;
    isImpersonating: boolean;
  },
): MemberAccess {
  if (
    user.isAdmin ||
    user.isSuperAdmin ||
    user.isCollabAdmin ||
    user.isUserManager ||
    user.isCataloguer ||
    Object.values(AREA_ADMIN_FLAGS).some((flag) => user[flag]) ||
    held.hasProjectMembership ||
    held.isCaptureReviewer ||
    held.hasFederationMembership ||
    held.hasGrant ||
    held.isImpersonating
  ) {
    return "staff";
  }
  return user.isArchiveUser ? "reader" : "none";
}

/**
 * `memberAccessFrom` with the reads done here, for a member with no
 * staff flag, grant or envelope only. Three reads, each scoped to the
 * request tenant: a project membership in one of its projects; a capture
 * QC review assignment on one of its volumes, read only where the tenant
 * has the digitization capability (elsewhere the capture screens are
 * gone, so the assignment gives no work); a federation membership, as
 * steward or staff, in its federation. The last covers a member reached
 * on their home tenant, where no grant is resolved but a steward
 * membership still makes them a capture manager and a federation
 * steward.
 */
export async function memberAccess(
  db: DrizzleD1Database<any>,
  tenant: { id: string; federationId: string; digitizationEnabled: boolean },
  user: User,
  held: { hasGrant: boolean; isImpersonating: boolean },
): Promise<MemberAccess> {
  const withoutReads = memberAccessFrom(user, {
    ...held,
    hasProjectMembership: false,
    isCaptureReviewer: false,
    hasFederationMembership: false,
  });
  if (withoutReads === "staff") return "staff";
  const [membership, review, federation] = await Promise.all([
    db
      .select({ id: projectMembers.id })
      .from(projectMembers)
      .innerJoin(projects, eq(projectMembers.projectId, projects.id))
      .where(and(eq(projectMembers.userId, user.id), eq(projects.tenantId, tenant.id)))
      .limit(1)
      .all(),
    tenant.digitizationEnabled
      ? db
          .select({ id: captureQcReviewers.pipelineVolumeId })
          .from(captureQcReviewers)
          .where(
            and(
              eq(captureQcReviewers.tenantId, tenant.id),
              eq(captureQcReviewers.reviewerId, user.id),
            ),
          )
          .limit(1)
          .all()
      : Promise.resolve([]),
    db
      .select({ id: federationMemberships.id })
      .from(federationMemberships)
      .where(
        and(
          eq(federationMemberships.userId, user.id),
          eq(federationMemberships.federationId, tenant.federationId),
        ),
      )
      .limit(1)
      .all(),
  ]);
  return memberAccessFrom(user, {
    ...held,
    hasProjectMembership: membership.length > 0,
    isCaptureReviewer: review.length > 0,
    hasFederationMembership: federation.length > 0,
  });
}

function underPath(pathname: string, base: string): boolean {
  return pathname === base || pathname.startsWith(`${base}/`);
}

/** True when a member of this kind may open this path. */
export function memberMayOpen(access: MemberAccess, pathname: string): boolean {
  if (access === "staff") return true;
  if (underPath(pathname, "/configuracion")) return true;
  if (access === "reader") return underPath(pathname, READER_LANDING);
  return underPath(pathname, NO_ACCESS_LANDING);
}

/**
 * True for a browser's top-level page navigation: a GET or HEAD whose
 * `Sec-Fetch-Dest` is `document`, or, when the request carries no fetch
 * metadata, one that accepts `text/html`. A request that declares a
 * prefetch or prerender purpose is never one.
 */
export function isDocumentNavigation(request: Request): boolean {
  if (request.method !== "GET" && request.method !== "HEAD") return false;
  const purpose = `${request.headers.get("Sec-Purpose") ?? ""} ${
    request.headers.get("Purpose") ?? ""
  }`.toLowerCase();
  if (purpose.includes("prefetch") || purpose.includes("prerender")) return false;
  const dest = request.headers.get("Sec-Fetch-Dest");
  if (dest !== null) return dest === "document";
  if (request.headers.get("Sec-Fetch-Mode") !== null) return false;
  return (request.headers.get("Accept") ?? "").includes("text/html");
}

/**
 * Keeps Readers inside `/records` and members with no access on
 * `/no-access`. Runs after `authMiddleware`, which has already set the
 * user, tenant, grant and impersonation contexts.
 */
export const confineMemberAccess: MiddlewareFunction = async ({
  request,
  context,
}) => {
  const user = context.get(userContext);
  const tenant = context.get(tenantContext);
  const access = await memberAccess(
    drizzle(context.cloudflare.env.DB),
    tenant,
    user,
    {
      hasGrant: context.get(grantContext) !== null,
      isImpersonating: context.get(impersonationContext) !== null,
    },
  );
  const pathname = new URL(request.url).pathname;
  if (memberMayOpen(access, pathname)) return;
  if (isDocumentNavigation(request)) {
    throw redirect(access === "reader" ? READER_LANDING : NO_ACCESS_LANDING);
  }
  throw new Response("Forbidden", { status: 403 });
};

/** Readers and those who pass the records area open the records pages. */
export function canReadRecords(user: Pick<User, "isArchiveUser"> & AccessUser): boolean {
  return user.isArchiveUser || canAdministerArea(user, "records");
}

/** Throws 403 unless `canReadRecords`. */
export function requireRecordsReader(user: User): void {
  if (!canReadRecords(user)) {
    throw new Response("Forbidden", { status: 403 });
  }
}

/** One row of a records list: a published record's heading. */
export interface PublishedRecordRow {
  id: string;
  title: string;
  referenceCode: string;
  descriptionLevel: string;
  dateExpression: string | null;
}

const rowColumns = {
  id: descriptions.id,
  title: descriptions.title,
  referenceCode: descriptions.referenceCode,
  descriptionLevel: descriptions.descriptionLevel,
  dateExpression: descriptions.dateExpression,
};

function pageOffset(page: number): number {
  return (Math.max(1, Math.floor(page)) - 1) * READER_PAGE_SIZE;
}

/**
 * True in a statement when `recordId` names a published record of the
 * tenant. Used by every follow-up read on the record page so that each
 * statement checks publication for itself.
 */
function recordIsPublished(tenantId: string, recordId: string) {
  return sql`EXISTS (SELECT 1 FROM descriptions r WHERE r.id = ${recordId} AND r.tenant_id = ${tenantId} AND r.is_published = 1)`;
}

/**
 * The entry points into the published tree: published records of the
 * tenant whose parent is not a published record of the tenant (no
 * parent, or an unpublished one). One page, ordered by reference code,
 * with the total under the same filter.
 */
export async function listPublishedEntryRecords(
  db: DrizzleD1Database<any>,
  tenantId: string,
  page: number,
): Promise<{ rows: PublishedRecordRow[]; total: number }> {
  // Reference codes are listed whole, as the Zasqua export publishes them.
  const where = and(
    eq(descriptions.tenantId, tenantId),
    eq(descriptions.isPublished, true),
    sql`NOT EXISTS (SELECT 1 FROM descriptions p WHERE p.id = ${descriptions.parentId} AND p.tenant_id = ${descriptions.tenantId} AND p.is_published = 1)`,
  );
  const [rows, totals] = await Promise.all([
    db
      .select(rowColumns)
      .from(descriptions)
      .where(where)
      .orderBy(asc(descriptions.referenceCode))
      .limit(READER_PAGE_SIZE)
      .offset(pageOffset(page))
      .all(),
    db.select({ n: count() }).from(descriptions).where(where).all(),
  ]);
  return { rows, total: totals[0]?.n ?? 0 };
}

/**
 * One page of a record's published children, in the hierarchy's own
 * order, with the count of published children.
 */
export async function listPublishedChildren(
  db: DrizzleD1Database<any>,
  tenantId: string,
  parentId: string,
  page: number,
): Promise<{ rows: PublishedRecordRow[]; total: number }> {
  // The parent's publication is checked in this same statement, and
  // reference codes are listed whole, as the Zasqua export publishes them.
  const where = and(
    eq(descriptions.tenantId, tenantId),
    eq(descriptions.parentId, parentId),
    eq(descriptions.isPublished, true),
    recordIsPublished(tenantId, parentId),
  );
  const [rows, totals] = await Promise.all([
    db
      .select(rowColumns)
      .from(descriptions)
      .where(where)
      .orderBy(asc(descriptions.position), asc(descriptions.referenceCode))
      .limit(READER_PAGE_SIZE)
      .offset(pageOffset(page))
      .all(),
    db.select({ n: count() }).from(descriptions).where(where).all(),
  ]);
  return { rows, total: totals[0]?.n ?? 0 };
}

/** A record's entity link as the Reader page shows it: names, no ids to follow. */
export interface ReaderEntityLink {
  id: string;
  descriptionId: string;
  entityId: string;
  role: string;
  roleNote: string | null;
  sequence: number;
  honorific: string | null;
  function: string | null;
  nameAsRecorded: string | null;
  createdAt: number;
  entityDisplayName: string;
  entityCode: string | null;
}

/** A record's place link as the Reader page shows it. */
export interface ReaderPlaceLink {
  id: string;
  descriptionId: string;
  placeId: string;
  role: string;
  roleNote: string | null;
  createdAt: number;
  placeLabel: string;
  placeCode: string | null;
}

/** The ancestor trail's entries: published ancestors only. */
export interface ReaderAncestor {
  id: string;
  title: string;
}

/**
 * Everything the record page shows, or null when the id names no
 * published record of the tenant. The ancestor trail is read upwards
 * one published parent at a time and stops at the first parent that
 * is not a published record of the tenant.
 */
export async function loadPublishedRecord(
  db: DrizzleD1Database<any>,
  tenant: { id: string; federationId: string },
  id: string,
  childPage: number,
) {
  const tenantId = tenant.id;
  // The record as stored, its reference code whole: the Zasqua export
  // publishes a published record's full reference code.
  const row = await db
    .select()
    .from(descriptions)
    .where(
      and(
        eq(descriptions.tenantId, tenantId),
        eq(descriptions.id, id),
        eq(descriptions.isPublished, true),
      ),
    )
    .get();
  if (!row) return null;

  const ancestors: ReaderAncestor[] = [];
  let parentId = row.parentId;
  let depth = 0;
  while (parentId && depth < MAX_ANCESTOR_DEPTH) {
    const ancestor = await db
      .select({
        id: descriptions.id,
        title: descriptions.title,
        parentId: descriptions.parentId,
      })
      .from(descriptions)
      .where(
        and(
          eq(descriptions.tenantId, tenantId),
          eq(descriptions.id, parentId),
          eq(descriptions.isPublished, true),
          recordIsPublished(tenantId, row.id),
        ),
      )
      .get();
    if (!ancestor) break;
    ancestors.unshift({ id: ancestor.id, title: ancestor.title });
    parentId = ancestor.parentId;
    depth++;
  }

  const [children, repository, entityLinks, placeLinks] = await Promise.all([
    listPublishedChildren(db, tenantId, row.id, childPage),
    db
      .select({ id: repositories.id, name: repositories.name })
      .from(repositories)
      .where(
        and(
          eq(repositories.tenantId, tenantId),
          eq(repositories.id, row.repositoryId),
          recordIsPublished(tenantId, row.id),
        ),
      )
      .get(),
    db
      .select({
        id: descriptionEntities.id,
        descriptionId: descriptionEntities.descriptionId,
        entityId: descriptionEntities.entityId,
        role: descriptionEntities.role,
        roleNote: descriptionEntities.roleNote,
        sequence: descriptionEntities.sequence,
        honorific: descriptionEntities.honorific,
        function: descriptionEntities.function,
        nameAsRecorded: descriptionEntities.nameAsRecorded,
        createdAt: descriptionEntities.createdAt,
        entityDisplayName: entities.displayName,
        entityCode: entities.entityCode,
      })
      .from(descriptionEntities)
      .innerJoin(descriptions, eq(descriptionEntities.descriptionId, descriptions.id))
      .innerJoin(entities, eq(descriptionEntities.entityId, entities.id))
      .where(
        and(
          eq(descriptionEntities.descriptionId, row.id),
          eq(descriptions.tenantId, tenantId),
          eq(descriptions.isPublished, true),
          authorityScope(entities, tenant.federationId, tenantId),
        ),
      )
      .orderBy(descriptionEntities.sequence)
      .all(),
    db
      .select({
        id: descriptionPlaces.id,
        descriptionId: descriptionPlaces.descriptionId,
        placeId: descriptionPlaces.placeId,
        role: descriptionPlaces.role,
        roleNote: descriptionPlaces.roleNote,
        createdAt: descriptionPlaces.createdAt,
        placeLabel: places.label,
        placeCode: places.placeCode,
      })
      .from(descriptionPlaces)
      .innerJoin(descriptions, eq(descriptionPlaces.descriptionId, descriptions.id))
      .innerJoin(places, eq(descriptionPlaces.placeId, places.id))
      .where(
        and(
          eq(descriptionPlaces.descriptionId, row.id),
          eq(descriptions.tenantId, tenantId),
          eq(descriptions.isPublished, true),
          authorityScope(places, tenant.federationId, tenantId),
        ),
      )
      .orderBy(descriptionPlaces.createdAt)
      .all(),
  ]);

  const record: Record<string, unknown> & {
    id: string;
    title: string;
    referenceCode: string;
    descriptionLevel: string;
    repositoryId: string;
    childCount: number;
  } = {
    ...Object.fromEntries(
      Object.entries(row).filter(
        ([column]) =>
          column === "id" || column === "repositoryId" || !NEVER_RENDERED.has(column),
      ),
    ),
    id: row.id,
    title: row.title,
    referenceCode: row.referenceCode,
    descriptionLevel: row.descriptionLevel,
    repositoryId: row.repositoryId,
    childCount: children.total,
  };

  return {
    record,
    ancestors,
    children,
    repositories: repository ? [repository] : [],
    entityLinks: entityLinks as ReaderEntityLink[],
    placeLinks: placeLinks as ReaderPlaceLink[],
  };
}

/** Columns the record page never renders: the finding aid's list, less the repository. */
export function readerHiddenColumns(): string[] {
  return [...NEVER_RENDERED].filter((column) => column !== "repositoryId");
}

// @version v0.8.0
