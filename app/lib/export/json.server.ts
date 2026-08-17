/**
 * JSON — the same field assembly as the CSV, with its types intact
 *
 * This module deals with emitting a resolved scope as structured
 * objects rather than spreadsheet rows. It is not a second export
 * pipeline: it asks the same forms the CSV asks for the same fields in
 * the same order, and the only thing it does differently is refuse to
 * flatten them into strings.
 *
 * ONE ARTIFACT, FOUR SECTIONS, AND A MASTHEAD. `meta` says what this
 * file is — the scope in the ledger's own words, the form, the counts
 * the confirm bar stated, and when it was generated — because a JSON
 * file on a desktop six months later must be able to answer "what is
 * this?" without the history row beside it. Then `records`, `entities`,
 * `places` and `links`, each present whether or not it holds anything:
 * a consumer writing `data.entities.length` should not have to guard
 * against the key being missing because the authorities toggle was off.
 *
 * KEY ORDER IS STABLE AND IT IS THE COLUMN CONTRACT'S ORDER. Every
 * record's keys run in `generateCanonicalHeaders(standard)` order, the
 * same generated projection of the union schema the import template and
 * the canonical CSV use; authority records run in `ENTITY_COLUMNS` /
 * `PLACE_COLUMNS` order. Two runs of one scope therefore produce
 * byte-identical files apart from the generated stamp, which makes
 * diffing two exports a real thing to do.
 *
 * WHERE IT DIVERGES FROM THE CSV, AND WHY — there are exactly three
 * places, and all three are the same argument:
 *
 *   - An absent value is `null`, not `""`. A CSV cannot tell the two
 *     apart; JSON can, and "we hold no scope note" and "we hold an
 *     empty scope note" are different claims about a catalogue.
 *   - `hasDigital` carries its real boolean. The CSV blanks it because
 *     a filled cell would reject its row on re-import — a round-trip
 *     constraint that does not bind a format nothing re-imports.
 *   - `legacyIds` carries the parsed array rather than the JSON text of
 *     the column. Re-encoding a structure as a string inside a
 *     structured file would be a strange thing to hand anybody.
 *
 * The Dublin Core form goes through the same door: its records are the
 * fifteen elements as `dc:*` keys, and its links ride in their
 * canonical shape for the reason `dc-form.server.ts` states.
 *
 * @version v0.7.0
 */

import { ENTITY_COLUMNS, PLACE_COLUMNS } from "./canonical-csv.server";
import type { ExportArtifact, ExportEmitContext } from "./canonical-csv.server";
import { assembleDcForm } from "./dc-form.server";
import { dcRecordAsObject } from "./dc/crosswalk";
import { standardForForm } from "./forms";
import type { ExportEmitInput } from "./emitters.server";
import { generateCanonicalHeaders } from "../import/canonical-template";
import {
  readEntityLinks,
  readPlaceLinks,
  readScopedDescriptions,
  readScopedEntities,
  readScopedPlaces,
} from "./rows.server";
import type { EntityRow, PlaceRow, ScopedDescription, ScopedLink } from "./rows.server";

/** The masthead. Everything a reader needs to place the file. */
export interface ExportJsonMeta {
  generatedAt: string;
  form: string;
  /** The column projection behind the form; null for Dublin Core. */
  standard: string | null;
  scope: {
    kind: string;
    recordClass: string;
    descriptor: unknown;
  };
  includeAuthorities: boolean;
  counts: { records: number; entities: number; places: number; links: number };
}

export interface ExportJsonDocument {
  meta: ExportJsonMeta;
  records: Record<string, unknown>[];
  entities: Record<string, unknown>[];
  places: Record<string, unknown>[];
  links: Record<string, unknown>[];
}

/** Emit a scope as one JSON document. */
export async function emitJson(
  input: ExportEmitInput,
  ctx: ExportEmitContext,
): Promise<ExportArtifact> {
  const document =
    input.form === "dc"
      ? await buildDcDocument(input, ctx)
      : await buildCanonicalDocument(input, ctx);

  await ctx.checkpoint("serializing", 1, 1);
  return {
    body: JSON.stringify(document, null, 2) + "\n",
    contentType: "application/json; charset=utf-8",
    extension: "json",
  };
}

function buildMeta(input: ExportEmitInput, standard: string | null): ExportJsonMeta {
  return {
    generatedAt: new Date().toISOString(),
    form: input.form,
    standard,
    scope: {
      kind: input.scope.kind,
      recordClass: input.scope.recordClass,
      descriptor: input.scope.descriptor,
    },
    includeAuthorities:
      input.scope.recordClass === "records" ? input.includeAuthorities : true,
    counts: {
      records: input.scope.counts.records,
      entities: input.scope.counts.entities,
      places: input.scope.counts.places,
      links: input.scope.counts.links,
    },
  };
}

