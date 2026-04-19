/**
 * Tests — repositories
 *
 * @version v0.3.0
 */
import { drizzle } from "drizzle-orm/d1";
import { env } from "cloudflare:test";
import * as schema from "../../app/db/schema";

export async function createTestRepository(overrides: Partial<{
  id: string;
  code: string;
  name: string;
  shortName: string | null;
  countryCode: string;
  country: string | null;
  city: string | null;
  address: string | null;
  website: string | null;
  notes: string | null;
  rightsText: string | null;
  displayTitle: string | null;
  subtitle: string | null;
  heroImageUrl: string | null;
  enabled: boolean;
}> = {}) {
  const db = drizzle(env.DB);
  const now = Date.now();
  const id = overrides.id ?? crypto.randomUUID();
  const values = {
    id,
    code: overrides.code ?? `REPO-${id.slice(0, 4)}`,
    name: overrides.name ?? "Test Repository",
    shortName: overrides.shortName ?? null,
    countryCode: overrides.countryCode ?? "COL",
    country: overrides.country ?? null,
    city: overrides.city ?? null,
    address: overrides.address ?? null,
    website: overrides.website ?? null,
    notes: overrides.notes ?? null,
    rightsText: overrides.rightsText ?? null,
    displayTitle: overrides.displayTitle ?? null,
    subtitle: overrides.subtitle ?? null,
    heroImageUrl: overrides.heroImageUrl ?? null,
    enabled: overrides.enabled ?? true,
    createdAt: now,
    updatedAt: now,
  };
  await db.insert(schema.repositories).values(values);
  return values;
}
