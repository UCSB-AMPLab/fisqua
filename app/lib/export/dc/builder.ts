/**
 * Dublin Core Bulk Export Builder
 *
 * This builder deals with per-fonds bulk Dublin Core emission. One
 * file per fonds; OAI-PMH 2.0 `<ListRecords>` envelope; one
 * `<record>` per published description; each record carries an
 * `<oai_dc:dc>` block with the 15 simple Dublin Core elements in spec
 * order. Future OAI-PMH endpoint (post-v0.5) streams these files
 * verbatim — no re-serialisation step.
 *
 * The element mapping is `./crosswalk.ts`. The `el()` helper from
 * `app/lib/export/xml/escape.ts` handles null-safety (null/empty input emits no element) and XML
 * escaping.
 *
 * Scope: descriptions only. Entities and places have no canonical
 * Dublin Core mapping.
 *
 * Pure function: no D1, no R2, no fetch. The publish pipeline wires
 * the data fetch + R2 PUT around this; the builder takes
 * already-fetched fonds rows + repository map + fonds code +
 * datestamp as input and returns the document as a UTF-8 string.
 *
 * THE MAPPING MOVED OUT; THE DOCUMENT STAYED (v0.7.0). Dublin Core is
 * a FORM rather than a format (self-service export design, ruling 1),
 * so the fifteen element assignments now live in `./crosswalk.ts` as
 * data and this builder renders them as the OAI-PMH document it always
 * did. It asks for the `oai-bulk` reading, which is the behaviour this
 * file shipped in v0.4 element for element but one: `dc:description` is
 * scope and content alone, and `dc:rights` is the repository's
 * attribution line in the record's language, where it used to be the
 * repository's rights text. The caller composes the line into each
 * repository it passes. The workspace export surface asks for the
 * other reading; neither can change without changing the crosswalk,
 * which is the point of moving it.
 *
 * The document is also available in three pieces (`buildDcBulkOpen`,
 * `buildDcBulkRecord`, `DC_BULK_CLOSE`) so the publish step can write a
 * large fonds a batch of rows at a time; each record depends only on
 * its own row and its repository.
 *
 * @version v0.9.0
 */

import { escapeXml, el } from "../xml/escape";
import type { EadInput, EadRepository } from "../types";
import {
  DC_ELEMENTS,
  DC_IDENTIFIER_PREFIX,
  dcDescriptionRecord,
  dcIdentifier,
} from "./crosswalk";

// ---------------------------------------------------------------------------
// Namespaces (OAI-PMH 2.0 + OAI-DC + DC simple)
// ---------------------------------------------------------------------------

const NS_OAI = "http://www.openarchives.org/OAI/2.0/";
const NS_OAI_DC = "http://www.openarchives.org/OAI/2.0/oai_dc/";
const NS_DC = "http://purl.org/dc/elements/1.1/";
const NS_XSI = "http://www.w3.org/2001/XMLSchema-instance";
const OAI_DC_SCHEMA_LOCATION =
  "http://www.openarchives.org/OAI/2.0/oai_dc/ http://www.openarchives.org/OAI/2.0/oai_dc.xsd";

// ---------------------------------------------------------------------------
// Mappings
//
// `DC_TYPE_MAP`, the language map, the default rights string and the
// identifier prefix live in `./crosswalk.ts`, so a second
// serialisation of the same form can reach them.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

/**
 * Emit one Dublin Core bulk file for one fonds.
 *
 * @param fondsRows  All descriptions in the fonds (caller filters by
 *                   tenant_id; the pipeline integration does that).
 *                   Unpublished rows (`isPublished === false`) are skipped.
 * @param repos      Repository lookup keyed by `repositoryId`. Used for
 *                   `<dc:source>` (name + city) and `<dc:rights>`
 *                   (the attribution line in the record's language,
 *                   else `DC_RIGHTS_DEFAULT`).
 * @param fondsCode  Reference code of the fonds (kept on the signature for
 *                   diagnostics + future per-fonds wrapper attributes —
 *                   not currently embedded in the OAI envelope itself).
 * @param datestamp  ISO-8601 date (typically YYYY-MM-DD) emitted as the
 *                   `<datestamp>` of every `<record>` in this file.
 *                   Typically the publish-run timestamp.
 *
 * @returns OAI-PMH 2.0 `<ListRecords>` document as a UTF-8 string. The
 *          file is structurally complete even when zero rows are
 *          published — empty `<ListRecords>` is well-formed XML and lets
 *          a future OAI endpoint signal an empty fonds slice without a
 *          separate "no rows" code path.
 */
