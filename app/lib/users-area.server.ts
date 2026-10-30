/**
 * Users Area — Who Works Where
 *
 * This module deals with the reads behind the two pages of the users
 * area, the list at `/admin/users` and one person at `/admin/users/:id`.
 * Both pages describe a person's access by AREA of the workspace —
 * Platform, Federation, Records management, Authorities, Cataloguing,
 * Digitization, Imports and exports — rather than by the role flags
 * one at a time. Every read is scoped to the request tenant; nothing
 * here writes.
 *
 * `workspaceAreas` names the areas a workspace has: Platform,
 * Federation and Records management always, the other four only when
 * the tenant capability behind them is on. An area the workspace does
 * not have is neither badged, offered as a filter, nor shown as a
 * section, so a flag left over from before a capability was switched
 * off does not read as access.
 *
 * `accessBadges` turns what is known about a person into one badge per
 * area, in two kinds: `administers` (the person runs the area) and
 * `works` (the person works in it). The mapping, area by area:
 *
 *   - Platform: super admin or user manager administers.
 *   - Federation: a `steward` membership in the tenant's federation
 *     administers, a `staff` one works.
 *   - Records management, Authorities, Cataloguing, Digitization and
 *     Imports and exports: a workspace admin (`isAdmin`) or super admin
 *     administers each of them, as `canAdministerArea` and
 *     `requireCollabAdmin` let both through every area.
 *   - Records management: records admin administers; the Reader
 *     (`isArchiveUser`) works.
 *   - Authorities: authorities admin administers.
 *   - Cataloguing: cataloguing admin (`isCollabAdmin`) administers; a
 *     cataloguer, or anyone with a project membership in the tenant's
 *     projects, works.
 *   - Digitization: digitization admin administers; the assigned capture
 *     QC reviewer of one of the tenant's volumes works. The state of
 *     each volume a person reviews comes from `loadVolumeScreenStates`,
 *     which reads those volumes only.
 *   - Imports and exports: imports admin administers.
 *
 * Where a person qualifies both ways, the area shows `administers`.
 *
 * `loadUsersList` reads the list: the tenant's own people with their
 * badges and last activity, and, separately, the people of other
 * workspaces who hold a membership in the tenant's federation, with
 * their home workspace and their access here. Those are read-only on
 * this page — their profiles belong to their own workspace — and a
 * membership in any other federation never brings anyone into either
 * group. The search (name or email) and the area filter apply to both
 * groups; the head counts do not. Reviewer assignments are read only
 * when the workspace has the Digitization area.
 *
 * `loadUserDetailAccess` reads what the detail page shows below the
 * profile, for one person of the tenant and one viewer. Which sections
 * the viewer sees is `visibleDetailSections`: Platform to super admins
 * and user managers, Federation to stewards of the tenant's federation
 * and super admins, the workspace areas to workspace admins and super
 * admins — and Cataloguing also to user managers, whose job the project
 * assignment there is. A section the viewer may not see is not read,
 * so its data never reaches the page. `detailRoles` lists each visible
 * section's roles with the person's current state; each of the ten role
 * flags carries its form field, and the two federation roles carry
 * none, as the page posts them together as one value.
 *
 * The access history comes from `audit_log` only (`loadAccessHistory`):
 * the `create_tenant` row that set the person up as the workspace's
 * first admin (matched on the bootstrap email it records), read as its
 * two grants, workspace admin and super admin, by the operator who
 * created the workspace; and the rows
 * about the person in this workspace of the four access actions —
 * `set_user_role`, `set_federation_role`, `set_project_membership` and
 * `invite_user` — each with the name of whoever made the change. An
 * entry about an area the viewer does not see is left out, as its
 * section is: a role flag, or an invitation's opening role, goes with
 * the section that shows that role, a federation change with
 * Federation, a project change with Cataloguing. An invitation with no
 * role names none, and every viewer sees it.
 *
 * @version v0.8.0
 */

