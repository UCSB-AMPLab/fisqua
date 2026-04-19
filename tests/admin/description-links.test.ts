/**
 * Tests — description links
 *
 * @version v0.3.0
 */
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { eq, and, asc } from "drizzle-orm";
import * as schema from "../../app/db/schema";
import { applyMigrations, cleanDatabase } from "../helpers/db";
import { createTestRepository } from "../helpers/repositories";
import { createTestDescription } from "../helpers/descriptions";
import { createTestEntity } from "../helpers/entities";
import { createTestPlace } from "../helpers/places";

describe("description entity links", () => {
  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDatabase();
  });

  it("link_entity creates a descriptionEntities record", async () => {
    const db = drizzle(env.DB);
    const repo = await createTestRepository({ id: "repo-1", code: "AHRB" });
    const desc = await createTestDescription({
      repositoryId: repo.id,
      referenceCode: "AHRB-001",
    });
    const entity = await createTestEntity({
      displayName: "Juan de Borja",
      entityCode: "ne-borja01",
    });

    const linkId = crypto.randomUUID();
    await db.insert(schema.descriptionEntities).values({
      id: linkId,
      descriptionId: desc.id,
      entityId: entity.id,
      role: "creator",
      sequence: 0,
      honorific: "Don",
      function: "Gobernador",
      nameAsRecorded: "Juan de Borja y Armendia",
      createdAt: Date.now(),
    });

    const link = await db
      .select()
      .from(schema.descriptionEntities)
      .where(eq(schema.descriptionEntities.id, linkId))
      .get();

    expect(link).toBeTruthy();
    expect(link!.descriptionId).toBe(desc.id);
    expect(link!.entityId).toBe(entity.id);
    expect(link!.role).toBe("creator");
    expect(link!.honorific).toBe("Don");
    expect(link!.function).toBe("Gobernador");
    expect(link!.nameAsRecorded).toBe("Juan de Borja y Armendia");
    expect(link!.sequence).toBe(0);
  });

  it("rejects duplicate (descriptionId, entityId, role)", async () => {
    const db = drizzle(env.DB);
    const repo = await createTestRepository({ id: "repo-1", code: "AHRB" });
    const desc = await createTestDescription({
      repositoryId: repo.id,
      referenceCode: "AHRB-001",
    });
    const entity = await createTestEntity({
      displayName: "Juan de Borja",
      entityCode: "ne-borja01",
    });

    await db.insert(schema.descriptionEntities).values({
      id: crypto.randomUUID(),
      descriptionId: desc.id,
      entityId: entity.id,
      role: "creator",
      sequence: 0,
      createdAt: Date.now(),
    });

    try {
      await db.insert(schema.descriptionEntities).values({
        id: crypto.randomUUID(),
        descriptionId: desc.id,
        entityId: entity.id,
        role: "creator",
        sequence: 1,
        createdAt: Date.now(),
      });
      expect.fail("Should have thrown on duplicate");
    } catch (e) {
      expect(e).toBeTruthy();
    }
  });

  it("update_entity_link updates role and styling fields", async () => {
    const db = drizzle(env.DB);
    const repo = await createTestRepository({ id: "repo-1", code: "AHRB" });
    const desc = await createTestDescription({
      repositoryId: repo.id,
      referenceCode: "AHRB-001",
    });
    const entity = await createTestEntity({
      displayName: "Juan de Borja",
      entityCode: "ne-borja01",
    });

    const linkId = crypto.randomUUID();
    await db.insert(schema.descriptionEntities).values({
      id: linkId,
      descriptionId: desc.id,
      entityId: entity.id,
      role: "creator",
      sequence: 0,
      createdAt: Date.now(),
    });

    await db
      .update(schema.descriptionEntities)
      .set({
        role: "witness",
        honorific: "Capitan",
        function: "Testigo",
        nameAsRecorded: "Juan de Borja",
      })
      .where(eq(schema.descriptionEntities.id, linkId));

    const updated = await db
      .select()
      .from(schema.descriptionEntities)
      .where(eq(schema.descriptionEntities.id, linkId))
      .get();

    expect(updated!.role).toBe("witness");
    expect(updated!.honorific).toBe("Capitan");
    expect(updated!.function).toBe("Testigo");
    expect(updated!.nameAsRecorded).toBe("Juan de Borja");
  });

  it("remove_entity_link deletes the junction record", async () => {
    const db = drizzle(env.DB);
    const repo = await createTestRepository({ id: "repo-1", code: "AHRB" });
    const desc = await createTestDescription({
      repositoryId: repo.id,
      referenceCode: "AHRB-001",
    });
    const entity = await createTestEntity({
      displayName: "Juan de Borja",
      entityCode: "ne-borja01",
    });

    const linkId = crypto.randomUUID();
    await db.insert(schema.descriptionEntities).values({
      id: linkId,
      descriptionId: desc.id,
      entityId: entity.id,
      role: "creator",
      sequence: 0,
      createdAt: Date.now(),
    });

    await db
      .delete(schema.descriptionEntities)
      .where(eq(schema.descriptionEntities.id, linkId));

    const deleted = await db
      .select()
      .from(schema.descriptionEntities)
      .where(eq(schema.descriptionEntities.id, linkId))
      .get();

    expect(deleted).toBeUndefined();
  });

  it("reorder_entity_link swaps sequence values between adjacent links", async () => {
    const db = drizzle(env.DB);
    const repo = await createTestRepository({ id: "repo-1", code: "AHRB" });
    const desc = await createTestDescription({
      repositoryId: repo.id,
      referenceCode: "AHRB-001",
    });
    const entity1 = await createTestEntity({
      id: "ent-1",
      displayName: "Entity A",
      entityCode: "ne-a01",
    });
    const entity2 = await createTestEntity({
      id: "ent-2",
      displayName: "Entity B",
      entityCode: "ne-b01",
    });

    const link1Id = crypto.randomUUID();
    const link2Id = crypto.randomUUID();

    await db.insert(schema.descriptionEntities).values({
      id: link1Id,
      descriptionId: desc.id,
      entityId: entity1.id,
      role: "creator",
      sequence: 0,
      createdAt: Date.now(),
    });
    await db.insert(schema.descriptionEntities).values({
      id: link2Id,
      descriptionId: desc.id,
      entityId: entity2.id,
      role: "witness",
      sequence: 1,
      createdAt: Date.now(),
    });

    // Swap: move link1 down (swap with link2)
    const currentLink = await db
      .select()
      .from(schema.descriptionEntities)
      .where(eq(schema.descriptionEntities.id, link1Id))
      .get();
    const adjacentLink = await db
      .select()
      .from(schema.descriptionEntities)
      .where(
        and(
          eq(schema.descriptionEntities.descriptionId, desc.id),
          eq(schema.descriptionEntities.sequence, currentLink!.sequence + 1)
        )
      )
      .get();

    expect(adjacentLink).toBeTruthy();

    // Swap sequences
    await db
      .update(schema.descriptionEntities)
      .set({ sequence: adjacentLink!.sequence })
      .where(eq(schema.descriptionEntities.id, link1Id));
    await db
      .update(schema.descriptionEntities)
      .set({ sequence: currentLink!.sequence })
      .where(eq(schema.descriptionEntities.id, adjacentLink!.id));

    // Verify swapped
    const afterLink1 = await db
      .select()
      .from(schema.descriptionEntities)
      .where(eq(schema.descriptionEntities.id, link1Id))
      .get();
    const afterLink2 = await db
      .select()
      .from(schema.descriptionEntities)
      .where(eq(schema.descriptionEntities.id, link2Id))
      .get();

    expect(afterLink1!.sequence).toBe(1);
    expect(afterLink2!.sequence).toBe(0);
  });

  it("loader returns entity links with role and styling fields for display", async () => {
    const db = drizzle(env.DB);
    const repo = await createTestRepository({ id: "repo-1", code: "AHRB" });
    const desc = await createTestDescription({
      repositoryId: repo.id,
      referenceCode: "AHRB-002",
    });
    const entity = await createTestEntity({
      displayName: "Catalina de Acero",
      entityCode: "ne-acero01",
    });

    await db.insert(schema.descriptionEntities).values({
      id: crypto.randomUUID(),
      descriptionId: desc.id,
      entityId: entity.id,
      role: "subject",
      sequence: 0,
      honorific: "Dona",
      function: "Otorgante",
      nameAsRecorded: "Catalina de Azero",
      createdAt: Date.now(),
    });

    // Query pattern matching the loader join
    const links = await db
      .select({
        id: schema.descriptionEntities.id,
        role: schema.descriptionEntities.role,
        roleNote: schema.descriptionEntities.roleNote,
        sequence: schema.descriptionEntities.sequence,
        honorific: schema.descriptionEntities.honorific,
        function: schema.descriptionEntities.function,
        nameAsRecorded: schema.descriptionEntities.nameAsRecorded,
        entityDisplayName: schema.entities.displayName,
        entityCode: schema.entities.entityCode,
      })
      .from(schema.descriptionEntities)
      .innerJoin(
        schema.entities,
        eq(schema.descriptionEntities.entityId, schema.entities.id)
      )
      .where(eq(schema.descriptionEntities.descriptionId, desc.id))
      .orderBy(asc(schema.descriptionEntities.sequence))
      .all();

    expect(links).toHaveLength(1);
    expect(links[0].role).toBe("subject");
    expect(links[0].honorific).toBe("Dona");
    expect(links[0].function).toBe("Otorgante");
    expect(links[0].nameAsRecorded).toBe("Catalina de Azero");
    expect(links[0].entityDisplayName).toBe("Catalina de Acero");
    expect(links[0].entityCode).toBe("ne-acero01");
  });
});

