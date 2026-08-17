/**
 * Canonical CSV — the round trip, and the proof the data is not a hostage
 *
 * This module deals with emitting a scope as spreadsheet rows in the
 * SAME columns the importer reads, so export → edit in a spreadsheet →
 * re-import lands through the existing update path with no column
 * mapping to do. It is the flagship format of the export surface for
 * exactly that reason: everything else demonstrates that Fisqua can
 * describe records, and this demonstrates that Fisqua can let go of
 * them.
 *
 * THE COLUMN CONTRACT IS NOT REDECLARED HERE. The description headers
 * are `generateCanonicalHeaders(standard)` verbatim — the same
 * generated projection of the union schema the import template downloads
 * — in the same order. `app/lib/import/canonical-template.ts` states
 * this as its own constraint ("this same projection is the future export
 * pipeline's emission shape"), and the drift test that pins the template
 * therefore pins this emitter too. A second column list would be a
 * second contract to get wrong.
 *
 * ONE FILE, AND SOMETIMES MORE THAN ONE KIND OF ROW. A run stores one
 * artifact, but an export that carries authorities carries three kinds
 * of thing: descriptions, authority records, and the links between
 * them. A CSV is one table, so:
 *
 *   - A records scope with the authorities toggle OFF emits the
 *     canonical description columns and NOTHING ELSE — byte-for-byte
 *     the shape the importer expects. This is the round trip proper.
 *   - Any other combination emits a DISCRIMINATED file: a leading
 *     `rowType` column, then the description columns, then the entity,
 *     place and link columns. Every row fills only its own kind's
 *     columns. Filtering to `rowType = description` and deleting the
 *     first column reproduces the round-trip file exactly, which is
 *     what keeps the two layouts one format rather than two.
 *
 * The authority and link columns carry their kind in their names
 * (`entityCode`, `placeLabel`, `linkRole`) because several of them
 * would otherwise collide with a description column of the same name —
 * `notes`, `legacyIds`, `dateStart` all exist on both sides — and the
 * importer rejects a file with duplicated headers outright, correctly.
 *
 * WHAT THE IMPORTER CAN READ BACK, AND WHAT IT CANNOT. Imports link
 * authorities, they never mint them (the import spec's link-never-mint
 * rule), so the entity, place and link rows are export-only: they carry
 * the workspace's authority data out, and no path reads them back in.
 * Two description columns are also asymmetric, and both are emitted
 * deliberately:
 *
 *   - `repositoryId` holds the column's own value, a UUID. The importer
 *     assigns the repository from the run's target and discards a bound
 *     value, so the cell is informational on the way back — but a
 *     header named `repositoryId` carrying a repository CODE would be a
 *     lie about which column it is.
 *   - `hasDigital` is emitted EMPTY, always. It is a checkbox whose
 *     validator accepts a real boolean and nothing else, so any filled
 *     cell would reject its whole row on re-import; blank means "leave
 *     it as it is on update, default false on create", which is the
 *     only value that round-trips. The flag is derivable from
 *     `iiifManifestUrl` in any case.
 *
 * ENCODING. UTF-8 with a leading BOM and CRLF line endings — the
 * `utf-8-sig` shape Excel needs to open accented Spanish correctly, and
 * the shape `decodeUtf8` strips on the way back in. Quoting is RFC 4180
 * and matches the importer's own parser: a cell is quoted when it holds
 * a comma, a quote, a newline or edge whitespace, and an embedded quote
 * doubles.
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
} from "../../db/schema";
import { authorityScope } from "../authority-ownership.server";
import { generateCanonicalHeaders } from "../import/canonical-template";
import type { Standard } from "../standards/types";
import type { Tenant } from "../../context";
import { ID_CHUNK } from "./scopes.server";
import type { ResolvedExportScope } from "./scopes.server";

/** The discriminator column, present only in the multi-table layout. */
export const ROW_TYPE_COLUMN = "rowType";

/** What a discriminated row says it is. */
export const CSV_ROW_TYPES = [
  "description",
  "entity",
  "place",
  "entityLink",
  "placeLink",
] as const;
export type CsvRowType = (typeof CSV_ROW_TYPES)[number];