import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import {
  auditLog,
  captureQcReviewers,
  federationMemberships,
  pipelineVolumes,
  projectMembers,
  projects,
  tenants,
  users,
} from "../db/schema";
import type { Tenant, User } from "../context";
import { isFederationSteward, type FederationRole } from "./federation.server";
import { federationNameOf, loadVolumeScreenStates, personName } from "./capture/screens.server";
import type { ScreenState } from "./capture/screens";
import type { RoleFlag } from "./permissions.server";
import { PROJECT_ROLES, type ProjectRole } from "./validation/enums";

/** The areas of the users area, in the order the pages show them. */
export const USERS_AREAS = [
  "platform",
  "federation",
  "records",
  "authorities",
  "cataloguing",
  "digitization",
  "imports",
] as const;

export type UsersArea = (typeof USERS_AREAS)[number];

/** Whether a badge says the person runs the area or works in it. */
export type BadgeKind = "administers" | "works";

export interface AreaBadge {
  area: UsersArea;
  kind: BadgeKind;
}

/** What `accessBadges` reads about a person. */
export interface BadgeFacts {
  isAdmin: boolean;
  isSuperAdmin: boolean;
  isUserManager: boolean;
  isCollabAdmin: boolean;
  isCataloguer: boolean;
  isArchiveUser: boolean;
  isRecordsAdmin: boolean;
  isAuthoritiesAdmin: boolean;
  isImportsAdmin: boolean;
  isDigitizationAdmin: boolean;
  /** The person's role in the tenant's federation, or null. */
  federationRole: FederationRole | null;
  /** Memberships in the tenant's projects. */
  projectCount: number;
  /** The tenant's volumes the person is the capture QC reviewer of. */
  reviewedVolumeCount: number;
}

type AreaCapabilities = Pick<
  Tenant,
  "crowdsourcingEnabled" | "authoritiesEnabled" | "digitizationEnabled" | "importsEnabled"
>;

/** The areas this workspace has, in page order. */
export function workspaceAreas(tenant: AreaCapabilities): UsersArea[] {
  return USERS_AREAS.filter((area) => {
    switch (area) {
      case "authorities":
        return tenant.authoritiesEnabled;
      case "cataloguing":
        return tenant.crowdsourcingEnabled;
      case "digitization":
        return tenant.digitizationEnabled;
      case "imports":
        return tenant.importsEnabled;
      default:
        return true;
    }
  });
}

function badgeKind(area: UsersArea, f: BadgeFacts): BadgeKind | null {
  // Workspace admins and super admins pass every workspace area.
  const everyArea = f.isAdmin || f.isSuperAdmin;
  switch (area) {
    case "platform":
      return f.isSuperAdmin || f.isUserManager ? "administers" : null;
    case "federation":
      return f.federationRole === "steward"
        ? "administers"
        : f.federationRole === "staff"
          ? "works"
          : null;
    case "records":
      if (everyArea || f.isRecordsAdmin) return "administers";
      return f.isArchiveUser ? "works" : null;
    case "authorities":
      return everyArea || f.isAuthoritiesAdmin ? "administers" : null;
    case "cataloguing":
      if (everyArea || f.isCollabAdmin) return "administers";
      return f.isCataloguer || f.projectCount > 0 ? "works" : null;
    case "digitization":
      if (everyArea || f.isDigitizationAdmin) return "administers";
      return f.reviewedVolumeCount > 0 ? "works" : null;
    case "imports":
      return everyArea || f.isImportsAdmin ? "administers" : null;
  }
}

/** One badge per area of `areas` the person has access to, in page order. */
export function accessBadges(facts: BadgeFacts, areas: readonly UsersArea[]): AreaBadge[] {
  const out: AreaBadge[] = [];
  for (const area of USERS_AREAS) {
    if (!areas.includes(area)) continue;
    const kind = badgeKind(area, facts);
    if (kind) out.push({ area, kind });
  }
  return out;
}

/** Reads `?area=` leniently: anything that is not one of the areas means all of them. */
export function parseAreaFilter(value: string | null): UsersArea | null {
  return (USERS_AREAS as readonly string[]).includes(value ?? "") ? (value as UsersArea) : null;
}

const NO_FLAGS = {
  isAdmin: false,
  isSuperAdmin: false,
  isUserManager: false,
  isCollabAdmin: false,
  isCataloguer: false,
  isArchiveUser: false,
  isRecordsAdmin: false,
  isAuthoritiesAdmin: false,
  isImportsAdmin: false,
  isDigitizationAdmin: false,
};

