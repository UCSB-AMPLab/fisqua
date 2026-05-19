/**
 * Tests — import-schema validation wrapper
 *
 * This suite exercises the two helpers added to `scripts/lib/validate.ts`:
 *
 *   - `validateRowAgainstImportSchemas(record, table)` — wraps
 *     `importDescriptionSchema` (for descriptions) plus light
 *     NOT-NULL sanity checks for the other three tenanted tables.
 *     The base schema is intentionally permissive — per-standard
 *     mandatoriness (`descriptionValidatorFor`) is NOT applied at
 *     the import boundary, because the bulk import absorbs corpus
 *     data that pre-dates the per-standard validators.
 *
 *   - `validateLegacyIdsValue(jsonString)` — round-trips a serialised
 *     `legacy_ids` value through `LegacyIdsSchema`. Every row builder's
 *     emitted `legacy_ids` JSON is expected to round-trip cleanly; a
 *     malformed value is surfaced as a structured failure list rather
 *     than a thrown exception so the orchestrator can aggregate it
 *     into the FailureReport.
 *
 * The lazy-import pattern matches `tests/import/legacy-ids-validation.test.ts`
 * so the helpers resolve at test-time rather than at module load.
 *
 * @version v0.4.0
 */
import { describe, it, expect } from "vitest";

describe("validateRowAgainstImportSchemas — descriptions", () => {
  it("returns ok=true for a valid description record", async () => {
    const { validateRowAgainstImportSchemas } = await import(
      "../../scripts/lib/validate"
    );
    const now = Math.floor(Date.now() / 1000);
    const record = {
      id: "11111111-1111-4111-8111-111111111111",
      repositoryId: "22222222-2222-4222-8222-222222222222",
      descriptionLevel: "fonds",
      referenceCode: "AHRB-001",
      title: "Test fonds",
      createdAt: now,
      updatedAt: now,
    };
    const result = validateRowAgainstImportSchemas(record, "descriptions");
    expect(result.ok).toBe(true);
    expect(result.messages).toEqual([]);
  });

  it("returns ok=false with field-path messages when a required field is missing", async () => {
    const { validateRowAgainstImportSchemas } = await import(
      "../../scripts/lib/validate"
    );
    const record = {
      // missing id, repositoryId, descriptionLevel, referenceCode, title,
      // createdAt, updatedAt — every one of these should fault.
    };
    const result = validateRowAgainstImportSchemas(record, "descriptions");
    expect(result.ok).toBe(false);
    expect(result.messages.length).toBeGreaterThan(0);
    // Each message includes a colon-separated path: <field>: <issue>.
    for (const message of result.messages) {
      expect(message).toMatch(/.+: .+/);
    }
  });
});

describe("validateRowAgainstImportSchemas — non-description tables", () => {
  it("flags entities missing display_name", async () => {
    const { validateRowAgainstImportSchemas } = await import(
      "../../scripts/lib/validate"
    );
    const result = validateRowAgainstImportSchemas(
      { display_name: null },
      "entities",
    );
    expect(result.ok).toBe(false);
    expect(result.messages).toEqual(["display_name: required"]);
  });

  it("flags places missing label", async () => {
    const { validateRowAgainstImportSchemas } = await import(
      "../../scripts/lib/validate"
    );
    const result = validateRowAgainstImportSchemas({}, "places");
    expect(result.ok).toBe(false);
    expect(result.messages).toEqual(["label: required"]);
  });

  it("flags repositories missing code", async () => {
    const { validateRowAgainstImportSchemas } = await import(
      "../../scripts/lib/validate"
    );
    const result = validateRowAgainstImportSchemas(
      { code: undefined },
      "repositories",
    );
    expect(result.ok).toBe(false);
    expect(result.messages).toEqual(["code: required"]);
  });

  it("returns ok=true when the sanity check passes", async () => {
    const { validateRowAgainstImportSchemas } = await import(
      "../../scripts/lib/validate"
    );
    const result = validateRowAgainstImportSchemas(
      { display_name: "Persona Uno" },
      "entities",
    );
    expect(result.ok).toBe(true);
    expect(result.messages).toEqual([]);
  });
});

describe("validateLegacyIdsValue", () => {
  it("returns ok=true for a well-formed legacy_ids JSON string", async () => {
    const { validateLegacyIdsValue } = await import(
      "../../scripts/lib/validate"
    );
    const value = JSON.stringify([
      { provider: "django-zasqua", id: 42 },
      { provider: "ca-object", id: 100 },
    ]);
    const result = validateLegacyIdsValue(value);
    expect(result.ok).toBe(true);
    expect(result.messages).toEqual([]);
  });

  it("returns ok=false with a parser message when the JSON is malformed", async () => {
    const { validateLegacyIdsValue } = await import(
      "../../scripts/lib/validate"
    );
    const result = validateLegacyIdsValue("{not json");
    expect(result.ok).toBe(false);
    expect(result.messages.length).toBe(1);
    expect(result.messages[0]).toMatch(/^legacy_ids: not valid JSON/);
  });

  it("returns ok=false with schema-path messages when the JSON is well-formed but the shape is wrong", async () => {
    const { validateLegacyIdsValue } = await import(
      "../../scripts/lib/validate"
    );
    // provider must be a non-empty string; an empty string fails the schema.
    const value = JSON.stringify([{ provider: "", id: 1 }]);
    const result = validateLegacyIdsValue(value);
    expect(result.ok).toBe(false);
    expect(result.messages.length).toBeGreaterThan(0);
    for (const message of result.messages) {
      expect(message).toMatch(/^legacy_ids\..+: .+/);
    }
  });
});

// Version: v0.4.0
