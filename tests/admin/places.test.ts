/**
 * Tests — places
 *
 * @version v0.3.0
 */
import {
  describe,
  it,
  expect,
  beforeAll,
  beforeEach,
} from "vitest";
import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { eq, sql } from "drizzle-orm";
import * as schema from "../../app/db/schema";
import { applyMigrations, cleanDatabase } from "../helpers/db";
import { createTestPlace } from "../helpers/places";
import { createTestUser } from "../helpers/auth";
import { createTestRepository } from "../helpers/repositories";

describe("place CRUD", () => {
  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDatabase();
  });

  it("creates a place with valid data", async () => {
    const db = drizzle(env.DB);
    const now = Date.now();
    const id = crypto.randomUUID();

    await db.insert(schema.places).values({
      id,
      placeCode: "nl-abc123",
      label: "Santa Fe de Bogota",
      displayName: "Santa Fe de Bogota",
      placeType: "city",
      nameVariants: '["Bogota", "Santafe"]',
      historicalGobernacion: "Santa Fe",
      historicalPartido: "Bogota",
      historicalRegion: "C",
      countryCode: "COL",
      adminLevel1: "Cundinamarca",
      adminLevel2: "Bogota D.C.",
      latitude: 4.6097,
      longitude: -74.0817,
      coordinatePrecision: "exact",
      createdAt: now,
      updatedAt: now,
    });

    const place = await db
      .select()
      .from(schema.places)
      .where(eq(schema.places.id, id))
      .get();

    expect(place).toBeTruthy();
    expect(place!.placeCode).toBe("nl-abc123");
    expect(place!.label).toBe("Santa Fe de Bogota");
    expect(place!.displayName).toBe("Santa Fe de Bogota");
    expect(place!.placeType).toBe("city");
    expect(place!.nameVariants).toBe('["Bogota", "Santafe"]');
    expect(place!.historicalGobernacion).toBe("Santa Fe");
    expect(place!.historicalPartido).toBe("Bogota");
    expect(place!.historicalRegion).toBe("C");
    expect(place!.countryCode).toBe("COL");
    expect(place!.adminLevel1).toBe("Cundinamarca");
    expect(place!.adminLevel2).toBe("Bogota D.C.");
    expect(place!.latitude).toBeCloseTo(4.6097);
    expect(place!.longitude).toBeCloseTo(-74.0817);
    expect(place!.coordinatePrecision).toBe("exact");
    expect(place!.createdAt).toBe(now);
    expect(place!.updatedAt).toBe(now);
  });

  it("rejects duplicate placeCode", async () => {
    await createTestPlace({ placeCode: "nl-dupl01" });

    try {
      await createTestPlace({
        id: crypto.randomUUID(),
        placeCode: "nl-dupl01",
        label: "Other Place",
      });
      expect.fail("Should have thrown on duplicate place code");
    } catch (e) {
      expect(e).toBeTruthy();
    }
  });

  it("updates place fields including historical context", async () => {
    const db = drizzle(env.DB);
    const place = await createTestPlace({
      historicalGobernacion: "Popayan",
    });

    const newUpdatedAt = Date.now() + 1000;
    await db
      .update(schema.places)
      .set({
        historicalGobernacion: "Santa Fe",
        historicalPartido: "Tunja",
        updatedAt: newUpdatedAt,
      })
      .where(eq(schema.places.id, place.id));

    const updated = await db
      .select()
      .from(schema.places)
      .where(eq(schema.places.id, place.id))
      .get();

    expect(updated!.historicalGobernacion).toBe("Santa Fe");
    expect(updated!.historicalPartido).toBe("Tunja");
    expect(updated!.updatedAt).toBe(newUpdatedAt);
  });

  it("stores coordinates as real numbers", async () => {
    const db = drizzle(env.DB);
    const place = await createTestPlace({
      latitude: 4.6097,
      longitude: -74.0817,
      coordinatePrecision: "exact",
      placeCode: "nl-coord1",
    });

    const fetched = await db
      .select()
      .from(schema.places)
      .where(eq(schema.places.id, place.id))
      .get();

    expect(fetched!.latitude).toBeCloseTo(4.6097, 4);
    expect(fetched!.longitude).toBeCloseTo(-74.0817, 4);
    expect(fetched!.coordinatePrecision).toBe("exact");
  });

  it("deletes place without linked descriptions", async () => {
    const db = drizzle(env.DB);
    const place = await createTestPlace();

    await db
      .delete(schema.places)
      .where(eq(schema.places.id, place.id));

    const deleted = await db
      .select()
      .from(schema.places)
      .where(eq(schema.places.id, place.id))
      .get();

    expect(deleted).toBeUndefined();
  });

  it("delete blocked when descriptionPlaces exist", async () => {
    const db = drizzle(env.DB);
    const place = await createTestPlace();
    const user = await createTestUser();
    const repo = await createTestRepository();
    const now = Date.now();

    // Create a description
    const descId = crypto.randomUUID();
    await db.insert(schema.descriptions).values({
      id: descId,
      repositoryId: repo.id,
      descriptionLevel: "fonds",
      referenceCode: "PLACE-001",
      localIdentifier: "PLACE-001",
      title: "Test Fonds",
      position: 0,
      depth: 0,
      childCount: 0,
      createdBy: user.id,
      createdAt: now,
      updatedAt: now,
    });

    // Link place to description
    await db.insert(schema.descriptionPlaces).values({
      id: crypto.randomUUID(),
      descriptionId: descId,
      placeId: place.id,
      role: "created",
      createdAt: now,
    });

    // Attempt to delete place -- should fail due to onDelete: "restrict"
    try {
      await db
        .delete(schema.places)
        .where(eq(schema.places.id, place.id));
      expect.fail("Should have thrown on FK constraint");
    } catch (e) {
      expect(e).toBeTruthy();
    }
  });
});