// ---------------------------------------------------------------------------
// The list
// ---------------------------------------------------------------------------

export interface UsersListPerson {
  id: string;
  /** The name, or the email when there is none. */
  name: string;
  email: string;
  lastActiveAt: number | null;
  badges: AreaBadge[];
}

export interface FederationPerson {
  id: string;
  name: string;
  homeWorkspace: string;
  federationRole: FederationRole;
  badges: AreaBadge[];
  reviewedVolumeCount: number;
}

export interface UsersList {
  workspaceName: string;
  federationName: string | null;
  /** The tenant's people, before the search and the filter. */
  peopleCount: number;
  /** The federation's people from other workspaces, before the search and the filter. */
  federationPeopleCount: number;
  areas: UsersArea[];
  people: UsersListPerson[];
  federationPeople: FederationPerson[];
}

export interface UsersListFilter {
  query: string;
  area: UsersArea | null;
}

function matches(
  filter: UsersListFilter,
  name: string | null,
  email: string,
  badges: AreaBadge[],
): boolean {
  if (filter.area && !badges.some((b) => b.area === filter.area)) return false;
  const q = filter.query.trim().toLowerCase();
  if (!q) return true;
  return (name ?? "").toLowerCase().includes(q) || email.toLowerCase().includes(q);
}

async function projectCountsIn(db: DrizzleD1Database<any>, tenantId: string): Promise<Map<string, number>> {
  const rows = await db
    .select({ userId: projectMembers.userId, n: sql<number>`count(*)` })
    .from(projectMembers)
    .innerJoin(projects, eq(projectMembers.projectId, projects.id))
    .where(eq(projects.tenantId, tenantId))
    .groupBy(projectMembers.userId)
    .all();
  return new Map(rows.map((r) => [r.userId, Number(r.n)]));
}

async function reviewCountsIn(db: DrizzleD1Database<any>, tenantId: string): Promise<Map<string, number>> {
  const rows = await db
    .select({ userId: captureQcReviewers.reviewerId, n: sql<number>`count(*)` })
    .from(captureQcReviewers)
    .where(eq(captureQcReviewers.tenantId, tenantId))
    .groupBy(captureQcReviewers.reviewerId)
    .all();
  return new Map(rows.map((r) => [r.userId, Number(r.n)]));
}