/** The three descriptive standards and the canonical form. */
async function buildCanonicalDocument(
  input: ExportEmitInput,
  ctx: ExportEmitContext,
): Promise<ExportJsonDocument> {
  const { db, tenant, scope } = input;
  const standard = standardForForm(input.form, input.ownStandard);
  if (standard === null) {
    // Unreachable: the only form with no standard is Dublin Core, and
    // it never arrives here. Named rather than assumed, so a fourth
    // form added later fails loudly instead of emitting a bare file.
    throw new Error(`No column projection for the ${input.form} form`);
  }
  const columns = generateCanonicalHeaders(standard);
  const authorityScopeKind = scope.recordClass !== "records";
  const withAuthorities = authorityScopeKind || input.includeAuthorities;

  const records: Record<string, unknown>[] = [];
  if (!authorityScopeKind) {
    await ctx.checkpoint("descriptions", 0, scope.memberIds.length);
    const rows = await readScopedDescriptions(db, tenant, scope.memberIds);
    for (const scoped of rows) records.push(descriptionObject(scoped, columns));
    await ctx.checkpoint("descriptions", records.length, scope.memberIds.length);
  }

  const entities: Record<string, unknown>[] = [];
  const places: Record<string, unknown>[] = [];
  const links: Record<string, unknown>[] = [];

  if (withAuthorities) {
    const total = scope.entityIds.length + scope.placeIds.length + scope.counts.links;
    await ctx.checkpoint("authorities", 0, total);

    for (const row of await readScopedEntities(db, tenant, scope.entityIds)) {
      entities.push(entityObject(row));
    }
    await ctx.checkpoint("authorities", entities.length, total);

    const placeCodes = new Map<string, string>();
    const placeRows = await readScopedPlaces(db, tenant, scope.placeIds);
    for (const row of placeRows) placeCodes.set(row.id, row.placeCode ?? row.label);
    for (const row of placeRows) places.push(placeObject(row, placeCodes));
    await ctx.checkpoint("authorities", entities.length + places.length, total);

    for (const link of await collectLinks(input)) links.push(link);
    await ctx.checkpoint(
      "authorities",
      Math.min(entities.length + places.length + links.length, total),
      total,
    );
  }

  return { meta: buildMeta(input, standard), records, entities, places, links };
}

/** The Dublin Core form, through the same crosswalk the DC CSV uses. */
async function buildDcDocument(
  input: ExportEmitInput,
  ctx: ExportEmitContext,
): Promise<ExportJsonDocument> {
  const data = await assembleDcForm(input, ctx);
  return {
    meta: buildMeta(input, null),
    records: data.records.map(dcRecordAsObject),
    entities: data.entities.map(dcRecordAsObject),
    places: data.places.map(dcRecordAsObject),
    links: data.links.map(({ rowType, link }) => linkObject(rowType, link)),
  };
}

/**
 * Every link the scope carries, read from whichever side the scope
 * holds — descriptions for a records scope, authorities for an
 * authority scope.
 */
async function collectLinks(input: ExportEmitInput): Promise<Record<string, unknown>[]> {
  const { db, tenant, scope } = input;
  const authorityScopeKind = scope.recordClass !== "records";
  const side = authorityScopeKind ? "authorities" : "descriptions";
  const entityIds = authorityScopeKind ? scope.entityIds : scope.memberIds;
  const placeIds = authorityScopeKind ? scope.placeIds : scope.memberIds;

  const out: Record<string, unknown>[] = [];
  for (const link of await readEntityLinks(db, tenant, side, entityIds)) {
    out.push(linkObject("entityLink", link));
  }
  for (const link of await readPlaceLinks(db, tenant, side, placeIds)) {
    out.push(linkObject("placeLink", link));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Object projections. Column ORDER comes from the shared contracts; only
// the values differ from the CSV's, and only in the three ways the
// module header names.
// ---------------------------------------------------------------------------

function descriptionObject(
  scoped: ScopedDescription,
  columns: string[],
): Record<string, unknown> {
  const row = scoped.row as unknown as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const column of columns) {
    if (column === "parent") {
      out[column] = scoped.parentReferenceCode;
      continue;
    }
    if (column === "legacyIds") {
      out[column] = scoped.legacyIds ?? [];
      continue;
    }
    out[column] = row[column] ?? null;
  }
  return out;
}

function entityObject(row: EntityRow): Record<string, unknown> {
  const values: Record<string, unknown> = {
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
  return inColumnOrder(ENTITY_COLUMNS, values);
}

function placeObject(
  row: PlaceRow,
  placeCodes: Map<string, string>,
): Record<string, unknown> {
  const values: Record<string, unknown> = {
    placeCode: row.placeCode,
    placeLabel: row.label,
    placeDisplayName: row.displayName,
    placeType: row.placeType,
    placeFclass: row.fclass,
    placeNameVariants: row.nameVariants,
    placeParentCode: row.parentId ? (placeCodes.get(row.parentId) ?? null) : null,
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
  return inColumnOrder(PLACE_COLUMNS, values);
}

/**
 * A link, carrying its kind. The `rowType` values are the canonical
 * CSV's own row types, so a consumer reading both formats meets one
 * vocabulary.
 */
function linkObject(rowType: string, link: ScopedLink): Record<string, unknown> {
  return { rowType, ...link };
}

function inColumnOrder(
  columns: readonly string[],
  values: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const column of columns) out[column] = values[column] ?? null;
  return out;
}

/* @version v0.7.0 */
