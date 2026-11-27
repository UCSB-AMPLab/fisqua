/**
 * Description Formatter
 *
 * This module deals with mapping one Drizzle row off `descriptions`
 * into the shape the published JSON expects. It handles language-code
 * lookup, hierarchy level resolution, repository short-code
 * denormalisation, and the allowlist of fields that are safe to
 * publish — internal bookkeeping columns (createdBy, updatedBy,
 * internal notes) are deliberately excluded.
 *
 * A description's `mets_url` is built from its tenant's `mets_base_url`
 * as `{base}/{reference_code}.xml`, with `?` and `#` removed from the
 * code and trailing slashes from the base, the same address the IIIF
 * manifest's `seeAlso` names. It is the site's METS address for the
 * record, and every description has one, digitised or not: the file at
 * that address is written by the site's engine, which builds one per
 * description. A description of a tenant without a base carries
 * `mets_url: null`; the key is written on every description.
 *
 * Every description carries `modified_at`, the UTC calendar date of its
 * `updated_at` (`modifiedAtDate`), and none when that is empty.
 *
 * The formatter is the same for every tenant: no rule names a tenant,
 * repository, fonds or reference-code pattern. `children_level` is the
 * description level of a description's published children
 * (`childrenLevel`), and `publication_title` is the stored value.
 *
 * @version v0.9.0
 */

import type { ExportDescription } from "./types";
import { LANGUAGE_MAP, modifiedAtDate } from "./constants";
import { LEVEL_HIERARCHY } from "../description-levels";
import { DESCRIPTION_LEVELS } from "../validation/enums";

/** A published child of a description, as `childrenLevel` reads it. */
export interface ExportChild {
  referenceCode: string;
  descriptionLevel: string;
}

/** Where a level sorts in a tie: its rank, then its place in the level list. */
function levelOrder(level: string): [number, number] {
  const index = (DESCRIPTION_LEVELS as readonly string[]).indexOf(level);
  return [LEVEL_HIERARCHY[level] ?? Number.MAX_SAFE_INTEGER, index < 0 ? Number.MAX_SAFE_INTEGER : index];
}

/**
 * The level of a description's children: null when it has no published
 * children, otherwise the description level they share, or, when they
 * mix levels, the most common one. A tie goes to the broader level
 * (`LEVEL_HIERARCHY`), then to the earlier in `DESCRIPTION_LEVELS`, and
 * levels outside both to the lower code point, so the result does not
 * depend on the order the children are given in.
 */
export function childrenLevel(children: ExportChild[]): string | null {
  if (children.length === 0) return null;
  const counts = new Map<string, number>();
  for (const c of children) counts.set(c.descriptionLevel, (counts.get(c.descriptionLevel) ?? 0) + 1);
  return [...counts.entries()].sort(([la, na], [lb, nb]) => {
    if (na !== nb) return nb - na;
    const [ra, ia] = levelOrder(la);
    const [rb, ib] = levelOrder(lb);
    return ra - rb || ia - ib || (la < lb ? -1 : la > lb ? 1 : 0);
  })[0][0];
}

/**
 * The METS address of a description under its tenant's base, or
 * undefined when the tenant has none.
 */
export function metsUrl(referenceCode: string, metsBaseUrl: string | null | undefined): string | undefined {
  const base = (metsBaseUrl ?? "").trim().replace(/\/+$/, "");
  if (!base) return undefined;
  return `${base}/${referenceCode.replace(/[?#]/g, "")}.xml`;
}

/**
 * Map a D1 description row + its repository to ExportDescription.
 * Only exported fields are included — internal fields (internalNotes,
 * createdBy, updatedBy) are excluded. `formerReferenceCodes` are the
 * reference codes the description was published under before
 * (`former-codes.server.ts`); the field is omitted when there are none.
 * `children` are the description's published children, whatever order
 * they come in; `child_count` and `has_children` are counted from them, so
 * an unpublished child is not counted.
 */
export function formatDescription(
  row: {
    id: string;
    parentId: string | null;
    childCount: number;
    descriptionLevel: string;
    referenceCode: string;
    localIdentifier: string | null;
    title: string;
    dateExpression: string | null;
    dateStart: string | null;
    hasDigital: boolean | null;
    iiifManifestUrl: string | null;
    scopeContent: string | null;
    ocrText: string | null;
    extent: string | null;
    arrangement: string | null;
    accessConditions: string | null;
    reproductionConditions: string | null;
    language: string | null;
    locationOfOriginals: string | null;
    locationOfCopies: string | null;
    findingAids: string | null;
    notes: string | null;
    imprint: string | null;
    editionStatement: string | null;
    seriesStatement: string | null;
    publicationTitle?: string | null;
    uniformTitle: string | null;
    sectionTitle: string | null;
    pages: string | null;
    creatorDisplay: string | null;
    placeDisplay: string | null;
    updatedAt?: number | null;
  },
  repo: { code: string; country: string | null },
  parentRefCode: string | null,
  children: ExportChild[],
  metsBaseUrl: string | null = null,
  formerReferenceCodes: string[] = []
): ExportDescription {
  const mets = metsUrl(row.referenceCode, metsBaseUrl);
  const modifiedAt = modifiedAtDate(row.updatedAt);
  return {
    id: row.id,
    repository_code: repo.code,
    country: repo.country ?? "",
    reference_code: row.referenceCode,
    // local_identifier RELAXED to nullable in 0036 (DACS/RAD do not
    // mandate it). The export shape stays string for snapshot
    // continuity; coerce null to empty string.
    local_identifier: row.localIdentifier ?? "",
    title: row.title,
    description_level: row.descriptionLevel,
    date_expression: row.dateExpression,
    date_start: row.dateStart,
    parent_id: row.parentId,
    parent_reference_code: parentRefCode,
    // Counted from the published children, not the stored child_count, which counts unpublished children too.
    has_children: children.length > 0,
    child_count: children.length,
    children_level: childrenLevel(children),
    has_digital: row.hasDigital ?? false,
    iiif_manifest_url: row.iiifManifestUrl ?? "",
    mets_url: mets || null,
    ...(formerReferenceCodes.length > 0
      ? { former_reference_codes: formerReferenceCodes }
      : {}),
    scope_content: row.scopeContent,
    ocr_text: row.ocrText ?? "",
    extent: row.extent,
    arrangement: row.arrangement,
    access_conditions: row.accessConditions,
    reproduction_conditions: row.reproductionConditions,
    language: LANGUAGE_MAP[row.language ?? ""] ?? row.language ?? null,
    location_of_originals: row.locationOfOriginals,
    location_of_copies: row.locationOfCopies,
    // Dropped in 0036 (0% populated); preserved as null in export
    // shape for downstream-snapshot continuity.
    related_materials: null,
    finding_aids: row.findingAids,
    notes: row.notes,
    publication_title: row.publicationTitle || null,
    imprint: row.imprint,
    edition_statement: row.editionStatement,
    series_statement: row.seriesStatement,
    uniform_title: row.uniformTitle,
    section_title: row.sectionTitle,
    pages: row.pages,
    creator_display: row.creatorDisplay,
    place_display: row.placeDisplay,
    ...(modifiedAt ? { modified_at: modifiedAt } : {}),
  };
}

// @version v0.9.0
