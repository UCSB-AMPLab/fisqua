/**
 * Scripts — the actor, the scope and the record fields the command line shares
 *
 * This module deals with the pieces of the former authority-link file
 * command that the command line (`scripts/fisqua.ts`) still uses. The
 * command itself, which linked descriptions from a file shape of its
 * own, was retired once the authorities change file gained `add-link`
 * and `add-place-link` (`./authorities-cli/additions.ts`).
 *
 *   newRecordId     a version 8 UUID made from a namespace, the
 *                   federation, the tenant, the file's name and a key,
 *                   so a run of the same file again finds what it made;
 *                   every noun of the command line makes its ids with it.
 *   RowReader       the read every noun is given: one SQL SELECT, its rows.
 *   readerDb        a read-only Drizzle client over a `RowReader`, so the
 *                   app's code minter (`generateUniqueCode`) and prefix
 *                   reader read D1 as the run does.
 *   resolveActor    the acting user by email, the tenant `--tenant` names,
 *                   how the user may act there, and the six area flags
 *                   `canWorkInArea` decides with. A user acts in one of
 *                   three ways, tried in this order:
 *                     member          a user of the tenant, with the flags
 *                                     stored on their row; their tenant
 *                                     must not be disabled;
 *                     platform-admin  `users.is_platform_admin` exactly 1,
 *                                     their row not on the platform
 *                                     tenant, on a tenant of kind `tenant`
 *                                     that is not disabled, with every
 *                                     flag on, as `admitsAsPlatformAdmin`
 *                                     admits them and
 *                                     `platformAdminEffectiveUser` hands
 *                                     them to the app;
 *                     lead-admin      the workspace admin (`is_admin`) of
 *                                     the lead tenant of the tenant's
 *                                     federation, which is active, on a
 *                                     tenant that is neither disabled nor
 *                                     suspended, their own tenant not
 *                                     disabled, with the flags a steward
 *                                     grant carries in a member
 *                                     (`grantEffectiveRoleFlags`):
 *                                     workspace admin, never super admin.
 *                   Nobody else acts: a user of another member, or a user
 *                   of the lead who is not its admin, is refused. An
 *                   unknown email or tenant, a disabled tenant, or a user
 *                   who may not work in records also stops the run
 *                   (`AuthorityLinksStop`).
 *   reportActorOf   the acting user as a run's report records them, and
 *   actedAsPhrase   how a report or a log line names the way they acted.
 *   resolveCommandActor  the same, for a standalone command writing as
 *                   one user in one workspace (the merge lists), with
 *                   its guards and a steward check for shared records.
 *   changelogActedAsOf  what each changelog row the run writes records
 *                   in `acted_as` (migration 0127): `platform-admin` or
 *                   `lead-admin`, NULL for a member.
 *   readScope       the tenant's federation, whether its authorities are
 *                   on, the owner a new record gets (`resolveMintOwner`:
 *                   NULL where the federation shares its authorities) and
 *                   whether the user is a steward of the federation
 *                   (`isFederationSteward`): the federation active, and
 *                   the user the workspace admin of its lead tenant
 *                   acting on the lead itself, or holding a steward
 *                   membership of it. A platform admin acting on the lead
 *                   is its workspace admin there, as in the app; the
 *                   lead's admin acting on a member is no steward there
 *                   without a steward membership, as in the app.
 *                   `../cli/access-guards.ts` guards both reads in the
 *                   SQL file.
 *   recordValuesOf  a new entity's or place's columns, as
 *                   `/admin/entities/new` and `/admin/places/new` write
 *                   them, checked with the editor's schemas, or the reason
 *                   they are refused. `ENTITY_RECORD` and `PLACE_RECORD`
 *                   name the cells it reads.
 *   recountStatement  the editor's recount of a vocabulary term's entity
 *                   count, over the entities the tenant can see.
 *
 * @version v0.9.0
 */

import { drizzle as proxyDrizzle } from "drizzle-orm/sqlite-proxy";
import type { BatchItem } from "drizzle-orm/batch";
import type { z } from "zod/v4";
import { renderStatement } from "../../app/lib/capture/file-route.server";
import { createEntitySchema } from "../../app/lib/validation/entity";
import { createPlaceSchema } from "../../app/lib/validation/place";
import { canWorkInArea, type AccessUser } from "../../app/lib/user-access.server";
import { grantEffectiveRoleFlags } from "../../app/lib/federation.server";
import { PLATFORM_TENANT_ID } from "../../app/lib/tenant";
import type { ChangelogActedAs } from "../../app/db/schema";
import { actorGuards, scopeGuards } from "./cli/access-guards";
import { actorQuery } from "./description-date-corrections";
import { escapeSql } from "./sql";