export function buildDcBulk(
  fondsRows: ReadonlyArray<EadInput>,
  repos: ReadonlyMap<string, EadRepository>,
  fondsCode: string,
  datestamp: string,
): string {
  // fondsCode is part of the contract for future per-fonds wrapper
  // attributes (e.g. an `<about>` block keyed by fonds reference); not
  // currently embedded but kept on the signature so future per-fonds
  // wrapper attributes don't need a re-typing pass.
  void fondsCode;

  const published = fondsRows.filter((r) => r.isPublished);

  let xml = buildDcBulkOpen();
  for (const row of published) {
    xml += buildDcBulkRecord(row, repos, datestamp);
  }
  xml += DC_BULK_CLOSE;
  return xml;
}

/**
 * The bulk file up to its first `<record>`. With `buildDcBulkRecord`
 * and `DC_BULK_CLOSE` it lets the publish step write a fonds a batch of
 * rows at a time; `buildDcBulk` is the three run over the whole fonds.
 */
export function buildDcBulkOpen(): string {
  let xml = '<?xml version="1.0" encoding="UTF-8"?>\n';
  xml += `<ListRecords xmlns="${NS_OAI}"\n`;
  xml += `             xmlns:oai_dc="${NS_OAI_DC}"\n`;
  xml += `             xmlns:dc="${NS_DC}"\n`;
  xml += `             xmlns:xsi="${NS_XSI}"\n`;
  xml += `             xsi:schemaLocation="${OAI_DC_SCHEMA_LOCATION}">\n`;
  return xml;
}

/** One description's `<record>`. */
export function buildDcBulkRecord(
  row: EadInput,
  repos: ReadonlyMap<string, EadRepository>,
  datestamp: string,
): string {
  return renderRecord(row, repos, datestamp);
}

/** The closing tag after the last `<record>`. */
export const DC_BULK_CLOSE = `</ListRecords>\n`;

// ---------------------------------------------------------------------------
// Helpers (private)
// ---------------------------------------------------------------------------

/**
 * Emit one `<record>` block for one published description row. Element
 * ordering inside `<oai_dc:dc>` is OAI-DC spec order: title, creator, subject, description, publisher,
 * contributor, date, type, format, identifier, source, language,
 * relation, coverage, rights.
 *
 * `dc:contributor` is intentionally omitted in v0.4 — entity-level
 * contributors are OAI-PMH-endpoint scope, not bulk-export scope.
 * The slot stays in the documented ordering so
 * the future v0.5+ insertion lands without renumbering the rest; the
 * crosswalk holds it as a permanently-null element for the same reason.
 *
 * The element VALUES come from `dcDescriptionRecord`; this function
 * decides only where they sit in the OAI envelope and how deep they are
 * indented. Iterating `DC_ELEMENTS` rather than naming fifteen calls
 * keeps the emission order and the crosswalk's order the same order by
 * construction.
 */
function renderRecord(
  row: EadInput,
  repos: ReadonlyMap<string, EadRepository>,
  datestamp: string,
): string {
  const repo = repos.get(row.repositoryId);
  const ref = dcIdentifier(row.referenceCode);
  const record = dcDescriptionRecord(row, repo, "oai-bulk");

  let r = `  <record>\n`;
  r += `    <header>\n`;
  r += `      <identifier>${escapeXml(DC_IDENTIFIER_PREFIX + ref)}</identifier>\n`;
  r += `      <datestamp>${escapeXml(datestamp)}</datestamp>\n`;
  r += `    </header>\n`;
  r += `    <metadata>\n`;
  r += `      <oai_dc:dc>\n`;

  // Spec order: title, creator, subject, description, publisher,
  // contributor, date, type, format, identifier, source, language,
  // relation, coverage, rights. `el()` emits nothing for a null or
  // blank element, so an absent field leaves no empty tag behind.
  for (const element of DC_ELEMENTS) {
    r += elIndented(`dc:${element}`, record[element]);
  }

  r += `      </oai_dc:dc>\n`;
  r += `    </metadata>\n`;
  r += `  </record>\n`;
  return r;
}

/**
 * Indent `el()` output for the OAI-DC nesting depth.
 *
 * `el()` in `xml/escape.ts` emits `    <tag>...</tag>\n` (4-space indent)
 * because that's the single nesting level it was originally written for
 * inside `<dmdSec>` → `<mdWrap>` → `<xmlData>`. Inside the OAI envelope
 * the `<dc:*>` elements sit one level deeper (`<record>` → `<metadata>`
 * → `<oai_dc:dc>` → `<dc:*>`), so we re-indent to 8 spaces.
 *
 * Returns "" for null/empty input — the el() helper's null-safety
 * propagates here unchanged.
 */
function elIndented(tag: string, text: string | null | undefined): string {
  const out = el(tag, text);
  if (!out) return "";
  return out.replace(/^    /, "        ");
}

/* @version v0.9.0 */
