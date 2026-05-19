/**
 * ISAD(G) Standard Config
 *
 * This module deals with the ISAD(G) 2nd ed. data layer for Fisqua's
 * standard-aware form + validator family. Every section/field in this
 * file was extracted
 * from the existing admin form
 * (`app/components/descriptions/description-form.tsx`) — that form
 * was the implicit ISAD(G) config from v0.3 onwards; lifting it into
 * a typed `StandardConfig` lets the universal renderer + validator
 * factory consume it the same way they consume DACS and RAD.
 *
 * The 6 essential ISAD(G) elements (mandatory across levels per the
 * ICA spec) are: Reference Code (3.1.1), Title (3.1.2), Date(s)
 * (3.1.3), Level of Description (3.1.4), Extent (3.1.5), and — at
 * the top of the hierarchy — Name of Creator(s) (3.2.1) and Scope
 * and Content (3.3.1). Encoded in `ISADG_REQUIRED_BY_LEVEL` below.
 *
 * Note on `localIdentifier`: it is `requiredAt: []` here. ISAD(G)'s
 * 6 essential elements do NOT include a local identifier; migration
 * `drizzle/0036_union_schema.sql` RELAXED the column to nullable for
 * DACS/RAD compatibility. The existing v0.3 form treated it as
 * required (a Neogranadina-only convention, not an ISAD(G)
 * requirement). Locked OFF here; flip if the convention reasserts
 * itself.
 *
 * [CITED: https://www.accesstomemory.org/en/docs/2.6/user-manual/data-templates/isad-template/]
 *   AtoM's ISAD(G) data template; mirrors the official ICA-CDS spec
 *   for the 26-element field set and area structure.
 *
 * @version v0.4.0
 */

import type { DescriptionLevel, StandardConfig } from "./types";

/**
 * Per-level mandatory column lists derived from ISAD(G) essential
 * elements plus the AtoM per-level template.
 *
 * Ordering rationale per level:
 *   - fonds / collection: top-of-hierarchy levels carry the full 6
 *     essentials PLUS creator (3.2.1) and scope (3.3.1) since these
 *     are required at the top of the description hierarchy.
 *   - subfonds / series: drop creator (inherited from fonds) but keep
 *     scope (descriptions still need scope at every aggregating level).
 *   - subseries: drop scope at the lowest aggregating level — extent
 *     and the 4 identity essentials remain.
 *   - section / volume: project-internal levels with no canonical ICA
 *     mandatoriness; minimal set (referenceCode, title, level).
 *   - file / item: leaf-ish levels — keep dates and the identity 4.
 */
const ISADG_REQUIRED_BY_LEVEL: Record<DescriptionLevel, ReadonlyArray<string>> = {
  // `repositoryId` carries a non-null FK constraint at the DB layer
  // (`app/db/schema.ts`); it is included at every level here so the
  // validator surfaces a proper field-level error rather than letting
  // a DB constraint error bubble up. Single-source-of-truth contract:
  // every column the renderer should asterisk MUST live in this table
  // for at least one level it applies to.
  fonds: [
    "referenceCode",
    "title",
    "dateExpression",
    "descriptionLevel",
    "extent",
    "creatorDisplay",
    "scopeContent",
    "repositoryId",
  ],
  subfonds: [
    "referenceCode",
    "title",
    "dateExpression",
    "descriptionLevel",
    "extent",
    "scopeContent",
    "repositoryId",
  ],
  series: [
    "referenceCode",
    "title",
    "dateExpression",
    "descriptionLevel",
    "extent",
    "scopeContent",
    "repositoryId",
  ],
  subseries: [
    "referenceCode",
    "title",
    "dateExpression",
    "descriptionLevel",
    "extent",
    "repositoryId",
  ],
  collection: [
    "referenceCode",
    "title",
    "dateExpression",
    "descriptionLevel",
    "extent",
    "creatorDisplay",
    "scopeContent",
    "repositoryId",
  ],
  section: ["referenceCode", "title", "descriptionLevel", "repositoryId"],
  volume: ["referenceCode", "title", "descriptionLevel", "repositoryId"],
  file: [
    "referenceCode",
    "title",
    "dateExpression",
    "descriptionLevel",
    "repositoryId",
  ],
  item: [
    "referenceCode",
    "title",
    "dateExpression",
    "descriptionLevel",
    "repositoryId",
  ],
};