/**
 * Authority-record columns. Export-only (imports never mint an
 * authority), so this list answers to no import contract — it is the
 * `entities` table's descriptive columns, kind-prefixed to stay clear
 * of the description headers.
 */
export const ENTITY_COLUMNS = [
  "entityCode",
  "entityDisplayName",
  "entitySortName",
  "entityGivenName",
  "entitySurname",
  "entityType",
  "entityHonorific",
  "entityPrimaryFunction",
  "entityNameVariants",
  "entityDatesOfExistence",
  "entityDateStart",
  "entityDateEnd",
  "entityHistory",
  "entityFunctions",
  "entitySources",
  "entityWikidataId",
  "entityViafId",
  "entityDbeId",
  "entityLegacyIds",
  "entityNotes",
  "entityInternalNotes",
] as const;

/** Place columns, on the same rule as the entity columns. */
export const PLACE_COLUMNS = [
  "placeCode",
  "placeLabel",
  "placeDisplayName",
  "placeType",
  "placeFclass",
  "placeNameVariants",
  "placeParentCode",
  "placeLatitude",
  "placeLongitude",
  "placeCoordinatePrecision",
  "placeTgnId",
  "placeHgisId",
  "placeWhgId",
  "placeLegacyIds",
  "placeNotes",
  "placeInternalNotes",
] as const;

/**
 * Link columns, shared by both link row types. Both sides are named by
 * CODE rather than by id: a reference code and an authority code are
 * what a person can read, look up and correct in a spreadsheet, and
 * they are what survives a re-import into a different workspace.
 */
export const LINK_COLUMNS = [
  "linkDescriptionCode",
  "linkAuthorityCode",
  "linkRole",
  "linkRoleNote",
  "linkRoleRaw",
  "linkSequence",
  "linkHonorific",
  "linkFunction",
  "linkNameAsRecorded",
] as const;

/** Which blocks a file carries; decides the layout and the headers. */
export interface CanonicalCsvLayout {
  /** Description rows and the canonical columns. */
  descriptions: boolean;
  /** Entity, place and link rows, and their columns. */
  authorities: boolean;
}

/**
 * The header row for a layout. Single-block files carry no `rowType`:
 * the discriminator exists to tell kinds apart, and a file with one
 * kind has nothing to tell apart — adding it would break the round trip
 * for the sake of a column that says the same word on every line.
 */
export function canonicalCsvHeaders(
  standard: Standard,
  layout: CanonicalCsvLayout,
): string[] {
  const blocks: string[][] = [];
  if (layout.descriptions) blocks.push(generateCanonicalHeaders(standard));
  if (layout.authorities) {
    blocks.push([...ENTITY_COLUMNS], [...PLACE_COLUMNS], [...LINK_COLUMNS]);
  }
  const columns = blocks.flat();
  const discriminated = layout.descriptions && layout.authorities;
  return discriminated || layout.authorities
    ? [ROW_TYPE_COLUMN, ...columns]
    : columns;
}

/** RFC 4180 cell. Matches what `app/lib/import/csv.ts` parses back. */
export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "boolean") return value ? "true" : "false";
  const text = String(value);
  if (text === "") return "";
  const needsQuotes =
    text.includes(",") ||
    text.includes('"') ||
    text.includes("\n") ||
    text.includes("\r") ||
    text !== text.trim();
  return needsQuotes ? `"${text.replace(/"/g, '""')}"` : text;
}

/** One record as a CSV line, in the given column order. */
function csvLine(columns: readonly string[], row: Record<string, unknown>): string {
  return columns.map((column) => csvCell(row[column])).join(",") + "\r\n";
}

/** UTF-8 BOM: the `utf-8-sig` head Excel needs and the importer strips. */
const BOM = "\uFEFF";

/**
 * What the emitter is doing, in the vocabulary the dialog's working
 * line uses: writing descriptions, then authorities, then the
 * serialisation.
 */
export type ExportStage = "descriptions" | "authorities" | "serializing";

/**
 * The lifecycle's hook into a long emit. The run implementation records
 * the stage and the progress, and throws if the run was cancelled — so
 * an emitter never has to know what cancellation is, only where it is
 * safe to be interrupted.
 */
export interface ExportEmitContext {
  checkpoint(stage: ExportStage, done: number, total: number): Promise<void>;
}