export async function loadUsersList(
  db: DrizzleD1Database<any>,
  tenant: Tenant,
  filter: UsersListFilter,
): Promise<UsersList> {
  const areas = workspaceAreas(tenant);

  const home = await db
    .select({
      id: users.id,
      name: users.name,
      email: users.email,
      isAdmin: users.isAdmin,
      isSuperAdmin: users.isSuperAdmin,
      isUserManager: users.isUserManager,
      isCollabAdmin: users.isCollabAdmin,
      isCataloguer: users.isCataloguer,
      isArchiveUser: users.isArchiveUser,
      isRecordsAdmin: users.isRecordsAdmin,
      isAuthoritiesAdmin: users.isAuthoritiesAdmin,
      isImportsAdmin: users.isImportsAdmin,
      isDigitizationAdmin: users.isDigitizationAdmin,
      lastActiveAt: users.lastActiveAt,
    })
    .from(users)
    .where(eq(users.tenantId, tenant.id))
    .orderBy(asc(users.name), asc(users.email))
    .all();

  // Every membership in the tenant's federation, home people and others
  // alike; one read, split below by home tenant.
  const memberships = await db
    .select({
      userId: federationMemberships.userId,
      role: federationMemberships.role,
      name: users.name,
      email: users.email,
      userTenantId: users.tenantId,
      homeWorkspace: tenants.name,
    })
    .from(federationMemberships)
    .innerJoin(users, eq(users.id, federationMemberships.userId))
    .innerJoin(tenants, eq(tenants.id, users.tenantId))
    .where(eq(federationMemberships.federationId, tenant.federationId))
    .orderBy(asc(users.name), asc(users.email))
    .all();

  const projectCounts = await projectCountsIn(db, tenant.id);
  // Without the Digitization area, reviewer assignments are no access:
  // they are not read, so no one is shown reviewing anything.
  const reviewCounts = areas.includes("digitization")
    ? await reviewCountsIn(db, tenant.id)
    : new Map<string, number>();
  const homeRole = new Map(
    memberships
      .filter((m) => m.userTenantId === tenant.id)
      .map((m) => [m.userId, m.role as FederationRole]),
  );

  const allPeople = home.map((u) => ({
    id: u.id,
    name: personName(u.name, u.email),
    rawName: u.name,
    email: u.email,
    lastActiveAt: u.lastActiveAt,
    badges: accessBadges(
      {
        ...u,
        federationRole: homeRole.get(u.id) ?? null,
        projectCount: projectCounts.get(u.id) ?? 0,
        reviewedVolumeCount: reviewCounts.get(u.id) ?? 0,
      },
      areas,
    ),
  }));

  // People of other workspaces: their home flags say nothing about this
  // workspace, so only what ties them here is read.
  const allFederationPeople = memberships
    .filter((m) => m.userTenantId !== tenant.id)
    .map((m) => {
      const reviewedVolumeCount = reviewCounts.get(m.userId) ?? 0;
      return {
        id: m.userId,
        name: personName(m.name, m.email),
        rawName: m.name,
        email: m.email,
        homeWorkspace: m.homeWorkspace,
        federationRole: m.role as FederationRole,
        reviewedVolumeCount,
        badges: accessBadges(
          {
            ...NO_FLAGS,
            federationRole: m.role as FederationRole,
            projectCount: projectCounts.get(m.userId) ?? 0,
            reviewedVolumeCount,
          },
          areas,
        ),
      };
    });

  return {
    workspaceName: tenant.name,
    federationName: await federationNameOf(db, tenant),
    peopleCount: allPeople.length,
    federationPeopleCount: allFederationPeople.length,
    areas,
    people: allPeople
      .filter((p) => matches(filter, p.rawName, p.email, p.badges))
      .map(({ id, name, email, lastActiveAt, badges }) => ({ id, name, email, lastActiveAt, badges })),
    federationPeople: allFederationPeople
      .filter((p) => matches(filter, p.rawName, p.email, p.badges))
      .map(({ id, name, homeWorkspace, federationRole, badges, reviewedVolumeCount }) => ({
        id,
        name,
        homeWorkspace,
        federationRole,
        badges,
        reviewedVolumeCount,
      })),
  };
}

// ---------------------------------------------------------------------------
// One person
// ---------------------------------------------------------------------------

/** Which parts of the detail page a viewer sees. */
export interface DetailVisibility {
  platform: boolean;
  federation: boolean;
  /** Records management, Authorities, Digitization, Imports and exports. */
  areas: boolean;
  cataloguing: boolean;
}

export async function visibleDetailSections(
  db: DrizzleD1Database<any>,
  viewer: User,
  tenant: Tenant,
): Promise<DetailVisibility> {
  const areas = !!viewer.isAdmin || !!viewer.isSuperAdmin;
  return {
    platform: !!viewer.isSuperAdmin || !!viewer.isUserManager,
    federation: !!viewer.isSuperAdmin || (await isFederationSteward(db, viewer, tenant)),
    areas,
    cataloguing: areas || !!viewer.isUserManager,
  };
}

/** The sections of the detail page this viewer sees, in page order. */
export function detailSections(visibility: DetailVisibility, tenant: AreaCapabilities): UsersArea[] {
  return workspaceAreas(tenant).filter((area) => {
    switch (area) {
      case "platform":
        return visibility.platform;
      case "federation":
        return visibility.federation;
      case "cataloguing":
        return visibility.cataloguing;
      default:
        return visibility.areas;
    }
  });
}

/**
 * A role as the detail page shows it. `key` names its label and
 * description; `field` is the role flag's form field, and null for the
 * two federation roles, which the page posts as one `federationRole`.
 */
export interface RoleView {
  key:
    | "super_admin"
    | "user_manager"
    | "steward"
    | "staff"
    | "workspace_admin"
    | "records_admin"
    | "archive_user"
    | "authorities_admin"
    | "cataloguing_admin"
    | "cataloguer"
    | "digitization_admin"
    | "imports_admin";
  field: RoleFlag | null;
  checked: boolean;
}

