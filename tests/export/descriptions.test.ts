/**
 * Tests — description export formatter
 *
 * This suite pins the pure helpers that shape a D1 description row
 * into the public-export JSON payload: `formatDescription` (the
 * field-level transformer) and `childrenLevel` (the level of a
 * description's children, which the public tree uses to label them).
 * Neither reads a tenant, repository or reference code: a
 * description's `children_level` is the description level its
 * published children share (the most common one when they mix, ties
 * going to the broader level), or null when it has none, and
 * `publication_title` is the stored value. Every description has a
 * `mets_url`, its METS address under the tenant's base, whether or not
 * it is digitised, and null only when the tenant has no base.
 *
 * The formatter strips internal-only columns (e.g. `legacyIds`,
 * `pathCache`), preserves the ISAD(G) elements, and collapses
 * empty strings to `null` so the frontend's JSON consumers don't
 * have to discriminate "" vs missing.
 *
 * @version v0.9.0
 */
import { describe, it, expect } from "vitest";
import {
  childrenLevel,
  formatDescription,
} from "../../app/lib/export/descriptions.server";
import type { ExportDescription } from "../../app/lib/export/types";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeDescriptionRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "desc-001",
    repositoryId: "repo-001",
    parentId: null as string | null,
    position: 0,
    rootDescriptionId: null as string | null,
    depth: 0,
    childCount: 0,
    pathCache: "",
    descriptionLevel: "file",
    resourceType: null as string | null,
    genre: "[]",
    referenceCode: "co-ahr-gob-caj001-car001",
    localIdentifier: "GOB-001",
    title: "Test description",
    translatedTitle: null as string | null,
    uniformTitle: null as string | null,
    dateExpression: "1810",
    dateStart: "1810-01-01",
    dateEnd: null as string | null,
    dateCertainty: null as string | null,
    extent: "1 folio",
    dimensions: null as string | null,
    medium: null as string | null,
    imprint: null as string | null,
    editionStatement: null as string | null,
    seriesStatement: null as string | null,
    volumeNumber: null as string | null,
    issueNumber: null as string | null,
    pages: null as string | null,
    provenance: null as string | null,
    scopeContent: "Test scope",
    ocrText: "Test OCR",
    arrangement: null as string | null,
    accessConditions: null as string | null,
    reproductionConditions: null as string | null,
    language: "192",
    locationOfOriginals: null as string | null,
    locationOfCopies: null as string | null,
    // related_materials dropped in 0036 (0% populated).
    findingAids: null as string | null,
    sectionTitle: null as string | null,
    notes: null as string | null,
    internalNotes: null as string | null,
    creatorDisplay: "Juan de la Cruz",
    placeDisplay: "Rionegro",
    iiifManifestUrl: "https://iiif.zasqua.org/manifests/co-ahr-gob-caj001-car001.json",
    hasDigital: true,
    isPublished: true,
    createdBy: null as string | null,
    updatedBy: null as string | null,
    createdAt: 1700000000,
    updatedAt: 1700000000,
    ...overrides,
  };
}

function makeRepoRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "repo-001",
    code: "co-ahr",
    name: "Archivo Histórico de Rionegro",
    shortName: "AHR",
    countryCode: "COL",
    country: "Colombia",
    city: "Rionegro",
    address: null as string | null,
    website: null as string | null,
    rightsText: null as string | null,
    notes: null as string | null,
    displayTitle: null as string | null,
    subtitle: null as string | null,
    heroImageUrl: null as string | null,
    enabled: true,
    createdAt: 1700000000,
    updatedAt: 1700000000,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// childrenLevel
// ---------------------------------------------------------------------------

const kid = (referenceCode: string, descriptionLevel: string) => ({ referenceCode, descriptionLevel });

describe("childrenLevel", () => {
  it("is null when there are no published children", () => {
    expect(childrenLevel([])).toBeNull();
  });

  it("is the level the children share", () => {
    expect(childrenLevel([kid("x-1", "file"), kid("x-2", "file")])).toBe("file");
    expect(childrenLevel([kid("x-1", "series")])).toBe("series");
  });

  it("is the most common level when the children mix levels", () => {
    expect(childrenLevel([kid("x-1", "item"), kid("x-2", "file"), kid("x-3", "item")])).toBe("item");
  });

  it("breaks a tie by the level hierarchy, the broader level first, whatever the order given", () => {
    expect(childrenLevel([kid("x-1", "item"), kid("x-2", "file")])).toBe("file");
    expect(childrenLevel([kid("x-2", "file"), kid("x-1", "item")])).toBe("file");
    expect(childrenLevel([kid("x-1", "subseries"), kid("x-2", "series")])).toBe("series");
    // Two levels of the same rank: the order of DESCRIPTION_LEVELS decides.
    expect(childrenLevel([kid("x-1", "volume"), kid("x-2", "file")])).toBe("file");
    expect(childrenLevel([kid("x-1", "collection"), kid("x-2", "subfonds")])).toBe("subfonds");
  });

  it("reads nothing from reference codes", () => {
    expect(childrenLevel([kid("co-ahr-gob-caj001", "file"), kid("co-ahr-gob-caj002", "file")])).toBe("file");
    expect(childrenLevel([kid("co-ahrb-not-n1-001", "file")])).toBe("file");
  });
});

