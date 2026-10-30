/**
 * Tests — manifest settings on repositories and tenants
 *
 * A pipeline manifest takes its rights and attribution from the
 * volume's repository and its homepage, provider and METS link from the
 * tenant. This suite pins the columns that hold those values and the
 * forms that set them:
 *
 *   - each of the eight columns round-trips through Drizzle;
 *   - `readManifestFields` trims, turns an empty field into null,
 *     strips trailing slashes from the site and METS URLs, and refuses a
 *     rights URI or URL that is not http or https under its field name;
 *   - the repository edit and create actions save and clear each of the
 *     three repository fields, and refuse a bad rights URI naming it;
 *   - the operator tenant action saves and clears each of the five
 *     tenant fields, audits a change, writes nothing on no change, and
 *     refuses a bad URL naming the field.
 *
 * @version v0.8.0
 */
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { and, eq } from "drizzle-orm";
import { RouterContextProvider } from "react-router";
import {
  applyMigrations,
  cleanDatabase,
  seedTenants,
  seedOperatorUser,
  OPERATOR_TEST_USER_ID,
  OPERATOR_TEST_EMAIL,
  DEFAULT_TEST_TENANT_ID,
} from "../helpers/db";
import { createTestUser } from "../helpers/auth";
import { createTestRepository } from "../helpers/repositories";
import { tenantContext, userContext, type User } from "../../app/context";
import { makeTenantContext, makeUserContext } from "../helpers/context";
import { PLATFORM_TENANT_ID } from "../../app/lib/tenant";
import * as schema from "../../app/db/schema";
import {
  readManifestFields,
  REPOSITORY_MANIFEST_FIELDS,
  TENANT_MANIFEST_FIELDS,
  URI_SCHEME_MESSAGE,
} from "../../app/lib/validation/manifest-fields";

const NEW_ROUTE = "../../app/routes/_auth.admin.repositories.new";
const DETAIL_ROUTE = "../../app/routes/_auth.admin.repositories.$id";
const OPERATOR_ROUTE = "../../app/routes/_operator.tenants.$slug";

function db() {
  return drizzle(env.DB, { schema });
}

function form(entries: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(entries)) f.set(k, v);
  return f;
}

function adminCtx(user: User): any {
  const c = new RouterContextProvider();
  c.set(userContext, user);
  c.set(tenantContext, makeTenantContext({ id: DEFAULT_TEST_TENANT_ID, multiRepositoryEnabled: true }));
  (c as any).cloudflare = { env };
  return c;
}

function operatorCtx(): any {
  const c = new RouterContextProvider();
  c.set(
    userContext,
    makeUserContext({
      id: OPERATOR_TEST_USER_ID,
      tenantId: PLATFORM_TENANT_ID,
      isSuperAdmin: true,
      email: OPERATOR_TEST_EMAIL,
    }),
  );
  c.set(
    tenantContext,
    makeTenantContext({
      id: PLATFORM_TENANT_ID,
      slug: "platform",
      name: "Platform",
      kind: "platform",
      descriptiveStandard: null,
    }),
  );
  (c as any).cloudflare = { env };
  return c;
}

async function adminUser(): Promise<User> {
  const u = await createTestUser({ isAdmin: true, tenantId: DEFAULT_TEST_TENANT_ID });
  return makeUserContext({ id: u.id, tenantId: DEFAULT_TEST_TENANT_ID, isAdmin: true });
}

async function readRepository(id: string) {
  return db()
    .select()
    .from(schema.repositories)
    .where(and(eq(schema.repositories.tenantId, DEFAULT_TEST_TENANT_ID), eq(schema.repositories.id, id)))
    .get();
}

async function readTenant() {
  return db().select().from(schema.tenants).where(eq(schema.tenants.id, DEFAULT_TEST_TENANT_ID)).get();
}

