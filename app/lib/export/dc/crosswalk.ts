/**
 * Dublin Core as a FORM — the fifteen-element crosswalk, as data
 *
 * This module deals with the mapping itself, separated from any one
 * serialisation of it. Ruling 1 of the self-service export design says
 * Dublin Core is a FORM and not a FORMAT: it is a crosswalk to fifteen
 * elements, and once it is a field set it can leave as XML, as CSV, or
 * as JSON like any other form. The mapping used to live inside
 * `builder.ts`, where it could only ever become XML; it lives here now,
 * and `builder.ts` renders what this module decides.
 *
 * THE MAPPING IS UNCHANGED. Every element assignment below was lifted
 * from `builder.ts` line for line, including the two that look like
 * oversights and are not: `dc:contributor` is deliberately never
 * populated (entity-level contributors are OAI-PMH-endpoint scope, not
 * bulk-export scope), and `dc:coverage` deliberately repeats
 * `dateExpression` (DCMI permits a temporal reading of coverage, and
 * for archival materials that is the canonical one — one source, two
 * facets).
 *
 * TWO READINGS, AND THEY DIFFER IN EXACTLY TWO ELEMENTS. The OAI bulk
 * file and a workspace export are both Dublin Core, but they are not
 * the same document:
 *
 *   - `oai-bulk` is what the publish pipeline has emitted since v0.4.
 *     `dc:description` is scope and content alone; `dc:rights` is the
 *     repository's licence statement, because a harvested record needs
 *     to say what may be done with it and the repository is the one
 *     making that promise.
 *   - `workspace-export` is the export surface's reading, and it is the
 *     one the choice-cost card describes. Scope and content MERGES with
 *     the biographical/administrative note into `dc:description`, and
 *     access conditions MERGE with reproduction conditions into
 *     `dc:rights`. This is where the merges the loss report warns about
 *     actually happen — the warning and the behaviour are the same two
 *     facts, and they must not drift apart.
 *
 * Nothing else varies between them, which is why the reading is one
 * argument rather than a second mapping.
 *
 * AN AUTHORITY RECORD IS A THIN DUBLIN CORE RECORD, and the export
 * surface's authority card rules how thin: «Fifteen-element crosswalk ·
 * agents as creator and subject». An entity is named in `dc:creator`, a
 * place in `dc:subject`, and everything the fifteen elements have no
 * term for is LEFT EMPTY rather than approximated. In particular
 * `dc:type` is null for both: the DCMI Type Vocabulary is a closed set
 * of twelve terms and none of them means "a person" or "a place", so
 * emitting `Text` for an authority record would be a false statement
 * about what the record is. EAC-CPF is the standard built for this job
 * and is a later cut; until it exists, Dublin Core says the little it
 * can honestly say.
 *
 * @version v0.7.0
 */

import { sanitiseRefForKey } from "../xml/escape";

/**
 * The fifteen elements of simple Dublin Core, in OAI-DC spec order.
 * The order is part of the contract: it is the order the XML emits, the
 * order the CSV's columns run in, and the order the JSON's keys take.
 */
export const DC_ELEMENTS = [
  "title",
  "creator",
  "subject",
  "description",
  "publisher",
  "contributor",
  "date",
  "type",
  "format",
  "identifier",
  "source",
  "language",
  "relation",
  "coverage",
  "rights",
] as const;
export type DcElement = (typeof DC_ELEMENTS)[number];

/** One crosswalked record: every element present, absent ones null. */
export type DcRecord = Record<DcElement, string | null>;

/**
 * Which reading of the crosswalk. See the module header — the two
 * differ in `dc:description` and `dc:rights` and in nothing else.
 */
export type DcReading = "oai-bulk" | "workspace-export";

/** Column headers for a Dublin Core CSV or the keys of a DC JSON object. */
export const DC_COLUMNS: string[] = DC_ELEMENTS.map((e) => `dc:${e}`);

/**
 * `descriptionLevel` → DCMI Type. Lifted from `builder.ts`, which took
 * it from `mets-builder.ts`. Levels absent from the map emit no
 * `dc:type` at all rather than guessing a term.
 */
export const DC_TYPE_MAP: Record<string, string> = {
  fonds: "Collection",
  subfonds: "Collection",
  series: "Collection",
  subseries: "Collection",
  collection: "Collection",
  section: "Collection",
  file: "Collection",
  item: "Text",
  volume: "Text",
};

/** Language code → human-readable label. Lifted from `builder.ts`. */
export const DC_LANGUAGE_MAP: Record<string, string> = {
  "192": "Español",
  "173": "Español",
  "195": "Español",
  Spanish: "Español",
  spa: "Español",
  eng: "English",
  fra: "Français",
  por: "Português",
};

/**
 * Rights statement when a repository has none of its own. Only the
 * `oai-bulk` reading uses it: a workspace export's `dc:rights` carries
 * the record's own access and reproduction conditions, and a record
 * with neither says nothing rather than borrowing a licence.
 */
export const DC_RIGHTS_DEFAULT =
  "All materials in the public domain. Please credit the institution.";

/** Prefix on the OAI `<header><identifier>`. Not part of `dc:identifier`. */
export const DC_IDENTIFIER_PREFIX = "fisqua:";