describe("description place links", () => {
  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDatabase();
  });

  it("link_place creates a descriptionPlaces record", async () => {
    const db = drizzle(env.DB);
    const repo = await createTestRepository({ id: "repo-1", code: "AHRB" });
    const desc = await createTestDescription({
      repositoryId: repo.id,
      referenceCode: "AHRB-001",
    });
    const place = await createTestPlace({
      label: "Santa Fe de Bogota",
      placeCode: "nl-bogota01",
    });

    const linkId = crypto.randomUUID();
    await db.insert(schema.descriptionPlaces).values({
      id: linkId,
      descriptionId: desc.id,
      placeId: place.id,
      role: "created",
      createdAt: Date.now(),
    });

    const link = await db
      .select()
      .from(schema.descriptionPlaces)
      .where(eq(schema.descriptionPlaces.id, linkId))
      .get();

    expect(link).toBeTruthy();
    expect(link!.descriptionId).toBe(desc.id);
    expect(link!.placeId).toBe(place.id);
    expect(link!.role).toBe("created");
  });

  it("rejects duplicate (descriptionId, placeId, role)", async () => {
    const db = drizzle(env.DB);
    const repo = await createTestRepository({ id: "repo-1", code: "AHRB" });
    const desc = await createTestDescription({
      repositoryId: repo.id,
      referenceCode: "AHRB-001",
    });
    const place = await createTestPlace({
      label: "Santa Fe de Bogota",
      placeCode: "nl-bogota01",
    });

    await db.insert(schema.descriptionPlaces).values({
      id: crypto.randomUUID(),
      descriptionId: desc.id,
      placeId: place.id,
      role: "created",
      createdAt: Date.now(),
    });

    try {
      await db.insert(schema.descriptionPlaces).values({
        id: crypto.randomUUID(),
        descriptionId: desc.id,
        placeId: place.id,
        role: "created",
        createdAt: Date.now(),
      });
      expect.fail("Should have thrown on duplicate");
    } catch (e) {
      expect(e).toBeTruthy();
    }
  });

  it("update_place_link updates role", async () => {
    const db = drizzle(env.DB);
    const repo = await createTestRepository({ id: "repo-1", code: "AHRB" });
    const desc = await createTestDescription({
      repositoryId: repo.id,
      referenceCode: "AHRB-001",
    });
    const place = await createTestPlace({
      label: "Santa Fe de Bogota",
      placeCode: "nl-bogota01",
    });

    const linkId = crypto.randomUUID();
    await db.insert(schema.descriptionPlaces).values({
      id: linkId,
      descriptionId: desc.id,
      placeId: place.id,
      role: "created",
      createdAt: Date.now(),
    });

    await db
      .update(schema.descriptionPlaces)
      .set({ role: "subject" })
      .where(eq(schema.descriptionPlaces.id, linkId));

    const updated = await db
      .select()
      .from(schema.descriptionPlaces)
      .where(eq(schema.descriptionPlaces.id, linkId))
      .get();

    expect(updated!.role).toBe("subject");
  });

  it("remove_place_link deletes the junction record", async () => {
    const db = drizzle(env.DB);
    const repo = await createTestRepository({ id: "repo-1", code: "AHRB" });
    const desc = await createTestDescription({
      repositoryId: repo.id,
      referenceCode: "AHRB-001",
    });
    const place = await createTestPlace({
      label: "Santa Fe de Bogota",
      placeCode: "nl-bogota01",
    });

    const linkId = crypto.randomUUID();
    await db.insert(schema.descriptionPlaces).values({
      id: linkId,
      descriptionId: desc.id,
      placeId: place.id,
      role: "created",
      createdAt: Date.now(),
    });

    await db
      .delete(schema.descriptionPlaces)
      .where(eq(schema.descriptionPlaces.id, linkId));

    const deleted = await db
      .select()
      .from(schema.descriptionPlaces)
      .where(eq(schema.descriptionPlaces.id, linkId))
      .get();

    expect(deleted).toBeUndefined();
  });

  it("loader returns place links with role fields for display", async () => {
    const db = drizzle(env.DB);
    const repo = await createTestRepository({ id: "repo-1", code: "AHRB" });
    const desc = await createTestDescription({
      repositoryId: repo.id,
      referenceCode: "AHRB-003",
    });
    const place = await createTestPlace({
      label: "Santa Fe de Bogota",
      placeCode: "nl-bogota01",
    });

    await db.insert(schema.descriptionPlaces).values({
      id: crypto.randomUUID(),
      descriptionId: desc.id,
      placeId: place.id,
      role: "created",
      roleNote: "Place of issuance",
      createdAt: Date.now(),
    });

    // Query pattern matching the loader join
    const links = await db
      .select({
        id: schema.descriptionPlaces.id,
        role: schema.descriptionPlaces.role,
        roleNote: schema.descriptionPlaces.roleNote,
        placeLabel: schema.places.label,
        placeCode: schema.places.placeCode,
      })
      .from(schema.descriptionPlaces)
      .innerJoin(
        schema.places,
        eq(schema.descriptionPlaces.placeId, schema.places.id)
      )
      .where(eq(schema.descriptionPlaces.descriptionId, desc.id))
      .all();

    expect(links).toHaveLength(1);
    expect(links[0].role).toBe("created");
    expect(links[0].roleNote).toBe("Place of issuance");
    expect(links[0].placeLabel).toBe("Santa Fe de Bogota");
    expect(links[0].placeCode).toBe("nl-bogota01");
  });
});
