/**
 * Tests — entities update action: primaryFunctionId validation
 *
 * This suite pins the fix for the one route-vs-schema mismatch the
 * Stage 2 validation read found: the typeahead's hidden
 * `primaryFunctionId` field bypasses the Zod schema and feeds an FK
 * column, so a stale id (term merged/deleted since page load, or a
 * tampered field) used to fail the whole UPDATE on the FK constraint
 * and swallow the curator's entire edit into the generic error. The
 * action now verifies the term exists and fails field-scoped, leaving
 * the record untouched.
 *
 * The term must also belong to the request tenant's federation, on
 * update and on create: a term id from another federation is refused
 * the same way, no entity is written, and the foreign term's count and
 * timestamp are left as they were.
 *
 * Harness mirrors tests/admin/vocab-merge-split-action.test.ts.
 *
 * @version v0.9.0
 */
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { RouterContextProvider } from "react-router";
import * as schema from "../../app/db/schema";
import {
  applyMigrations,
  cleanDatabase,
  seedFederations,
  DEFAULT_TEST_FEDERATION_ID,
  SECOND_TEST_FEDERATION_ID,
} from "../helpers/db";
import { createTestUser } from "../helpers/auth";
import { createTestEntity } from "../helpers/entities";
import { tenantContext, userContext, type User } from "../../app/context";
import { makeTenantContext, makeUserContext } from "../helpers/context";
// Instantiate the route module graph at file load so the in-test
// `await import()` resolves from a warm module cache. A cold route-graph
// import inside a timed test body can exceed testTimeout when this file
// is scheduled late against a saturated Workers-pool module runner on a
// resource-constrained (2-core CI) runner.
import "../../app/routes/_auth.admin.entities.$id";
import "../../app/routes/_auth.admin.entities.new";

function buildContext(user: User): any {
  const ctx = new RouterContextProvider();
  ctx.set(userContext, user);
  ctx.set(tenantContext, makeTenantContext({ id: user.tenantId }));
  (ctx as any).cloudflare = { env };
  return ctx;
}

function updateForm(entityId: string, fields: Record<string, string>): Request {
  const body = new URLSearchParams({
    _action: "update",
    displayName: "Juan de Castellanos",
    sortName: "Castellanos, Juan de",
    entityType: "person",
    nameVariants: "[]",
    ...fields,
  });
  return new Request(
    `http://neogranadina.fisqua.test/admin/entities/${entityId}`,
    {
      method: "POST",
      body,
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    },
  );
}

async function runUpdate(user: User, entityId: string, fields: Record<string, string>) {
  const { action } = await import(
    "../../app/routes/_auth.admin.entities.$id"
  );
  return (await action({
    request: updateForm(entityId, fields),
    context: buildContext(user),
    params: { id: entityId },
  } as any)) as any;
}

