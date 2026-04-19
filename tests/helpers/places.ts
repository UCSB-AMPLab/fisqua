/**
 * Tests — places
 *
 * @version v0.3.0
 */
import { drizzle } from "drizzle-orm/d1";
import { env } from "cloudflare:test";
import * as schema from "../../app/db/schema";

export async function createTestPlace(overrides: Partial<{
  id: string;
  placeCode: string;
  label: string;
  displayName: string;
  placeType: string;
  nameVariants: string;
  parentId: string;
  historicalGobernacion: string;
  historicalPartido: string;
  historicalRegion: string;
  countryCode: string;
  adminLevel1: string;
  adminLevel2: string;
  latitude: number;
  longitude: number;
  coordinatePrecision: string;
  mergedInto: string;
  tgnId: string;
  hgisId: string;
  whgId: string;
  wikidataId: string;
}> = {}) {
  const db = drizzle(env.DB);
  const now = Date.now();
  const id = overrides.id ?? crypto.randomUUID();
  const values = {
    id,
    placeCode: overrides.placeCode ?? "nl-test01",
    label: overrides.label ?? "Test Place",
    displayName: overrides.displayName ?? "Test Place",
    placeType: overrides.placeType ?? "city",
    nameVariants: overrides.nameVariants ?? "[]",
    parentId: overrides.parentId ?? undefined,
    historicalGobernacion: overrides.historicalGobernacion ?? undefined,
    historicalPartido: overrides.historicalPartido ?? undefined,
    historicalRegion: overrides.historicalRegion ?? undefined,
    countryCode: overrides.countryCode ?? undefined,
    adminLevel1: overrides.adminLevel1 ?? undefined,
    adminLevel2: overrides.adminLevel2 ?? undefined,
    latitude: overrides.latitude ?? undefined,
    longitude: overrides.longitude ?? undefined,
    coordinatePrecision: overrides.coordinatePrecision ?? undefined,
    mergedInto: overrides.mergedInto ?? undefined,
    tgnId: overrides.tgnId ?? undefined,
    hgisId: overrides.hgisId ?? undefined,
    whgId: overrides.whgId ?? undefined,
    wikidataId: overrides.wikidataId ?? undefined,
    createdAt: now,
    updatedAt: now,
  };
  await db.insert(schema.places).values(values);
  return values;
}
