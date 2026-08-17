/**
 * Dublin Core as a form, over a scope — assembly and the CSV of it
 *
 * This module deals with taking a resolved export scope through the
 * fifteen-element crosswalk and handing back either structured records
 * (which the JSON emitter serialises) or a spreadsheet (which this
 * module writes itself). It is the half of ruling 1 that touches the
 * database; `dc/crosswalk.ts` is the half that is pure.
 *
 * THE READING IS ALWAYS `workspace-export`. A workspace export's
 * `dc:description` merges scope and content with the biographical note,
 * and its `dc:rights` merges access with reproduction conditions —
 * precisely the merges the loss report warns about under the Form axis.
 * The OAI bulk file's reading is the publish pipeline's and is not
 * reachable from here.
 *
 * EVERY DESCRIPTION IN THE SCOPE LEAVES, published or not. The bulk
 * builder filters on `isPublished` because a harvester may only see
 * what a workspace has published; a workspace exporting its own records
 * is not harvesting them, and silently dropping the unpublished half of
 * a scope whose count the confirm bar just stated would be the worst
 * kind of surprise.
 *
 * THE CSV LAYOUT MIRRORS THE CANONICAL ONE'S DISCIPLINE. A records
 * scope with authorities off is fifteen `dc:*` columns and nothing
 * else. Anything else is DISCRIMINATED: a leading `rowType`, then the
 * fifteen elements, then the link columns. Entities and places need no
 * columns of their own here — an authority record crosswalked to Dublin
 * Core IS fifteen elements, the same fifteen — which is the one way
 * this layout is simpler than the canonical CSV's.
 *
 * LINKS RIDE IN THEIR CANONICAL SHAPE, in both this CSV and the JSON.
 * Dublin Core has no element for "this record was created by that
 * authority record"; `dc:creator` carries a NAME, not a relationship
 * with a role and a sequence. Rather than lose the links or invent an
 * element for them, they are emitted in the same link columns every
 * other format uses, and the file says so with its `rowType`.
 *
 * @version v0.7.0
 */

import { csvCell, LINK_COLUMNS, ROW_TYPE_COLUMN } from "./canonical-csv.server";
import type {
  CsvRowType,
  ExportArtifact,
  ExportEmitContext,
} from "./canonical-csv.server";
import {
  DC_COLUMNS,
  DC_ELEMENTS,
  dcDescriptionRecord,
  dcEntityRecord,
  dcPlaceRecord,
  dcRecordAsObject,
} from "./dc/crosswalk";
import type { DcRecord } from "./dc/crosswalk";
import type { ExportEmitInput } from "./emitters.server";
import {
  readEntityLinks,
  readPlaceLinks,
  readRepositories,
  readScopedDescriptions,
  readScopedEntities,
  readScopedPlaces,
} from "./rows.server";
import type { ScopedLink } from "./rows.server";

/** UTF-8 BOM: the `utf-8-sig` head Excel needs and the importer strips. */
const BOM = "\uFEFF";

/** A crosswalked scope, before anything has decided how to write it. */
export interface DcFormData {
  records: DcRecord[];
  entities: DcRecord[];
  places: DcRecord[];
  links: { rowType: Extract<CsvRowType, "entityLink" | "placeLink">; link: ScopedLink }[];
}

/**
 * Run a scope through the crosswalk. Both Dublin Core serialisations
 * call this, so a DC CSV and a DC JSON of the same scope carry the same
 * fifteen values in the same order — which is what makes Dublin Core
 * one form rather than two lookalike formats.
 */
