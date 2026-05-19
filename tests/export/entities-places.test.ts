/**
 * Tests — entities + places export formatters
 *
 * This suite pins the parallel pair of helpers that shape the
 * authority-record export payloads: `formatEntity` / `formatPlace`
 * (the field-level transformers) and `filterLinkedEntities` /
 * `filterLinkedPlaces` (the linkage-aware filters that keep only
 * authorities actually referenced by at least one description being
 * exported — orphan authorities are dropped from the public
 * payload).
 *
 * The linkage filter is what makes a partial fonds export feasible:
 * exporting one repository shouldn't drag every entity in the
 * tenant along with it. The filter computes the transitive closure
 * from the description set's link rows and intersects against the
 * authority set; only authorities inside the closure survive.
 *
 * @version v0.4.0
 */
import { describe, it, expect } from "vitest";
import {
  formatEntity,
  filterLinkedEntities,
} from "../../app/lib/export/entities.server";
import {
  formatPlace,
  filterLinkedPlaces,
} from "../../app/lib/export/places.server";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeEntityRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "ent-001",
    entityCode: "ne-000001",
    displayName: "Juan de la Cruz",
    sortName: "Cruz, Juan de la",
    surname: "Cruz",
    givenName: "Juan",
    entityType: "person" as const,
    honorific: "Don",
    primaryFunction: "notary",
    nameVariants: '["Juan Cruz", "J. de la Cruz"]',
    datesOfExistence: "1750-1820",
    dateStart: "1750-01-01",
    dateEnd: "1820-12-31",
    history: "Notable notary of Rionegro.",
    // legal_status dropped in 0036 (0% populated).
    functions: null as string | null,
    sources: "Parish records",
    mergedInto: null as string | null,
    wikidataId: "Q12345",
    viafId: "67890",
    createdAt: 1700000000,
    updatedAt: 1700000000,
    ...overrides,
  };
}

function makePlaceRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "place-001",
    placeCode: "nl-000001",
    label: "Rionegro",
    displayName: "Rionegro, Antioquia",
    placeType: "city" as const,
    nameVariants: '["San Nicolás de Rionegro"]',
    parentId: null as string | null,
    latitude: 6.15,
    longitude: -75.37,
    coordinatePrecision: "exact",
    // historical_*, country_code, admin_level_*, wikidata_id all
    // dropped on places in 0036. fclass added (5-value GeoNames).
    fclass: "P" as "P" | "H" | "A" | "T" | "S" | null,
    needsGeocoding: false,
    mergedInto: null as string | null,
    tgnId: "7005074",
    hgisId: "hgis-001",
    whgId: "whg-001",
    createdAt: 1700000000,
    updatedAt: 1700000000,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// formatEntity
// ---------------------------------------------------------------------------

describe("formatEntity", () => {
  it("maps entityCode to entity_code", () => {
    const result = formatEntity(makeEntityRow());
    expect(result.entity_code).toBe("ne-000001");
  });

  it("maps dateStart to both date_start and date_earliest (legacy alias)", () => {
    const result = formatEntity(makeEntityRow());
    expect(result.date_start).toBe("1750-01-01");
    expect(result.date_earliest).toBe("1750-01-01");
  });

  it("maps dateEnd to both date_end and date_latest (legacy alias)", () => {
    const result = formatEntity(makeEntityRow());
    expect(result.date_end).toBe("1820-12-31");
    expect(result.date_latest).toBe("1820-12-31");
  });

  it("parses nameVariants JSON string into array", () => {
    const result = formatEntity(makeEntityRow());
    expect(result.name_variants).toEqual(["Juan Cruz", "J. de la Cruz"]);
  });

  it("sets particle to null (no D1 column, per research A4)", () => {
    const result = formatEntity(makeEntityRow());
    expect(result.particle).toBeNull();
  });

  it("maps all other fields correctly", () => {
    const result = formatEntity(makeEntityRow());
    expect(result.display_name).toBe("Juan de la Cruz");
    expect(result.sort_name).toBe("Cruz, Juan de la");
    expect(result.given_name).toBe("Juan");
    expect(result.surname).toBe("Cruz");
    expect(result.entity_type).toBe("person");
    expect(result.honorific).toBe("Don");
    expect(result.primary_function).toBe("notary");
    expect(result.dates_of_existence).toBe("1750-1820");
    expect(result.history).toBe("Notable notary of Rionegro.");
    expect(result.sources).toBe("Parish records");
    expect(result.wikidata_id).toBe("Q12345");
    expect(result.viaf_id).toBe("67890");
  });

  it("handles empty nameVariants gracefully", () => {
    const result = formatEntity(makeEntityRow({ nameVariants: null }));
    expect(result.name_variants).toEqual([]);
  });

  it("prefers primaryFunctionCanonical over primaryFunction when both present", () => {
    const result = formatEntity(
      makeEntityRow({
        primaryFunction: "notary",
        primaryFunctionCanonical: "Notario",
      })
    );
    expect(result.primary_function).toBe("Notario");
  });

  it("falls back to primaryFunction when primaryFunctionCanonical is null", () => {
    const result = formatEntity(
      makeEntityRow({
        primaryFunction: "notary",
        primaryFunctionCanonical: null,
      })
    );
    expect(result.primary_function).toBe("notary");
  });

  it("falls back to primaryFunction when primaryFunctionCanonical is undefined (no FK)", () => {
    const result = formatEntity(makeEntityRow({ primaryFunction: "notary" }));
    expect(result.primary_function).toBe("notary");
  });

  it("exports null when both primaryFunction and primaryFunctionCanonical are null", () => {
    const result = formatEntity(
      makeEntityRow({
        primaryFunction: null,
        primaryFunctionCanonical: null,
      })
    );
    expect(result.primary_function).toBeNull();
  });

  it("exports canonical even for deprecated vocabulary terms", () => {
    // Deprecated terms retain their canonical value — the status field is
    // separate from the canonical string, so export still resolves correctly.
    const result = formatEntity(
      makeEntityRow({
        primaryFunction: "old-text",
        primaryFunctionCanonical: "Escribano",
      })
    );
    expect(result.primary_function).toBe("Escribano");
  });
});