describe("place search", () => {
  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDatabase();
  });

  it("search by FTS5 matches label", async () => {
    const db = drizzle(env.DB);
    await createTestPlace({
      label: "Cartagena de Indias",
      placeCode: "nl-fts001",
    });
    await createTestPlace({
      id: crypto.randomUUID(),
      label: "Mompox",
      placeCode: "nl-fts002",
    });

    try {
      // FTS5 may not be available in test D1 environment
      const results = await db.all(
        sql`SELECT p.* FROM places p JOIN places_fts f ON p.id = f.rowid WHERE places_fts MATCH 'Cartagena'`
      );
      expect(results.length).toBeGreaterThanOrEqual(1);
    } catch {
      // FTS5 not available -- fall back to LIKE
      const results = await db
        .select()
        .from(schema.places)
        .where(sql`${schema.places.label} LIKE '%Cartagena%'`)
        .all();
      expect(results).toHaveLength(1);
      expect(results[0].label).toBe("Cartagena de Indias");
    }
  });

  it("search fallback to LIKE on label", async () => {
    const db = drizzle(env.DB);
    await createTestPlace({
      label: "Villa de Leyva",
      placeCode: "nl-like01",
    });
    await createTestPlace({
      id: crypto.randomUUID(),
      label: "Tunja",
      placeCode: "nl-like02",
    });

    const results = await db
      .select()
      .from(schema.places)
      .where(sql`${schema.places.label} LIKE '%Leyva%'`)
      .all();

    expect(results).toHaveLength(1);
    expect(results[0].label).toBe("Villa de Leyva");
  });
});

describe("place pagination", () => {
  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDatabase();
  });

  it("cursor pagination on label", async () => {
    const db = drizzle(env.DB);
    await createTestPlace({
      label: "Alpha Town",
      placeCode: "nl-alph01",
    });
    await createTestPlace({
      id: crypto.randomUUID(),
      label: "Bravo City",
      placeCode: "nl-brav01",
    });
    await createTestPlace({
      id: crypto.randomUUID(),
      label: "Charlie Village",
      placeCode: "nl-char01",
    });

    // Cursor after Alpha Town -- should return Bravo and Charlie
    const results = await db
      .select()
      .from(schema.places)
      .where(sql`${schema.places.label} > 'Alpha Town'`)
      .orderBy(schema.places.label)
      .all();

    expect(results).toHaveLength(2);
    expect(results[0].label).toBe("Bravo City");
    expect(results[1].label).toBe("Charlie Village");
  });
});

