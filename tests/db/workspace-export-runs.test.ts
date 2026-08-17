/**
 * Tests — workspace export runs
 *
 * Covers `app/lib/export/scopes.server.ts` (the four What doors resolved
 * to what will leave) and `app/lib/export/run.server.ts` (the ledger
 * row's lifecycle: start, execute, cancel, fail, read, sweep). What is
 * pinned here is everything a surface cannot check for itself: that a
 * branch walk never leaks another tenant's row even when that row
 * spoofs the parent link; that a carried scope's stashed ids are
 * re-read under THIS tenant rather than trusted, so a foreign id never
 * surfaces; that a handlist export takes the handlist's own order and
 * excludes tombstones; the three named refusals a handlist scope can
 * raise (needs-review, empty, untyped); that a run row lands `running`
 * before the artifact exists and `completed` with counts and an R2
 * object once it does; that a carried scope is spent when the RUN
 * STARTS, not when the export page opened; that a cancel leaves no
 * artifact behind; that a format failure is recorded as a code and its
 * detail rather than a sentence; that reads are tenant-scoped the same
 * way a 404 is; that the retention sweep only touches rows past the
 * window; and that the run lifecycle threads the run id and the locale
 * through to an emitter that signs itself with them.
 *
 * NO FAKE R2 BINDING EXISTS YET IN THIS REPO for a full-surface test
 * (`tests/imports/staging.test.ts` and `tests/export/r2-client.test.ts`
 * each hand-roll one), so this file follows the same established
 * pattern: a minimal in-memory object implementing only `put`, `get`
 * and `delete` — the three methods `run.server.ts` actually calls.
 *
 * FIXTURES. The request tenant is Neogranadina (isadg); the second test
 * tenant stands in for "another workspace" throughout. The whole-
 * workspace door is measured against the RAD test tenant instead,
 * because summing "every description in the tenant" only means
 * something against a tenant this file does not also use for other
 * fixtures — every other door is targeted by explicit ids, so sharing
 * Neogranadina across many `it()` blocks does not contaminate them.
 * Each `it()` seeds its own description/entity rows with fresh random
 * ids so it is self-contained regardless of whether storage happens to
 * carry state across tests in this pool.
 *
 * THE DUPLICATE-REFERENCE-CODE FIXTURE drops the harness's own
 * `desc_ref_code_idx` unique index for one seed. The schema enforces
 * uniqueness precisely so the EAD emitter's `assertUniqueReferenceCodes`
 * should never fire on a healthy workspace (the module's own words); the
 * only way to exercise the guard it still carries — for imported data
 * from before the index existed — is to seed the collision the index
 * would otherwise refuse.
 *
 * @version v0.7.0
 */
import { describe, it, expect, beforeAll } from "vitest";
import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import * as schema from "../../app/db/schema";
import { applyMigrations, cleanDatabase, SECOND_TEST_TENANT_ID } from "../helpers/db";
import {
  NEOGRANADINA_TENANT_ID,
  NEOGRANADINA_FEDERATION_ID,
  RAD_TEST_TENANT_ID,
} from "../../app/lib/tenant";
import { parseSearch } from "../../app/lib/search-query";
import { stashCarriedScope } from "../../app/lib/carried-scopes.server";
import { createHandlist } from "../../app/lib/handlists.server";
import {
  resolveExportScope,
  ExportScopeError,
} from "../../app/lib/export/scopes.server";
import {
  startExportRun,
  cancelExportRun,
  getExportRun,
  listExportRuns,
  sweepExpiredExports,
  exportObjectKey,
} from "../../app/lib/export/run.server";
import type { Tenant, User } from "../../app/context";

const TENANT_A = NEOGRANADINA_TENANT_ID;
const FED_A = NEOGRANADINA_FEDERATION_ID;
const TENANT_B = SECOND_TEST_TENANT_ID;
const TENANT_RAD = RAD_TEST_TENANT_ID;

const OWNER_ID = "8a100000-0000-4000-8000-000000000001";
/** Admin-gated formats (csv, ead-xml, json) and any authority-typed
 * handlist access need this role; the pdf colophon test deliberately
 * keeps the plain owner, to pin that the re-ruled tier puts it in
 * every member's hands. */
