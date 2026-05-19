/**
 * Tests — import helpers
 *
 * This module deals with the shared fixtures the import tests consume:
 * per-table sample-row
 * factories that produce Django-shaped records with realistic
 * defaults, a 7-row adjacency tree generator, and the
 * `DOMAIN_TABLES` re-export that keeps the runtime cross-tenant
 * fixture (`tests/import/clear-isolation.test.ts`) in lock-step
 * with the meta-grep keystone
 * (`tests/db/cross-tenant-coverage.test.ts`).
 *
 * Why factories instead of static fixtures? Row-builder tests need
 * "a record with these two fields overridden, everything else
 * realistic"; static JSON fixtures force every test to ship a full
 * Django-shaped object even when only one field matters. The
 * factories return plain objects so callers can spread overrides
 * freely:
 *
 *     makeDescriptionRecord({ id: 99, ca_object_id: 100 })
 *
 * `make7RowAdjacencyTree()` returns the same shape as the JSON
 * fixture at `tests/import/fixtures/adjacency/descriptions.json` —
 * unit tests that don't want to touch the disk can call the factory
 * instead. The two stay in lock-step by construction (the JSON file
 * is a serialised snapshot of what this factory returns) so future
 * tests are free to choose either form. The shape is exactly the
 * 3-level tree (1 fonds, 2 series, 4 files) so adjacency-rebuild
 * assertions are deterministic.
 *
 * The re-export of `DOMAIN_TABLES` mirrors the keystone in
 * `tests/db/cross-tenant-coverage.test.ts` byte-for-byte. If the
 * schema gains a sixth tenanted table, the keystone is updated
 * first; this re-export follows in the same commit.
 *
 * @version v0.4.0
 */

import { NEOGRANADINA_TENANT_ID } from "../../app/lib/tenant";

/**
 * The five tenanted domain tables — the same set the cross-tenant
 * keystone enforces. The clear-isolation test uses this constant as
 * the canonical iteration target so a future tenanted table can't
 * be added in one place and forgotten in the other.
 */
export const DOMAIN_TABLES = [
  "users",
  "repositories",
  "descriptions",
  "entities",
  "places",
] as const;

/**
 * Locked test tenant id for default fixtures — equal to the seeded
 * `neogranadina` row. Mirrors the `DEFAULT_TEST_TENANT_ID` export
 * from `tests/helpers/db.ts` byte-for-byte. Re-defined here (rather
 * than re-exported) because `tests/helpers/db.ts` imports
 * `cloudflare:test`, which is only available under the workers
 * vitest pool — `tests/import/**` runs under the Node pool
 * (`vitest.import.config.ts`) and would crash at module load if it
 * pulled in the workers-only helper.
 */
export const DEFAULT_TEST_TENANT_ID: string = NEOGRANADINA_TENANT_ID;

/**
 * Second tenant id used by cross-tenant negative tests. Mirrors
 * `tests/helpers/db.ts:SECOND_TEST_TENANT_ID` byte-for-byte. The
 * SQL-shape contract in `tests/import/clear-isolation.test.ts`
 * names it directly; a runtime D1 round-trip seeds both tenants
 * and asserts the SECOND tenant's rows survive the clear.
 */
export const SECOND_TEST_TENANT_ID =
  "22222222-2222-4222-8222-222222222222" as const;

let descriptionAutoId = 100_000;
let entityAutoId = 200_000;
let placeAutoId = 300_000;

/**
 * Factory: a Django-shaped description record.
 *
 * Auto-increments the Django pk so two callers in the same test get
 * distinct rows without coordination. Spread `overrides` to set or
 * clear any field; pass `id` explicitly to lock the pk for an
 * assertion.
 */
export function makeDescriptionRecord(
  overrides: Partial<Record<string, unknown>> = {}
): Record<string, unknown> {
  const id = overrides.id ?? descriptionAutoId++;
  return {
    id,
    ca_object_id: null,
    ca_collection_id: null,
    parent_id: null,
    title: "Test description",
    reference_code: `co-test-${String(id).padStart(2, "0")}`,
    local_identifier: `co-test-${String(id).padStart(2, "0")}`,
    description_level: "item",
    language: "es",
    is_published: 1,
    has_digital: 0,
    date_start: null,
    date_end: null,
    iiif_manifest_url: null,
    created_at: "2023-06-15T14:30:00Z",
    updated_at: "2023-06-15T14:30:00Z",
    ...overrides,
  };
}

/**
 * Factory: a Django-shaped entity record.
 */
export function makeEntityRecord(
  overrides: Partial<Record<string, unknown>> = {}
): Record<string, unknown> {
  const id = overrides.id ?? entityAutoId++;
  return {
    id,
    ca_entity_id: null,
    dbe_id: null,
    display_name: `Entity ${id}`,
    sort_name: `Entity ${id}`,
    entity_type: "person",
    date_start: null,
    date_end: null,
    history: null,
    created_at: "2023-06-15T14:30:00Z",
    updated_at: "2023-06-15T14:30:00Z",
    ...overrides,
  };
}

/**
 * Factory: a Django-shaped place record.
 */
export function makePlaceRecord(
  overrides: Partial<Record<string, unknown>> = {}
): Record<string, unknown> {
  const id = overrides.id ?? placeAutoId++;
  return {
    id,
    ca_place_ids: null,
    label: `Place ${id}`,
    display_name: `Place ${id}`,
    place_type: "city",
    fclass: "P",
    latitude: null,
    longitude: null,
    created_at: "2023-06-15T14:30:00Z",
    updated_at: "2023-06-15T14:30:00Z",
    ...overrides,
  };
}

/**
 * Factory: the 7-row 3-level adjacency tree from
 * `36-VALIDATION.md`. One fonds (id=1), two series under it (ids 2
 * and 3), two files under each series (ids 4-5 and 6-7). The shape
 * matches `tests/import/fixtures/adjacency/descriptions.json`
 * byte-for-byte.
 */
export function make7RowAdjacencyTree(): Record<string, unknown>[] {
  const base = {
    language: "es",
    is_published: 1,
    has_digital: 0,
    created_at: "2023-06-15T14:30:00Z",
    updated_at: "2023-06-15T14:30:00Z",
  };
  return [
    {
      id: 1,
      parent_id: null,
      local_identifier: "co-test",
      title: "Fonds",
      reference_code: "co-test",
      description_level: "fonds",
      ...base,
    },
    {
      id: 2,
      parent_id: 1,
      local_identifier: "co-test-01",
      title: "Series A",
      reference_code: "co-test-01",
      description_level: "series",
      ...base,
    },
    {
      id: 3,
      parent_id: 1,
      local_identifier: "co-test-02",
      title: "Series B",
      reference_code: "co-test-02",
      description_level: "series",
      ...base,
    },
    {
      id: 4,
      parent_id: 2,
      local_identifier: "co-test-01-001",
      title: "File 4",
      reference_code: "co-test-01-001",
      description_level: "file",
      ...base,
    },
    {
      id: 5,
      parent_id: 2,
      local_identifier: "co-test-01-002",
      title: "File 5",
      reference_code: "co-test-01-002",
      description_level: "file",
      ...base,
    },
    {
      id: 6,
      parent_id: 3,
      local_identifier: "co-test-02-001",
      title: "File 6",
      reference_code: "co-test-02-001",
      description_level: "file",
      ...base,
    },
    {
      id: 7,
      parent_id: 3,
      local_identifier: "co-test-02-002",
      title: "File 7",
      reference_code: "co-test-02-002",
      description_level: "file",
      ...base,
    },
  ];
}

// Version: v0.4.0