describe("formatDescription: children_level", () => {
  it("is null for a description with no published children, whatever its code, level or child count", () => {
    for (const [referenceCode, descriptionLevel, childCount] of [
      ["co-ahr-gob-caj001", "file", 0],
      ["co-ahr-gob-caj001-car001", "file", 3],
      ["co-ahrb-not-n1", "subfonds", 2],
      ["co-ahr-gob", "fonds", 0],
    ] as const) {
      const row = makeDescriptionRow({ referenceCode, descriptionLevel, childCount });
      expect(formatDescription(row, makeRepoRow(), null, []).children_level).toBeNull();
    }
  });

  it("is the level of its published children", () => {
    const row = makeDescriptionRow({ referenceCode: "co-ahr-gob-caj001", childCount: 2 });
    const children = [kid("co-ahr-gob-caj001-car001", "file"), kid("co-ahr-gob-caj001-car002", "file")];
    expect(formatDescription(row, makeRepoRow(), null, children).children_level).toBe("file");
  });
});

describe("formatDescription: child_count", () => {
  it("counts the published children it is given, not the stored child count", () => {
    const row = makeDescriptionRow({ referenceCode: "co-ahrb-aht", descriptionLevel: "fonds", childCount: 134 });
    const children = [kid("co-ahrb-aht-003", "series"), kid("co-ahrb-aht-004", "series")];
    const out = formatDescription(row, makeRepoRow(), null, children);
    expect(out.child_count).toBe(2);
    expect(out.has_children).toBe(true);
  });

  it("has no children when none of its stored children is published", () => {
    const out = formatDescription(makeDescriptionRow({ childCount: 2 }), makeRepoRow(), null, []);
    expect(out.child_count).toBe(0);
    expect(out.has_children).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// publication_title
// ---------------------------------------------------------------------------

describe("formatDescription: publication_title", () => {
  it("exports the stored value", () => {
    const row = makeDescriptionRow({ publicationTitle: "Boletín de Historia" });
    expect(formatDescription(row, makeRepoRow(), null, []).publication_title).toBe("Boletín de Historia");
  });

  it("exports none when none is stored, whatever the repository or series statement", () => {
    const repo = makeRepoRow({ code: "pe-bn", country: "Perú" });
    const item = makeDescriptionRow({ referenceCode: "pe-bn-cdip-t01-v01-001", seriesStatement: "Tomo I, vol. 1" });
    expect(formatDescription(item, repo, null, []).publication_title).toBeNull();
    const blank = makeDescriptionRow({ publicationTitle: "" });
    expect(formatDescription(blank, makeRepoRow(), null, []).publication_title).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// formatDescription
// ---------------------------------------------------------------------------

describe("formatDescription", () => {
  it("maps a complete D1 row to ExportDescription with all fields", () => {
    const row = makeDescriptionRow();
    const repo = makeRepoRow();
    const result = formatDescription(row, repo, null, [], "https://manifests.zasqua.org/mets");

    expect(result.id).toBe("desc-001");
    expect(result.repository_code).toBe("co-ahr");
    expect(result.country).toBe("Colombia");
    expect(result.reference_code).toBe("co-ahr-gob-caj001-car001");
    expect(result.local_identifier).toBe("GOB-001");
    expect(result.title).toBe("Test description");
    expect(result.description_level).toBe("file");
    expect(result.date_expression).toBe("1810");
    expect(result.date_start).toBe("1810-01-01");
    expect(result.parent_id).toBeNull();
    expect(result.parent_reference_code).toBeNull();
    expect(result.has_children).toBe(false);
    expect(result.child_count).toBe(0);
    expect(result.children_level).toBeNull(); // no children
    expect(result.has_digital).toBe(true);
    expect(result.mets_url).toBe(
      "https://manifests.zasqua.org/mets/co-ahr-gob-caj001-car001.xml"
    );
    expect(result.scope_content).toBe("Test scope");
    expect(result.ocr_text).toBe("Test OCR");
    expect(result.creator_display).toBe("Juan de la Cruz");
    expect(result.place_display).toBe("Rionegro");
    expect(result.publication_title).toBeNull();
  });

  it("maps language code to display name", () => {
    const row = makeDescriptionRow({ language: "192" });
    const repo = makeRepoRow();
    const result = formatDescription(row, repo, null, []);
    expect(result.language).toBe("Español");
  });

  it("passes through unknown language codes as-is", () => {
    const row = makeDescriptionRow({ language: "Latin" });
    const repo = makeRepoRow();
    const result = formatDescription(row, repo, null, []);
    expect(result.language).toBe("Latin");
  });

  it("constructs mets_url from the tenant's base, stripping ? and # from the code", () => {
    const row = makeDescriptionRow({ referenceCode: "co-ahr-gob?#test" });
    const repo = makeRepoRow();
    const result = formatDescription(row, repo, null, [], "https://manifests.zasqua.org/mets/");
    expect(result.mets_url).toBe("https://manifests.zasqua.org/mets/co-ahr-gobtest.xml");
  });

  it("exports mets_url as null when the tenant has no METS base", () => {
    const row = makeDescriptionRow();
    const repo = makeRepoRow();
    for (const base of [null, "", "  "]) {
      const result = formatDescription(row, repo, null, [], base);
      expect(result).toHaveProperty("mets_url", null);
    }
    expect(formatDescription(row, repo, null, [])).toHaveProperty("mets_url", null);
  });

  it("gives every description its METS address under the tenant's base, digitised or not", () => {
    const repo = makeRepoRow();
    const base = "https://manifests.zasqua.org/mets";
    for (const digital of [
      { hasDigital: true, iiifManifestUrl: null },
      { hasDigital: false, iiifManifestUrl: "https://iiif.example.org/m.json" },
      { hasDigital: null, iiifManifestUrl: "https://iiif.example.org/m.json" },
      { hasDigital: false, iiifManifestUrl: null },
    ]) {
      const result = formatDescription(makeDescriptionRow(digital), repo, null, [], base);
      expect(result, JSON.stringify(digital)).toHaveProperty(
        "mets_url",
        "https://manifests.zasqua.org/mets/co-ahr-gob-caj001-car001.xml",
      );
    }
  });

  it("sets parent_reference_code when provided", () => {
    const row = makeDescriptionRow({ parentId: "parent-001" });
    const repo = makeRepoRow();
    const result = formatDescription(row, repo, "co-ahr-gob-caj001", []);
    expect(result.parent_reference_code).toBe("co-ahr-gob-caj001");
  });

  it("does not include internalNotes, createdBy, or updatedBy", () => {
    const row = makeDescriptionRow({
      internalNotes: "SECRET",
      createdBy: "user-001",
      updatedBy: "user-002",
    });
    const repo = makeRepoRow();
    const result = formatDescription(row, repo, null, []);
    const keys = Object.keys(result);
    expect(keys).not.toContain("internal_notes");
    expect(keys).not.toContain("internalNotes");
    expect(keys).not.toContain("created_by");
    expect(keys).not.toContain("createdBy");
    expect(keys).not.toContain("updated_by");
    expect(keys).not.toContain("updatedBy");
  });
});

// ---------------------------------------------------------------------------
// isPublished filtering
// ---------------------------------------------------------------------------

describe("isPublished filtering", () => {
  it("excludes descriptions with isPublished=false", () => {
    const published = makeDescriptionRow({ isPublished: true });
    const unpublished = makeDescriptionRow({ isPublished: false });
    const rows = [published, unpublished];
    const filtered = rows.filter((r) => r.isPublished);
    expect(filtered).toHaveLength(1);
    expect(filtered[0]).toBe(published);
  });
});

describe("modified_at (description)", () => {
  const call = (updatedAt: unknown) =>
    formatDescription(makeDescriptionRow({ updatedAt: updatedAt }), makeRepoRow(), null, []);

  it("is the UTC calendar date of updated_at in milliseconds", () => {
    expect(call(1700000000000).modified_at).toBe("2023-11-14");
  });

  it("reads a value below 1e11 as seconds", () => {
    expect(call(1700000000).modified_at).toBe("2023-11-14");
  });

  it("keeps the UTC date just before and at midnight UTC", () => {
    expect(call(1710028799999).modified_at).toBe("2024-03-09");
    expect(call(1710028800000).modified_at).toBe("2024-03-10");
  });

  it("omits the field when updated_at is null or not finite", () => {
    for (const value of [null, undefined, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(call(value)).not.toHaveProperty("modified_at");
    }
  });
});

// @version v0.9.0
