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
 * Element mapping reuses the line-anchored precedent at
 * `mets-builder.ts:161-173` (every one of the 15 mappings has an
 * analog there). The `el()` helper from `app/lib/export/xml/escape.ts`
 * handles null-safety (null/empty input emits no element) and XML
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
 * file shipped in v0.4 element for element: `dc:description` is scope
 * and content alone and `dc:rights` is the repository's licence
 * statement. The workspace export surface asks for the other reading;
 * neither can change without changing the crosswalk, which is the
 * point of moving it.
 *
 * @version v0.7.0
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
// identifier prefix moved to `./crosswalk.ts` in v0.7.0 so a second
// serialisation of the same form could reach them. They were lifted
// from mets-builder.ts:36-53 originally; nothing about them changed in
// the move.
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
 *                   (rightsText fallback to RIGHTS_DEFAULT).
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

  let xml = '<?xml version="1.0" encoding="UTF-8"?>\n';
  xml += `<ListRecords xmlns="${NS_OAI}"\n`;
  xml += `             xmlns:oai_dc="${NS_OAI_DC}"\n`;
  xml += `             xmlns:dc="${NS_DC}"\n`;
  xml += `             xmlns:xsi="${NS_XSI}"\n`;
  xml += `             xsi:schemaLocation="${OAI_DC_SCHEMA_LOCATION}">\n`;

  for (const row of published) {
    xml += renderRecord(row, repos, datestamp);
  }

  xml += `</ListRecords>\n`;
  return xml;
}

// ---------------------------------------------------------------------------
// Helpers (private)
// ---------------------------------------------------------------------------

/**
 * Emit one `<record>` block for one published description row. Element
 * ordering inside `<oai_dc:dc>` is OAI-DC spec order (RESEARCH Open
 * Question 4 lock): title, creator, subject, description, publisher,
 * contributor, date, type, format, identifier, source, language,
 * relation, coverage, rights.
 *
 * `dc:contributor` is intentionally omitted in v0.4 — entity-level
 * contributors are OAI-PMH-endpoint scope, not bulk-export scope
 * (RESEARCH §Pattern 3). The slot stays in the documented ordering so
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
 * propagates here unchanged (RESEARCH Pitfall 4).
 */
function elIndented(tag: string, text: string | null | undefined): string {
  const out = el(tag, text);
  if (!out) return "";
  return out.replace(/^    /, "        ");
}

/* @version v0.7.0 */
