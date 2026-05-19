/**
 * Dublin Core Bulk Builder — Structural Tests
 *
 * This suite locks the Dublin Core contract: per-fonds bulk DC file in OAI-PMH
 * 2.0 `<ListRecords>` envelope, 15-element closed-set vocabulary in
 * spec order, no DC Terms refinements, null-safe element emission,
 * and XML-special-char escaping.
 *
 * Assertions are deliberately string- and regex-level rather than
 * DOM-parser based: `@xmldom/xmldom` is not in `package.json`, and
 * adding a new dependency for one test file is a worse trade than
 * the slightly looser regex matchers used here. Every assertion
 * still pins a hard structural invariant — wrapper namespaces,
 * record cardinality, element ordering, vocabulary closed set,
 * null-safety, escape — and carries enough specificity that a
 * builder regression breaks the matching it() block rather than
 * passing silently.
 *
 * Fixture surface (from `tests/export/ead/fixtures.ts`):
 *   - Row 0 (`co-ahr-gob`): XML-special chars in title +
 *     scopeContent so the XML-escape path is exercised on every run.
 *   - Row 2 (`co-ahr-gob-s1-f1`): `dateExpression: null` so the
 *     null-safety guard (no empty `<dc:date>`) is exercised
 *     structurally.
 *   - All four rows have `isPublished: true`, so the cardinality
 *     assertion against the published count anchors at 4 records.
 *
 * If a structural assertion fails, the DC builder
 * (`app/lib/export/dc/builder.ts`) is iterated until the contract
 * holds.
 *
 * @version v0.4.0
 */

import { describe, it, expect } from "vitest";
import { buildDcBulk } from "../../../app/lib/export/dc/builder";
import { sampleFondsRows, sampleRepositoryById } from "../ead/fixtures";

const FONDS_CODE = "co-ahr-gob";
const DATESTAMP = "2026-05-04";

const VALID_DC_ELEMENTS = new Set([
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
]);

const SPEC_ORDER = [
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
];

describe("buildDcBulk — wrapper structure", () => {
  it("emits XML declaration + <ListRecords> root in OAI 2.0 namespace", () => {
    const xml = buildDcBulk(sampleFondsRows, sampleRepositoryById, FONDS_CODE, DATESTAMP);
    expect(xml).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(xml).toContain('<ListRecords xmlns="http://www.openarchives.org/OAI/2.0/"');
    expect(xml).toMatch(/<\/ListRecords>\s*$/);
  });

  it("declares all five required namespaces on <ListRecords>", () => {
    const xml = buildDcBulk(sampleFondsRows, sampleRepositoryById, FONDS_CODE, DATESTAMP);
    expect(xml).toContain('xmlns="http://www.openarchives.org/OAI/2.0/"');
    expect(xml).toContain('xmlns:oai_dc="http://www.openarchives.org/OAI/2.0/oai_dc/"');
    expect(xml).toContain('xmlns:dc="http://purl.org/dc/elements/1.1/"');
    expect(xml).toContain('xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"');
    expect(xml).toContain('xsi:schemaLocation="http://www.openarchives.org/OAI/2.0/oai_dc/');
  });

  it("matches every <record> open tag with a close tag", () => {
    const xml = buildDcBulk(sampleFondsRows, sampleRepositoryById, FONDS_CODE, DATESTAMP);
    const opens = (xml.match(/<record>/g) ?? []).length;
    const closes = (xml.match(/<\/record>/g) ?? []).length;
    expect(opens).toBe(closes);
    expect(opens).toBeGreaterThan(0);
  });
});

describe("buildDcBulk — record cardinality", () => {
  it("emits one <record> per published row in fondsRows", () => {
    const xml = buildDcBulk(sampleFondsRows, sampleRepositoryById, FONDS_CODE, DATESTAMP);
    const recordCount = (xml.match(/<record>/g) ?? []).length;
    const publishedCount = sampleFondsRows.filter((r) => r.isPublished).length;
    expect(recordCount).toBe(publishedCount);
  });

  it("skips unpublished rows", () => {
    const mixed = [
      ...sampleFondsRows,
      {
        ...sampleFondsRows[0],
        id: "00000000-0000-4000-8000-0000000000ff",
        referenceCode: "co-ahr-gob-unpub",
        isPublished: false,
      },
    ];
    const xml = buildDcBulk(mixed, sampleRepositoryById, FONDS_CODE, DATESTAMP);
    expect(xml).not.toContain("co-ahr-gob-unpub");
    const recordCount = (xml.match(/<record>/g) ?? []).length;
    expect(recordCount).toBe(sampleFondsRows.filter((r) => r.isPublished).length);
  });

  it("each <record> has <header> with <identifier>fisqua:... and <datestamp>", () => {
    const xml = buildDcBulk(sampleFondsRows, sampleRepositoryById, FONDS_CODE, DATESTAMP);
    expect(xml).toMatch(
      /<header>\s*<identifier>fisqua:[\w-]+<\/identifier>\s*<datestamp>2026-05-04<\/datestamp>\s*<\/header>/,
    );
  });

  it("emits <ListRecords>...</ListRecords> with no <record> children when zero rows are published", () => {
    const empty = sampleFondsRows.map((r) => ({ ...r, isPublished: false }));
    const xml = buildDcBulk(empty, sampleRepositoryById, FONDS_CODE, DATESTAMP);
    expect(xml).toContain("<ListRecords");
    expect(xml).toMatch(/<\/ListRecords>\s*$/);
    expect(xml).not.toContain("<record>");
  });
});

