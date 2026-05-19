/**
 * EAD3 Builder Unit Tests
 *
 * This suite carries structural assertions on the string output of `buildEad3` plus the
 * `getEadProfile` registry's contract. These tests are deliberately
 * structural (string `toContain` / regex match) rather than full RNG
 * validation — the RNG validation suite lives at
 * `tests/export/ead/schema-validation.test.ts` and runs under the
 * Node pool because xmllint-wasm reads `node:fs`. The builder's
 * contract is that it produces structurally-shaped EAD3; the
 * validator's contract is that the output validates against the
 * official EAD3 RNG.
 *
 * The fixture (`tests/export/ead/fixtures.ts`) exercises:
 *   - Four description levels (fonds, series, file, item) so per-level
 *     emission is covered.
 *   - XML-special characters in title and scopeContent so the
 *     XML-escape mitigation runs on every test.
 *   - A null `dateExpression` row for null-safety.
 *   - Two `legacyIds` providers ("ca", "django") so the primary +
 *     secondary unitid emission scheme is exercised end-to-end.
 *
 * @version v0.4.0
 */

import { describe, it, expect } from "vitest";
import { buildEad3 } from "../../../app/lib/export/ead/builder";
import { ISADG_EAD_PROFILE } from "../../../app/lib/export/ead/profiles/isadg";
import { DACS_EAD_PROFILE } from "../../../app/lib/export/ead/profiles/dacs";
import { RAD_EAD_PROFILE } from "../../../app/lib/export/ead/profiles/rad";
import { getEadProfile } from "../../../app/lib/export/ead/profiles/registry";
import { sampleFondsRows, sampleRepositoryById } from "./fixtures";

const CREATE_DATE = "2026-05-04T10:00:00Z";