const ADMIN_ID = "8a100000-0000-4000-8000-000000000002";

const REPO_A = "8b100000-0000-4000-8000-000000000001";
const REPO_B = "8b100000-0000-4000-8000-000000000002";
const REPO_RAD = "8b100000-0000-4000-8000-000000000003";

function db() {
  return drizzle(env.DB, { schema });
}

function makeUser(overrides: Partial<User> & Pick<User, "id" | "tenantId">): User {
  return {
    email: `${overrides.id}@test.local`,
    name: null,
    isAdmin: false,
    isSuperAdmin: false,
    isCollabAdmin: false,
    isArchiveUser: false,
    isUserManager: false,
    isCataloguer: false,
    lastActiveAt: null,
    githubId: null,
    ...overrides,
  };
}

const owner = makeUser({ id: OWNER_ID, tenantId: TENANT_A });
const admin = makeUser({ id: ADMIN_ID, tenantId: TENANT_A, isAdmin: true });

async function loadTenant(id: string): Promise<Tenant> {
  const row = await db().select().from(schema.tenants).where(eq(schema.tenants.id, id)).get();
  if (!row) throw new Error(`tenant ${id} not seeded`);
  return row as Tenant;
}

async function seedUser(id: string, tenantId: string, isAdmin = false): Promise<void> {
  const now = Date.now();
  await env.DB.prepare(
    "INSERT OR IGNORE INTO users (id, tenant_id, email, is_admin, created_at, updated_at) VALUES (?,?,?,?,?,?)",
  )
    .bind(id, tenantId, `${id}@test.local`, isAdmin ? 1 : 0, now, now)
    .run();
}

async function seedRepository(id: string, tenantId: string, code: string): Promise<void> {
  const now = Date.now();
  await db().insert(schema.repositories).values({
    id,
    tenantId,
    code,
    name: `Repository ${code}`,
    countryCode: "COL",
    enabled: true,
    createdAt: now,
    updatedAt: now,
  });
}

let codeCounter = 0;
/** A fresh, collision-free reference code for a fixture description. */
function uniqueCode(tag: string): string {
  codeCounter += 1;
  return `WR-${tag}-${codeCounter}`.toUpperCase();
}

async function seedDescription(values: {
  id: string;
  tenantId: string;
  repositoryId: string;
  referenceCode: string;
  title: string;
  parentId?: string | null;
  position?: number;
}): Promise<void> {
  const now = Date.now();
  await db().insert(schema.descriptions).values({
    id: values.id,
    tenantId: values.tenantId,
    repositoryId: values.repositoryId,
    parentId: values.parentId ?? null,
    position: values.position ?? 0,
    descriptionLevel: "item",
    referenceCode: values.referenceCode,
    title: values.title,
    legacyIds: "[]",
    createdAt: now,
    updatedAt: now,
  });
}

async function seedEntity(values: {
  id: string;
  federationId: string;
  tenantId: string | null;
  displayName: string;
}): Promise<void> {
  const now = Date.now();
  await db().insert(schema.entities).values({
    id: values.id,
    federationId: values.federationId,
    tenantId: values.tenantId,
    entityCode: `ne-${values.id.slice(-6)}`,
    displayName: values.displayName,
    sortName: values.displayName.toLowerCase(),
    entityType: "person",
    nameVariants: "[]",
    createdAt: now,
    updatedAt: now,
  });
}

/** One 'split' row on the append-only authority-operations ledger. */
async function seedSplitOperation(values: {
  id: string;
  sourceId: string;
  targetId: string;
  createdAt: number;
}): Promise<void> {
  await db().insert(schema.authorityOperations).values({
    id: values.id,
    federationId: FED_A,
    recordType: "entity",
    operation: "split",
    sourceId: values.sourceId,
    targetId: values.targetId,
    userId: OWNER_ID,
    detail: null,
    createdAt: values.createdAt,
  });
}