describe("buildDcBulk — closed-set DC vocabulary", () => {
  it("every dc:* element is in the 15-element closed set (no DC Terms leakage)", () => {
    const xml = buildDcBulk(sampleFondsRows, sampleRepositoryById, FONDS_CODE, DATESTAMP);
    const matches = [...xml.matchAll(/<dc:(\w+)\b/g)];
    expect(matches.length).toBeGreaterThan(0);
    const found = new Set(matches.map((m) => m[1]));
    for (const tag of found) {
      expect(VALID_DC_ELEMENTS.has(tag)).toBe(true);
    }
  });

  it("no <dcterms:*> elements appear", () => {
    const xml = buildDcBulk(sampleFondsRows, sampleRepositoryById, FONDS_CODE, DATESTAMP);
    expect(xml).not.toMatch(/<dcterms:/);
  });

  it("does not declare the dcterms namespace on <ListRecords>", () => {
    const xml = buildDcBulk(sampleFondsRows, sampleRepositoryById, FONDS_CODE, DATESTAMP);
    expect(xml).not.toMatch(/xmlns:dcterms=/);
  });
});

describe("buildDcBulk — element ordering inside <oai_dc:dc>", () => {
  it("elements appear in OAI-DC spec order (title → creator → ... → rights)", () => {
    const xml = buildDcBulk(sampleFondsRows, sampleRepositoryById, FONDS_CODE, DATESTAMP);
    const blocks = xml.match(/<oai_dc:dc>([\s\S]*?)<\/oai_dc:dc>/g) ?? [];
    expect(blocks.length).toBeGreaterThan(0);
    for (const block of blocks) {
      const tagsInOrder = [...block.matchAll(/<dc:(\w+)\b/g)].map((m) => m[1]);
      const expected = SPEC_ORDER.filter((t) => tagsInOrder.includes(t));
      expect(tagsInOrder).toEqual(expected);
    }
  });
});

describe("buildDcBulk — null-safety (RESEARCH Pitfall 4)", () => {
  it("emits no empty <dc:date> when dateExpression is null", () => {
    const xml = buildDcBulk(sampleFondsRows, sampleRepositoryById, FONDS_CODE, DATESTAMP);
    expect(xml).not.toContain("<dc:date></dc:date>");
    expect(xml).not.toContain("<dc:date/>");
  });

  it("the file-level row in the fixture (dateExpression: null) has no <dc:date> at all", () => {
    const xml = buildDcBulk(sampleFondsRows, sampleRepositoryById, FONDS_CODE, DATESTAMP);
    // Slice individual records by splitting on the </record> close tag and
    // pick the one carrying the s1-f1 identifier. A naive
    // `<record>[\s\S]*?fisqua:co-ahr-gob-s1-f1[\s\S]*?</record>` regex
    // anchors at the document's first `<record>` and runs through to the
    // s1-f1 closer, picking up the preceding records' `<dc:date>` elements
    // along the way — the assertion would then fail spuriously even when
    // the s1-f1 record itself has no `<dc:date>`.
    const records = xml.split(/<\/record>/).map((s) => s + "</record>");
    const target = records.find((r) => r.includes("fisqua:co-ahr-gob-s1-f1<"));
    expect(target).toBeDefined();
    expect(target!).not.toContain("<dc:date>");
    expect(target!).not.toContain("<dc:date/>");
  });
});

describe("buildDcBulk — XML escape (T-37-02)", () => {
  it("escapes XML-special chars in element content", () => {
    const xml = buildDcBulk(sampleFondsRows, sampleRepositoryById, FONDS_CODE, DATESTAMP);
    // sampleFondsRows[0] title = "Gobernación de Rionegro <colonial period>"
    expect(xml).toContain("&lt;colonial period&gt;");
    expect(xml).not.toContain("Rionegro <colonial period>");
    // sampleFondsRows[0] scopeContent = "Documentos administrativos & judiciales"
    expect(xml).toContain("administrativos &amp; judiciales");
    expect(xml).not.toContain("administrativos & judiciales");
  });
});

/* @version v0.4.0 */
