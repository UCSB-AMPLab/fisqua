/**
 * Tests — two-tenant federation fixture
 *
 * This helper seeds the two-tenant federation the export tests read
 * across: `neogranadina` (the lead, DEFAULT_TEST_TENANT_ID) owns the
 * `co-ahrb` repository and the `co-ahrb-gob` fonds; `ahr` (a member of
 * the same federation) owns the `co-ahr` repository and the `co-ahr-gob`
 * fonds. Each fonds has one published child. A federation-scoped entity
 * and a place are linked only to the AHR fonds, so a read that spans
 * the federation sees them and a lead-only read does not.
 *
 * The federation export aggregation suite and the publish pre-flight
 * counts suite use it. Call it after `cleanDatabase()`, which re-seeds
 * the standard tenants and the federation but not the `ahr` tenant.
 *
 * @version v0.9.0
 */
import { drizzle } from "drizzle-orm/d1";
import * as schema from "../../app/db/schema";
import { DEFAULT_TEST_TENANT_ID, DEFAULT_TEST_FEDERATION_ID } from "./db";
import { AHR_TENANT_ID } from "../../app/lib/tenant";

export type Db = ReturnType<typeof drizzle>;

// Stable ids so leak/presence assertions read cleanly.
export const NEO_FONDS_ID = "aaaaaaaa-0001-4001-8001-000000000001";
export const NEO_CHILD_ID = "aaaaaaaa-0001-4001-8001-000000000002";
export const AHR_FONDS_ID = "bbbbbbbb-0001-4001-8001-000000000001";
export const AHR_CHILD_ID = "bbbbbbbb-0001-4001-8001-000000000002";
export const AHR_ONLY_ENTITY_ID = "cccccccc-0001-4001-8001-000000000001";
export const AHR_ONLY_PLACE_ID = "dddddddd-0001-4001-8001-000000000001";

/**
 * Seed a two-tenant federation: lead (neogranadina, co-ahrb) + member
 * (ahr, co-ahr) in the SAME federation. An entity + place link ONLY to
 * the AHR (member) fonds so the authority fan-out is testable.
 */
export async function seedFederationFixture(db: Db) {
  const now = Date.now();

  // Member tenant `ahr` in the Neogranadina federation (the step-6
  // partition target). cleanDatabase() re-seeds only the standard
  // fixtures, so ahr is inserted per-test here.
  await db.insert(schema.tenants).values({
    id: AHR_TENANT_ID,
    slug: "ahr",
    name: "Archivo Histórico de Rionegro",
    kind: "tenant",
    descriptiveStandard: "isadg",
    status: "active",
    crowdsourcingEnabled: false,
    vocabularyHubEnabled: true,
    publishPipelineEnabled: true,
    multiRepositoryEnabled: false,
    federationId: DEFAULT_TEST_FEDERATION_ID,
    createdAt: now,
    updatedAt: now,
  });

  const neoRepoId = crypto.randomUUID();
  const ahrRepoId = crypto.randomUUID();
  await db.insert(schema.repositories).values([
    {
      id: neoRepoId,
      tenantId: DEFAULT_TEST_TENANT_ID,
      code: "co-ahrb",
      name: "Archivo Histórico de la Diócesis",
      country: "Colombia",
      enabled: true,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: ahrRepoId,
      tenantId: AHR_TENANT_ID,
      code: "co-ahr",
      name: "Archivo Histórico de Rionegro",
      country: "Colombia",
      enabled: true,
      createdAt: now,
      updatedAt: now,
    },
  ]);

  // Lead fonds (co-ahrb-gob) + one published child.
  await db.insert(schema.descriptions).values([
    {
      id: NEO_FONDS_ID,
      tenantId: DEFAULT_TEST_TENANT_ID,
      repositoryId: neoRepoId,
      parentId: null,
      rootDescriptionId: NEO_FONDS_ID,
      descriptionLevel: "fonds",
      referenceCode: "co-ahrb-gob",
      localIdentifier: "AHRB-001",
      title: "Gobierno (AHRB)",
      isPublished: true,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: NEO_CHILD_ID,
      tenantId: DEFAULT_TEST_TENANT_ID,
      repositoryId: neoRepoId,
      parentId: NEO_FONDS_ID,
      rootDescriptionId: NEO_FONDS_ID,
      descriptionLevel: "series",
      referenceCode: "co-ahrb-gob-s1",
      localIdentifier: "AHRB-001-s1",
      title: "Serie AHRB",
      isPublished: true,
      createdAt: now,
      updatedAt: now,
    },
  ]);

  // Member (AHR) fonds (co-ahr-gob) + one published child.
  await db.insert(schema.descriptions).values([
    {
      id: AHR_FONDS_ID,
      tenantId: AHR_TENANT_ID,
      repositoryId: ahrRepoId,
      parentId: null,
      rootDescriptionId: AHR_FONDS_ID,
      descriptionLevel: "fonds",
      referenceCode: "co-ahr-gob",
      localIdentifier: "AHR-001",
      title: "Gobierno (AHR)",
      isPublished: true,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: AHR_CHILD_ID,
      tenantId: AHR_TENANT_ID,
      repositoryId: ahrRepoId,
      parentId: AHR_FONDS_ID,
      rootDescriptionId: AHR_FONDS_ID,
      descriptionLevel: "series",
      referenceCode: "co-ahr-gob-s1",
      localIdentifier: "AHR-001-s1",
      title: "Serie AHR",
      isPublished: true,
      createdAt: now,
      updatedAt: now,
    },
  ]);

  // Federation-scoped entity + place, each linked ONLY to the AHR fonds.
  // A lead-only export never sees them; a federation export must.
  await db.insert(schema.entities).values({
    id: AHR_ONLY_ENTITY_ID,
    federationId: DEFAULT_TEST_FEDERATION_ID,
    entityCode: "ne-ahr-001",
    displayName: "Alcalde de Rionegro",
    sortName: "Alcalde de Rionegro",
    entityType: "person",
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(schema.descriptionEntities).values({
    id: crypto.randomUUID(),
    descriptionId: AHR_FONDS_ID,
    entityId: AHR_ONLY_ENTITY_ID,
    role: "subject",
    createdAt: now,
  });

  await db.insert(schema.places).values({
    id: AHR_ONLY_PLACE_ID,
    federationId: DEFAULT_TEST_FEDERATION_ID,
    placeCode: "pl-ahr-001",
    label: "Rionegro",
    displayName: "Rionegro, Antioquia",
    placeType: "city",
    fclass: "P",
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(schema.descriptionPlaces).values({
    id: crypto.randomUUID(),
    descriptionId: AHR_FONDS_ID,
    placeId: AHR_ONLY_PLACE_ID,
    role: "subject",
    createdAt: now,
  });
}