// ---------------------------------------------------------------------------
// filterLinkedEntities
// ---------------------------------------------------------------------------

describe("filterLinkedEntities", () => {
  it("only includes entities linked to at least one published description", () => {
    const entities = [
      makeEntityRow({ id: "ent-001" }),
      makeEntityRow({ id: "ent-002" }),
      makeEntityRow({ id: "ent-003" }),
    ];
    const linkedIds = new Set(["ent-001", "ent-003"]);
    const result = filterLinkedEntities(entities, linkedIds);
    expect(result).toHaveLength(2);
    expect(result.map((e) => e.id)).toEqual(["ent-001", "ent-003"]);
  });

  it("returns empty array when no entities are linked", () => {
    const entities = [makeEntityRow({ id: "ent-001" })];
    const result = filterLinkedEntities(entities, new Set());
    expect(result).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// formatPlace
// ---------------------------------------------------------------------------

describe("formatPlace", () => {
  it("maps label to label", () => {
    const result = formatPlace(makePlaceRow());
    expect(result.label).toBe("Rionegro");
  });

  it("maps placeType to place_type and fclass to fclass", () => {
    // fclass is sourced from the dedicated column added in
    // drizzle/0036 (5-value GeoNames feature class) rather than
    // aliased from placeType.
    const result = formatPlace(makePlaceRow());
    expect(result.place_type).toBe("city");
    expect(result.fclass).toBe("P");
  });

  it("emits null for the dropped historical_* fields (0036)", () => {
    const result = formatPlace(makePlaceRow());
    // historical_gobernacion, historical_partido, historical_region,
    // country_code, admin_level_*, wikidata_id all dropped from the
    // places table; the formatter preserves the public-export shape
    // by emitting null for snapshot continuity.
    expect(result.historical_gobernacion).toBeNull();
    expect(result.historical_partido).toBeNull();
    expect(result.historical_region).toBeNull();
    expect(result.country_code).toBeNull();
    expect(result.admin_level_1).toBeNull();
    expect(result.admin_level_2).toBeNull();
    expect(result.wikidata_id).toBeNull();
  });

  it("parses nameVariants JSON string into array", () => {
    const result = formatPlace(makePlaceRow());
    expect(result.name_variants).toEqual(["San Nicolás de Rionegro"]);
  });

  it("handles null nameVariants gracefully", () => {
    const result = formatPlace(makePlaceRow({ nameVariants: null }));
    expect(result.name_variants).toEqual([]);
  });

  it("maps coordinate and LOD fields that survived 0036", () => {
    const result = formatPlace(makePlaceRow());
    expect(result.latitude).toBe(6.15);
    expect(result.longitude).toBe(-75.37);
    expect(result.coordinate_precision).toBe("exact");
    expect(result.place_code).toBe("nl-000001");
    expect(result.tgn_id).toBe("7005074");
    expect(result.hgis_id).toBe("hgis-001");
    expect(result.whg_id).toBe("whg-001");
  });
});

// ---------------------------------------------------------------------------
// filterLinkedPlaces
// ---------------------------------------------------------------------------

describe("filterLinkedPlaces", () => {
  it("only includes places linked to at least one published description", () => {
    const places = [
      makePlaceRow({ id: "place-001" }),
      makePlaceRow({ id: "place-002" }),
    ];
    const linkedIds = new Set(["place-002"]);
    const result = filterLinkedPlaces(places, linkedIds);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("place-002");
  });

  it("returns empty array when no places are linked", () => {
    const places = [makePlaceRow({ id: "place-001" })];
    const result = filterLinkedPlaces(places, new Set());
    expect(result).toHaveLength(0);
  });
});