describe("buildEad3 — common structural invariants", () => {
  it("emits XML declaration + <ead> root with EAD3 namespace", () => {
    const xml = buildEad3(sampleFondsRows, sampleRepositoryById, ISADG_EAD_PROFILE, CREATE_DATE);
    expect(xml).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(xml).toContain('<ead xmlns="http://ead3.archivists.org/schema/"');
  });

  it("emits exactly one <archdesc>", () => {
    const xml = buildEad3(sampleFondsRows, sampleRepositoryById, ISADG_EAD_PROFILE, CREATE_DATE);
    const matches = xml.match(/<archdesc\b/g) ?? [];
    expect(matches.length).toBe(1);
  });

  it("places <did> as the first child of <archdesc> (universal EAD3 ordering)", () => {
    const xml = buildEad3(sampleFondsRows, sampleRepositoryById, ISADG_EAD_PROFILE, CREATE_DATE);
    // The first opening tag inside <archdesc ...> must be <did>.
    const archdescMatch = xml.match(/<archdesc[^>]*>\s*<([a-z]+)/);
    expect(archdescMatch?.[1]).toBe("did");
  });

  it("escapes XML-special chars in titles (T-37-02)", () => {
    const xml = buildEad3(sampleFondsRows, sampleRepositoryById, ISADG_EAD_PROFILE, CREATE_DATE);
    expect(xml).toContain("&lt;colonial period&gt;");
    expect(xml).not.toContain("Rionegro <colonial period>");
  });

  it("escapes ampersands in scopeContent (T-37-02)", () => {
    const xml = buildEad3(sampleFondsRows, sampleRepositoryById, ISADG_EAD_PROFILE, CREATE_DATE);
    expect(xml).toContain("Documentos administrativos &amp; judiciales");
    expect(xml).not.toContain("Documentos administrativos & judiciales");
  });

  it("emits primary <unitid> from referenceCode + secondary <unitid localtype='<provider>'> per legacyIds (Open Question 2)", () => {
    const xml = buildEad3(sampleFondsRows, sampleRepositoryById, ISADG_EAD_PROFILE, CREATE_DATE);
    // Primary unitid: no @localtype, value = referenceCode.
    expect(xml).toContain("<unitid>co-ahr-gob</unitid>");
    // Secondary unitids: @localtype = provider, value = legacy id
    // (stringified). EAD3 uses `localtype` (not EAD2002's `type`) —
    // The attribute name follows EAD3's RNG grammar.
    expect(xml).toContain('<unitid localtype="ca">12345</unitid>');
    expect(xml).toContain('<unitid localtype="django">gob_001</unitid>');
  });

  it("omits <unitdate> when dateExpression is null (Pitfall 4)", () => {
    const xml = buildEad3(sampleFondsRows, sampleRepositoryById, ISADG_EAD_PROFILE, CREATE_DATE);
    // No empty <unitdate></unitdate> or self-closing form should appear
    // for the file-level row whose dateExpression is null.
    expect(xml).not.toMatch(/<unitdate>\s*<\/unitdate>/);
    expect(xml).not.toContain("<unitdate/>");
    expect(xml).not.toContain("<unitdate />");
  });

  it("emits one <c> per non-fonds row with the row's level attribute", () => {
    const xml = buildEad3(sampleFondsRows, sampleRepositoryById, ISADG_EAD_PROFILE, CREATE_DATE);
    expect(xml).toContain('<c level="series"');
    expect(xml).toContain('<c level="file"');
    expect(xml).toContain('<c level="item"');
    // No <c level="fonds"> — the fonds row drives <archdesc>, not <c>.
    expect(xml).not.toContain('<c level="fonds"');
  });

  it("renders <repository> with the repo display name", () => {
    const xml = buildEad3(sampleFondsRows, sampleRepositoryById, ISADG_EAD_PROFILE, CREATE_DATE);
    expect(xml).toContain("Archivo Histórico de Rionegro");
  });

  it("balances <ead> open and close tags", () => {
    const xml = buildEad3(sampleFondsRows, sampleRepositoryById, ISADG_EAD_PROFILE, CREATE_DATE);
    expect((xml.match(/<ead\b/g) ?? []).length).toBe(1);
    expect((xml.match(/<\/ead>/g) ?? []).length).toBe(1);
  });

  it("returns empty string when fondsRows is empty", () => {
    const xml = buildEad3([], sampleRepositoryById, ISADG_EAD_PROFILE, CREATE_DATE);
    expect(xml).toBe("");
  });

  it("throws when no fonds-level row is present", () => {
    const noFondsRows = sampleFondsRows.filter((r) => r.descriptionLevel !== "fonds");
    expect(() =>
      buildEad3(noFondsRows, sampleRepositoryById, ISADG_EAD_PROFILE, CREATE_DATE),
    ).toThrow(/no fonds-level row/i);
  });
});