describe("readManifestFields", () => {
  it("trims values and turns empty fields into null", () => {
    const r = readManifestFields(
      form({ manifestRights: "  https://example.test/rights  ", attributionEn: "   " }),
      REPOSITORY_MANIFEST_FIELDS,
    );
    expect(r).toEqual({
      ok: true,
      values: { manifestRights: "https://example.test/rights", attributionEn: null, attributionEs: null },
    });
  });

  it("strips trailing slashes from the site and METS URLs only", () => {
    const r = readManifestFields(
      form({
        publicSiteUrl: "https://site.test//",
        providerUrl: "https://provider.test/",
        metsBaseUrl: "https://files.test/mets/",
      }),
      TENANT_MANIFEST_FIELDS,
    );
    expect(r.ok && r.values).toEqual({
      publicSiteUrl: "https://site.test",
      publicSiteName: null,
      providerName: null,
      providerUrl: "https://provider.test/",
      metsBaseUrl: "https://files.test/mets",
    });
  });

  it.each([
    ["manifestRights", REPOSITORY_MANIFEST_FIELDS],
    ["publicSiteUrl", TENANT_MANIFEST_FIELDS],
    ["providerUrl", TENANT_MANIFEST_FIELDS],
    ["metsBaseUrl", TENANT_MANIFEST_FIELDS],
  ] as const)("refuses a value that is not an http or https URI in %s, naming it", (field, fields) => {
    for (const bad of ["not a url", "ftp://files.test/x", "mailto:someone@example.test"]) {
      const r = readManifestFields(form({ [field]: bad }), fields as readonly string[] as any);
      expect(r).toEqual({ ok: false, errors: { [field]: [URI_SCHEME_MESSAGE] } });
    }
  });

  it("accepts any text in the attribution and name fields", () => {
    const r = readManifestFields(
      form({ attributionEn: "not a url", attributionEs: "tampoco" }),
      REPOSITORY_MANIFEST_FIELDS,
    );
    expect(r.ok).toBe(true);
  });
});

describe("manifest setting columns", () => {
  beforeAll(async () => {
    await applyMigrations();
  });
  beforeEach(async () => {
    await cleanDatabase();
    await seedTenants();
  });

  it.each(REPOSITORY_MANIFEST_FIELDS)("repositories.%s round-trips", async (field) => {
    const repo = await createTestRepository({ [field]: `value of ${field}` });
    expect((await readRepository(repo.id))![field]).toBe(`value of ${field}`);
    await db()
      .update(schema.repositories)
      .set({ [field]: null })
      .where(and(eq(schema.repositories.tenantId, DEFAULT_TEST_TENANT_ID), eq(schema.repositories.id, repo.id)));
    expect((await readRepository(repo.id))![field]).toBeNull();
  });

  it.each(TENANT_MANIFEST_FIELDS)("tenants.%s round-trips", async (field) => {
    expect((await readTenant())![field]).toBeNull();
    await db()
      .update(schema.tenants)
      .set({ [field]: `value of ${field}` })
      .where(eq(schema.tenants.id, DEFAULT_TEST_TENANT_ID));
    expect((await readTenant())![field]).toBe(`value of ${field}`);
  });
});