/** What `dc:source` and the bulk reading's `dc:rights` are read from. */
export interface DcRepository {
  name: string;
  city: string;
  rightsText: string | null;
}

/**
 * A description as the crosswalk reads it. Structurally satisfied by
 * `EadInput` (the publish pipeline's row shape) and by a projection of
 * a `descriptions` row, so neither caller needs an adapter.
 */
export interface DcDescriptionRow {
  referenceCode: string;
  title: string;
  descriptionLevel: string;
  dateExpression: string | null;
  extent: string | null;
  creatorDisplay: string | null;
  scopeContent: string | null;
  placeDisplay: string | null;
  imprint: string | null;
  language: string | null;
  parentReferenceCode: string | null;
  accessConditions?: string | null;
  reproductionConditions?: string | null;
  adminBiogHistory?: string | null;
}

/** An entity as the crosswalk reads it. */
export interface DcEntityRow {
  entityCode: string | null;
  displayName: string;
  entityType: string;
  datesOfExistence: string | null;
  history: string | null;
  sources: string | null;
}

/** A place as the crosswalk reads it. */
export interface DcPlaceRow {
  placeCode: string | null;
  label: string;
  displayName: string | null;
  notes: string | null;
}

/** The identifier half of a reference code, path-safe. */
export function dcIdentifier(referenceCode: string): string {
  return sanitiseRefForKey(referenceCode);
}

/**
 * Two fields becoming one element. The blank line between them is the
 * only trace left that there were two — which is exactly the ambiguity
 * the loss report calls "merged", and the reason it is reported as a
 * distinct harm from a dropped field.
 */
function merge(a: string | null | undefined, b: string | null | undefined): string | null {
  const parts = [a, b].filter((v): v is string => typeof v === "string" && v.trim() !== "");
  if (parts.length === 0) return null;
  return parts.join("\n\n");
}

function nullIfBlank(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return value.trim() === "" ? null : value;
}

/** One description as fifteen elements. */
export function dcDescriptionRecord(
  row: DcDescriptionRow,
  repo: DcRepository | undefined,
  reading: DcReading,
): DcRecord {
  const source = repo && repo.name && repo.city ? `${repo.name}, ${repo.city}` : null;
  const language = row.language
    ? (DC_LANGUAGE_MAP[row.language] ?? row.language)
    : null;

  const description =
    reading === "workspace-export"
      ? merge(row.scopeContent, row.adminBiogHistory)
      : nullIfBlank(row.scopeContent);

  const rights =
    reading === "workspace-export"
      ? merge(row.accessConditions, row.reproductionConditions)
      : repo?.rightsText && repo.rightsText.trim().length > 0
        ? repo.rightsText
        : DC_RIGHTS_DEFAULT;

  return {
    title: nullIfBlank(row.title),
    creator: nullIfBlank(row.creatorDisplay),
    subject: nullIfBlank(row.placeDisplay),
    description,
    publisher: nullIfBlank(row.imprint),
    // Never populated — see the module header.
    contributor: null,
    date: nullIfBlank(row.dateExpression),
    type: DC_TYPE_MAP[row.descriptionLevel] ?? null,
    format: nullIfBlank(row.extent),
    identifier: dcIdentifier(row.referenceCode),
    source,
    language,
    relation: nullIfBlank(row.parentReferenceCode),
    coverage: nullIfBlank(row.dateExpression),
    rights,
  };
}

/**
 * One entity as fifteen elements. The agent is named twice on purpose —
 * once as the record's title, because a Dublin Core record must say
 * what it is about, and once as `dc:creator`, which is the slot the
 * authority card rules for agents.
 */
export function dcEntityRecord(row: DcEntityRow): DcRecord {
  return {
    title: nullIfBlank(row.displayName),
    creator: nullIfBlank(row.displayName),
    subject: null,
    description: nullIfBlank(row.history),
    publisher: null,
    contributor: null,
    date: nullIfBlank(row.datesOfExistence),
    // No DCMI Type term means "a person" or "an organisation".
    type: null,
    format: null,
    identifier: nullIfBlank(row.entityCode),
    source: nullIfBlank(row.sources),
    language: null,
    relation: null,
    coverage: null,
    rights: null,
  };
}

/**
 * One place as fifteen elements. A place is the `dc:subject` of the
 * records that name it and its own `dc:coverage` — the spatial reading
 * of coverage, by name. Coordinates are not emitted: DCMI encodes them
 * through the Point scheme, and this crosswalk does not claim a scheme.
 */
export function dcPlaceRecord(row: DcPlaceRow): DcRecord {
  const name = nullIfBlank(row.displayName) ?? nullIfBlank(row.label);
  return {
    title: nullIfBlank(row.label),
    creator: null,
    subject: name,
    description: nullIfBlank(row.notes),
    publisher: null,
    contributor: null,
    date: null,
    // No DCMI Type term means "a place".
    type: null,
    format: null,
    identifier: nullIfBlank(row.placeCode),
    source: null,
    language: null,
    relation: null,
    coverage: name,
    rights: null,
  };
}

/** A record as `{ "dc:title": …, … }`, in element order. */
export function dcRecordAsObject(record: DcRecord): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const element of DC_ELEMENTS) out[`dc:${element}`] = record[element];
  return out;
}

/* @version v0.7.0 */
