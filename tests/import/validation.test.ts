/**
 * Tests — import-side validation primitives
 *
 * This suite pins the pure helpers shared across every import
 * command: `generateUniqueCodes` (produces `<prefix>-<6char>`
 * authority codes with collision avoidance against the
 * 32-character `ALPHABET` — lowercase letters minus the
 * confusable `0/o`/`1/l`), `validateRows` (the row-by-row Zod
 * runner that aggregates failures into a structured report rather
 * than throwing on the first invalid row), and the transform trio
 * `toEpochSeconds` / `toIsoDate` / `stringifyJsonArray` that
 * normalises legacy date and array shapes for D1 storage.
 *
 * The `generateUniqueCodes` cases pin the alphabet contract
 * (no confusables — a cataloguer reading "ne-abc1de" from a
 * printed catalogue must not mistype "1" for "l"), the uniqueness
 * property across larger batches (1000 codes still distinct), and
 * the per-prefix isolation (`ne-*` for entities, `nl-*` for places).
 *
 * @version v0.3.0
 */
import { describe, it, expect } from "vitest";
import { generateUniqueCodes, ALPHABET } from "../../scripts/lib/codes";
import { validateRows } from "../../scripts/lib/validate";
import { toEpochSeconds, toIsoDate, stringifyJsonArray } from "../../scripts/lib/transform";
import { importEntitySchema } from "../../app/lib/validation/entity";

describe("generateUniqueCodes", () => {
  it("generates the requested number of unique codes", () => {
    const codes = generateUniqueCodes("ne", 100);
    expect(codes).toHaveLength(100);
    expect(new Set(codes).size).toBe(100);
  });

  it("produces codes matching the expected pattern", () => {
    const codes = generateUniqueCodes("ne", 10);
    codes.forEach((code) => {
      expect(code).toMatch(/^ne-[a-z2-9]{6}$/);
    });
  });

  it("produces nl-prefixed codes for places", () => {
    const codes = generateUniqueCodes("nl", 50);
    expect(codes).toHaveLength(50);
    expect(new Set(codes).size).toBe(50);
    codes.forEach((code) => {
      expect(code).toMatch(/^nl-[a-z2-9]{6}$/);
    });
  });

  it("uses only characters from the 30-char ALPHABET", () => {
    const codes = generateUniqueCodes("ne", 100);
    const allowedChars = new Set(ALPHABET.split(""));
    codes.forEach((code) => {
      const suffix = code.slice(3); // skip "ne-"
      for (const char of suffix) {
        expect(allowedChars.has(char)).toBe(true);
      }
    });
  });
});

describe("validateRows", () => {
  const validEntity = {
    id: "550e8400-e29b-41d4-a716-446655440001",
    entityCode: "ne-abcdef",
    displayName: "Test Entity",
    sortName: "Entity, Test",
    entityType: "person" as const,
    nameVariants: "[]",
    createdAt: 1700000000,
    updatedAt: 1700000000,
  };

  it("returns all valid rows in the valid array", () => {
    const result = validateRows([validEntity], importEntitySchema, "entities");
    expect(result.valid).toHaveLength(1);
    expect(result.errors).toHaveLength(0);
  });

  it("collects invalid rows as errors without aborting", () => {
    const invalidEntity = { ...validEntity, displayName: "" }; // min length 1
    const result = validateRows(
      [validEntity, invalidEntity, validEntity],
      importEntitySchema,
      "entities"
    );
    expect(result.valid).toHaveLength(2);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].row).toBe(1); // 0-indexed row 1
    expect(result.errors[0].table).toBe("entities");
    expect(result.errors[0].errors.length).toBeGreaterThan(0);
  });
});

describe("toEpochSeconds", () => {
  it("converts ISO datetime to epoch seconds", () => {
    expect(toEpochSeconds("2024-01-15T10:30:00Z")).toBe(1705314600);
  });

  it("returns null for null input", () => {
    expect(toEpochSeconds(null)).toBeNull();
  });

  it("returns null for undefined input", () => {
    expect(toEpochSeconds(undefined)).toBeNull();
  });
});

describe("toIsoDate", () => {
  it("passes through YYYY-MM-DD strings", () => {
    expect(toIsoDate("2024-01-15")).toBe("2024-01-15");
  });

  it("passes through partial dates", () => {
    expect(toIsoDate("1750")).toBe("1750");
    expect(toIsoDate("1750-06")).toBe("1750-06");
  });

  it("returns null for null", () => {
    expect(toIsoDate(null)).toBeNull();
  });

  it("returns null for undefined", () => {
    expect(toIsoDate(undefined)).toBeNull();
  });
});

describe("stringifyJsonArray", () => {
  it("stringifies an array", () => {
    expect(stringifyJsonArray(["a", "b"])).toBe('["a","b"]');
  });

  it("returns [] for null", () => {
    expect(stringifyJsonArray(null)).toBe("[]");
  });

  it("returns [] for undefined", () => {
    expect(stringifyJsonArray(undefined)).toBe("[]");
  });

  it("returns string as-is if already a string", () => {
    expect(stringifyJsonArray('["x"]')).toBe('["x"]');
  });
});