export interface CanonicalCsvInput {
  db: DrizzleD1Database<any>;
  tenant: Tenant;
  scope: ResolvedExportScope;
  /** Which standard's column projection to emit. */
  standard: Standard;
  includeAuthorities: boolean;
}

/** A finished artifact, ready for its R2 key and its ledger row. */
export interface ExportArtifact {
  body: string;
  contentType: string;
  /** File extension without the dot. */
  extension: string;
}

function chunk<T>(items: readonly T[], size = ID_CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Emit a scope as canonical CSV.
 *
 * Rows are written in the scope's own order — the hierarchy's preorder,
 * the carried set's order, the handlist's order — because that order is
 * part of what was chosen. Authority and link blocks follow the
 * descriptions, each in its own stable order, so two runs of the same
 * scope produce the same bytes.
 *
 * The body is assembled as an array of lines and joined once at the
 * end. Growing a single string would copy it on every row.
 */
export async function emitCanonicalCsv(
  input: CanonicalCsvInput,
  ctx: ExportEmitContext,
): Promise<ExportArtifact> {
  const { db, tenant, scope, standard } = input;
  const authorityScopeKind = scope.recordClass !== "records";
  const layout: CanonicalCsvLayout = {
    descriptions: !authorityScopeKind,
    authorities: authorityScopeKind || input.includeAuthorities,
  };
  const columns = canonicalCsvHeaders(standard, layout);
  const discriminated = columns[0] === ROW_TYPE_COLUMN;
  const descriptionColumns = generateCanonicalHeaders(standard);

  const lines: string[] = [BOM + columns.join(",") + "\r\n"];

  const write = (rowType: CsvRowType, row: Record<string, unknown>): void => {
    lines.push(csvLine(columns, discriminated ? { ...row, rowType } : row));
  };

  // ---- Stage 1: descriptions -------------------------------------------
  if (layout.descriptions) {
    const total = scope.memberIds.length;
    await ctx.checkpoint("descriptions", 0, total);
    let done = 0;
    for (const part of chunk(scope.memberIds)) {
      const rows = await readDescriptions(db, tenant, part);
      const parentCodes = await readReferenceCodes(
        db,
        tenant,
        [...new Set(rows.map((r) => r.parentId).filter((id): id is string => id !== null))],
      );
      for (const id of part) {
        const row = rows.find((r) => r.id === id);
        if (!row) continue;
        write("description", descriptionRow(row, descriptionColumns, parentCodes));
      }
      done += part.length;
      await ctx.checkpoint("descriptions", Math.min(done, total), total);
    }
  }

  // ---- Stage 2: authorities and their links ----------------------------
  if (layout.authorities) {
    const total =
      scope.entityIds.length + scope.placeIds.length + scope.counts.links;
    await ctx.checkpoint("authorities", 0, total);
    let done = 0;

    for (const part of chunk(scope.entityIds)) {
      const rows = await readEntities(db, tenant, part);
      for (const id of part) {
        const row = rows.find((r) => r.id === id);
        if (row) write("entity", entityRow(row));
      }
      done += part.length;
      await ctx.checkpoint("authorities", done, total);
    }

    const placeParents = await readPlaceCodes(db, tenant, scope.placeIds);
    for (const part of chunk(scope.placeIds)) {
      const rows = await readPlaces(db, tenant, part);
      for (const id of part) {
        const row = rows.find((r) => r.id === id);
        if (row) write("place", placeRow(row, placeParents));
      }
      done += part.length;
      await ctx.checkpoint("authorities", done, total);
    }

    // Links are read from the AUTHORITY side for an authority scope and
    // from the DESCRIPTION side for a records scope, so each reads the
    // set it actually holds rather than the one it inferred.
    const entityLinks = authorityScopeKind
      ? await readEntityLinksByAuthority(db, tenant, scope.entityIds)
      : await readEntityLinksByDescription(db, tenant, scope.memberIds);
    for (const link of entityLinks) write("entityLink", link);
    done += entityLinks.length;
    await ctx.checkpoint("authorities", Math.min(done, total), total);

    const placeLinks = authorityScopeKind
      ? await readPlaceLinksByAuthority(db, tenant, scope.placeIds)
      : await readPlaceLinksByDescription(db, tenant, scope.memberIds);
    for (const link of placeLinks) write("placeLink", link);
    done += placeLinks.length;
    await ctx.checkpoint("authorities", Math.min(done, total), total);
  }

  await ctx.checkpoint("serializing", 1, 1);
  return {
    body: lines.join(""),
    contentType: "text/csv; charset=utf-8",
    extension: "csv",
  };
}

// ---------------------------------------------------------------------------
// Row projections
// ---------------------------------------------------------------------------

type DescriptionRow = typeof descriptions.$inferSelect;

/**
 * One description as the canonical columns see it. Every header is a
 * field name on the row except the two the template owns itself:
 * `parent`, which resolves to the parent's reference code because that
 * is how the importer rebuilds the hierarchy, and `hasDigital`, which
 * is deliberately blank (see the module header).
 */
function descriptionRow(
  row: DescriptionRow,
  columns: string[],
  parentCodes: Map<string, string>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const column of columns) {
    if (column === "parent") {
      out[column] = row.parentId ? (parentCodes.get(row.parentId) ?? "") : "";
      continue;
    }
    if (column === "hasDigital") {
      out[column] = "";
      continue;
    }
    out[column] = (row as unknown as Record<string, unknown>)[column] ?? "";
  }
  return out;
}

