/**
 * RAD Standard Config
 *
 * This module deals with the Rules for Archival Description
 * (Canadian Council of Archives, revised 2008) data layer for
 * Fisqua's standard-aware form + validator family. RAD is the third
 * primary standard Fisqua supports as a tenant's
 * `descriptive_standard`; this config provides RAD form variants for
 * all description levels.
 *
 * RAD treats six elements as mandatory at every level (Title proper,
 * Level of description, Repository, Reference code, Extent — RAD
 * calls this "physical description" — and Date(s) of creation). At
 * fonds level, Creator and Scope/Content + Administrative History
 * are additionally required; series and file levels add Scope/Content
 * conditionally (when not subsumed by a higher level). Encoded in
 * `RAD_REQUIRED_BY_LEVEL` below.
 *
 * Known-limitation #1 — the per-level scope/content mandatoriness in
 * this config is ENCODED FROM THE AtoM RAD data-template
 * intersection, NOT directly from the canonical CCA spec (the
 * official PDF was only partially extracted during research). A
 * RAD-fluent reviewer SHOULD audit `RAD_REQUIRED_BY_LEVEL` before a
 * real RAD tenant onboards. The integration tests enforce what's in
 * this config, not the platonic spec.
 *
 * Known-limitation #2 — `class_specific` section: RAD's "Class of
 * materials specific details" area covers cartographic, architectural,
 * and philatelic specialised description elements. Fisqua's union
 * schema does NOT carry these specialised columns. The
 * `class_specific` section ships with `fields: []` and renders empty
 * for v0.4. Surface to a future release if a RAD tenant catalogues
 * cartographic or architectural materials and needs the specialised
 * elements.
 *
 * Known-limitation #3 — Title proper / supplied title: RAD
 * distinguishes "title proper" (formal, transcribed) from "supplied
 * title" (cataloguer-supplied, conventionally bracketed). Fisqua's
 * `title` column is plain text — the cataloguer can add brackets
 * manually for supplied titles, but the distinction is not encoded
 * structurally. Per-standard label override on `title` for RAD
 * displays "Title proper" via the i18n resolver wrapper.
 *
 * Schema-coverage note: an earlier design proposed
 * `descriptionsArchivists`, `revisionHistory`,
 * `languageOfDescription`, and `dbeId` (on descriptions) for the RAD
 * `description_control` and `standard_number` sections. None of those
 * exist on `descriptions` in `app/db/schema.ts` — `dbeId` exists on
 * `entities`, not descriptions. For v0.4 the RAD config uses only
 * existing schema columns; the description_control section ships
 * with `fields: []` for the same reason as `class_specific`, and
 * standard_number falls back to `publicationTitle` (the closest
 * existing analogue).
 *
 * [CITED: https://www.accesstomemory.org/en/docs/2.5/user-manual/data-templates/rad-template/]
 *   AtoM's RAD data template; mirrors official CCA RAD field set.
 * [CITED: https://archivescanada.ca/wp-content/uploads/2022/08/RADComplete_July2008.pdf]
 *   Canadian Council of Archives — RAD complete 2008 (canonical PDF).
 *
 * @version v0.4.0
 */

import type { DescriptionLevel, StandardConfig } from "./types";

/**
 * Per-level mandatory column lists, with the AtoM-intersection
 * caveat from known-limitation #1 above.
 *
 * RAD's "Mandatory at all levels" set is encoded here as 6 columns
 * (title, descriptionLevel, repositoryId, referenceCode, extent,
 * dateExpression). Fonds adds creator + scopeContent +
 * adminBiogHistory; series and file add scopeContent.
 */