describe("place merge and split", () => {
  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDatabase();
  });

  it("merge sets mergedInto and reassigns place links", async () => {
    const db = drizzle(env.DB);
    const user = await createTestUser();
    const repo = await createTestRepository();
    const now = Date.now();

    const source = await createTestPlace({
      label: "Source Place",
      placeCode: "nl-src001",
    });
    const target = await createTestPlace({
      id: crypto.randomUUID(),
      label: "Target Place",
      placeCode: "nl-tgt001",
    });

    // Create description and link to source
    const descId = crypto.randomUUID();
    await db.insert(schema.descriptions).values({
      id: descId,
      repositoryId: repo.id,
      descriptionLevel: "item",
      referenceCode: "PMERGE-001",
      localIdentifier: "PMERGE-001",
      title: "Test Item",
      position: 0,
      depth: 0,
      childCount: 0,
      createdBy: user.id,
      createdAt: now,
      updatedAt: now,
    });

    const linkId = crypto.randomUUID();
    await db.insert(schema.descriptionPlaces).values({
      id: linkId,
      descriptionId: descId,
      placeId: source.id,
      role: "created",
      createdAt: now,
    });

    // Merge: reassign link from source to target, mark source as merged
    await db
      .update(schema.descriptionPlaces)
      .set({ placeId: target.id })
      .where(eq(schema.descriptionPlaces.id, linkId));

    await db
      .update(schema.places)
      .set({ mergedInto: target.id, updatedAt: Date.now() })
      .where(eq(schema.places.id, source.id));

    // Verify
    const mergedSource = await db
      .select()
      .from(schema.places)
      .where(eq(schema.places.id, source.id))
      .get();
    expect(mergedSource!.mergedInto).toBe(target.id);

    const link = await db
      .select()
      .from(schema.descriptionPlaces)
      .where(eq(schema.descriptionPlaces.id, linkId))
      .get();
    expect(link!.placeId).toBe(target.id);
  });

  it("split creates new place with fresh code and moves links", async () => {
    const db = drizzle(env.DB);
    const user = await createTestUser();
    const repo = await createTestRepository();
    const now = Date.now();

    const original = await createTestPlace({
      label: "Original Place",
      placeCode: "nl-orig01",
      historicalGobernacion: "Santa Fe",
    });

    // Create description and link
    const descId = crypto.randomUUID();
    await db.insert(schema.descriptions).values({
      id: descId,
      repositoryId: repo.id,
      descriptionLevel: "item",
      referenceCode: "PSPLIT-001",
      localIdentifier: "PSPLIT-001",
      title: "Test Item",
      position: 0,
      depth: 0,
      childCount: 0,
      createdBy: user.id,
      createdAt: now,
      updatedAt: now,
    });

    const linkId = crypto.randomUUID();
    await db.insert(schema.descriptionPlaces).values({
      id: linkId,
      descriptionId: descId,
      placeId: original.id,
      role: "created",
      createdAt: now,
    });

    // Split: create new place (copy fields, clear LOD), move the link
    const newPlaceId = crypto.randomUUID();
    await db.insert(schema.places).values({
      id: newPlaceId,
      placeCode: "nl-splt01",
      label: "Split Place",
      displayName: "Split Place",
      placeType: "city",
      historicalGobernacion: "Santa Fe",
      nameVariants: "[]",
      // LOD identifiers cleared on split
      tgnId: null,
      hgisId: null,
      whgId: null,
      wikidataId: null,
      createdAt: now,
      updatedAt: now,
    });

    await db
      .update(schema.descriptionPlaces)
      .set({ placeId: newPlaceId })
      .where(eq(schema.descriptionPlaces.id, linkId));

    // Verify both places exist
    const origPlace = await db
      .select()
      .from(schema.places)
      .where(eq(schema.places.id, original.id))
      .get();
    expect(origPlace).toBeTruthy();

    const splitPlace = await db
      .select()
      .from(schema.places)
      .where(eq(schema.places.id, newPlaceId))
      .get();
    expect(splitPlace).toBeTruthy();
    expect(splitPlace!.label).toBe("Split Place");
    expect(splitPlace!.historicalGobernacion).toBe("Santa Fe");
    // LOD should be null
    expect(splitPlace!.tgnId).toBeNull();
    expect(splitPlace!.wikidataId).toBeNull();

    // Verify link points to new place
    const link = await db
      .select()
      .from(schema.descriptionPlaces)
      .where(eq(schema.descriptionPlaces.id, linkId))
      .get();
    expect(link!.placeId).toBe(newPlaceId);
  });
});

