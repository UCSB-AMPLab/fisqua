/**
 * Tests — project settings
 *
 * @version v0.3.0
 */
import { describe, test, expect } from "vitest";
import {
  readProjectSettings,
  writeProjectSettings,
  getDocumentSubtypes,
  setDocumentSubtypes,
} from "../../app/lib/project-settings";
import { DEFAULT_DOCUMENT_SUBTYPES } from "../../app/_data/document-subtypes";

describe("readProjectSettings()", () => {
  test("null returns empty object", () => {
    expect(readProjectSettings(null)).toEqual({});
  });
  test("undefined returns empty object", () => {
    expect(readProjectSettings(undefined)).toEqual({});
  });
  test("empty / whitespace string returns empty object", () => {
    expect(readProjectSettings("")).toEqual({});
    expect(readProjectSettings("   ")).toEqual({});
  });
  test("malformed JSON returns empty object (does not throw)", () => {
    expect(readProjectSettings("{not json")).toEqual({});
  });
  test("JSON array returns empty object (not a valid settings shape)", () => {
    expect(readProjectSettings("[1, 2, 3]")).toEqual({});
  });
  test("JSON null returns empty object", () => {
    expect(readProjectSettings("null")).toEqual({});
  });
  test("valid object passes through", () => {
    expect(readProjectSettings('{"documentSubtypes":["Escritura"]}')).toEqual({
      documentSubtypes: ["Escritura"],
    });
  });
});

describe("getDocumentSubtypes() fallback", () => {
  test("null falls back to DEFAULT_DOCUMENT_SUBTYPES", () => {
    expect(getDocumentSubtypes(null)).toEqual([...DEFAULT_DOCUMENT_SUBTYPES]);
  });
  test("missing key falls back to DEFAULT_DOCUMENT_SUBTYPES", () => {
    expect(getDocumentSubtypes("{}")).toEqual([...DEFAULT_DOCUMENT_SUBTYPES]);
  });
  test("empty array falls back to DEFAULT_DOCUMENT_SUBTYPES", () => {
    expect(getDocumentSubtypes('{"documentSubtypes":[]}')).toEqual([
      ...DEFAULT_DOCUMENT_SUBTYPES,
    ]);
  });
  test("customised list wins over seed", () => {
    expect(
      getDocumentSubtypes('{"documentSubtypes":["Escritura","Poder"]}'),
    ).toEqual(["Escritura", "Poder"]);
  });
  test("cleans whitespace and drops empty strings", () => {
    expect(
      getDocumentSubtypes(
        '{"documentSubtypes":["  Escritura  ", "", "Poder"]}',
      ),
    ).toEqual(["Escritura", "Poder"]);
  });
  test("all-whitespace list falls back to seed", () => {
    expect(
      getDocumentSubtypes('{"documentSubtypes":[" ", "  "]}'),
    ).toEqual([...DEFAULT_DOCUMENT_SUBTYPES]);
  });
  test("non-string entries are filtered out", () => {
    expect(
      getDocumentSubtypes(
        '{"documentSubtypes":["Escritura", 42, null, "Poder"]}',
      ),
    ).toEqual(["Escritura", "Poder"]);
  });
});

describe("writeProjectSettings()", () => {
  test("empty object serialises to null (not '{}')", () => {
    expect(writeProjectSettings({})).toBeNull();
  });
  test("empty documentSubtypes array drops the key and returns null", () => {
    expect(writeProjectSettings({ documentSubtypes: [] })).toBeNull();
  });
  test("non-empty list serialises with the key preserved", () => {
    expect(writeProjectSettings({ documentSubtypes: ["Escritura"] })).toBe(
      '{"documentSubtypes":["Escritura"]}',
    );
  });
});

describe("setDocumentSubtypes()", () => {
  test("adds subtypes list to a null blob", () => {
    expect(setDocumentSubtypes(null, ["Escritura", "Poder"])).toBe(
      '{"documentSubtypes":["Escritura","Poder"]}',
    );
  });
  test("clearing the list drops the key and returns null", () => {
    expect(
      setDocumentSubtypes('{"documentSubtypes":["Escritura"]}', []),
    ).toBeNull();
  });
  test("trims whitespace and drops empty entries", () => {
    expect(setDocumentSubtypes(null, ["  Escritura  ", "", "Poder"])).toBe(
      '{"documentSubtypes":["Escritura","Poder"]}',
    );
  });
  test("round-trip preserves the list verbatim", () => {
    const raw = setDocumentSubtypes(null, ["Escritura", "Poder"]);
    expect(getDocumentSubtypes(raw)).toEqual(["Escritura", "Poder"]);
  });
});

describe("DEFAULT_DOCUMENT_SUBTYPES seed", () => {
  test("seed is non-empty and all-Spanish", () => {
    expect(DEFAULT_DOCUMENT_SUBTYPES.length).toBeGreaterThan(0);
    // Sanity check a few known Spanish entries.
    expect(DEFAULT_DOCUMENT_SUBTYPES).toContain("Escritura");
    expect(DEFAULT_DOCUMENT_SUBTYPES).toContain("Testamento");
  });
});
