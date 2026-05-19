/**
 * Tests — descriptions
 *
 * This helper module wraps description-row creation for the test
 * suite. Every description row carries a tenant_id NOT NULL FK to
 * tenants(id), so tests must call seedTenants() before invoking this
 * helper. Defaults to DEFAULT_TEST_TENANT_ID.
 *
 * @version v0.4.0
 */
import { drizzle } from "drizzle-orm/d1";
import { env } from "cloudflare:test";
import * as schema from "../../app/db/schema";
import { DEFAULT_TEST_TENANT_ID } from "./db";

export async function createTestDescription(
  overrides: Partial<{
    id: string;
    tenantId: string;
    repositoryId: string;
    parentId: string | null;
    position: number;
    rootDescriptionId: string | null;
    depth: number;
    childCount: number;
    pathCache: string;
    descriptionLevel: string;
    referenceCode: string;
    localIdentifier: string;
    title: string;
    dateExpression: string | null;
    scopeContent: string | null;
    isPublished: boolean;
  }> = {}
) {
  const db = drizzle(env.DB);
  const now = Date.now();
  const id = overrides.id ?? crypto.randomUUID();
  const values = {
    id,
    tenantId: overrides.tenantId ?? DEFAULT_TEST_TENANT_ID,
    repositoryId: overrides.repositoryId ?? "repo-test",
    parentId: overrides.parentId ?? null,
    position: overrides.position ?? 0,
    rootDescriptionId: overrides.rootDescriptionId ?? null,
    depth: overrides.depth ?? 0,
    childCount: overrides.childCount ?? 0,
    pathCache: overrides.pathCache ?? "",
    descriptionLevel: (overrides.descriptionLevel ?? "fonds") as
      (typeof schema.descriptions.$inferInsert)["descriptionLevel"],
    referenceCode: overrides.referenceCode ?? `ref-${id.slice(0, 8)}`,
    localIdentifier: overrides.localIdentifier ?? `loc-${id.slice(0, 8)}`,
    title: overrides.title ?? "Test Description",
    dateExpression: overrides.dateExpression ?? null,
    scopeContent: overrides.scopeContent ?? null,
    isPublished: overrides.isPublished ?? true,
    createdAt: now,
    updatedAt: now,
  };
  await db.insert(schema.descriptions).values(values);
  return values;
}
