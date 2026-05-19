/**
 * DACS Standard Config
 *
 * This module deals with the Describing Archives: A Content Standard
 * (SAA, 2nd ed.) data layer for Fisqua's standard-aware form +
 * validator family. DACS is one of the three primary standards
 * Fisqua supports as a tenant's `descriptive_standard`; this config
 * provides DACS form variants for all description levels.
 *
 * The DACS Single-Level Minimum (§ 1.4 in the SAA-TS-DACS source) is
 * 10 elements: Reference Code (2.1), Repository (2.2), Title (2.3),
 * Date (2.4), Extent (2.5), Name of Creator (2.6), Scope and Content
 * (3.1), Conditions Governing Access (4.1), Languages and Scripts
 * (4.5), and Rights Statements (8.2). For multilevel descriptions,
 * DACS § 1.5 says "each subsequent level should include all
 * higher-level elements unless information repeats" — encoded here
 * as: subsequent levels (subfonds/series/subseries/file/item) require
 * only the rapidly-divergent fields (referenceCode, title,
 * descriptionLevel, dateExpression, extent, scopeContent), with
 * repository/access/language/creator inherited from the top.
 *
 * Known limitation — DACS § 8.2 Rights Statements: Fisqua's union
 * schema dropped rights structured fields per the production audit
 * (0% populated in Neogranadina). The `rights` section in this config
 * is a pseudo-section satisfied via `accessConditions` narrative
 * free-text for v0.4. The renderer surfaces it under a rights-area
 * label override; per-standard locale overrides flag it as the
 * Rights Statements area for DACS tenants.
 *
 * Schema-coverage note: an earlier design proposed
 * `descriptionsArchivists`, `revisionHistory`, and
 * `languageOfDescription` columns for the DACS `description_control`
 * section. None of those columns exist on `descriptions` in
 * `app/db/schema.ts` — only the 5 union-schema additions from
 * `drizzle/0036_union_schema.sql` (adminBiogHistory,
 * preferredCitation, acquisitionInfo, systemOfArrangement,
 * physicalCharacteristics) and the standard-neutral columns. Adding
 * those three would either require a follow-up schema migration or
 * leave render dereferences against `description[col]` returning
 * undefined. For v0.4 the DACS config uses only existing schema
 * columns; if a real DACS tenant onboards and needs those three,
 * surface as a schema follow-up.
 *
 * [CITED: https://saa-ts-dacs.github.io/dacs/06_part_I/02_chapter_01.html]
 *   Society of American Archivists — DACS, Chapter 1: Levels of
 *   Description and Required Elements (canonical online source).
 *
 * @version v0.4.0
 */

import type { DescriptionLevel, StandardConfig } from "./types";

/**
 * Per-level mandatory column lists. Sources:
 *   - Top-of-hierarchy (fonds/collection): full Single-Level Minimum
 *     per DACS § 1.4 (10 elements; rights satisfied via
 *     accessConditions per the known limitation above).
 *   - Subsequent levels: rapidly-divergent fields only, per the
 *     DACS § 1.5 multilevel inheritance rule.
 */