/** A problem that stops the whole run: an actor or a scope that may not act. */
export class AuthorityLinksStop extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthorityLinksStop";
  }
}

/** A new entity's cells, as the editor's create form names them. */
export const ENTITY_RECORD = [
  "display_name",
  "name_variants",
  "sort_name",
  "surname",
  "given_name",
  "entity_type",
  "honorific",
  "primary_function",
  "dates_of_existence",
  "date_start",
  "date_end",
] as const;
export const PLACE_RECORD = ["display_name", "name_variants", "label", "place_type", "latitude", "longitude"] as const;

/** The cells `recordValuesOf` reads. */
type Column = (typeof ENTITY_RECORD)[number] | (typeof PLACE_RECORD)[number];

export type AuthorityType = "entity" | "place";

/**
 * The id of the record a key makes: a version 8 UUID from the SHA-256 of
 * `[<namespace>, <federation id>, <tenant id>, <file name>, <new_key>]`
 * as JSON, an encoding no two different sets of parts share. The tenant
 * is the actor's, so two tenants' files never make one id. Each kind of
 * id passes a namespace of its own, so no two kinds ever share an id;
 * `link-file`, the default, was the retired authority-link command's.
 */
export async function newRecordId(
  federationId: string,
  tenantId: string,
  file: string,
  newKey: string,
  namespace = "link-file",
): Promise<string> {
  const name = JSON.stringify([namespace, federationId, tenantId, file, newKey]);
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(name))).slice(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x80;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const h = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** One SQL SELECT and its rows: the read every noun of the command line is given. */
export type RowReader = (sql: string) => Promise<Record<string, unknown>[]>;

const text = (v: unknown) => (v === null || v === undefined ? "" : String(v));
const truthy = (v: unknown) => v === 1 || v === "1" || v === true || v === "true";
const blank = (v: unknown) => v === null || v === undefined || v === "";

/**
 * A Drizzle client that runs its queries through the run's reads, so
 * the app's own code minter reads D1 as the run does. It is used for
 * reads only.
 */
export function readerDb(rows: RowReader) {
  return proxyDrizzle(async (query, params, method) => {
    const statement = renderStatement({ toSQL: () => ({ sql: query, params }) } as unknown as BatchItem<"sqlite">);
    const found = (await rows(statement.slice(0, -1))).map((r) => Object.values(r));
    return { rows: method === "get" ? (found[0] as any) : found };
  });
}

/** How the acting user may act in the tenant (`resolveActor`). */
export type ActingBasis = "member" | "platform-admin" | "lead-admin";

export interface Actor {
  id: string;
  email: string;
  name: string;
  /** The tenant the run acts in, which `--tenant` names. */
  tenantId: string;
  tenantSlug: string;
  /** The user's own tenant: the tenant itself for a member. */
  homeTenantId: string;
  homeTenantSlug: string;
  basis: ActingBasis;
  /** The flags the editor's area checks read, as the user acts in the tenant. */
  access: AccessUser;
  /** What the basis was decided on, for the guards; null for a member. */
  standing: Standing | null;
}

/** The values a platform admin's or a lead admin's standing was decided on, as read. */
export interface Standing {
  /** `users.is_platform_admin`, read as the app reads it: exactly 1. */
  isPlatformAdmin: boolean;
  /** `users.is_admin`, read as `resolveActor` reads a flag. */
  isAdmin: boolean;
  /** The tenant's kind, status and federation, and that federation's status and lead, each empty for NULL. */
  tenantKind: string;
  tenantStatus: string;
  federationId: string;
  federationStatus: string;
  leadTenantId: string;
}

const EVERY_FLAG: AccessUser = {
  isAdmin: true, isSuperAdmin: true, isRecordsAdmin: true, isAuthoritiesAdmin: true, isImportsAdmin: true, isDigitizationAdmin: true,
  worksInEveryArea: false,
};

export async function resolveActor(rows: RowReader, email: string, tenantSlug: string): Promise<Actor> {
  const found = await rows(actorQuery(email));
  if (found.length === 0) throw new AuthorityLinksStop(`No user has the email ${email}`);
  const u = found[0];
  const [f] = await rows(
    `SELECT is_admin, is_super_admin, is_records_admin, is_authorities_admin, is_imports_admin, is_digitization_admin FROM users WHERE id = ${escapeSql(text(u.id))}`,
  );
  const identity = { id: text(u.id), email: text(u.email), name: text(u.name), homeTenantId: text(u.tenant_id), homeTenantSlug: text(u.tenant_slug) };
  let actor: Actor;
  if (text(u.tenant_slug) === tenantSlug) {
    if (text(u.tenant_disabled_at) !== "") throw new AuthorityLinksStop(`The tenant ${text(u.tenant_slug)} is disabled`);
    const access: AccessUser = {
      isAdmin: truthy(f?.is_admin),
      isSuperAdmin: truthy(f?.is_super_admin),
      isRecordsAdmin: truthy(f?.is_records_admin),
      isAuthoritiesAdmin: truthy(f?.is_authorities_admin),
      isImportsAdmin: truthy(f?.is_imports_admin),
      isDigitizationAdmin: truthy(f?.is_digitization_admin),
      worksInEveryArea: false,
    };
    actor = { ...identity, tenantId: text(u.tenant_id), tenantSlug, basis: "member", access, standing: null };
  } else {
    const [t] = await rows(
      `SELECT t.id AS id, IFNULL(t.kind, '') AS kind, IFNULL(t.status, '') AS status, IFNULL(t.disabled_at, '') AS disabled_at,
       IFNULL(t.federation_id, '') AS federation_id, IFNULL(f.status, '') AS federation_status, IFNULL(f.lead_tenant_id, '') AS lead_tenant_id
       FROM tenants t LEFT JOIN federations f ON f.id = t.federation_id WHERE t.slug = ${escapeSql(tenantSlug)}`,
    );
    if (!t) throw new AuthorityLinksStop(`No tenant has the slug ${tenantSlug}`);
    if (text(t.disabled_at) !== "") throw new AuthorityLinksStop(`The tenant ${tenantSlug} is disabled`);
    const [p] = await rows(`SELECT is_platform_admin FROM users WHERE id = ${escapeSql(identity.id)}`);
    const standing: Standing = {
      isPlatformAdmin: Number(p?.is_platform_admin) === 1,
      isAdmin: truthy(f?.is_admin),
      tenantKind: text(t.kind),
      tenantStatus: text(t.status),
      federationId: text(t.federation_id),
      federationStatus: text(t.federation_status),
      leadTenantId: text(t.lead_tenant_id),
    };
    const at = { ...identity, tenantId: text(t.id), tenantSlug, standing };
    if (standing.isPlatformAdmin && identity.homeTenantId !== PLATFORM_TENANT_ID && standing.tenantKind === "tenant") {
      actor = { ...at, basis: "platform-admin", access: { ...EVERY_FLAG } };
    } else if (
      standing.isAdmin &&
      standing.federationId !== "" &&
      standing.federationStatus === "active" &&
      standing.leadTenantId === identity.homeTenantId &&
      standing.tenantStatus !== "suspended" &&
      text(u.tenant_disabled_at) === ""
    ) {
      const g = grantEffectiveRoleFlags("steward");
      const access: AccessUser = {
        isAdmin: g.isAdmin, isSuperAdmin: g.isSuperAdmin, isRecordsAdmin: g.isRecordsAdmin, isAuthoritiesAdmin: g.isAuthoritiesAdmin,
        isImportsAdmin: g.isImportsAdmin, isDigitizationAdmin: g.isDigitizationAdmin, worksInEveryArea: g.worksInEveryArea,
      };
      actor = { ...at, basis: "lead-admin", access };
    } else {
      throw new AuthorityLinksStop(
        `${email} may not act in ${tenantSlug}: a user of ${identity.homeTenantSlug}, not a platform admin, ` +
          `and not an admin of the lead workspace of ${tenantSlug}'s federation`,
      );
    }
  }
  // As the description editor's link actions: the records area.
  if (!canWorkInArea(actor.access, "records")) throw new AuthorityLinksStop(`${email} may not work in records in ${tenantSlug}`);
  return actor;
}

/** The acting user as a run's report records them: who, how they acted, and their own tenant. */
export interface ReportActor {
  id: string;
  email: string;
  actedAs: ActingBasis;
  homeTenant: string;
}

export function reportActorOf(actor: Actor): ReportActor {
  return { id: actor.id, email: actor.email, actedAs: actor.basis, homeTenant: actor.homeTenantSlug };
}

/** What a changelog row the run writes records in `acted_as` (migration 0127): NULL for a member. */
export function changelogActedAsOf(actor: Pick<Actor, "basis">): ChangelogActedAs | null {
  return actor.basis === "member" ? null : actor.basis;
}

/** How a report or a log line names the way the user acted: nothing for a member. */
export function actedAsPhrase(actor: Pick<ReportActor, "actedAs" | "homeTenant">): string {
  if (actor.actedAs === "lead-admin") return ` as the admin of ${actor.homeTenant}, the lead workspace of the federation`;
  if (actor.actedAs === "platform-admin") return " as a platform admin";
  return "";
}

export interface Scope {
  federationId: string;
  federationSlug: string;
  /** `resolveMintOwner`: null where the federation shares its authorities. */
  owner: string | null;
  /** `isFederationSteward`, for a mint into the shared space. */
  steward: boolean;
}

export async function readScope(rows: RowReader, actor: Actor): Promise<Scope> {
  const [t] = await rows(
    `SELECT t.authorities_enabled, t.federation_id, f.slug, f.status, f.lead_tenant_id, f.shared_authorities_enabled
     FROM tenants t LEFT JOIN federations f ON f.id = t.federation_id WHERE t.id = ${escapeSql(actor.tenantId)}`,
  );
  if (!t || blank(t.federation_id) || blank(t.slug)) throw new AuthorityLinksStop(`The tenant ${actor.tenantSlug} has no federation`);
  if (!truthy(t.authorities_enabled)) throw new AuthorityLinksStop(`The tenant ${actor.tenantSlug} does not have authorities on`);
  const federationId = text(t.federation_id);
  const owner = truthy(t.shared_authorities_enabled) ? null : actor.tenantId;
  // As isFederationSteward: the workspace admin of the federation's lead
  // tenant acting on the lead itself (a platform admin is its admin
  // there), or a steward membership of the federation. The lead's admin
  // acting on a member is no steward there, as in the app.
  const [u] = await rows(`SELECT is_admin FROM users WHERE id = ${escapeSql(actor.id)}`);
  const memberships = await rows(
    `SELECT id FROM federation_memberships WHERE user_id = ${escapeSql(actor.id)} AND federation_id = ${escapeSql(federationId)} AND role = 'steward'`,
  );
  const lead = text(t.lead_tenant_id);
  const steward =
    text(t.status) === "active" &&
    ((lead === actor.tenantId && (actor.basis === "platform-admin" || truthy(u?.is_admin))) || memberships.length > 0);
  return { federationId, federationSlug: text(t.slug), owner, steward };
}

/**
 * Who acts for a standalone command that writes as one user (by id) in
 * one workspace: the user resolved as `resolveActor` resolves them, how
 * the changelog records it (`changelogActedAsOf`), and the guards that
 * open its SQL file (`actorGuards`, and `scopeGuards` when it changes
 * the federation's shared records, which then need a steward,
 * `readScope`). An unknown user, a workspace they may not act in, or
 * shared records without a steward stop the run (`AuthorityLinksStop`).
 */
export async function resolveCommandActor(
  rows: RowReader,
  userId: string,
  tenantSlug: string,
  opts: { shared: boolean },
): Promise<{ actor: Actor; actedAs: ChangelogActedAs | null; guards: string[] }> {
  const [u] = await rows(`SELECT email FROM users WHERE id = ${escapeSql(userId)}`);
  if (!u) throw new AuthorityLinksStop(`No user has the id ${userId}`);
  const actor = await resolveActor(rows, text(u.email), tenantSlug);
  const guards = actorGuards(actor);
  if (opts.shared) {
    const scope = await readScope(rows, actor);
    if (!scope.steward) throw new AuthorityLinksStop(`${actor.email} is not a steward of ${scope.federationSlug}, whose shared records the run changes`);
    guards.push(...scopeGuards(actor, scope));
  }
  return { actor, actedAs: changelogActedAsOf(actor), guards };
}

/** The zod issues of a field check, under the file's column names. */
function issues(result: { success: boolean; error?: z.ZodError }, columns: Record<string, string>): string | null {
  if (result.success || !result.error) return null;
  return result.error.issues
    .map((i) => `${columns[String(i.path[0])] ?? String(i.path[0])}: ${i.message}`)
    .join("; ");
}

const ENTITY_CHECK = createEntitySchema.omit({ entityCode: true });
const PLACE_CHECK = createPlaceSchema.omit({ placeCode: true });
const RECORD_FILE_COLUMN: Record<string, string> = {
  displayName: "display_name",
  sortName: "sort_name",
  givenName: "given_name",
  entityType: "entity_type",
  primaryFunction: "primary_function",
  nameVariants: "name_variants",
  datesOfExistence: "dates_of_existence",
  dateStart: "date_start",
  dateEnd: "date_end",
  placeType: "place_type",
};

/** A new record's columns, as the editor's create writes them, or the reason they are refused. */
export function recordValuesOf(type: AuthorityType, c: Record<Column, string>): Record<string, unknown> | string {
  const other = (type === "entity" ? PLACE_RECORD : ENTITY_RECORD).filter(
    (k) => c[k] !== "" && !(type === "entity" ? ENTITY_RECORD : PLACE_RECORD).includes(k as never),
  );
  if (other.length > 0) return `a new ${type} does not take ${other.join(", ")}`;
  let variants: string[] = [];
  if (c.name_variants !== "") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(c.name_variants);
    } catch {
      parsed = null;
    }
    if (!Array.isArray(parsed) || parsed.some((v) => typeof v !== "string")) return "name_variants: not a JSON array of strings";
    variants = parsed as string[];
  }
  const nameVariants = JSON.stringify(variants);
  if (type === "entity") {
    const given = {
      displayName: c.display_name || undefined,
      sortName: c.sort_name || undefined,
      surname: c.surname || undefined,
      givenName: c.given_name || undefined,
      honorific: c.honorific || undefined,
      entityType: c.entity_type || undefined,
      primaryFunction: c.primary_function || undefined,
      nameVariants,
      datesOfExistence: c.dates_of_existence || undefined,
      dateStart: c.date_start || null,
      dateEnd: c.date_end || null,
    };
    const problem = issues(ENTITY_CHECK.safeParse(given), RECORD_FILE_COLUMN);
    if (problem) return problem;
    return {
      displayName: given.displayName,
      sortName: given.sortName,
      surname: given.surname ?? null,
      givenName: given.givenName ?? null,
      entityType: given.entityType,
      honorific: given.honorific ?? null,
      primaryFunction: given.primaryFunction ?? null,
      nameVariants,
      datesOfExistence: given.datesOfExistence ?? null,
      dateStart: given.dateStart,
      dateEnd: given.dateEnd,
      history: null,
      sources: null,
      wikidataId: null,
      viafId: null,
    };
  }
  const coordinate = (v: string, column: string): number | null | string => {
    if (v === "") return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : `${column}: ${JSON.stringify(v)} is not a number`;
  };
  const latitude = coordinate(c.latitude, "latitude");
  const longitude = coordinate(c.longitude, "longitude");
  if (typeof latitude === "string") return latitude;
  if (typeof longitude === "string") return longitude;
  const given = {
    label: c.label || undefined,
    displayName: c.display_name || undefined,
    placeType: c.place_type || null,
    nameVariants,
    parentId: null,
    latitude,
    longitude,
    tgnId: null,
    hgisId: null,
    whgId: null,
  };
  const problem = issues(PLACE_CHECK.safeParse(given), RECORD_FILE_COLUMN);
  if (problem) return problem;
  return { ...given, mergedInto: null };
}

/** As the editor's create: the term's entity count, over the entities the tenant can see. */
export function recountStatement(termId: string, federationId: string, tenantId: string, now: number): string {
  const F = escapeSql(federationId);
  const id = escapeSql(termId);
  return (
    `UPDATE vocabulary_terms SET entity_count = (SELECT COUNT(*) FROM entities WHERE federation_id = ${F} ` +
    `AND (tenant_id IS NULL OR tenant_id = ${escapeSql(tenantId)}) AND primary_function_id = ${id}), updated_at = ${now} ` +
    `WHERE id = ${id} AND federation_id = ${F} AND merged_into IS NULL;`
  );
}

// @version v0.9.0
