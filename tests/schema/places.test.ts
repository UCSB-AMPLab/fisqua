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
import { eq } from "drizzle-orm";
import * as schema from "../../app/db/schema";
import { applyMigrations, cleanDatabase } from "../helpers/db";

describe("places table (SCHEMA-04)", () => {
  let db: ReturnType<typeof drizzle>;

  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDatabase();
    db = drizzle(env.DB, { schema });
  });

  it("can insert a place with required fields", async () => {
    const id = crypto.randomUUID();
    const now = Date.now();

    await db.insert(schema.places).values({
      id,
      placeCode: "nl-abc234",
      label: "Tunja",
      displayName: "Tunja, Boyaca, Colombia",
      createdAt: now,
      updatedAt: now,
    });

    const [row] = await db
      .select()
      .from(schema.places)
      .where(eq(schema.places.id, id));

    expect(row).toBeDefined();
    expect(row.placeCode).toBe("nl-abc234");
    expect(row.label).toBe("Tunja");
    expect(row.displayName).toBe("Tunja, Boyaca, Colombia");
  });

  it("placeCode has unique constraint", async () => {
    const now = Date.now();

    await db.insert(schema.places).values({
      id: crypto.randomUUID(),
      placeCode: "nl-xxxxxx",
      label: "Place A",
      displayName: "Place A Display",
      createdAt: now,
      updatedAt: now,
    });

    await expect(
      db.insert(schema.places).values({
        id: crypto.randomUUID(),
        placeCode: "nl-xxxxxx",
        label: "Place B",
        displayName: "Place B Display",
        createdAt: now,
        updatedAt: now,
      })
    ).rejects.toThrow();
  });

  it("latitude and longitude accept real (floating-point) values", async () => {
    const id = crypto.randomUUID();
    const now = Date.now();

    await db.insert(schema.places).values({
      id,
      placeCode: "nl-coords",
      label: "Tunja",
      displayName: "Tunja, Boyaca",
      latitude: 5.5353,
      longitude: -73.3678,
      createdAt: now,
      updatedAt: now,
    });

    const [row] = await db
      .select()
      .from(schema.places)
      .where(eq(schema.places.id, id));

    expect(row.latitude).toBeCloseTo(5.5353);
    expect(row.longitude).toBeCloseTo(-73.3678);
  });

  it("mergedInto column exists", async () => {
    const mainId = crypto.randomUUID();
    const mergedId = crypto.randomUUID();
    const now = Date.now();

    await db.insert(schema.places).values({
      id: mainId,
      placeCode: "nl-main01",
      label: "Main Place",
      displayName: "Main Place Display",
      createdAt: now,
      updatedAt: now,
    });

    await db.insert(schema.places).values({
      id: mergedId,
      placeCode: "nl-mrgd01",
      label: "Merged Place",
      displayName: "Merged Place Display",
      mergedInto: mainId,
      createdAt: now,
      updatedAt: now,
    });

    const [row] = await db
      .select()
      .from(schema.places)
      .where(eq(schema.places.id, mergedId));

    expect(row.mergedInto).toBe(mainId);
  });

  it("needsGeocoding defaults to true", async () => {
    const id = crypto.randomUUID();
    const now = Date.now();

    await db.insert(schema.places).values({
      id,
      placeCode: "nl-geoco",
      label: "Ungeocoded Place",
      displayName: "Ungeocoded Place Display",
      createdAt: now,
      updatedAt: now,
    });

    const [row] = await db
      .select()
      .from(schema.places)
      .where(eq(schema.places.id, id));

    expect(row.needsGeocoding).toBe(true);
  });
});