type TargetFlags = Omit<BadgeFacts, "federationRole" | "projectCount" | "reviewedVolumeCount">;

/** The roles of each section in `sections`, with the person's current state. */
export function detailRoles(
  target: TargetFlags,
  sections: readonly UsersArea[],
  federationRole: FederationRole | null,
): Partial<Record<UsersArea, RoleView[]>> {
  const all: Record<UsersArea, RoleView[]> = {
    platform: [
      { key: "super_admin", field: "isSuperAdmin", checked: !!target.isSuperAdmin },
      { key: "user_manager", field: "isUserManager", checked: !!target.isUserManager },
    ],
    federation: [
      { key: "steward", field: null, checked: federationRole === "steward" },
      { key: "staff", field: null, checked: federationRole === "staff" },
    ],
    records: [
      { key: "workspace_admin", field: "isAdmin", checked: !!target.isAdmin },
      { key: "records_admin", field: "isRecordsAdmin", checked: !!target.isRecordsAdmin },
      { key: "archive_user", field: "isArchiveUser", checked: !!target.isArchiveUser },
    ],
    authorities: [
      { key: "authorities_admin", field: "isAuthoritiesAdmin", checked: !!target.isAuthoritiesAdmin },
    ],
    cataloguing: [
      { key: "cataloguing_admin", field: "isCollabAdmin", checked: !!target.isCollabAdmin },
      { key: "cataloguer", field: "isCataloguer", checked: !!target.isCataloguer },
    ],
    digitization: [
      { key: "digitization_admin", field: "isDigitizationAdmin", checked: !!target.isDigitizationAdmin },
    ],
    imports: [{ key: "imports_admin", field: "isImportsAdmin", checked: !!target.isImportsAdmin }],
  };
  const out: Partial<Record<UsersArea, RoleView[]>> = {};
  for (const area of sections) out[area] = all[area];
  return out;
}

export interface ReviewedVolume {
  volumeId: string;
  referenceCode: string;
  /** As the Volumes screen shows it; null when that screen does not list the volume. */
  state: ScreenState | null;
}

/** Each role flag's role key, which names its label. */
export const ROLE_KEY_OF_FLAG: Record<RoleFlag, RoleView["key"]> = {
  isSuperAdmin: "super_admin",
  isUserManager: "user_manager",
  isAdmin: "workspace_admin",
  isArchiveUser: "archive_user",
  isRecordsAdmin: "records_admin",
  isAuthoritiesAdmin: "authorities_admin",
  isImportsAdmin: "imports_admin",
  isDigitizationAdmin: "digitization_admin",
  isCollabAdmin: "cataloguing_admin",
  isCataloguer: "cataloguer",
};

/** The section of the detail page that shows each role flag. */
const AREA_OF_FLAG: Record<RoleFlag, UsersArea> = {
  isSuperAdmin: "platform",
  isUserManager: "platform",
  isAdmin: "records",
  isArchiveUser: "records",
  isRecordsAdmin: "records",
  isAuthoritiesAdmin: "authorities",
  isImportsAdmin: "imports",
  isDigitizationAdmin: "digitization",
  isCollabAdmin: "cataloguing",
  isCataloguer: "cataloguing",
};

/** The roles an invitation can open with, by the value the invite form posts. */
export type InviteRoleKey =
  | "workspace_admin"
  | "records_admin"
  | "authorities_admin"
  | "digitization_admin"
  | "imports_admin"
  | "archive_user";

/** The section of the detail page that shows each invitation role. */
const AREA_OF_INVITE_ROLE: Record<InviteRoleKey, UsersArea> = {
  workspace_admin: "records",
  records_admin: "records",
  archive_user: "records",
  authorities_admin: "authorities",
  digitization_admin: "digitization",
  imports_admin: "imports",
};

/**
 * One entry of the access history, newest first on the page. `actor`
 * is the name (or email) of whoever made the change; `role` names a
 * label in `role_<role>`; `project` is the project's name.
 */