function entityRow(row: typeof entities.$inferSelect): Record<string, unknown> {
  return {
    entityCode: row.entityCode,
    entityDisplayName: row.displayName,
    entitySortName: row.sortName,
    entityGivenName: row.givenName,
    entitySurname: row.surname,
    entityType: row.entityType,
    entityHonorific: row.honorific,
    entityPrimaryFunction: row.primaryFunction,
    entityNameVariants: row.nameVariants,
    entityDatesOfExistence: row.datesOfExistence,
    entityDateStart: row.dateStart,
    entityDateEnd: row.dateEnd,
    entityHistory: row.history,
    entityFunctions: row.functions,
    entitySources: row.sources,
    entityWikidataId: row.wikidataId,
    entityViafId: row.viafId,
    entityDbeId: row.dbeId,
    entityLegacyIds: row.legacyIds,
    entityNotes: row.notes,
    entityInternalNotes: row.internalNotes,
  };
}

function placeRow(
  row: typeof places.$inferSelect,
  parentCodes: Map<string, string>,
): Record<string, unknown> {
  return {
    placeCode: row.placeCode,
    placeLabel: row.label,
    placeDisplayName: row.displayName,
    placeType: row.placeType,
    placeFclass: row.fclass,
    placeNameVariants: row.nameVariants,
    placeParentCode: row.parentId ? (parentCodes.get(row.parentId) ?? "") : "",
    placeLatitude: row.latitude,
    placeLongitude: row.longitude,
    placeCoordinatePrecision: row.coordinatePrecision,
    placeTgnId: row.tgnId,
    placeHgisId: row.hgisId,
    placeWhgId: row.whgId,
    placeLegacyIds: row.legacyIds,
    placeNotes: row.notes,
    placeInternalNotes: row.internalNotes,
  };
}

// ---------------------------------------------------------------------------
// Reads. Every statement names the request tenant, and every authority
// read goes through `authorityScope`.
// ---------------------------------------------------------------------------

async function readDescriptions(
  db: DrizzleD1Database<any>,
  tenant: Tenant,
  ids: string[],
): Promise<DescriptionRow[]> {
  if (ids.length === 0) return [];
  return db
    .select()
    .from(descriptions)
    .where(and(eq(descriptions.tenantId, tenant.id), inArray(descriptions.id, ids)))
    .all();
}

