/**
 * Tests — descriptions
 *
 * @version v0.3.0
 */
import { describe, it, expect } from "vitest";
import {
  childrenLevel,
  publicationTitle,
  formatDescription,
} from "../../app/lib/export/descriptions.server";
import { formatRepositories } from "../../app/lib/export/repositories.server";
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
    relatedMaterials: null as string | null,
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
    enabled: true,
    createdAt: 1700000000,
    updatedAt: 1700000000,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// childrenLevel
// ---------------------------------------------------------------------------

describe("childrenLevel", () => {
  it("returns 'carpeta' for ref codes ending in -caj\\d+", () => {
    expect(childrenLevel("co-ahr-gob-caj001", "fonds", [])).toBe("carpeta");
  });

  it("returns 'item' for ref codes ending in -car\\d+", () => {
    expect(childrenLevel("co-ahr-gob-caj001-car001", "file", [])).toBe("item");
  });

  it("returns 'item' for ref codes ending in -leg\\d+", () => {
    expect(childrenLevel("co-ahjci-mfc-leg001", "file", [])).toBe("item");
  });

  it("returns 'item' for ref codes ending in -tom\\d+", () => {
    expect(childrenLevel("co-ahr-gob-tom001", "file", [])).toBe("item");
  });

  it("returns 'item' for ref codes ending in -t\\d+", () => {
    expect(childrenLevel("co-ahr-gob-t01", "file", [])).toBe("item");
  });

  it("returns 'item' for ref codes ending in -aht-\\d+", () => {
    expect(childrenLevel("co-ahrb-aht-001", "file", [])).toBe("item");
  });

  it("returns 'item' for ref codes ending in -cab-\\d+", () => {
    expect(childrenLevel("co-ahrb-cab-001", "file", [])).toBe("item");
  });

  it("returns 'caja' when fonds children are all -caj refs", () => {
    const childRefs = ["co-ahr-gob-caj001", "co-ahr-gob-caj002"];
    expect(childrenLevel("co-ahr-gob", "fonds", childRefs)).toBe("caja");
  });

  it("returns 'tomo' when fonds children are all -tom refs", () => {
    const childRefs = ["co-ahr-gob-tom001", "co-ahr-gob-tom002"];
    expect(childrenLevel("co-ahr-gob", "fonds", childRefs)).toBe("tomo");
  });

  it("returns 'tomo' when fonds children are -t0 refs", () => {
    const childRefs = ["co-ahr-gob-t01", "co-ahr-gob-t02"];
    expect(childrenLevel("co-ahr-gob", "fonds", childRefs)).toBe("tomo");
  });

  it("returns null when fonds children are mixed types", () => {
    const childRefs = ["co-ahr-gob-caj001", "co-ahr-gob-tom001"];
    expect(childrenLevel("co-ahr-gob", "fonds", childRefs)).toBeNull();
  });

  it("returns LEVEL_HIERARCHY fallback for series", () => {
    expect(childrenLevel(null, "series", [])).toBe("subseries");
  });

  it("returns LEVEL_HIERARCHY fallback for file", () => {
    expect(childrenLevel(null, "file", [])).toBe("item");
  });

  it("returns null for unknown level with no ref code match", () => {
    expect(childrenLevel(null, "unknown-level", [])).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// publicationTitle
// ---------------------------------------------------------------------------

describe("publicationTitle", () => {
  it("returns CDIP title for pe-bn repo with series_statement", () => {
    expect(publicationTitle("pe-bn-cdip-001", "pe-bn")).toBe(
      "Colección Documental de la Independencia del Perú"
    );
  });

  it("returns null for non-pe-bn repo", () => {
    expect(publicationTitle("co-ahr-gob-caj001", "co-ahr")).toBeNull();
  });

  it("returns null for pe-bn repo without cdip in ref code", () => {
    expect(publicationTitle("pe-bn-other-001", "pe-bn")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// formatDescription
// ---------------------------------------------------------------------------

describe("formatDescription", () => {
  it("maps a complete D1 row to ExportDescription with all fields", () => {
    const row = makeDescriptionRow();
    const repo = makeRepoRow();
    const result = formatDescription(row, repo, null, []);

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
    expect(result.children_level).toBe("item"); // -car\d+ match
    expect(result.has_digital).toBe(true);
    expect(result.mets_url).toBe(
      "https://mets.zasqua.org/co-ahr-gob-caj001-car001.xml"
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

  it("constructs mets_url from reference code stripping ? and #", () => {
    const row = makeDescriptionRow({ referenceCode: "co-ahr-gob?#test" });
    const repo = makeRepoRow();
    const result = formatDescription(row, repo, null, []);
    expect(result.mets_url).toBe("https://mets.zasqua.org/co-ahr-gobtest.xml");
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

// ---------------------------------------------------------------------------
// formatRepositories
// ---------------------------------------------------------------------------

describe("formatRepositories", () => {
  it("nests root_descriptions and computes description_count", () => {
    const repo = makeRepoRow({
      rightsText: "Reproduction by permission only.",
    });

    const rootDesc: ExportDescription = {
      id: "desc-root",
      repository_code: "co-ahr",
      country: "Colombia",
      reference_code: "co-ahr-gob",
      local_identifier: "GOB",
      title: "Gobernación",
      description_level: "fonds",
      date_expression: null,
      date_start: null,
      parent_id: null,
      parent_reference_code: null,
      has_children: true,
      child_count: 5,
      children_level: "caja",
      has_digital: false,
      iiif_manifest_url: "",
      mets_url: "https://mets.zasqua.org/co-ahr-gob.xml",
      scope_content: null,
      ocr_text: "some text",
      extent: null,
      arrangement: null,
      access_conditions: null,
      reproduction_conditions: null,
      language: null,
      location_of_originals: null,
      location_of_copies: null,
      related_materials: null,
      finding_aids: null,
      notes: null,
      publication_title: null,
      imprint: null,
      edition_statement: null,
      series_statement: null,
      uniform_title: null,
      section_title: null,
      pages: null,
      creator_display: null,
      place_display: null,
    };

    const childDesc: ExportDescription = {
      ...rootDesc,
      id: "desc-child",
      reference_code: "co-ahr-gob-caj001",
      parent_id: "desc-root",
      parent_reference_code: "co-ahr-gob",
      description_level: "file",
      has_children: false,
      child_count: 0,
    };

    // 23-06: counts come from a precomputed map; only the (small) root set
    // is passed in as already-formatted descriptions.
    const counts = new Map<string, number>([["co-ahr", 2]]);
    void childDesc;
    const result = formatRepositories([repo], counts, [rootDesc]);

    expect(result).toHaveLength(1);
    expect(result[0].code).toBe("co-ahr");
    expect(result[0].description_count).toBe(2);
    expect(result[0].root_descriptions).toHaveLength(1);
    expect(result[0].root_descriptions[0].reference_code).toBe("co-ahr-gob");
    // root_descriptions should not contain ocr_text
    expect("ocr_text" in result[0].root_descriptions[0]).toBe(false);
    expect(result[0].image_reproduction_text).toBe(
      "Reproduction by permission only."
    );
  });

  it("handles repositories with no descriptions", () => {
    const repo = makeRepoRow({ code: "empty-repo" });
    const result = formatRepositories([repo], new Map(), []);

    expect(result).toHaveLength(1);
    expect(result[0].description_count).toBe(0);
    expect(result[0].root_descriptions).toHaveLength(0);
  });
});