export async function assembleDcForm(
  input: ExportEmitInput,
  ctx: ExportEmitContext,
): Promise<DcFormData> {
  const { db, tenant, scope } = input;
  const authorityScopeKind = scope.recordClass !== "records";
  const withAuthorities = authorityScopeKind || input.includeAuthorities;

  const records: DcRecord[] = [];
  if (!authorityScopeKind) {
    await ctx.checkpoint("descriptions", 0, scope.memberIds.length);
    const rows = await readScopedDescriptions(db, tenant, scope.memberIds);
    const repos = await readRepositories(
      db,
      tenant,
      rows.map((r) => r.row.repositoryId),
    );
    for (const scoped of rows) {
      records.push(
        dcDescriptionRecord(
          {
            referenceCode: scoped.row.referenceCode,
            title: scoped.row.title,
            descriptionLevel: scoped.row.descriptionLevel,
            dateExpression: scoped.row.dateExpression,
            extent: scoped.row.extent,
            creatorDisplay: scoped.row.creatorDisplay,
            scopeContent: scoped.row.scopeContent,
            placeDisplay: scoped.row.placeDisplay,
            imprint: scoped.row.imprint,
            language: scoped.row.language,
            parentReferenceCode: scoped.parentReferenceCode,
            accessConditions: scoped.row.accessConditions,
            reproductionConditions: scoped.row.reproductionConditions,
            adminBiogHistory: scoped.row.adminBiogHistory,
          },
          repos.get(scoped.row.repositoryId),
          "workspace-export",
        ),
      );
    }
    await ctx.checkpoint("descriptions", records.length, scope.memberIds.length);
  }

  const entityRecords: DcRecord[] = [];
  const placeRecords: DcRecord[] = [];
  const links: DcFormData["links"] = [];

  if (withAuthorities) {
    const total =
      scope.entityIds.length + scope.placeIds.length + scope.counts.links;
    await ctx.checkpoint("authorities", 0, total);

    for (const row of await readScopedEntities(db, tenant, scope.entityIds)) {
      entityRecords.push(
        dcEntityRecord({
          entityCode: row.entityCode,
          displayName: row.displayName,
          entityType: row.entityType,
          datesOfExistence: row.datesOfExistence,
          history: row.history,
          sources: row.sources,
        }),
      );
    }
    await ctx.checkpoint("authorities", entityRecords.length, total);

    for (const row of await readScopedPlaces(db, tenant, scope.placeIds)) {
      placeRecords.push(
        dcPlaceRecord({
          placeCode: row.placeCode,
          label: row.label,
          displayName: row.displayName,
          notes: row.notes,
        }),
      );
    }
    await ctx.checkpoint(
      "authorities",
      entityRecords.length + placeRecords.length,
      total,
    );

    const side = authorityScopeKind ? "authorities" : "descriptions";
    const entityLinkIds = authorityScopeKind ? scope.entityIds : scope.memberIds;
    const placeLinkIds = authorityScopeKind ? scope.placeIds : scope.memberIds;
    for (const link of await readEntityLinks(db, tenant, side, entityLinkIds)) {
      links.push({ rowType: "entityLink", link });
    }
    for (const link of await readPlaceLinks(db, tenant, side, placeLinkIds)) {
      links.push({ rowType: "placeLink", link });
    }
    await ctx.checkpoint(
      "authorities",
      Math.min(entityRecords.length + placeRecords.length + links.length, total),
      total,
    );
  }

  return { records, entities: entityRecords, places: placeRecords, links };
}

/** Whether a Dublin Core file needs the discriminator column. */
function isDiscriminated(input: ExportEmitInput): boolean {
  return input.scope.recordClass !== "records" || input.includeAuthorities;
}

/** The header row for a Dublin Core CSV under this scope and toggle. */
export function dcCsvHeaders(input: ExportEmitInput): string[] {
  return isDiscriminated(input)
    ? [ROW_TYPE_COLUMN, ...DC_COLUMNS, ...LINK_COLUMNS]
    : [...DC_COLUMNS];
}

/**
 * Emit a scope as a Dublin Core CSV: one row per record, fifteen
 * columns, and the authority blocks after them when they were asked
 * for. Same encoding as the canonical CSV — UTF-8 with a BOM, CRLF
 * lines, RFC 4180 quoting — because a spreadsheet does not care which
 * form it is holding and Excel's needs do not change with the crosswalk.
 */
export async function emitDcCsv(
  input: ExportEmitInput,
  ctx: ExportEmitContext,
): Promise<ExportArtifact> {
  const data = await assembleDcForm(input, ctx);
  const columns = dcCsvHeaders(input);
  const discriminated = columns[0] === ROW_TYPE_COLUMN;

  const lines: string[] = [BOM + columns.join(",") + "\r\n"];

  const write = (rowType: CsvRowType, values: Record<string, unknown>): void => {
    const row = discriminated ? { [ROW_TYPE_COLUMN]: rowType, ...values } : values;
    lines.push(columns.map((column) => csvCell(row[column])).join(",") + "\r\n");
  };

  for (const record of data.records) write("description", dcRecordAsObject(record));
  for (const record of data.entities) write("entity", dcRecordAsObject(record));
  for (const record of data.places) write("place", dcRecordAsObject(record));
  for (const { rowType, link } of data.links) {
    write(rowType, link as unknown as Record<string, unknown>);
  }

  await ctx.checkpoint("serializing", 1, 1);
  return {
    body: lines.join(""),
    contentType: "text/csv; charset=utf-8",
    extension: "csv",
  };
}

/** The fifteen element names, for a caller building its own header row. */
export { DC_COLUMNS, DC_ELEMENTS };

/* @version v0.7.0 */