describe("entities update action — primaryFunctionId validation", () => {
  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDatabase();
  });

  it("rejects a nonexistent primaryFunctionId with a field-scoped error and no partial write", async () => {
    const admin = makeUserContext({ isAdmin: true });
    const db = drizzle(env.DB, { schema });
    await db.insert(schema.users).values({
      id: admin.id,
      tenantId: admin.tenantId,
      email: "admin-pfv@example.test",
      isAdmin: true,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    const entityRow = await createTestEntity({
      federationId: DEFAULT_TEST_FEDERATION_ID,
      displayName: "Original Name",
    });
    const entityId = entityRow.id;

    const res = await runUpdate(admin, entityId, {
      displayName: "Should Not Land",
      primaryFunction: "Escribano",
      primaryFunctionId: crypto.randomUUID(),
    });


    expect(res.ok).toBe(false);
    expect(res.errors?.primaryFunction?.[0]).toContain("no longer exists");
    expect(res.error).not.toBe("generic");

    const [row] = await db
      .select({ displayName: schema.entities.displayName })
      .from(schema.entities)
      .where(eq(schema.entities.id, entityId))
      .all();
    expect(row.displayName).toBe("Original Name");
  });

  it("accepts an existing term id and links it", async () => {
    const admin = makeUserContext({ isAdmin: true });
    const db = drizzle(env.DB, { schema });
    await db.insert(schema.users).values({
      id: admin.id,
      tenantId: admin.tenantId,
      email: "admin-pfv2@example.test",
      isAdmin: true,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    const entityRow = await createTestEntity({
      federationId: DEFAULT_TEST_FEDERATION_ID,
      displayName: "Original Name",
    });
    const entityId = entityRow.id;
    const termId = crypto.randomUUID();
    await db.insert(schema.vocabularyTerms).values({
      id: termId,
      federationId: DEFAULT_TEST_FEDERATION_ID,
      canonical: "Escribano",
      status: "approved",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    const res = await runUpdate(admin, entityId, {
      displayName: "Updated Name",
      primaryFunction: "Escribano",
      primaryFunctionId: termId,
    });

    expect(res.ok).not.toBe(false);

    const [row] = await db
      .select({
        displayName: schema.entities.displayName,
        primaryFunctionId: schema.entities.primaryFunctionId,
      })
      .from(schema.entities)
      .where(eq(schema.entities.id, entityId))
      .all();
    expect(row.displayName).toBe("Updated Name");
    expect(row.primaryFunctionId).toBe(termId);
  });

  describe("text that no longer names the submitted term", () => {
    async function setUp() {
      const admin = makeUserContext({ isAdmin: true });
      const db = drizzle(env.DB, { schema });
      await db.insert(schema.users).values({
        id: admin.id,
        tenantId: admin.tenantId,
        email: "admin-pfv-retyped@example.test",
        isAdmin: true,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      const alcaldeId = crypto.randomUUID();
      const mayorId = crypto.randomUUID();
      for (const [id, canonical] of [
        [alcaldeId, "Alcalde"],
        [mayorId, "Alcalde mayor"],
      ]) {
        await db.insert(schema.vocabularyTerms).values({
          id,
          federationId: DEFAULT_TEST_FEDERATION_ID,
          canonical,
          status: "approved",
          createdAt: Date.now(),
          updatedAt: Date.now(),
        });
      }
      const entity = await createTestEntity({
        federationId: DEFAULT_TEST_FEDERATION_ID,
        displayName: "Original Name",
      });
      return { admin, db, alcaldeId, mayorId, entityId: entity.id };
    }

    async function storedFunction(db: any, entityId: string) {
      const [row] = await db
        .select({ id: schema.entities.primaryFunctionId })
        .from(schema.entities)
        .where(eq(schema.entities.id, entityId))
        .all();
      return row.id as string | null;
    }

    it("resolves an existing term from the text, not the stale id", async () => {
      const { admin, db, alcaldeId, mayorId, entityId } = await setUp();
      const res = await runUpdate(admin, entityId, {
        primaryFunction: "Alcalde mayor",
        primaryFunctionId: alcaldeId,
      });
      expect(res.ok).not.toBe(false);
      expect(await storedFunction(db, entityId)).toBe(mayorId);
    });

    it("proposes a new term when the text matches none", async () => {
      const { admin, db, alcaldeId, entityId } = await setUp();
      const res = await runUpdate(admin, entityId, {
        primaryFunction: "Corregidor",
        primaryFunctionId: alcaldeId,
      });
      expect(res.ok).not.toBe(false);
      const stored = await storedFunction(db, entityId);
      expect(stored).not.toBe(alcaldeId);
      const [term] = await db
        .select({ canonical: schema.vocabularyTerms.canonical, status: schema.vocabularyTerms.status })
        .from(schema.vocabularyTerms)
        .where(eq(schema.vocabularyTerms.id, stored as string))
        .all();
      expect(term).toEqual({ canonical: "Corregidor", status: "proposed" });
    });

    it("keeps the id when the text still names the term, in any case", async () => {
      const { admin, db, alcaldeId, entityId } = await setUp();
      const res = await runUpdate(admin, entityId, {
        primaryFunction: " alcalde ",
        primaryFunctionId: alcaldeId,
      });
      expect(res.ok).not.toBe(false);
      expect(await storedFunction(db, entityId)).toBe(alcaldeId);
    });

    it("resolves from the text on create as well", async () => {
      const { admin, db, alcaldeId, mayorId } = await setUp();
      const { action } = await import("../../app/routes/_auth.admin.entities.new");
      const res = (await action({
        request: new Request("http://neogranadina.fisqua.test/admin/entities/new", {
          method: "POST",
          body: new URLSearchParams({
            _action: "create",
            displayName: "Retyped Function Test",
            sortName: "Test, Retyped Function",
            entityType: "person",
            primaryFunction: "Alcalde mayor",
            primaryFunctionId: alcaldeId,
          }),
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
        }),
        context: buildContext(admin),
        params: {},
      } as any)) as any;
      expect(res.errors).toBeUndefined();
      const [row] = await db
        .select({ id: schema.entities.primaryFunctionId })
        .from(schema.entities)
        .where(eq(schema.entities.displayName, "Retyped Function Test"))
        .all();
      expect(row.id).toBe(mayorId);
    });
  });

  describe("a selected term changed since the page loaded", () => {
    async function setUp() {
      const admin = makeUserContext({ isAdmin: true });
      const db = drizzle(env.DB, { schema });
      await db.insert(schema.users).values({
        id: admin.id,
        tenantId: admin.tenantId,
        email: "admin-pfv-renamed@example.test",
        isAdmin: true,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      const entity = await createTestEntity({
        federationId: DEFAULT_TEST_FEDERATION_ID,
        displayName: "Original Name",
      });
      const term = async (canonical: string, mergedInto: string | null = null) => {
        const id = crypto.randomUUID();
        await db.insert(schema.vocabularyTerms).values({
          id,
          federationId: DEFAULT_TEST_FEDERATION_ID,
          canonical,
          status: "approved",
          mergedInto,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        });
        return id;
      };
      const stored = async () => {
        const [row] = await db
          .select({ id: schema.entities.primaryFunctionId })
          .from(schema.entities)
          .where(eq(schema.entities.id, entity.id))
          .all();
        return row.id as string | null;
      };
      const storedText = async () => {
        const [row] = await db
          .select({ text: schema.entities.primaryFunction })
          .from(schema.entities)
          .where(eq(schema.entities.id, entity.id))
          .all();
        return row.text as string | null;
      };
      return { admin, db, entityId: entity.id, term, stored, storedText };
    }

    it("keeps the id when the term was renamed after the pick", async () => {
      const { admin, entityId, term, stored, storedText } = await setUp();
      const id = await term("Escribano publico");
      const res = await runUpdate(admin, entityId, {
        primaryFunction: "Escribano",
        primaryFunctionId: id,
        primaryFunctionSelectedText: "Escribano",
      });
      expect(res.ok).not.toBe(false);
      expect(await stored()).toBe(id);
      expect(await storedText()).toBe("Escribano publico");
    });

    it("resolves from the text when it differs from the pick and the current name", async () => {
      const { admin, entityId, term, stored } = await setUp();
      const id = await term("Escribano publico");
      const other = await term("Escribano de cabildo");
      const res = await runUpdate(admin, entityId, {
        primaryFunction: "Escribano de cabildo",
        primaryFunctionId: id,
        primaryFunctionSelectedText: "Escribano",
      });
      expect(res.ok).not.toBe(false);
      expect(await stored()).toBe(other);
    });

    it("follows a merged term to its survivor", async () => {
      const { admin, entityId, term, stored, storedText } = await setUp();
      const survivor = await term("Escribano real");
      const loser = await term("Escribano", survivor);
      const res = await runUpdate(admin, entityId, {
        primaryFunction: "Escribano",
        primaryFunctionId: loser,
        primaryFunctionSelectedText: "Escribano",
      });
      expect(res.ok).not.toBe(false);
      expect(await stored()).toBe(survivor);
      expect(await storedText()).toBe("Escribano real");
    });

    it("stores the id's own name when the request pairs it with other text", async () => {
      const { admin, entityId, term, stored, storedText } = await setUp();
      const carpintero = await term("Carpintero");
      const res = await runUpdate(admin, entityId, {
        primaryFunction: "Escribano",
        primaryFunctionId: carpintero,
        primaryFunctionSelectedText: "Escribano",
      });
      expect(res.ok).not.toBe(false);
      expect(await stored()).toBe(carpintero);
      expect(await storedText()).toBe("Carpintero");
    });

    it("stores the id's own name on create as well", async () => {
      const { admin, db, term } = await setUp();
      const carpintero = await term("Carpintero");
      const { action } = await import("../../app/routes/_auth.admin.entities.new");
      const res = (await action({
        request: new Request("http://neogranadina.fisqua.test/admin/entities/new", {
          method: "POST",
          body: new URLSearchParams({
            _action: "create",
            displayName: "Tampered Function Test",
            sortName: "Test, Tampered Function",
            entityType: "person",
            primaryFunction: "Escribano",
            primaryFunctionId: carpintero,
            primaryFunctionSelectedText: "Escribano",
          }),
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
        }),
        context: buildContext(admin),
        params: {},
      } as any)) as any;
      expect(res.errors).toBeUndefined();
      const [row] = await db
        .select({ id: schema.entities.primaryFunctionId, text: schema.entities.primaryFunction })
        .from(schema.entities)
        .where(eq(schema.entities.displayName, "Tampered Function Test"))
        .all();
      expect(row).toEqual({ id: carpintero, text: "Carpintero" });
    });
  });

  describe("a term of another federation", () => {
    const T0 = 1_700_000_000_000;

    async function setUp() {
      await seedFederations();
      const admin = makeUserContext({ isAdmin: true });
      const db = drizzle(env.DB, { schema });
      await db.insert(schema.users).values({
        id: admin.id,
        tenantId: admin.tenantId,
        email: "admin-pfv-foreign@example.test",
        isAdmin: true,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      const foreignTermId = crypto.randomUUID();
      await db.insert(schema.vocabularyTerms).values({
        id: foreignTermId,
        federationId: SECOND_TEST_FEDERATION_ID,
        canonical: "Escribano",
        status: "approved",
        entityCount: 7,
        createdAt: T0,
        updatedAt: T0,
      });
      return { admin, db, foreignTermId };
    }

    async function foreignTerm(db: any, id: string) {
      const [row] = await db
        .select({ entityCount: schema.vocabularyTerms.entityCount, updatedAt: schema.vocabularyTerms.updatedAt })
        .from(schema.vocabularyTerms)
        .where(eq(schema.vocabularyTerms.id, id))
        .all();
      return row;
    }

    it("is refused on create, writing no entity and leaving the term untouched", async () => {
      const { admin, db, foreignTermId } = await setUp();
      const { action } = await import("../../app/routes/_auth.admin.entities.new");
      const res = (await action({
        request: new Request("http://neogranadina.fisqua.test/admin/entities/new", {
          method: "POST",
          body: new URLSearchParams({
            _action: "create",
            displayName: "Foreign Function Test",
            sortName: "Test, Foreign Function",
            entityType: "person",
            primaryFunction: "Escribano",
            primaryFunctionId: foreignTermId,
          }),
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
        }),
        context: buildContext(admin),
        params: {},
      } as any)) as any;

      expect(res.ok).toBe(false);
      expect(res.errors?.primaryFunction).toHaveLength(1);
      const made = await db
        .select({ id: schema.entities.id })
        .from(schema.entities)
        .where(eq(schema.entities.displayName, "Foreign Function Test"))
        .all();
      expect(made).toEqual([]);
      expect(await foreignTerm(db, foreignTermId)).toEqual({ entityCount: 7, updatedAt: T0 });
    });

    it("is refused on update, leaving the entity and the term untouched", async () => {
      const { admin, db, foreignTermId } = await setUp();
      const entityRow = await createTestEntity({ federationId: DEFAULT_TEST_FEDERATION_ID, displayName: "Original Name" });
      const res = await runUpdate(admin, entityRow.id, {
        displayName: "Should Not Land",
        primaryFunction: "Escribano",
        primaryFunctionId: foreignTermId,
      });
      expect(res.ok).toBe(false);
      expect(res.errors?.primaryFunction).toHaveLength(1);
      const [row] = await db
        .select({ displayName: schema.entities.displayName })
        .from(schema.entities)
        .where(eq(schema.entities.id, entityRow.id))
        .all();
      expect(row.displayName).toBe("Original Name");
      expect(await foreignTerm(db, foreignTermId)).toEqual({ entityCount: 7, updatedAt: T0 });
    });
  });
});

// @version v0.9.0