const RAD_REQUIRED_BY_LEVEL: Record<DescriptionLevel, ReadonlyArray<string>> = {
  fonds: [
    "title",
    "descriptionLevel",
    "repositoryId",
    "referenceCode",
    "extent",
    "dateExpression",
    "creatorDisplay",
    "scopeContent",
    // RAD strongly emphasises administrative/biographical history at
    // fonds level — required-vs-recommended is a judgement call (see
    // known-limitation #1); flip if a RAD-fluent reviewer disagrees.
    "adminBiogHistory",
  ],
  collection: [
    "title",
    "descriptionLevel",
    "repositoryId",
    "referenceCode",
    "extent",
    "dateExpression",
    "creatorDisplay",
    "scopeContent",
  ],
  subfonds: [
    "title",
    "descriptionLevel",
    "repositoryId",
    "referenceCode",
    "extent",
    "dateExpression",
    "scopeContent",
  ],
  series: [
    "title",
    "descriptionLevel",
    "repositoryId",
    "referenceCode",
    "extent",
    "dateExpression",
    // RAD requires scope/content conditionally at series (see
    // known-limitation #1); the AtoM intersection treats it as
    // required and SCAA Basic RAD implies it.
    "scopeContent",
  ],
  subseries: [
    "title",
    "descriptionLevel",
    "repositoryId",
    "referenceCode",
    "extent",
    "dateExpression",
  ],
  section: [
    "title",
    "descriptionLevel",
    "repositoryId",
    "referenceCode",
  ],
  volume: [
    "title",
    "descriptionLevel",
    "repositoryId",
    "referenceCode",
  ],
  file: [
    "title",
    "descriptionLevel",
    "repositoryId",
    "referenceCode",
    "extent",
    "dateExpression",
    // Scope/content at file level when not subsumed by series (see
    // known-limitation #1). We require it to surface a placeholder;
    // cataloguer can copy the series scope down. Flip if a reviewer
    // prefers optional.
    "scopeContent",
  ],
  item: [
    "title",
    "descriptionLevel",
    "repositoryId",
    "referenceCode",
    "extent",
    "dateExpression",
  ],
};

/**
 * Single source of truth for per-field mandatoriness. See the
 * matching helper in `app/lib/standards/isadg.ts` for the rationale —
 * deriving `requiredAt` from the per-level table prevents drift
 * between the renderer's asterisk display and the validator's
 * required-field check.
 */
function requiredAtFor(col: string): ReadonlyArray<DescriptionLevel> {
  return (Object.entries(RAD_REQUIRED_BY_LEVEL) as Array<
    [DescriptionLevel, ReadonlyArray<string>]
  >)
    .filter(([, cols]) => cols.includes(col))
    .map(([lvl]) => lvl);
}