export type AccessHistoryEntry =
  | { kind: "role_granted" | "role_revoked"; at: number; role: RoleView["key"]; actor: string }
  | { kind: "federation_granted" | "federation_revoked"; at: number; role: FederationRole; actor: string }
  | { kind: "project_added" | "project_changed"; at: number; role: ProjectRole; project: string; actor: string }
  | { kind: "project_removed"; at: number; project: string; actor: string }
  | { kind: "invited"; at: number; role: InviteRoleKey; actor: string }
  | { kind: "invited_no_role"; at: number; actor: string };

export interface UserDetailAccess {
  sections: UsersArea[];
  roles: Partial<Record<UsersArea, RoleView[]>>;
  federation: { name: string | null; role: FederationRole | null } | null;
  reviewedVolumes: ReviewedVolume[] | null;
  history: AccessHistoryEntry[];
}

export async function loadUserDetailAccess(
  db: DrizzleD1Database<any>,
  tenant: Tenant,
  viewer: User,
  target: TargetFlags & { id: string; email: string },
  now: number,
): Promise<UserDetailAccess> {
  const sections = detailSections(await visibleDetailSections(db, viewer, tenant), tenant);

  let federation: UserDetailAccess["federation"] = null;
  if (sections.includes("federation")) {
    const membership = await db
      .select({ role: federationMemberships.role })
      .from(federationMemberships)
      .where(
        and(
          eq(federationMemberships.userId, target.id),
          eq(federationMemberships.federationId, tenant.federationId),
        ),
      )
      .get();
    federation = {
      name: await federationNameOf(db, tenant),
      role: (membership?.role as FederationRole | undefined) ?? null,
    };
  }

  let reviewedVolumes: ReviewedVolume[] | null = null;
  if (sections.includes("digitization")) {
    const assigned = await db
      .select({ volumeId: captureQcReviewers.pipelineVolumeId, referenceCode: pipelineVolumes.referenceCode })
      .from(captureQcReviewers)
      .innerJoin(
        pipelineVolumes,
        and(
          eq(pipelineVolumes.id, captureQcReviewers.pipelineVolumeId),
          eq(pipelineVolumes.tenantId, captureQcReviewers.tenantId),
        ),
      )
      .where(and(eq(captureQcReviewers.tenantId, tenant.id), eq(captureQcReviewers.reviewerId, target.id)))
      .orderBy(asc(pipelineVolumes.referenceCode))
      .all();
    // The states of these volumes only: a profile never reads the
    // workspace's whole capture history.
    const stateOf = await loadVolumeScreenStates(
      db,
      tenant.id,
      assigned.map((a) => a.volumeId),
      now,
    );
    reviewedVolumes = assigned.map((a) => ({
      volumeId: a.volumeId,
      referenceCode: a.referenceCode,
      state: stateOf.get(a.volumeId) ?? null,
    }));
  }

  return {
    sections,
    roles: detailRoles(target, sections, federation?.role ?? null),
    federation,
    reviewedVolumes,
    history: await loadAccessHistory(db, tenant.id, target, sections),
  };
}