describe("buildEad3 — per-standard profile divergence", () => {
  it("DACS places <bioghist> under <archdesc> when adminBiogHistory is populated (context placement)", () => {
    const fondsWithBiog = sampleFondsRows.map((r, i) =>
      i === 0 ? { ...r, adminBiogHistory: "Biographical history of the Gobernación" } : r,
    );
    const xml = buildEad3(fondsWithBiog, sampleRepositoryById, DACS_EAD_PROFILE, CREATE_DATE);
    expect(xml).toContain("<bioghist>");
    expect(xml).toContain("Biographical history of the Gobernación");
    // DACS context placement: <bioghist> appears before <scopecontent> in
    // the universal EAD3 element order.
    const bioghistIdx = xml.indexOf("<bioghist>");
    const scopeIdx = xml.indexOf("<scopecontent>");
    expect(bioghistIdx).toBeGreaterThan(-1);
    expect(scopeIdx).toBeGreaterThan(bioghistIdx);
  });

  it("ISADG places admin/biog under <notestmt> rather than <bioghist> (notes placement)", () => {
    const fondsWithBiog = sampleFondsRows.map((r, i) =>
      i === 0 ? { ...r, adminBiogHistory: "Administrative history" } : r,
    );
    const xml = buildEad3(fondsWithBiog, sampleRepositoryById, ISADG_EAD_PROFILE, CREATE_DATE);
    // ISAD(G) routes admin/biog into <notestmt><note>, not a top-level <bioghist>.
    expect(xml).not.toContain("<bioghist>");
    expect(xml).toContain("<notestmt>");
    expect(xml).toContain("Administrative history");
  });

  it("ISADG omits <bioghist> AND <notestmt> when adminBiogHistory is null", () => {
    const xml = buildEad3(sampleFondsRows, sampleRepositoryById, ISADG_EAD_PROFILE, CREATE_DATE);
    expect(xml).not.toContain("<bioghist>");
    expect(xml).not.toContain("<notestmt>");
  });

  it("DACS includes <prefercite> when preferredCitation is populated", () => {
    const fondsWithCite = sampleFondsRows.map((r, i) =>
      i === 0 ? { ...r, preferredCitation: "Cite as: Gobernación de Rionegro, AHR." } : r,
    );
    const xml = buildEad3(fondsWithCite, sampleRepositoryById, DACS_EAD_PROFILE, CREATE_DATE);
    expect(xml).toContain("<prefercite>");
    expect(xml).toContain("Cite as: Gobernación de Rionegro");
  });

  it("ISADG omits <prefercite> even when preferredCitation is populated (not part of ISAD(G))", () => {
    const fondsWithCite = sampleFondsRows.map((r, i) =>
      i === 0 ? { ...r, preferredCitation: "Cite as: ..." } : r,
    );
    const xml = buildEad3(fondsWithCite, sampleRepositoryById, ISADG_EAD_PROFILE, CREATE_DATE);
    expect(xml).not.toContain("<prefercite>");
  });

  it("RAD includes <arrangement> when systemOfArrangement is populated", () => {
    const fondsWithArr = sampleFondsRows.map((r, i) =>
      i === 0 ? { ...r, systemOfArrangement: "Arranged chronologically by year" } : r,
    );
    const xml = buildEad3(fondsWithArr, sampleRepositoryById, RAD_EAD_PROFILE, CREATE_DATE);
    expect(xml).toContain("<arrangement>");
    expect(xml).toContain("Arranged chronologically by year");
  });

  it("DACS omits <arrangement> from systemOfArrangement (profile gates it OFF; standard arrangement column would handle it)", () => {
    const fondsWithArr = sampleFondsRows.map((r, i) =>
      i === 0 ? { ...r, systemOfArrangement: "DACS-only arrangement narrative" } : r,
    );
    const xml = buildEad3(fondsWithArr, sampleRepositoryById, DACS_EAD_PROFILE, CREATE_DATE);
    expect(xml).not.toContain("DACS-only arrangement narrative");
  });

  it("emits <acqinfo> for all three profiles when acquisitionInfo is populated", () => {
    const fondsWithAcq = sampleFondsRows.map((r, i) =>
      i === 0 ? { ...r, acquisitionInfo: "Donated by the Gobernación in 1950" } : r,
    );
    for (const profile of [ISADG_EAD_PROFILE, DACS_EAD_PROFILE, RAD_EAD_PROFILE]) {
      const xml = buildEad3(fondsWithAcq, sampleRepositoryById, profile, CREATE_DATE);
      expect(xml).toContain("<acqinfo>");
      expect(xml).toContain("Donated by the Gobernación in 1950");
    }
  });
});

describe("getEadProfile (registry)", () => {
  it("returns the right profile for known standards", () => {
    expect(getEadProfile("isadg").standard).toBe("isadg");
    expect(getEadProfile("dacs").standard).toBe("dacs");
    expect(getEadProfile("rad").standard).toBe("rad");
  });

  it("throws on unknown standard with the documented error shape", () => {
    expect(() => getEadProfile("xyz" as never)).toThrow(
      "Unknown descriptive standard: xyz",
    );
  });
});