export const RAD_CONFIG: StandardConfig = {
  standard: "rad",
  sections: [
    {
      // RAD — Title and statement of responsibility area.
      // Note: RAD's "Title proper" maps to `title` here (see header
      // known-limitation #3); per-standard locale override displays
      // "Title proper" instead of plain "Title" for RAD tenants.
      id: "identity",
      fields: [
        { column: "title", primitive: "text", requiredAt: requiredAtFor("title") },
        { column: "translatedTitle", primitive: "text", requiredAt: requiredAtFor("translatedTitle") },
        {
          column: "descriptionLevel",
          primitive: "level-select",
          requiredAt: requiredAtFor("descriptionLevel"),
        },
        { column: "referenceCode", primitive: "text", requiredAt: requiredAtFor("referenceCode") },
        { column: "localIdentifier", primitive: "text", requiredAt: requiredAtFor("localIdentifier") },
        {
          column: "repositoryId",
          primitive: "repository-select",
          requiredAt: requiredAtFor("repositoryId"),
        },
      ],
    },
    {
      // RAD — Edition area (typically item-level only).
      id: "edition",
      fields: [
        { column: "editionStatement", primitive: "text", requiredAt: [] },
      ],
    },
    {
      // RAD — Class of materials specific details area
      // (cartographic, architectural, philatelic).
      // EMPTY in v0.4 — see header known-limitation #2.
      // TODO(RAD-specific): if a RAD tenant onboards and catalogues
      // specialised materials, add cartographic / architectural /
      // philatelic columns to descriptions in a follow-up schema
      // migration, then populate this section.
      id: "class_specific",
      fields: [],
    },
    {
      // RAD — Dates of creation area.
      id: "dates_creation",
      fields: [
        {
          column: "dateExpression",
          primitive: "date-range",
          requiredAt: requiredAtFor("dateExpression"),
        },
        { column: "dateStart", primitive: "date", requiredAt: requiredAtFor("dateStart") },
        { column: "dateEnd", primitive: "date", requiredAt: requiredAtFor("dateEnd") },
        { column: "dateCertainty", primitive: "text", requiredAt: requiredAtFor("dateCertainty") },
      ],
    },
    {
      // RAD — Physical description area.
      id: "physical_description",
      fields: [
        { column: "extent", primitive: "text", requiredAt: requiredAtFor("extent") },
        { column: "dimensions", primitive: "text", requiredAt: requiredAtFor("dimensions") },
        { column: "medium", primitive: "text", requiredAt: requiredAtFor("medium") },
        {
          column: "physicalCharacteristics",
          primitive: "textarea",
          requiredAt: requiredAtFor("physicalCharacteristics"),
          hints: { rows: 4 },
        },
      ],
    },
    {
      // RAD — Publisher's series area (item-level publishing metadata).
      id: "publishers_series",
      fields: [
        { column: "imprint", primitive: "text", requiredAt: [] },
        { column: "seriesStatement", primitive: "text", requiredAt: [] },
        { column: "publicationTitle", primitive: "text", requiredAt: [] },
      ],
    },
    {
      // RAD — Archival description area: custodial history (maps to
      // `provenance`), scope and content,
      // administrative/biographical history.
      id: "archival_description",
      fields: [
        {
          column: "creatorDisplay",
          primitive: "text",
          requiredAt: requiredAtFor("creatorDisplay"),
        },
        // RAD's "Custodial history" — mapped to existing `provenance`.
        {
          column: "provenance",
          primitive: "textarea",
          requiredAt: requiredAtFor("provenance"),
          hints: { rows: 4 },
        },
        {
          column: "scopeContent",
          primitive: "textarea",
          requiredAt: requiredAtFor("scopeContent"),
          hints: { rows: 6 },
        },
        {
          column: "adminBiogHistory",
          primitive: "textarea",
          requiredAt: requiredAtFor("adminBiogHistory"),
          hints: { rows: 6 },
        },
        {
          column: "systemOfArrangement",
          primitive: "textarea",
          requiredAt: requiredAtFor("systemOfArrangement"),
          hints: { rows: 4 },
        },
      ],
    },
    {
      // RAD — Notes area.
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
      // RAD — Standard number area.
      // Schema-coverage deviation (see header): `dbeId` is on
      // `entities`, not `descriptions`. `publicationTitle` is the
      // closest existing analogue (used as a proxy for source-edition
      // standard numbers in the v0.3 form).
      id: "standard_number",
      fields: [
        { column: "publicationTitle", primitive: "text", requiredAt: [] },
      ],
    },
    {
      // RAD — Access points (cross-references; rendered via the
      // entity-linker / place-linker primitives below).
      id: "access_points",
      fields: [],
    },
    {
      // RAD — Description control area.
      // Schema-coverage deviation (see header): the proposed
      // descriptionsArchivists / revisionHistory / languageOfDescription
      // columns do not exist on descriptions. Section ships empty for
      // v0.4; revisit if a RAD tenant requires them.
      id: "description_control",
      fields: [],
    },
    {
      // Project addition: ISAAR(CPF) entity linker — RAD's "Name access
      // points" map here.
      id: "entities",
      fields: [
        { column: "entities", primitive: "entity-linker", requiredAt: [] },
      ],
    },
    {
      // Project addition: place linker — RAD's "Place access points".
      id: "places",
      fields: [
        { column: "places", primitive: "place-linker", requiredAt: [] },
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
  ],
  requiredFieldsForLevel: (level) => RAD_REQUIRED_BY_LEVEL[level] ?? [],
};

/* @version v0.4.0 */
