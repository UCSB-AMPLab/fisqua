/**
 * Scope reads — the rows every serialisation but the CSV shares
 *
 * This module deals with getting a resolved scope's descriptions,
 * authority records and links out of D1 as TYPED OBJECTS, in the
 * scope's own order, for the emitters that are not the canonical CSV:
 * the JSON emitter, the Dublin Core form, and the EAD XML builder's
 * input.
 *
 * WHY THIS IS NOT `canonical-csv.server.ts`. That module reads the same
 * five things and keeps its readers private, deliberately: everything
 * it produces is a CSV cell, so a null and an empty string are the same
 * value to it and a number is a string. JSON must tell those apart —
 * `null` and `""` say different things about a catalogue, and a
 * sequence is a number — and the EAD builder needs `legacyIds` as a
 * parsed array rather than as the JSON text the column holds. What the
 * two modules DO share is the column contract: the header lists
 * (`ENTITY_COLUMNS`, `PLACE_COLUMNS`, `LINK_COLUMNS`,
 * `generateCanonicalHeaders`) are imported from there rather than
 * restated, so the two serialisations cannot disagree about which
 * fields exist even though they disagree about how to write them.
 *
 * ORDER IS PRESERVED, NOT RECOVERED. Descriptions come back in the
 * order their ids were asked for — the scope resolver decided that
 * order and it is part of what was chosen. Rows that have vanished
 * between resolution and emission are skipped rather than left as
 * holes.
 *
 * TENANT SCOPE IS SPELLED IN EVERY STATEMENT, and every authority read
 * goes through `authorityScope()` rather than a bare federation filter,
 * because an authority may be federation-shared or tenant-owned and
 * only that helper knows the difference. The id lists are chunked at
 * `ID_CHUNK` for D1's bound-parameter cap.
 *
 * @version v0.7.0
 */

import { and, eq, inArray } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import {
  descriptionEntities,
  descriptionPlaces,
  descriptions,
  entities,
  places,
  repositories,
} from "../../db/schema";
import { authorityScope } from "../authority-ownership.server";
import { LegacyIdsSchema } from "../validation/legacy-ids";
import type { Tenant } from "../../context";
import { ID_CHUNK } from "./scopes.server";

export type DescriptionRow = typeof descriptions.$inferSelect;
export type EntityRow = typeof entities.$inferSelect;
export type PlaceRow = typeof places.$inferSelect;

/** A description with the two things its own row cannot tell us. */
export interface ScopedDescription {
  row: DescriptionRow;
  /** The parent's reference code, or null at the top of the tree. */
  parentReferenceCode: string | null;
  /** `legacy_ids` parsed and validated; null when there are none. */
  legacyIds: Array<{ provider: string; id: string | number }> | null;
}

/** One description↔authority link, in the canonical link columns' terms. */
export interface ScopedLink {
  linkDescriptionCode: string;
  linkAuthorityCode: string;
  linkRole: string;
  linkRoleNote: string | null;
  linkRoleRaw: string | null;
  linkSequence: number | null;
  linkHonorific: string | null;
  linkFunction: string | null;
  linkNameAsRecorded: string | null;
}

/** A repository as the EAD and Dublin Core builders read it. */
export interface ScopedRepository {
  name: string;
  city: string;
  code: string;
  rightsText: string | null;
}