/** A faithful in-memory `R2Bucket`, covering the surface `run.server.ts` uses. */
function mockBucket(): { bucket: R2Bucket; store: Map<string, Uint8Array> } {
  const store = new Map<string, Uint8Array>();
  const enc = new TextEncoder();
  const toBytes = (body: unknown): Uint8Array => {
    if (typeof body === "string") return enc.encode(body);
    if (body instanceof Uint8Array) return body;
    if (body instanceof ArrayBuffer) return new Uint8Array(body);
    return enc.encode(String(body));
  };
  const bucket = {
    async put(key: string, body: unknown) {
      store.set(key, toBytes(body));
      return {} as unknown;
    },
    async get(key: string) {
      const bytes = store.get(key);
      if (!bytes) return null;
      return {
        async arrayBuffer() {
          return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
        },
      };
    },
    async delete(key: string) {
      store.delete(key);
    },
  } as unknown as R2Bucket;
  return { bucket, store };
}

describe("workspace export runs", () => {
  let tenantA: Tenant;
  let tenantB: Tenant;
  let tenantRad: Tenant;

  beforeAll(async () => {
    await applyMigrations();
    await cleanDatabase();
    await seedUser(OWNER_ID, TENANT_A);
    await seedUser(ADMIN_ID, TENANT_A, true);
    await seedRepository(REPO_A, TENANT_A, "WR-A");
    await seedRepository(REPO_B, TENANT_B, "WR-B");
    await seedRepository(REPO_RAD, TENANT_RAD, "WR-RAD");
    tenantA = await loadTenant(TENANT_A);
    tenantB = await loadTenant(TENANT_B);
    tenantRad = await loadTenant(TENANT_RAD);
  });

  describe("resolveExportScope — workspace door", () => {
    it("counts every description in the tenant, tenant-scoped", async () => {
      const id1 = crypto.randomUUID();
      const id2 = crypto.randomUUID();
      await seedDescription({
        id: id1,
        tenantId: TENANT_RAD,
        repositoryId: REPO_RAD,
        referenceCode: uniqueCode("workspace-1"),
        title: "Workspace door one",
      });
      await seedDescription({
        id: id2,
        tenantId: TENANT_RAD,
        repositoryId: REPO_RAD,
        referenceCode: uniqueCode("workspace-2"),
        title: "Workspace door two",
      });

      const resolved = await resolveExportScope(
        db(),
        tenantRad,
        makeUser({ id: OWNER_ID, tenantId: TENANT_RAD }),
        { kind: "workspace" },
        { includeAuthorities: false },
      );
      expect(resolved.recordClass).toBe("records");
      expect(resolved.descriptor).toEqual({ kind: "workspace" });
      expect([...resolved.memberIds].sort()).toEqual([id1, id2].sort());
      expect(resolved.counts.records).toBe(2);
    });
  });

  describe("resolveExportScope — branch door", () => {
    it("walks a node and its descendants in preorder, excluding a spoofed foreign-tenant child", async () => {
      const rootId = crypto.randomUUID();
      const childId = crypto.randomUUID();
      const grandchildId = crypto.randomUUID();
      const foreignId = crypto.randomUUID();

      await seedDescription({
        id: rootId,
        tenantId: TENANT_A,
        repositoryId: REPO_A,
        referenceCode: uniqueCode("branch-root"),
        title: "Branch root",
      });
      await seedDescription({
        id: childId,
        tenantId: TENANT_A,
        repositoryId: REPO_A,
        referenceCode: uniqueCode("branch-child"),
        title: "Branch child",
        parentId: rootId,
      });
      await seedDescription({
        id: grandchildId,
        tenantId: TENANT_A,
        repositoryId: REPO_A,
        referenceCode: uniqueCode("branch-grandchild"),
        title: "Branch grandchild",
        parentId: childId,
      });
      // Another tenant's row, spoofing this tenant's root as its parent —
      // the recursive walk's tenant predicate must keep it out regardless.
      await seedDescription({
        id: foreignId,
        tenantId: TENANT_B,
        repositoryId: REPO_B,
        referenceCode: uniqueCode("branch-foreign"),
        title: "Foreign spoof",
        parentId: rootId,
      });

      const resolved = await resolveExportScope(
        db(),
        tenantA,
        owner,
        { kind: "branch", descriptionId: rootId },
        { includeAuthorities: false },
      );
      expect(resolved.memberIds).toEqual([rootId, childId, grandchildId]);
      expect(resolved.memberIds).not.toContain(foreignId);
      expect(resolved.descriptor).toMatchObject({
        kind: "branch",
        descriptionId: rootId,
        titleChain: ["Branch root"],
      });
    });
  });

  describe("resolveExportScope — carried door", () => {
    it("re-reads the stashed ids under this tenant; a foreign id never surfaces", async () => {
      const ownId = crypto.randomUUID();
      const foreignId = crypto.randomUUID();
      await seedDescription({
        id: ownId,
        tenantId: TENANT_A,
        repositoryId: REPO_A,
        referenceCode: uniqueCode("carried-own"),
        title: "Carried own",
      });
      await seedDescription({
        id: foreignId,
        tenantId: TENANT_B,
        repositoryId: REPO_B,
        referenceCode: uniqueCode("carried-foreign"),
        title: "Carried foreign",
      });

      const scopeId = await stashCarriedScope(db(), owner, tenantA, {
        recordType: "records",
        mode: "ids",
        ids: [ownId, foreignId],
        constraints: [{ label: "carried pill" }],
        query: { input: parseSearch(["carried"]), facets: {} },
      });

      const resolved = await resolveExportScope(
        db(),
        tenantA,
        owner,
        { kind: "carried", carriedScopeId: scopeId },
        { includeAuthorities: false },
      );
      expect(resolved.memberIds).toEqual([ownId]);
      expect(resolved.memberIds).not.toContain(foreignId);
      expect(resolved.descriptor).toMatchObject({
        kind: "carried",
        carriedScopeId: scopeId,
        found: 2,
        unticked: 0,
        willExport: 1,
      });
    });
  });

  describe("resolveExportScope — handlist door", () => {
    it("keeps the handlist's own order and excludes a tombstoned member", async () => {
      const d1 = crypto.randomUUID();
      const d2 = crypto.randomUUID();
      const d3 = crypto.randomUUID();
      const tombstone = crypto.randomUUID(); // never seeded
      await seedDescription({
        id: d1,
        tenantId: TENANT_A,
        repositoryId: REPO_A,
        referenceCode: uniqueCode("handlist-order-1"),
        title: "Handlist order one",
      });
      await seedDescription({
        id: d2,
        tenantId: TENANT_A,
        repositoryId: REPO_A,
        referenceCode: uniqueCode("handlist-order-2"),
        title: "Handlist order two",
      });
      await seedDescription({
        id: d3,
        tenantId: TENANT_A,
        repositoryId: REPO_A,
        referenceCode: uniqueCode("handlist-order-3"),
        title: "Handlist order three",
      });

      const created = await createHandlist(db(), tenantA, owner, {
        name: `Order kept ${crypto.randomUUID()}`,
        recordType: "records",
        memberIds: [d3, d1, tombstone, d2],
      });

      const resolved = await resolveExportScope(
        db(),
        tenantA,
        owner,
        { kind: "handlist", handlistId: created.id },
        { includeAuthorities: false },
      );
      expect(resolved.memberIds).toEqual([d3, d1, d2]);
      expect(resolved.memberIds).not.toContain(tombstone);
      expect(resolved.descriptor).toMatchObject({
        kind: "handlist",
        handlistId: created.id,
        total: 4,
        exportable: 3,
      });
    });

    it("refuses with handlist-needs-review when a split lands as current drift", async () => {
      const source = crypto.randomUUID();
      const target = crypto.randomUUID();
      const t0 = 1_700_100_000_000;
      await seedEntity({
        id: source,
        federationId: FED_A,
        tenantId: TENANT_A,
        displayName: "Split Source",
      });
      await seedEntity({
        id: target,
        federationId: FED_A,
        tenantId: TENANT_A,
        displayName: "Split Target",
      });
      const created = await createHandlist(
        db(),
        tenantA,
        admin,
        {
          name: `Needs review ${crypto.randomUUID()}`,
          recordType: "entities",
          memberIds: [source],
        },
        t0,
      );
      // After the member was added: current drift, must flag.
      await seedSplitOperation({
        id: crypto.randomUUID(),
        sourceId: source,
        targetId: target,
        createdAt: t0 + 10_000,
      });

      const error = await resolveExportScope(
        db(),
        tenantA,
        admin,
        { kind: "handlist", handlistId: created.id },
        { includeAuthorities: false },
      ).catch((e) => e);
      expect(error).toBeInstanceOf(ExportScopeError);
      expect((error as ExportScopeError).code).toBe("handlist-needs-review");
    });

    it("refuses with handlist-empty when every member would be excluded", async () => {
      const created = await createHandlist(db(), tenantA, owner, {
        name: `Empty after tombstone ${crypto.randomUUID()}`,
        recordType: "records",
        memberIds: [crypto.randomUUID()], // never seeded: a pure tombstone
      });

      const error = await resolveExportScope(
        db(),
        tenantA,
        owner,
        { kind: "handlist", handlistId: created.id },
        { includeAuthorities: false },
      ).catch((e) => e);
      expect(error).toBeInstanceOf(ExportScopeError);
      expect((error as ExportScopeError).code).toBe("handlist-empty");
    });

    it("refuses with handlist-untyped for a handlist with no members yet", async () => {
      const created = await createHandlist(db(), tenantA, owner, {
        name: `Untyped ${crypto.randomUUID()}`,
      });

      const error = await resolveExportScope(
        db(),
        tenantA,
        owner,
        { kind: "handlist", handlistId: created.id },
        { includeAuthorities: false },
      ).catch((e) => e);
      expect(error).toBeInstanceOf(ExportScopeError);
      expect((error as ExportScopeError).code).toBe("handlist-untyped");
    });
  });

  describe("startExportRun / execute — the csv path end to end", () => {
    it("goes running -> completed with counts, file_name, file_size, r2_key, and the object lands in the bucket", async () => {
      const rootId = crypto.randomUUID();
      const childId = crypto.randomUUID();
      await seedDescription({
        id: rootId,
        tenantId: TENANT_A,
        repositoryId: REPO_A,
        referenceCode: uniqueCode("run-root"),
        title: "Run root",
      });
      await seedDescription({
        id: childId,
        tenantId: TENANT_A,
        repositoryId: REPO_A,
        referenceCode: uniqueCode("run-child"),
        title: "Run child",
        parentId: rootId,
      });
      const { bucket, store } = mockBucket();

      const started = await startExportRun(
        { db: db(), bucket, tenant: tenantA, user: admin, locale: "en" },
        {
          scope: { kind: "branch", descriptionId: rootId },
          form: "isadg",
          format: "csv",
          includeAuthorities: false,
        },
      );

      const running = await getExportRun(db(), tenantA, started.runId);
      expect(running?.status).toBe("running");
      expect(running?.fileName).toBeNull();
      expect(running?.r2Key).toBeNull();

      await started.execute();

      const completed = await getExportRun(db(), tenantA, started.runId);
      expect(completed?.status).toBe("completed");
      expect(completed?.counts.records).toBe(2);
      expect(completed?.fileName).toMatch(/\.csv$/);
      expect(completed?.fileSize).toBeGreaterThan(0);
      expect(completed?.r2Key).toBe(
        exportObjectKey(TENANT_A, started.runId, completed!.fileName as string),
      );
      expect(store.has(completed!.r2Key as string)).toBe(true);
    });

    it("stamps a carried scope's consumed_at when the run starts, before execute ever runs", async () => {
      const id1 = crypto.randomUUID();
      await seedDescription({
        id: id1,
        tenantId: TENANT_A,
        repositoryId: REPO_A,
        referenceCode: uniqueCode("consume"),
        title: "Consume me",
      });
      // Stashed and later spent by the same admin user: startExportRun
      // needs admin for the csv format, and getCarriedScope is owner-only.
      const scopeId = await stashCarriedScope(db(), admin, tenantA, {
        recordType: "records",
        mode: "ids",
        ids: [id1],
        constraints: [],
        query: { input: parseSearch(["consume"]), facets: {} },
      });
      const before = await db()
        .select()
        .from(schema.carriedScopes)
        .where(eq(schema.carriedScopes.id, scopeId))
        .get();
      expect(before?.consumedAt).toBeNull();

      const { bucket } = mockBucket();
      const started = await startExportRun(
        { db: db(), bucket, tenant: tenantA, user: admin, locale: "en" },
        {
          scope: { kind: "carried", carriedScopeId: scopeId },
          form: "isadg",
          format: "csv",
          includeAuthorities: false,
        },
      );

      const after = await db()
        .select()
        .from(schema.carriedScopes)
        .where(eq(schema.carriedScopes.id, scopeId))
        .get();
      expect(after?.consumedAt).not.toBeNull();
      // Spent, but not yet executed — the run row exists and the artifact
      // has not landed.
      const running = await getExportRun(db(), tenantA, started.runId);
      expect(running?.status).toBe("running");
    });

    it("cancelExportRun flips a running row, and execute() leaves no artifact behind", async () => {
      const id1 = crypto.randomUUID();
      await seedDescription({
        id: id1,
        tenantId: TENANT_A,
        repositoryId: REPO_A,
        referenceCode: uniqueCode("cancel"),
        title: "Cancel me",
      });
      const { bucket, store } = mockBucket();
      const started = await startExportRun(
        { db: db(), bucket, tenant: tenantA, user: admin, locale: "en" },
        {
          scope: { kind: "branch", descriptionId: id1 },
          form: "isadg",
          format: "csv",
          includeAuthorities: false,
        },
      );

      const flipped = await cancelExportRun(db(), tenantA, started.runId);
      expect(flipped).toBe(true);

      await started.execute();

      const after = await getExportRun(db(), tenantA, started.runId);
      expect(after?.status).toBe("cancelled");
      expect(after?.r2Key).toBeNull();
      expect([...store.keys()].some((k) => k.includes(started.runId))).toBe(false);
    });

    it("records a duplicate-reference-code format failure as {code, detail}, leaving no artifact", async () => {
      // The unique index normally forbids this fixture outright — see
      // the module header for why dropping it here is the honest way to
      // exercise the guard the emitter still carries.
      await env.DB.exec("DROP INDEX IF EXISTS desc_ref_code_idx");

      const rootId = crypto.randomUUID();
      const idA = crypto.randomUUID();
      const idB = crypto.randomUUID();
      const dupCode = uniqueCode("dup");
      await seedDescription({
        id: rootId,
        tenantId: TENANT_A,
        repositoryId: REPO_A,
        referenceCode: uniqueCode("dup-root"),
        title: "Duplicate root",
      });
      await seedDescription({
        id: idA,
        tenantId: TENANT_A,
        repositoryId: REPO_A,
        referenceCode: dupCode,
        title: "First title",
        parentId: rootId,
      });
      await seedDescription({
        id: idB,
        tenantId: TENANT_A,
        repositoryId: REPO_A,
        referenceCode: dupCode,
        title: "Second title",
        parentId: rootId,
      });

      const { bucket, store } = mockBucket();
      const started = await startExportRun(
        { db: db(), bucket, tenant: tenantA, user: admin, locale: "en" },
        {
          scope: { kind: "branch", descriptionId: rootId },
          form: "isadg",
          format: "ead-xml",
          includeAuthorities: false,
        },
      );
      await started.execute();

      const after = await getExportRun(db(), tenantA, started.runId);
      expect(after?.status).toBe("failed");
      expect(after?.failure?.code).toBe("duplicate-reference-code");
      const titles = (after?.failure?.detail as { titles?: string[] } | undefined)?.titles;
      expect(titles).toBeDefined();
      expect([...(titles as string[])].sort()).toEqual(
        ["First title", "Second title"].sort(),
      );
      expect(after?.r2Key).toBeNull();
      expect([...store.keys()].some((k) => k.includes(started.runId))).toBe(false);
    });
  });

  describe("getExportRun / listExportRuns — tenant-scoped reads", () => {
    it("reads null and absent across a tenant boundary", async () => {
      const id1 = crypto.randomUUID();
      await seedDescription({
        id: id1,
        tenantId: TENANT_A,
        repositoryId: REPO_A,
        referenceCode: uniqueCode("scoped-read"),
        title: "Scoped read",
      });
      const { bucket } = mockBucket();
      const started = await startExportRun(
        { db: db(), bucket, tenant: tenantA, user: admin, locale: "en" },
        {
          scope: { kind: "branch", descriptionId: id1 },
          form: "isadg",
          format: "csv",
          includeAuthorities: false,
        },
      );
      await started.execute();

      expect(await getExportRun(db(), tenantB, started.runId)).toBeNull();

      const listA = await listExportRuns(db(), tenantA);
      expect(listA.some((r) => r.id === started.runId)).toBe(true);

      const listB = await listExportRuns(db(), tenantB);
      expect(listB.some((r) => r.id === started.runId)).toBe(false);
    });
  });

  describe("sweepExpiredExports", () => {
    it("removes only rows past the retention window, deleting their bucket objects", async () => {
      const oldId = crypto.randomUUID();
      const freshId = crypto.randomUUID();
      await seedDescription({
        id: oldId,
        tenantId: TENANT_A,
        repositoryId: REPO_A,
        referenceCode: uniqueCode("sweep-old"),
        title: "Sweep old",
      });
      await seedDescription({
        id: freshId,
        tenantId: TENANT_A,
        repositoryId: REPO_A,
        referenceCode: uniqueCode("sweep-fresh"),
        title: "Sweep fresh",
      });

      const t0 = 1_700_000_000_000;
      const dayMs = 24 * 60 * 60 * 1000;
      const { bucket, store } = mockBucket();

      const oldRun = await startExportRun(
        { db: db(), bucket, tenant: tenantA, user: admin, locale: "en", now: () => t0 },
        {
          scope: { kind: "branch", descriptionId: oldId },
          form: "isadg",
          format: "csv",
          includeAuthorities: false,
        },
      );
      await oldRun.execute();

      const freshNow = t0 + 10 * dayMs; // 10 days after the old run's stamp
      const freshRun = await startExportRun(
        {
          db: db(),
          bucket,
          tenant: tenantA,
          user: admin,
          locale: "en",
          now: () => freshNow,
        },
        {
          scope: { kind: "branch", descriptionId: freshId },
          form: "isadg",
          format: "csv",
          includeAuthorities: false,
        },
      );
      await freshRun.execute();

      // 31 days past the OLD run's created_at, but only 21 days past the
      // fresh one's — the old row crosses the 30-day window, the fresh
      // one does not.
      const sweepNow = t0 + 31 * dayMs;
      const swept = await sweepExpiredExports(db(), bucket, tenantA, sweepNow);
      expect(swept).toBe(1);

      const oldAfter = await getExportRun(db(), tenantA, oldRun.runId);
      expect(oldAfter?.r2Key).toBeNull();
      const freshAfter = await getExportRun(db(), tenantA, freshRun.runId);
      expect(freshAfter?.r2Key).not.toBeNull();

      expect([...store.keys()].some((k) => k.includes(oldRun.runId))).toBe(false);
      expect([...store.keys()].some((k) => k.includes(freshRun.runId))).toBe(true);
    });
  });

  describe("the lifecycle threads runId and locale to the emitter", () => {
    it("signs a pdf run's stored colophon with its own run id", async () => {
      const id1 = crypto.randomUUID();
      await seedDescription({
        id: id1,
        tenantId: TENANT_A,
        repositoryId: REPO_A,
        referenceCode: uniqueCode("colophon"),
        title: "Colophon record",
      });
      const { bucket, store } = mockBucket();
      const started = await startExportRun(
        { db: db(), bucket, tenant: tenantA, user: owner, locale: "en" },
        {
          scope: { kind: "branch", descriptionId: id1 },
          form: "isadg",
          format: "pdf",
          includeAuthorities: false,
        },
      );
      await started.execute();

      const completed = await getExportRun(db(), tenantA, started.runId);
      expect(completed?.status).toBe("completed");
      const bytes = store.get(completed!.r2Key as string);
      expect(bytes).toBeDefined();
      const html = new TextDecoder().decode(bytes as Uint8Array);
      expect(html).toContain(started.runId);
    });
  });
});