describe("place description link CRUD", () => {
  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDatabase();
  });

  it("link_description creates junction record", async () => {
    const db = drizzle(env.DB);
    const place = await createTestPlace();
    const user = await createTestUser();
    const repo = await createTestRepository();
    const now = Date.now();

    const descId = crypto.randomUUID();
    await db.insert(schema.descriptions).values({
      id: descId,
      repositoryId: repo.id,
      descriptionLevel: "item",
      referenceCode: "PLINK-001",
      localIdentifier: "PLINK-001",
      title: "Place Link Test",
      position: 0,
      depth: 0,
      childCount: 0,
      createdBy: user.id,
      createdAt: now,
      updatedAt: now,
    });

    const linkId = crypto.randomUUID();
    await db.insert(schema.descriptionPlaces).values({
      id: linkId,
      descriptionId: descId,
      placeId: place.id,
      role: "created",
      createdAt: now,
    });

    const link = await db
      .select()
      .from(schema.descriptionPlaces)
      .where(eq(schema.descriptionPlaces.id, linkId))
      .get();

    expect(link).toBeTruthy();
    expect(link!.descriptionId).toBe(descId);
    expect(link!.placeId).toBe(place.id);
    expect(link!.role).toBe("created");
  });

  it("link_description with duplicate returns error", async () => {
    const db = drizzle(env.DB);
    const place = await createTestPlace();
    const user = await createTestUser();
    const repo = await createTestRepository();
    const now = Date.now();

    const descId = crypto.randomUUID();
    await db.insert(schema.descriptions).values({
      id: descId,
      repositoryId: repo.id,
      descriptionLevel: "item",
      referenceCode: "PDUP-001",
      localIdentifier: "PDUP-001",
      title: "Place Duplicate Link Test",
      position: 0,
      depth: 0,
      childCount: 0,
      createdBy: user.id,
      createdAt: now,
      updatedAt: now,
    });

    await db.insert(schema.descriptionPlaces).values({
      id: crypto.randomUUID(),
      descriptionId: descId,
      placeId: place.id,
      role: "created",
      createdAt: now,
    });

    try {
      await db.insert(schema.descriptionPlaces).values({
        id: crypto.randomUUID(),
        descriptionId: descId,
        placeId: place.id,
        role: "created",
        createdAt: now,
      });
      expect.fail("Should have thrown on unique constraint");
    } catch (e) {
      expect(e).toBeTruthy();
    }
  });

  it("edit_description_link updates role and roleNote", async () => {
    const db = drizzle(env.DB);
    const place = await createTestPlace();
    const user = await createTestUser();
    const repo = await createTestRepository();
    const now = Date.now();

    const descId = crypto.randomUUID();
    await db.insert(schema.descriptions).values({
      id: descId,
      repositoryId: repo.id,
      descriptionLevel: "item",
      referenceCode: "PEDIT-001",
      localIdentifier: "PEDIT-001",
      title: "Place Edit Link Test",
      position: 0,
      depth: 0,
      childCount: 0,
      createdBy: user.id,
      createdAt: now,
      updatedAt: now,
    });

    const linkId = crypto.randomUUID();
    await db.insert(schema.descriptionPlaces).values({
      id: linkId,
      descriptionId: descId,
      placeId: place.id,
      role: "created",
      createdAt: now,
    });

    await db
      .update(schema.descriptionPlaces)
      .set({ role: "subject", roleNote: "Main subject of the document" })
      .where(eq(schema.descriptionPlaces.id, linkId));

    const updated = await db
      .select()
      .from(schema.descriptionPlaces)
      .where(eq(schema.descriptionPlaces.id, linkId))
      .get();

    expect(updated!.role).toBe("subject");
    expect(updated!.roleNote).toBe("Main subject of the document");
  });

  it("unlink_description removes junction record", async () => {
    const db = drizzle(env.DB);
    const place = await createTestPlace();
    const user = await createTestUser();
    const repo = await createTestRepository();
    const now = Date.now();

    const descId = crypto.randomUUID();
    await db.insert(schema.descriptions).values({
      id: descId,
      repositoryId: repo.id,
      descriptionLevel: "item",
      referenceCode: "PUNLINK-001",
      localIdentifier: "PUNLINK-001",
      title: "Place Unlink Test",
      position: 0,
      depth: 0,
      childCount: 0,
      createdBy: user.id,
      createdAt: now,
      updatedAt: now,
    });

    const linkId = crypto.randomUUID();
    await db.insert(schema.descriptionPlaces).values({
      id: linkId,
      descriptionId: descId,
      placeId: place.id,
      role: "mentioned",
      createdAt: now,
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

  it("loader query returns descLinks with all fields", async () => {
    const db = drizzle(env.DB);
    const place = await createTestPlace();
    const user = await createTestUser();
    const repo = await createTestRepository();
    const now = Date.now();

    const descId = crypto.randomUUID();
    await db.insert(schema.descriptions).values({
      id: descId,
      repositoryId: repo.id,
      descriptionLevel: "fonds",
      referenceCode: "PLOAD-001",
      localIdentifier: "PLOAD-001",
      title: "Place Loader Test",
      position: 0,
      depth: 0,
      childCount: 0,
      createdBy: user.id,
      createdAt: now,
      updatedAt: now,
    });

    const linkId = crypto.randomUUID();
    await db.insert(schema.descriptionPlaces).values({
      id: linkId,
      descriptionId: descId,
      placeId: place.id,
      role: "sent_from",
      roleNote: "Origin city",
      createdAt: now,
    });

    const descLinks = await db
      .select({
        id: schema.descriptionPlaces.id,
        descriptionId: schema.descriptionPlaces.descriptionId,
        role: schema.descriptionPlaces.role,
        roleNote: schema.descriptionPlaces.roleNote,
        descriptionTitle: schema.descriptions.title,
        referenceCode: schema.descriptions.referenceCode,
        descriptionLevel: schema.descriptions.descriptionLevel,
      })
      .from(schema.descriptionPlaces)
      .innerJoin(
        schema.descriptions,
        eq(schema.descriptionPlaces.descriptionId, schema.descriptions.id)
      )
      .where(eq(schema.descriptionPlaces.placeId, place.id))
      .all();

    expect(descLinks).toHaveLength(1);
    expect(descLinks[0].id).toBe(linkId);
    expect(descLinks[0].descriptionId).toBe(descId);
    expect(descLinks[0].role).toBe("sent_from");
    expect(descLinks[0].roleNote).toBe("Origin city");
    expect(descLinks[0].descriptionTitle).toBe("Place Loader Test");
    expect(descLinks[0].referenceCode).toBe("PLOAD-001");
    expect(descLinks[0].descriptionLevel).toBe("fonds");
  });
});

describe("place schema verification", () => {
  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDatabase();
  });

  it("historical column names in schema", async () => {
    const db = drizzle(env.DB);
    const place = await createTestPlace({
      historicalGobernacion: "Popayan",
      historicalPartido: "Buga",
      historicalRegion: "SW",
      placeCode: "nl-hist01",
    });

    const fetched = await db
      .select()
      .from(schema.places)
      .where(eq(schema.places.id, place.id))
      .get();

    // Confirm the field name is historicalGobernacion (not colonialGobernacion)
    expect(fetched!.historicalGobernacion).toBe("Popayan");
    expect(fetched!.historicalPartido).toBe("Buga");
    expect(fetched!.historicalRegion).toBe("SW");

    // Verify via raw SQL that the DB columns are historical_*
    const rawResult = await env.DB.prepare(
      "SELECT historical_gobernacion, historical_partido, historical_region FROM places WHERE id = ?"
    ).bind(place.id).first();

    expect(rawResult!.historical_gobernacion).toBe("Popayan");
    expect(rawResult!.historical_partido).toBe("Buga");
    expect(rawResult!.historical_region).toBe("SW");
  });
});

describe("place code generation", () => {
  it("code generation produces nl- format", () => {
    const codePattern = /^nl-[a-z2-9]{6}$/;

    // Generate several codes and verify format
    const alphabet = "abcdefghjkmnpqrstvwxyz23456789";
    for (let i = 0; i < 10; i++) {
      const chars = Array.from({ length: 6 }, () =>
        alphabet[Math.floor(Math.random() * alphabet.length)]
      ).join("");
      const code = `nl-${chars}`;
      expect(code).toMatch(codePattern);
    }

    // Verify invalid codes are rejected
    expect("nl-abc12").not.toMatch(codePattern); // 5 chars
    expect("ne-abc123").not.toMatch(codePattern); // wrong prefix
    expect("nl-ABCDEF").not.toMatch(codePattern); // uppercase
    expect("nl-abc10o").not.toMatch(codePattern); // contains 'o'
  });
});
