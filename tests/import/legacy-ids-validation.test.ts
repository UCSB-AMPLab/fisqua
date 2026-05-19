/**
 * Tests — legacy-ids validation
 *
 * This suite is the round-trip test for the three `buildLegacyIds*`
 * helpers in `scripts/lib/transform.ts`. The helpers are the import-side
 * write boundary for the `legacy_ids` JSON column on descriptions,
 * entities, and places. Every helper validates its output through
 * `LegacyIdsSchema.parse(...)` before stringify so malformed
 * legacy_ids cannot be produced — that's the mitigation for the
 * tampering threat on the legacy_ids write boundary.
 *
 * The locked provider strings are:
 *
 *   - `django-zasqua` (every Django row carries the original integer pk)
 *   - `ca-object`     (CollectiveAccess object id, descriptions only)
 *   - `ca-collection` (CollectiveAccess collection id, descriptions only)
 *   - `ca-entity`     (CollectiveAccess entity id, entities only)
 *   - `ca-place`      (CollectiveAccess place id, places only — note
 *                      that Django's `ca_place_ids` is a JSON array, so
 *                      one Fisqua place can carry multiple `ca-place`
 *                      provenance entries from a CA→Fisqua merge)
 *
 * This file follows the lazy-import pattern from
 * `tests/import/description-import.test.ts:24-48` so the helpers
 * resolve at test-time rather than at module load.
 *
 * @version v0.4.0
 */
import { describe, it, expect } from "vitest";
import { LegacyIdsSchema } from "../../app/lib/validation/legacy-ids";

describe("buildLegacyIdsForDescription", () => {
  it("emits django-zasqua + ca-object + ca-collection when all three IDs are present", async () => {
    const { buildLegacyIdsForDescription } = await import(
      "../../scripts/lib/transform"
    );
    const value = buildLegacyIdsForDescription({
      id: 42,
      ca_object_id: 100,
      ca_collection_id: 7,
    });
    const parsed = JSON.parse(value);
    expect(parsed).toEqual([
      { provider: "django-zasqua", id: 42 },
      { provider: "ca-object", id: 100 },
      { provider: "ca-collection", id: 7 },
    ]);
    // round-trip through the schema must not throw
    expect(() => LegacyIdsSchema.parse(parsed)).not.toThrow();
  });

  it("emits only django-zasqua when CA fields are null/undefined", async () => {
    const { buildLegacyIdsForDescription } = await import(
      "../../scripts/lib/transform"
    );
    const value = buildLegacyIdsForDescription({
      id: 42,
      ca_object_id: null,
      ca_collection_id: undefined,
    });
    const parsed = JSON.parse(value);
    expect(parsed).toEqual([{ provider: "django-zasqua", id: 42 }]);
    expect(() => LegacyIdsSchema.parse(parsed)).not.toThrow();
  });
});

describe("buildLegacyIdsForEntity", () => {
  it("emits django-zasqua + ca-entity when both IDs are present", async () => {
    const { buildLegacyIdsForEntity } = await import(
      "../../scripts/lib/transform"
    );
    const value = buildLegacyIdsForEntity({ id: 5, ca_entity_id: 99 });
    const parsed = JSON.parse(value);
    expect(parsed).toEqual([
      { provider: "django-zasqua", id: 5 },
      { provider: "ca-entity", id: 99 },
    ]);
    expect(() => LegacyIdsSchema.parse(parsed)).not.toThrow();
  });
});

describe("buildLegacyIdsForPlace", () => {
  it("emits one ca-place entry per element of ca_place_ids", async () => {
    const { buildLegacyIdsForPlace } = await import(
      "../../scripts/lib/transform"
    );
    const value = buildLegacyIdsForPlace({
      id: 11,
      ca_place_ids: [200, 201],
    });
    const parsed = JSON.parse(value);
    expect(parsed).toEqual([
      { provider: "django-zasqua", id: 11 },
      { provider: "ca-place", id: 200 },
      { provider: "ca-place", id: 201 },
    ]);
    expect(() => LegacyIdsSchema.parse(parsed)).not.toThrow();
  });

  it("emits only django-zasqua when ca_place_ids is null", async () => {
    const { buildLegacyIdsForPlace } = await import(
      "../../scripts/lib/transform"
    );
    const value = buildLegacyIdsForPlace({ id: 11, ca_place_ids: null });
    const parsed = JSON.parse(value);
    expect(parsed).toEqual([{ provider: "django-zasqua", id: 11 }]);
    expect(() => LegacyIdsSchema.parse(parsed)).not.toThrow();
  });
});

describe("buildLegacyIds* — round-trip safety", () => {
  it("every produced value parses cleanly through LegacyIdsSchema", async () => {
    const {
      buildLegacyIdsForDescription,
      buildLegacyIdsForEntity,
      buildLegacyIdsForPlace,
    } = await import("../../scripts/lib/transform");
    const samples = [
      buildLegacyIdsForDescription({
        id: 1,
        ca_object_id: 2,
        ca_collection_id: 3,
      }),
      buildLegacyIdsForEntity({ id: 4, ca_entity_id: 5 }),
      buildLegacyIdsForPlace({ id: 6, ca_place_ids: [7, 8, 9] }),
      buildLegacyIdsForDescription({
        id: 10,
        ca_object_id: null,
        ca_collection_id: null,
      }),
      buildLegacyIdsForEntity({ id: 11, ca_entity_id: null }),
      buildLegacyIdsForPlace({ id: 12, ca_place_ids: null }),
    ];
    for (const value of samples) {
      const parsed = JSON.parse(value);
      expect(() => LegacyIdsSchema.parse(parsed)).not.toThrow();
    }
  });
});

// Version: v0.4.0
