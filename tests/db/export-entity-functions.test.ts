/**
 * Tests — entity functions in the workspace exports
 *
 * This suite pins that the canonical CSV and the workspace JSON read an
 * entity's functions from its `entity_functions` rows, one per line in
 * the order they were entered, and never from the `entities.functions`
 * column. The fixture gives one linked entity two rows and a value in
 * the column, so an export that read the column would show it.
 *
 * @version v0.9.0
 */
import { describe, it, expect, beforeAll } from "vitest";
import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import * as schema from "../../app/db/schema";
import { applyMigrations, cleanDatabase } from "../helpers/db";
import { DACS_TEST_TENANT_ID } from "../../app/lib/tenant";
import { resolveExportScope } from "../../app/lib/export/scopes.server";
import { emitCanonicalCsv } from "../../app/lib/export/canonical-csv.server";
import type { ExportEmitContext } from "../../app/lib/export/canonical-csv.server";
import { emitJson } from "../../app/lib/export/json.server";
import { decodeAndParseCsv } from "../../app/lib/import/csv";
import type { Tenant, User } from "../../app/context";

const TENANT = DACS_TEST_TENANT_ID;
const REPO = "8c400000-0000-4000-8000-000000000001";
const OWNER_ID = "8a400000-0000-4000-8000-000000000001";
const DESC = "8d400000-0000-4000-8000-000000000001";
const ENTITY = "8e400000-0000-4000-8000-000000000001";
const ctx: ExportEmitContext = { checkpoint: async () => {} };
const db = () => drizzle(env.DB, { schema });

const owner: User = {
  id: OWNER_ID, tenantId: TENANT, email: "owner@test.local", name: null, isAdmin: false, isSuperAdmin: false,
  isCollabAdmin: false, isArchiveUser: false, isUserManager: false, isCataloguer: false, isRecordsAdmin: false,
  isAuthoritiesAdmin: false, isImportsAdmin: false, isDigitizationAdmin: false, lastActiveAt: null, githubId: null,
};

describe("entity functions in the canonical CSV and the workspace JSON", () => {
  let tenant: Tenant;

  beforeAll(async () => {
    await applyMigrations();
    await cleanDatabase();
    const now = Date.now();
    await env.DB.prepare(
      "INSERT OR IGNORE INTO users (id, tenant_id, email, is_admin, created_at, updated_at) VALUES (?,?,?,?,?,?)",
    ).bind(OWNER_ID, TENANT, "owner@test.local", 0, now, now).run();
    tenant = (await db().select().from(schema.tenants).where(eq(schema.tenants.id, TENANT)).get()) as Tenant;
    await db().insert(schema.repositories).values({
      id: REPO, tenantId: TENANT, code: "EF-RT", name: "Repository", enabled: true, createdAt: now, updatedAt: now,
    });
    await db().insert(schema.descriptions).values({
      id: DESC, tenantId: TENANT, repositoryId: REPO, descriptionLevel: "series", referenceCode: "EF-RT-01",
      title: "Serie", legacyIds: "[]", createdAt: now, updatedAt: now,
    });
    await db().insert(schema.entities).values({
      id: ENTITY, federationId: tenant.federationId as string, tenantId: TENANT, entityCode: "ef-000001",
      displayName: "Persona", sortName: "persona", entityType: "person", nameVariants: "[]",
      functions: "texto de la columna", createdAt: now, updatedAt: now,
    });
    for (const [id, fn] of [["f-2", "Regidor"], ["f-1", "Alcalde"]]) {
      await env.DB.prepare(
        "INSERT INTO entity_functions (id, entity_id, function, created_at, updated_at) VALUES (?, ?, ?, 1, 1)",
      ).bind(id, ENTITY, fn).run();
    }
    await db().insert(schema.descriptionEntities).values({
      id: crypto.randomUUID(), descriptionId: DESC, entityId: ENTITY, role: "author", sequence: 0, createdAt: now,
    });
  });

  async function scope() {
    return resolveExportScope(db(), tenant, owner, { kind: "branch", descriptionId: DESC }, { includeAuthorities: true });
  }

  it("writes the rows in the canonical CSV's entityFunctions", async () => {
    const artifact = await emitCanonicalCsv(
      { db: db(), tenant, scope: await scope(), standard: "dacs", includeAuthorities: true },
      ctx,
    );
    const parsed = decodeAndParseCsv(new TextEncoder().encode(artifact.body));
    const typeIdx = parsed.headers.indexOf("rowType");
    const fnIdx = parsed.headers.indexOf("entityFunctions");
    const entityRow = parsed.rows.find((r) => r[typeIdx] === "entity");
    expect(entityRow?.[fnIdx]).toBe("Regidor\nAlcalde");
    expect(artifact.body).not.toContain("texto de la columna");
  });

  it("writes the rows in the workspace JSON's entityFunctions", async () => {
    const artifact = await emitJson(
      { db: db(), tenant, scope: await scope(), form: "dacs", ownStandard: "dacs", includeAuthorities: true },
      ctx,
    );
    const doc = JSON.parse(artifact.body) as { entities: Array<Record<string, unknown>> };
    expect(doc.entities[0].entityFunctions).toBe("Regidor\nAlcalde");
    expect(artifact.body).not.toContain("texto de la columna");
  });
});

// @version v0.9.0