/**
 * Single source of truth for per-field mandatoriness.
 *
 * The validator factory consumes `requiredFieldsForLevel(level)` and
 * pulls its required-column list from `ISADG_REQUIRED_BY_LEVEL` above.
 * The renderer reads each field's `requiredAt` array and decides
 * whether to display the asterisk. If the per-field arrays drift from
 * the per-level table, the form will show no asterisk while the save
 * still fails — bad UX.
 *
 * Resolution: derive every `requiredAt` array at module-eval time
 * from the per-level table itself, so adding a column to a level
 * automatically updates both surfaces.
 *
 * The column-name input is typed as `string` rather than a stricter
 * narrow type because each standard's column universe is defined by
 * the surrounding field configs in this file, not by a global enum;
 * a typo here would surface in the renderer's missing-asterisk
 * behaviour rather than as a TS error, which is acceptable given the
 * small allowed set and the keystone tests that exercise the matrix.
 */
function requiredAtFor(col: string): ReadonlyArray<DescriptionLevel> {
  return (Object.entries(ISADG_REQUIRED_BY_LEVEL) as Array<
    [DescriptionLevel, ReadonlyArray<string>]
  >)
    .filter(([, cols]) => cols.includes(col))
    .map(([lvl]) => lvl);
}

export const ISADG_CONFIG: StandardConfig = {
  standard: "isadg",
  sections: [
    {
      // ISAD 3.1 — Identity Statement Area
      id: "identity",
      fields: [
        { column: "referenceCode", primitive: "text", requiredAt: requiredAtFor("referenceCode") },
        // RELAXED in 0036; ISAD(G) does not mandate it (see header).
        { column: "localIdentifier", primitive: "text", requiredAt: requiredAtFor("localIdentifier") },
        { column: "title", primitive: "text", requiredAt: requiredAtFor("title") },
        { column: "translatedTitle", primitive: "text", requiredAt: requiredAtFor("translatedTitle") },
        { column: "uniformTitle", primitive: "text", requiredAt: requiredAtFor("uniformTitle") },
        {
          column: "descriptionLevel",
          primitive: "level-select",
          requiredAt: requiredAtFor("descriptionLevel"),
        },
        {
          column: "resourceType",
          primitive: "resource-type-select",
          requiredAt: requiredAtFor("resourceType"),
        },
        { column: "genre", primitive: "text", requiredAt: requiredAtFor("genre") },
        {
          column: "dateExpression",
          primitive: "date-range",
          requiredAt: requiredAtFor("dateExpression"),
        },
        { column: "dateStart", primitive: "date", requiredAt: requiredAtFor("dateStart") },
        { column: "dateEnd", primitive: "date", requiredAt: requiredAtFor("dateEnd") },
        { column: "dateCertainty", primitive: "text", requiredAt: requiredAtFor("dateCertainty") },
        { column: "extent", primitive: "text", requiredAt: requiredAtFor("extent") },
        { column: "dimensions", primitive: "text", requiredAt: requiredAtFor("dimensions") },
        { column: "medium", primitive: "text", requiredAt: requiredAtFor("medium") },
        {
          column: "repositoryId",
          primitive: "repository-select",
          requiredAt: requiredAtFor("repositoryId"),
        },
      ],
    },
    {
      // ISAD 3.2 — Context Area
      id: "context",
      fields: [
        {
          column: "provenance",
          primitive: "textarea",
          requiredAt: [],
          hints: { rows: 4 },
        },
        // creatorDisplay is denormalised for display/search; ISAD(G)
        // mandates a creator at top-of-hierarchy levels.
        {
          column: "creatorDisplay",
          primitive: "text",
          requiredAt: requiredAtFor("creatorDisplay"),
        },
      ],
    },
    {
      // ISAD 3.3 — Content and Structure Area
      id: "content",
      fields: [
        {
          column: "scopeContent",
          primitive: "textarea",
          requiredAt: requiredAtFor("scopeContent"),
          hints: { rows: 6 },
        },
        {
          column: "arrangement",
          primitive: "textarea",
          requiredAt: [],
          hints: { rows: 4 },
        },
        {
          column: "ocrText",
          primitive: "textarea",
          requiredAt: [],
          hints: { rows: 4 },
        },
      ],
    },
    {
      // ISAD 3.4 — Conditions of Access and Use Area.
      // Renamed from the earlier `section_access` locale key: section
      // IDs match the column-area concept ('conditions') rather than
      // a single column name ('access').
      id: "conditions",
      fields: [
        {
          column: "accessConditions",
          primitive: "textarea",
          requiredAt: [],
          hints: { rows: 3 },
        },
        {
          column: "reproductionConditions",
          primitive: "textarea",
          requiredAt: [],
          hints: { rows: 3 },
        },
        { column: "language", primitive: "text", requiredAt: [] },
      ],
    },
    {
      // ISAD 3.5 — Allied Materials Area
      id: "allied",
      fields: [
        { column: "locationOfOriginals", primitive: "text", requiredAt: [] },
        { column: "locationOfCopies", primitive: "text", requiredAt: [] },
        // relatedMaterials field was dropped in
        // drizzle/0036_union_schema.sql (0% populated in the audit).
        { column: "findingAids", primitive: "text", requiredAt: [] },
      ],
    },
    {
      // ISAD 3.6 — Notes Area
      id: "notes",
      fields: [
        {
          column: "notes",
          primitive: "textarea",
          requiredAt: [],
          hints: { rows: 4 },
        },
        {
          column: "internalNotes",
          primitive: "textarea",
          requiredAt: [],
          hints: { rows: 4 },
        },
      ],
    },
    {
      // Project addition (retained from v0.3 form): bibliographic block
      // for journal/edition/series metadata. Not part of ISAD(G) proper
      // but Fisqua needs it for source-edition descriptions.
      id: "bibliographic",
      fields: [
        { column: "imprint", primitive: "text", requiredAt: [] },
        { column: "editionStatement", primitive: "text", requiredAt: [] },
        { column: "seriesStatement", primitive: "text", requiredAt: [] },
        { column: "volumeNumber", primitive: "text", requiredAt: [] },
        { column: "issueNumber", primitive: "text", requiredAt: [] },
        { column: "pages", primitive: "text", requiredAt: [] },
        { column: "publicationTitle", primitive: "text", requiredAt: [] },
        { column: "sectionTitle", primitive: "text", requiredAt: [] },
      ],
    },
    {
      // Project addition: digital surrogate metadata.
      id: "digital",
      fields: [
        { column: "iiifManifestUrl", primitive: "iiif-url", requiredAt: [] },
        { column: "hasDigital", primitive: "checkbox", requiredAt: [] },
      ],
    },
    {
      // Project addition: ISAAR(CPF) entity linker (cross-references).
      // Renderer uses the entity-linker primitive; the column shape
      // here is a placeholder marker — the real data lives in the
      // description_entities junction table.
      id: "entities",
      fields: [
        { column: "entities", primitive: "entity-linker", requiredAt: [] },
      ],
    },
    {
      // Project addition: place linker (cross-references).
      id: "places",
      fields: [
        { column: "places", primitive: "place-linker", requiredAt: [] },
      ],
    },
  ],
  requiredFieldsForLevel: (level) => ISADG_REQUIRED_BY_LEVEL[level] ?? [],
};

/* @version v0.4.0 */