describe("repository forms", () => {
  beforeAll(async () => {
    await applyMigrations();
  });
  beforeEach(async () => {
    await cleanDatabase();
    await seedTenants();
  });

  function updateRequest(id: string, entries: Record<string, string>): Request {
    const body = form({ _action: "update", code: "test-1", name: "Test repository", countryCode: "COL", ...entries });
    return new Request(`http://neogranadina.fisqua.test/admin/repositories/${id}`, { method: "POST", body });
  }

  const VALUES = {
    manifestRights: "https://example.test/rights/",
    attributionEn: "English attribution",
    attributionEs: "Atribución en español",
  } as const;

  it.each(REPOSITORY_MANIFEST_FIELDS)("the edit form saves and clears %s", async (field) => {
    const user = await adminUser();
    const repo = await createTestRepository({ code: "test-1" });
    const { action } = await import(DETAIL_ROUTE);

    const saved = await action({
      request: updateRequest(repo.id, { [field]: VALUES[field] }),
      context: adminCtx(user),
      params: { id: repo.id },
    } as any);
    expect(saved).toMatchObject({ ok: true });
    expect((await readRepository(repo.id))![field]).toBe(VALUES[field]);

    const cleared = await action({
      request: updateRequest(repo.id, { [field]: "" }),
      context: adminCtx(user),
      params: { id: repo.id },
    } as any);
    expect(cleared).toMatchObject({ ok: true });
    expect((await readRepository(repo.id))![field]).toBeNull();
  });

  it("the edit form refuses a rights value that is not a URI, naming the field", async () => {
    const user = await adminUser();
    const repo = await createTestRepository({ code: "test-1", manifestRights: "https://example.test/kept" });
    const { action } = await import(DETAIL_ROUTE);
    const result = (await action({
      request: updateRequest(repo.id, { manifestRights: "CC BY-NC 4.0" }),
      context: adminCtx(user),
      params: { id: repo.id },
    } as any)) as any;
    expect(result.ok).toBe(false);
    expect(result.errors.manifestRights).toEqual([URI_SCHEME_MESSAGE]);
    expect((await readRepository(repo.id))!.manifestRights).toBe("https://example.test/kept");
  });

  function createRequest(entries: Record<string, string>): Request {
    const body = form({ _action: "create", code: "test-new", name: "New repository", countryCode: "COL", enabled: "on", ...entries });
    return new Request("http://neogranadina.fisqua.test/admin/repositories/new", { method: "POST", body });
  }

  async function createdRepository() {
    return db()
      .select()
      .from(schema.repositories)
      .where(and(eq(schema.repositories.tenantId, DEFAULT_TEST_TENANT_ID), eq(schema.repositories.code, "test-new")))
      .get();
  }

  it("the create form saves all three fields", async () => {
    const user = await adminUser();
    const { action } = await import(NEW_ROUTE);
    const result = (await action({ request: createRequest(VALUES), context: adminCtx(user), params: {} } as any)) as Response;
    expect(result.status).toBe(302);
    expect(await createdRepository()).toMatchObject(VALUES);
  });

  it("the create form stores empty fields as null", async () => {
    const user = await adminUser();
    const { action } = await import(NEW_ROUTE);
    const empty = { manifestRights: "", attributionEn: "", attributionEs: "" };
    const result = (await action({ request: createRequest(empty), context: adminCtx(user), params: {} } as any)) as Response;
    expect(result.status).toBe(302);
    expect(await createdRepository()).toMatchObject({ manifestRights: null, attributionEn: null, attributionEs: null });
  });

  it("the create form refuses a rights value that is not a URI, naming the field", async () => {
    const user = await adminUser();
    const { action } = await import(NEW_ROUTE);
    const result = (await action({
      request: createRequest({ manifestRights: "by-nc" }),
      context: adminCtx(user),
      params: {},
    } as any)) as any;
    expect(result.ok).toBe(false);
    expect(result.errors.manifestRights).toEqual([URI_SCHEME_MESSAGE]);
    expect(await createdRepository()).toBeUndefined();
  });
});

describe("operator tenant manifest settings", () => {
  beforeAll(async () => {
    await applyMigrations();
  });
  beforeEach(async () => {
    await cleanDatabase();
    await seedTenants();
    await seedOperatorUser();
  });

  const VALUES = {
    publicSiteUrl: "https://site.test",
    publicSiteName: "Site",
    providerName: "Provider",
    providerUrl: "https://provider.test/",
    metsBaseUrl: "https://files.test/mets",
  } as const;

  async function post(entries: Record<string, string>) {
    const { action } = await import(OPERATOR_ROUTE);
    const body = new URLSearchParams({ intent: "set_manifest_fields", ...entries });
    return action({
      request: new Request("https://platform.fisqua.test/operator/tenants/neogranadina", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: body.toString(),
      }),
      context: operatorCtx(),
      params: { slug: "neogranadina" },
    } as any) as Promise<any>;
  }

  async function auditRows() {
    return db()
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.targetTenantId, DEFAULT_TEST_TENANT_ID))
      .all();
  }

  it.each(TENANT_MANIFEST_FIELDS)("saves and clears %s", async (field) => {
    expect(await post({ [field]: VALUES[field] })).toEqual({ manifestSaved: true, noop: false });
    expect((await readTenant())![field]).toBe(VALUES[field]);
    expect(await post({ [field]: "" })).toEqual({ manifestSaved: true, noop: false });
    expect((await readTenant())![field]).toBeNull();
  });

  it("audits a change with the field's before and after", async () => {
    await post({ providerName: "Provider" });
    const rows = await auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].action).toBe("set_capability");
    const details = JSON.parse(rows[0].details as unknown as string);
    expect(details).toMatchObject({
      settingsChanged: "manifest_fields",
      changes: [{ field: "providerName", from: null, to: "Provider" }],
    });
  });

  it("writes nothing when no field changes", async () => {
    expect(await post({})).toEqual({ manifestSaved: true, noop: true });
    expect(await auditRows()).toHaveLength(0);
  });

  it("refuses a URL that is not http or https, naming the field", async () => {
    const result = await post({ metsBaseUrl: "files.test/mets", providerName: "Provider" });
    expect(result).toEqual({ fieldErrors: { metsBaseUrl: [URI_SCHEME_MESSAGE] } });
    const tenant = await readTenant();
    expect(tenant!.metsBaseUrl).toBeNull();
    expect(tenant!.providerName).toBeNull();
  });
});

// @version v0.8.0