/** Reads a JSON `details` value, or null when it is not an object. */
function detailsOf(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const ACCESS_ACTIONS = ["set_user_role", "set_federation_role", "set_project_membership", "invite_user"] as const;

const isFederationRole = (v: unknown): v is FederationRole => v === "steward" || v === "staff";
const isProjectRole = (v: unknown): v is ProjectRole => (PROJECT_ROLES as readonly unknown[]).includes(v);

/**
 * The person's access history from `audit_log`, newest first, as far
 * as `sections` lets the viewer see it (module header). A row whose
 * `details` do not read as its action writes them is left out.
 */
export async function loadAccessHistory(
  db: DrizzleD1Database<any>,
  tenantId: string,
  target: { id: string; email: string },
  sections: readonly UsersArea[],
): Promise<AccessHistoryEntry[]> {
  const out: AccessHistoryEntry[] = [];

  // The workspace's creation made its first person workspace admin and
  // super admin: two grants, each shown with its section.
  const created = await db
    .select({
      createdAt: auditLog.createdAt,
      details: auditLog.details,
      actorText: auditLog.actorUserIdText,
      actorName: users.name,
      actorEmail: users.email,
    })
    .from(auditLog)
    .leftJoin(users, eq(users.id, auditLog.actorUserId))
    .where(and(eq(auditLog.action, "create_tenant"), eq(auditLog.targetTenantId, tenantId)))
    .all();
  const wanted = target.email.trim().toLowerCase();
  for (const row of created) {
    const bootstrap = detailsOf(row.details)?.bootstrap_email;
    if (typeof bootstrap !== "string" || bootstrap.trim().toLowerCase() !== wanted) continue;
    const actor = row.actorEmail ? personName(row.actorName, row.actorEmail) : row.actorText;
    for (const flag of ["isAdmin", "isSuperAdmin"] as const) {
      if (sections.includes(AREA_OF_FLAG[flag])) {
        out.push({ kind: "role_granted", at: row.createdAt, role: ROLE_KEY_OF_FLAG[flag], actor });
      }
    }
  }

  const rows = await db
    .select({
      action: auditLog.action,
      createdAt: auditLog.createdAt,
      details: auditLog.details,
      actorText: auditLog.actorUserIdText,
      actorName: users.name,
      actorEmail: users.email,
    })
    .from(auditLog)
    .leftJoin(users, eq(users.id, auditLog.actorUserId))
    .where(
      and(
        eq(auditLog.targetTenantId, tenantId),
        eq(auditLog.targetObjectKind, "user"),
        eq(auditLog.targetObjectId, target.id),
        inArray(auditLog.action, [...ACCESS_ACTIONS]),
      ),
    )
    .all();

  // Project names, of this workspace's projects only.
  const projectIds = new Set<string>();
  for (const row of rows) {
    const id = row.action === "set_project_membership" ? detailsOf(row.details)?.project_id : null;
    if (typeof id === "string") projectIds.add(id);
  }
  const projectNames = new Map<string, string>();
  if (projectIds.size > 0 && sections.includes("cataloguing")) {
    const named = await db
      .select({ id: projects.id, name: projects.name })
      .from(projects)
      .where(and(eq(projects.tenantId, tenantId), inArray(projects.id, [...projectIds])))
      .all();
    for (const p of named) projectNames.set(p.id, p.name);
  }

  for (const row of rows) {
    const d = detailsOf(row.details);
    if (!d) continue;
    const at = row.createdAt;
    const actor = row.actorEmail ? personName(row.actorName, row.actorEmail) : row.actorText;
    switch (row.action) {
      case "set_user_role": {
        const flag = d.flag as RoleFlag;
        if (!(flag in ROLE_KEY_OF_FLAG) || !sections.includes(AREA_OF_FLAG[flag])) break;
        if (d.step !== "granted" && d.step !== "revoked") break;
        out.push({ kind: d.step === "granted" ? "role_granted" : "role_revoked", at, role: ROLE_KEY_OF_FLAG[flag], actor });
        break;
      }
      case "set_federation_role": {
        if (!sections.includes("federation")) break;
        if (isFederationRole(d.to)) out.push({ kind: "federation_granted", at, role: d.to, actor });
        else if (d.to === "none" && isFederationRole(d.from)) out.push({ kind: "federation_revoked", at, role: d.from, actor });
        break;
      }
      case "set_project_membership": {
        if (!sections.includes("cataloguing") || typeof d.project_id !== "string") break;
        const project = projectNames.get(d.project_id) ?? d.project_id;
        if (d.step === "removed") out.push({ kind: "project_removed", at, project, actor });
        else if ((d.step === "added" || d.step === "changed") && isProjectRole(d.role)) {
          out.push({ kind: d.step === "added" ? "project_added" : "project_changed", at, role: d.role, project, actor });
        }
        break;
      }
      case "invite_user": {
        if (typeof d.role === "string" && Object.hasOwn(AREA_OF_INVITE_ROLE, d.role)) {
          const role = d.role as InviteRoleKey;
          if (sections.includes(AREA_OF_INVITE_ROLE[role])) out.push({ kind: "invited", at, role, actor });
        } else if (d.role === "none") {
          out.push({ kind: "invited_no_role", at, actor });
        }
        break;
      }
    }
  }
  return out.sort((a, b) => b.at - a.at);
}

/* @version v0.8.0 */