/** Reference codes for a set of description ids — the `parent` column. */
async function readReferenceCodes(
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

async function readEntities(
  db: DrizzleD1Database<any>,
  tenant: Tenant,
  ids: string[],
): Promise<(typeof entities.$inferSelect)[]> {
  if (ids.length === 0) return [];
  return db
    .select()
    .from(entities)
    .where(
      and(
        authorityScope(entities, tenant.federationId, tenant.id),
        inArray(entities.id, ids),
      ),
    )
    .all();
}

async function readPlaces(
  db: DrizzleD1Database<any>,
  tenant: Tenant,
  ids: string[],
): Promise<(typeof places.$inferSelect)[]> {
  if (ids.length === 0) return [];
  return db
    .select()
    .from(places)
    .where(
      and(
        authorityScope(places, tenant.federationId, tenant.id),
        inArray(places.id, ids),
      ),
    )
    .all();
}

/** Place codes for the parent column, keyed by place id. */
async function readPlaceCodes(
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
 * Entity links under a set of DESCRIPTIONS — the records-scope reading.
 * Ordered by description code then sequence, so a record's agents keep
 * the order the cataloguer gave them.
 */
async function readEntityLinksByDescription(
  db: DrizzleD1Database<any>,
  tenant: Tenant,
  descriptionIds: string[],
): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  for (const part of chunk(descriptionIds)) {
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
          inArray(descriptions.id, part),
        ),
      )
      .all();
    for (const row of rows) out.push(entityLinkRow(row));
  }
  return sortLinks(out);
}

/** Entity links under a set of ENTITIES — the authority-scope reading. */
async function readEntityLinksByAuthority(
  db: DrizzleD1Database<any>,
  tenant: Tenant,
  entityIds: string[],
): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  for (const part of chunk(entityIds)) {
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
          inArray(descriptionEntities.entityId, part),
        ),
      )
      .all();
    for (const row of rows) out.push(entityLinkRow(row));
  }
  return sortLinks(out);
}

async function readPlaceLinksByDescription(
  db: DrizzleD1Database<any>,
  tenant: Tenant,
  descriptionIds: string[],
): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  for (const part of chunk(descriptionIds)) {
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
          inArray(descriptions.id, part),
        ),
      )
      .all();
    for (const row of rows) out.push(placeLinkRow(row));
  }
  return sortLinks(out);
}

async function readPlaceLinksByAuthority(
  db: DrizzleD1Database<any>,
  tenant: Tenant,
  placeIds: string[],
): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  for (const part of chunk(placeIds)) {
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
          inArray(descriptionPlaces.placeId, part),
        ),
      )
      .all();
    for (const row of rows) out.push(placeLinkRow(row));
  }
  return sortLinks(out);
}

function entityLinkRow(row: {
  descriptionCode: string;
  authorityCode: string | null;
  displayName: string;
  role: string;
  roleNote: string | null;
  roleRaw: string | null;
  sequence: number;
  honorific: string | null;
  fn: string | null;
  nameAsRecorded: string | null;
}): Record<string, unknown> {
  return {
    linkDescriptionCode: row.descriptionCode,
    // An authority with no code yet is named by its display name: the
    // link must stay resolvable by a human even before a code is issued.
    linkAuthorityCode: row.authorityCode ?? row.displayName,
    linkRole: row.role,
    linkRoleNote: row.roleNote,
    linkRoleRaw: row.roleRaw,
    linkSequence: row.sequence,
    linkHonorific: row.honorific,
    linkFunction: row.fn,
    linkNameAsRecorded: row.nameAsRecorded,
  };
}

function placeLinkRow(row: {
  descriptionCode: string;
  authorityCode: string | null;
  label: string;
  role: string;
  roleNote: string | null;
  roleRaw: string | null;
}): Record<string, unknown> {
  return {
    linkDescriptionCode: row.descriptionCode,
    linkAuthorityCode: row.authorityCode ?? row.label,
    linkRole: row.role,
    linkRoleNote: row.roleNote,
    linkRoleRaw: row.roleRaw,
    linkSequence: "",
    linkHonorific: "",
    linkFunction: "",
    linkNameAsRecorded: "",
  };
}

/**
 * Links in a stable order: by the record they belong to, then by the
 * cataloguer's sequence, then by the authority. Chunked reads arrive in
 * whatever order the chunks did, and an artifact that reordered itself
 * between two identical runs would make diffing an export useless.
 */
function sortLinks(rows: Record<string, unknown>[]): Record<string, unknown>[] {
  return rows.sort((a, b) => {
    const code = String(a.linkDescriptionCode).localeCompare(
      String(b.linkDescriptionCode),
    );
    if (code !== 0) return code;
    const seq = Number(a.linkSequence || 0) - Number(b.linkSequence || 0);
    if (seq !== 0) return seq;
    return String(a.linkAuthorityCode).localeCompare(String(b.linkAuthorityCode));
  });
}

/* @version v0.7.0 */