function chunk<T>(items: readonly T[], size = ID_CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * `legacy_ids` as a validated array, or null. Null rather than `[]` for
 * the same reason the publish pipeline uses null: the EAD builder
 * branches on the array being non-null before iterating, and a
 * malformed element must never reach it as the literal string
 * "undefined".
 */
export function parseLegacyIds(
  raw: unknown,
): Array<{ provider: string; id: string | number }> | null {
  if (raw === null || raw === undefined || raw === "") return null;
  let candidate: unknown = raw;
  if (typeof raw === "string") {
    try {
      candidate = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!Array.isArray(candidate)) return null;
  const out: Array<{ provider: string; id: string | number }> = [];
  for (const entry of candidate) {
    const parsed = LegacyIdsSchema.element.safeParse(entry);
    if (parsed.success) out.push(parsed.data);
  }
  return out.length > 0 ? out : null;
}

/**
 * The scope's descriptions, in the order asked for, each with its
 * parent's reference code resolved. Parent codes are looked up for the
 * whole set at once rather than per chunk, because a child and its
 * parent are often in different chunks and a per-chunk lookup would
 * miss half of them.
 */
export async function readScopedDescriptions(
  db: DrizzleD1Database<any>,
  tenant: Tenant,
  ids: string[],
): Promise<ScopedDescription[]> {
  const byId = new Map<string, DescriptionRow>();
  for (const part of chunk(ids)) {
    const rows = await db
      .select()
      .from(descriptions)
      .where(and(eq(descriptions.tenantId, tenant.id), inArray(descriptions.id, part)))
      .all();
    for (const row of rows) byId.set(row.id, row);
  }

  const parentIds = [
    ...new Set(
      [...byId.values()]
        .map((r) => r.parentId)
        .filter((id): id is string => id !== null && !byId.has(id)),
    ),
  ];
  const parentCodes = await readReferenceCodes(db, tenant, parentIds);
  for (const row of byId.values()) parentCodes.set(row.id, row.referenceCode);

  const out: ScopedDescription[] = [];
  for (const id of ids) {
    const row = byId.get(id);
    if (!row) continue;
    out.push({
      row,
      parentReferenceCode: row.parentId ? (parentCodes.get(row.parentId) ?? null) : null,
      legacyIds: parseLegacyIds(row.legacyIds),
    });
  }
  return out;
}

/** Reference codes for a set of description ids. */
export async function readReferenceCodes(
  db: DrizzleD1Database<any>,
  tenant: Tenant,
  ids: string[],
): Promise<Map<string, string>> {
  const codes = new Map<string, string>();
  for (const part of chunk(ids)) {
    const rows = await db
      .select({ id: descriptions.id, referenceCode: descriptions.referenceCode })
      .from(descriptions)
      .where(and(eq(descriptions.tenantId, tenant.id), inArray(descriptions.id, part)))
      .all();
    for (const row of rows) codes.set(row.id, row.referenceCode);
  }
  return codes;
}

/** The repositories a set of descriptions belongs to, keyed by id. */
export async function readRepositories(
  db: DrizzleD1Database<any>,
  tenant: Tenant,
  repositoryIds: string[],
): Promise<Map<string, ScopedRepository>> {
  const out = new Map<string, ScopedRepository>();
  const unique = [...new Set(repositoryIds)];
  for (const part of chunk(unique)) {
    const rows = await db
      .select({
        id: repositories.id,
        name: repositories.name,
        city: repositories.city,
        code: repositories.code,
        rightsText: repositories.rightsText,
      })
      .from(repositories)
      .where(and(eq(repositories.tenantId, tenant.id), inArray(repositories.id, part)))
      .all();
    for (const row of rows) {
      out.set(row.id, {
        name: row.name,
        city: row.city ?? "",
        code: row.code,
        rightsText: row.rightsText ?? null,
      });
    }
  }
  return out;
}

/** Entity rows in the order asked for. */
export async function readScopedEntities(
  db: DrizzleD1Database<any>,
  tenant: Tenant,
  ids: string[],
): Promise<EntityRow[]> {
  const byId = new Map<string, EntityRow>();
  for (const part of chunk(ids)) {
    const rows = await db
      .select()
      .from(entities)
      .where(
        and(
          authorityScope(entities, tenant.federationId, tenant.id),
          inArray(entities.id, part),
        ),
      )
      .all();
    for (const row of rows) byId.set(row.id, row);
  }
  return ids.map((id) => byId.get(id)).filter((row): row is EntityRow => row !== undefined);
}

/** Place rows in the order asked for. */
export async function readScopedPlaces(
  db: DrizzleD1Database<any>,
  tenant: Tenant,
  ids: string[],
): Promise<PlaceRow[]> {
  const byId = new Map<string, PlaceRow>();
  for (const part of chunk(ids)) {
    const rows = await db
      .select()
      .from(places)
      .where(
        and(
          authorityScope(places, tenant.federationId, tenant.id),
          inArray(places.id, part),
        ),
      )
      .all();
    for (const row of rows) byId.set(row.id, row);
  }
  return ids.map((id) => byId.get(id)).filter((row): row is PlaceRow => row !== undefined);
}

/** Place codes (or labels, for a place with no code yet), keyed by id. */
export async function readPlaceCodes(
  db: DrizzleD1Database<any>,
  tenant: Tenant,
  ids: string[],
): Promise<Map<string, string>> {
  const codes = new Map<string, string>();
  for (const part of chunk(ids)) {
    const rows = await db
      .select({ id: places.id, placeCode: places.placeCode, label: places.label })
      .from(places)
      .where(
        and(
          authorityScope(places, tenant.federationId, tenant.id),
          inArray(places.id, part),
        ),
      )
      .all();
    for (const row of rows) codes.set(row.id, row.placeCode ?? row.label);
  }
  return codes;
}

/**
 * Entity links. Read from the DESCRIPTION side for a records scope and
 * from the AUTHORITY side for an authority scope, so each reads the set
 * it actually holds rather than the one it inferred — the same split
 * the canonical CSV makes, for the same reason.
 */
export async function readEntityLinks(
  db: DrizzleD1Database<any>,
  tenant: Tenant,
  side: "descriptions" | "authorities",
  ids: string[],
): Promise<ScopedLink[]> {
  const out: ScopedLink[] = [];
  for (const part of chunk(ids)) {
    const rows = await db
      .select({
        descriptionCode: descriptions.referenceCode,
        authorityCode: entities.entityCode,
        displayName: entities.displayName,
        role: descriptionEntities.role,
        roleNote: descriptionEntities.roleNote,
        roleRaw: descriptionEntities.roleRaw,
        sequence: descriptionEntities.sequence,
        honorific: descriptionEntities.honorific,
        fn: descriptionEntities.function,
        nameAsRecorded: descriptionEntities.nameAsRecorded,
      })
      .from(descriptionEntities)
      .innerJoin(descriptions, eq(descriptions.id, descriptionEntities.descriptionId))
      .innerJoin(entities, eq(entities.id, descriptionEntities.entityId))
      .where(
        and(
          eq(descriptions.tenantId, tenant.id),
          authorityScope(entities, tenant.federationId, tenant.id),
          side === "descriptions"
            ? inArray(descriptions.id, part)
            : inArray(descriptionEntities.entityId, part),
        ),
      )
      .all();
    for (const row of rows) {
      out.push({
        linkDescriptionCode: row.descriptionCode,
        // An authority with no code yet is named by its display name:
        // the link must stay resolvable by a human before a code exists.
        linkAuthorityCode: row.authorityCode ?? row.displayName,
        linkRole: row.role,
        linkRoleNote: row.roleNote,
        linkRoleRaw: row.roleRaw,
        linkSequence: row.sequence,
        linkHonorific: row.honorific,
        linkFunction: row.fn,
        linkNameAsRecorded: row.nameAsRecorded,
      });
    }
  }
  return sortLinks(out);
}

/** Place links, on the same rule as the entity links. */
export async function readPlaceLinks(
  db: DrizzleD1Database<any>,
  tenant: Tenant,
  side: "descriptions" | "authorities",
  ids: string[],
): Promise<ScopedLink[]> {
  const out: ScopedLink[] = [];
  for (const part of chunk(ids)) {
    const rows = await db
      .select({
        descriptionCode: descriptions.referenceCode,
        authorityCode: places.placeCode,
        label: places.label,
        role: descriptionPlaces.role,
        roleNote: descriptionPlaces.roleNote,
        roleRaw: descriptionPlaces.roleRaw,
      })
      .from(descriptionPlaces)
      .innerJoin(descriptions, eq(descriptions.id, descriptionPlaces.descriptionId))
      .innerJoin(places, eq(places.id, descriptionPlaces.placeId))
      .where(
        and(
          eq(descriptions.tenantId, tenant.id),
          authorityScope(places, tenant.federationId, tenant.id),
          side === "descriptions"
            ? inArray(descriptions.id, part)
            : inArray(descriptionPlaces.placeId, part),
        ),
      )
      .all();
    for (const row of rows) {
      out.push({
        linkDescriptionCode: row.descriptionCode,
        linkAuthorityCode: row.authorityCode ?? row.label,
        linkRole: row.role,
        linkRoleNote: row.roleNote,
        linkRoleRaw: row.roleRaw,
        // A place link has no sequence, honorific, function or
        // name-as-recorded; the columns exist because entity links have
        // them, and null is the honest value rather than a blank.
        linkSequence: null,
        linkHonorific: null,
        linkFunction: null,
        linkNameAsRecorded: null,
      });
    }
  }
  return sortLinks(out);
}

/**
 * Links in a stable order: by the record they belong to, then by the
 * cataloguer's sequence, then by the authority. Identical to the
 * canonical CSV's ordering, so the two serialisations of one scope list
 * the same links in the same order.
 */
function sortLinks(rows: ScopedLink[]): ScopedLink[] {
  return rows.sort((a, b) => {
    const code = a.linkDescriptionCode.localeCompare(b.linkDescriptionCode);
    if (code !== 0) return code;
    const seq = (a.linkSequence ?? 0) - (b.linkSequence ?? 0);
    if (seq !== 0) return seq;
    return a.linkAuthorityCode.localeCompare(b.linkAuthorityCode);
  });
}

/* @version v0.7.0 */