const DACS_REQUIRED_BY_LEVEL: Record<DescriptionLevel, ReadonlyArray<string>> = {
  fonds: [
    "referenceCode",
    "repositoryId",
    "title",
    "dateExpression",
    "extent",
    "creatorDisplay",
    "scopeContent",
    "accessConditions",
    "language",
    "descriptionLevel",
  ],
  collection: [
    "referenceCode",
    "repositoryId",
    "title",
    "dateExpression",
    "extent",
    "creatorDisplay",
    "scopeContent",
    "accessConditions",
    "language",
    "descriptionLevel",
  ],
  // `repositoryId` is included at every level here even though DACS
  // § 1.5 multilevel inheritance treats it as derivable from the
  // top-of-hierarchy. The non-null FK at the DB layer
  // (`app/db/schema.ts`) means an empty value would surface as a
  // constraint error rather than a friendly form error; reproducing
  // the requirement at every level keeps the single-source-of-truth
  // contract (renderer asterisks and validator errors agree).
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
  section: ["referenceCode", "title", "descriptionLevel", "repositoryId"],
  volume: ["referenceCode", "title", "descriptionLevel", "repositoryId"],
  file: [
    "referenceCode",
    "title",
    "dateExpression",
    "descriptionLevel",
    "extent",
    "repositoryId",
  ],
  item: [
    "referenceCode",
    "title",
    "dateExpression",
    "descriptionLevel",
    "extent",
    "repositoryId",
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
  return (Object.entries(DACS_REQUIRED_BY_LEVEL) as Array<
    [DescriptionLevel, ReadonlyArray<string>]
  >)
    .filter(([, cols]) => cols.includes(col))
    .map(([lvl]) => lvl);
}

export const DACS_CONFIG: StandardConfig = {
  standard: "dacs",
  sections: [
    {
      // DACS § 2 — Identity Elements
      id: "identity",
      fields: [
        { column: "referenceCode", primitive: "text", requiredAt: requiredAtFor("referenceCode") },
        { column: "localIdentifier", primitive: "text", requiredAt: requiredAtFor("localIdentifier") },
        { column: "title", primitive: "text", requiredAt: requiredAtFor("title") },
        { column: "translatedTitle", primitive: "text", requiredAt: requiredAtFor("translatedTitle") },
        {
          column: "descriptionLevel",
          primitive: "level-select",
          requiredAt: requiredAtFor("descriptionLevel"),
        },
        {
          column: "dateExpression",
          primitive: "date-range",
          requiredAt: requiredAtFor("dateExpression"),
        },
        { column: "dateStart", primitive: "date", requiredAt: requiredAtFor("dateStart") },
        { column: "dateEnd", primitive: "date", requiredAt: requiredAtFor("dateEnd") },
        { column: "extent", primitive: "text", requiredAt: requiredAtFor("extent") },
        {
          column: "repositoryId",
          primitive: "repository-select",
          requiredAt: requiredAtFor("repositoryId"),
        },
      ],
    },
    {
      // DACS § 2.7 — Administrative/Biographical History.
      // Section moved from `notes` (ISAD(G)'s placement) to `context`
      // because DACS treats biographical history as a context element.
      id: "context",
      fields: [
        {
          column: "creatorDisplay",
          primitive: "text",
          requiredAt: requiredAtFor("creatorDisplay"),
        },
        {
          column: "adminBiogHistory",
          primitive: "textarea",
          requiredAt: requiredAtFor("adminBiogHistory"),
          hints: { rows: 6 },
        },
        {
          column: "provenance",
          primitive: "textarea",
          requiredAt: requiredAtFor("provenance"),
          hints: { rows: 4 },
        },
      ],
    },
    {
      // DACS § 3 — Content and Structure
      id: "content",
      fields: [
        {
          column: "scopeContent",
          primitive: "textarea",
          requiredAt: requiredAtFor("scopeContent"),
          hints: { rows: 6 },
        },
        {
          column: "systemOfArrangement",
          primitive: "textarea",
          requiredAt: requiredAtFor("systemOfArrangement"),
          hints: { rows: 4 },
        },
        {
          column: "arrangement",
          primitive: "textarea",
          requiredAt: requiredAtFor("arrangement"),
          hints: { rows: 4 },
        },
        {
          column: "physicalCharacteristics",
          primitive: "textarea",
          requiredAt: requiredAtFor("physicalCharacteristics"),
          hints: { rows: 4 },
        },
      ],
    },
    {
      // DACS § 4 — Conditions of Access and Use
      id: "conditions_access",
      fields: [
        {
          column: "accessConditions",
          primitive: "textarea",
          requiredAt: requiredAtFor("accessConditions"),
          hints: { rows: 4 },
        },
        {
          column: "reproductionConditions",
          primitive: "textarea",
          requiredAt: requiredAtFor("reproductionConditions"),
          hints: { rows: 3 },
        },
        { column: "language", primitive: "text", requiredAt: requiredAtFor("language") },
      ],
    },
    {
      // DACS § 5 — Acquisition and Appraisal Information
      id: "acquisition",
      fields: [
        {
          column: "acquisitionInfo",
          primitive: "textarea",
          requiredAt: [],
          hints: { rows: 6 },
        },
      ],
    },
    {
      // DACS § 6 — Related Materials
      id: "related_materials",
      fields: [
        { column: "locationOfOriginals", primitive: "text", requiredAt: [] },
        { column: "locationOfCopies", primitive: "text", requiredAt: [] },
        {
          column: "findingAids",
          primitive: "textarea",
          requiredAt: [],
          hints: { rows: 4 },
        },
      ],
    },
    {
      // DACS § 7 — Notes (includes preferred citation, § 7.1.5)
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
        // Recommended (not required) per DACS § 7.1.5.
        { column: "preferredCitation", primitive: "text", requiredAt: [] },
      ],
    },
    {
      // DACS § 8 — Rights Statements (pseudo-section; see header
      // known-limitation note). Renderer uses `accessConditions` here
      // under a rights-area label override.
      id: "rights",
      fields: [
        {
          column: "accessConditions",
          primitive: "textarea",
          requiredAt: [],
          hints: { rows: 4 },
        },
      ],
    },
    {
      // Project addition: ISAAR(CPF) entity linker.
      id: "entities",
      fields: [
        { column: "entities", primitive: "entity-linker", requiredAt: [] },
      ],
    },
    {
      // Project addition: place linker.
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
  requiredFieldsForLevel: (level) => DACS_REQUIRED_BY_LEVEL[level] ?? [],
};

/* @version v0.4.0 */
