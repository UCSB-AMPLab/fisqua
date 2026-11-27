/**
 * Tests — writes to one record that move the versions of the records
 * that publish its values
 *
 * This suite pins the four writes whose change reaches other records'
 * published files. A repository save that changes a field its
 * descriptions publish (here its city, which their EAD and Dublin Core
 * files carry) moves every one of its descriptions' versions, and a save
 * of another field moves none. A function term whose canonical name
 * changes moves every entity whose primary function it is, in
 * milliseconds; a save that keeps the name moves none. An operator's
 * change of a tenant's METS base URL moves every description of the
 * tenant, and a change of another manifest field moves none. A
 * reference code that starts or stops being live, by a create or a
 * delete, moves every description of the federation that records it as
 * a former reference code, under that provider only, as the export
 * reads `legacy_ids`; descriptions of another federation, other
 * providers, other codes and malformed lists are left as they are, and
 * no content of `legacy_ids` can make the triggering write fail. A
 * term save, a term rename and a manifest save made from a stale read
 * (a concurrent write between the action's read and its batch) are
 * refused with a conflict and write nothing.
 *
 * Each watched record starts at a version ten seconds ahead of the
 * clock and must end strictly past it. Every value here is a test value.
 *
 * @version v0.9.0
 */
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { eq, inArray } from "drizzle-orm";
import { RouterContextProvider } from "react-router";
import * as schema from "../../app/db/schema";
import {
  applyMigrations,
  cleanDatabase,
  seedFederations,
  seedTenants,
  seedOperatorUser,
  OPERATOR_TEST_USER_ID,
  OPERATOR_TEST_EMAIL,
  DEFAULT_TEST_TENANT_ID,
  DEFAULT_TEST_FEDERATION_ID,
  SECOND_TEST_TENANT_ID,
} from "../helpers/db";
import { createTestUser } from "../helpers/auth";
import { createTestRepository } from "../helpers/repositories";
import { createTestDescription } from "../helpers/descriptions";
import { createTestEntity } from "../helpers/entities";
import { tenantContext, userContext, type User } from "../../app/context";
import { makeTenantContext, makeUserContext } from "../helpers/context";
import { PLATFORM_TENANT_ID } from "../../app/lib/tenant";
import { formerCodeHoldersFollow } from "../../app/lib/export/former-codes.server";
import { action as repositoryAction } from "../../app/routes/_auth.admin.repositories.$id";
import { action as termAction } from "../../app/routes/_auth.admin.vocabularies.functions.$id";
import { action as termsAction } from "../../app/routes/_auth.admin.vocabularies.functions";
import { action as operatorAction } from "../../app/routes/_operator.tenants.$slug";
import { action as createDescription } from "../../app/routes/_auth.admin.descriptions.new";
import { action as descriptionPage } from "../../app/routes/_auth.admin.descriptions.$id";
import { action as descriptionTree } from "../../app/routes/_auth.admin.descriptions";

const A = DEFAULT_TEST_TENANT_ID;
const B = SECOND_TEST_TENANT_ID;

function db() {
  return drizzle(env.DB, { schema });
}

let admin: User;
let ahead = 0;

function context(user: User, tenant: Record<string, unknown> = {}): any {
  const ctx = new RouterContextProvider();
  ctx.set(userContext, user);
  ctx.set(tenantContext, makeTenantContext({ id: A, multiRepositoryEnabled: true, ...tenant }));
  (ctx as any).cloudflare = { env };
  return ctx;
}

async function post(
  action: (args: any) => Promise<unknown>,
  params: Record<string, string>,
  fields: Record<string, string>,
  ctx: any = context(admin),
) {
  const body = new URLSearchParams(fields);
  try {
    return await action({
      request: new Request("http://neogranadina.fisqua.test/admin/x", {
        method: "POST",
        body,
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
      }),
      context: ctx,
      params,
    });
  } catch (thrown) {
    if (thrown instanceof Response) return thrown;
    throw thrown;
  }
}

/**
 * The D1 binding with `concurrent` run once, just before the first
 * batch: a write that lands between an action's reads and its batch.
 */
function racedDb(concurrent: (db: D1Database) => Promise<unknown>): D1Database {
  let done = false;
  return new Proxy(env.DB, {
    get(target, prop) {
      if (prop === "batch") {
        return async (statements: D1PreparedStatement[]) => {
          if (!done) {
            done = true;
            await concurrent(target);
          }
          return target.batch(statements);
        };
      }
      const value = Reflect.get(target, prop);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function withDb(ctx: any, DB: D1Database): any {
  ctx.cloudflare = { env: { ...env, DB } };
  return ctx;
}

async function ageDescriptions(ids: string[]) {
  ahead = Date.now() + 10_000;
  await db().update(schema.descriptions).set({ updatedAt: ahead }).where(inArray(schema.descriptions.id, ids));
}

async function descriptionVersion(id: string) {
  return (await db().select({ v: schema.descriptions.updatedAt }).from(schema.descriptions)
    .where(eq(schema.descriptions.id, id)).get())!.v;
}

async function entityVersion(id: string) {
  return (await db().select({ v: schema.entities.updatedAt }).from(schema.entities)
    .where(eq(schema.entities.id, id)).get())!.v;
}

/** A description recording `code` under `provider` in its legacy ids. */
async function holder(tenantId: string, repositoryId: string, ref: string, legacyIds: string) {
  const row = await createTestDescription({ tenantId, repositoryId, referenceCode: ref });
  await db().update(schema.descriptions).set({ legacyIds }).where(eq(schema.descriptions.id, row.id));
  return row.id;
}

const former = (id: string | number) => JSON.stringify([{ provider: "former-reference-code", id }]);

beforeAll(async () => {
  await applyMigrations();
});

beforeEach(async () => {
  await cleanDatabase();
  await seedFederations();
  await seedTenants();
  const row = await createTestUser({ isAdmin: true });
  admin = makeUserContext({ id: row.id, tenantId: A, isAdmin: true });
});

describe("a repository save", () => {
  it("that changes a field its descriptions publish moves each of their versions", async () => {
    const repo = await createTestRepository({ tenantId: A, code: "FAN-R", city: "Tunja" });
    const other = await createTestRepository({ tenantId: A, code: "FAN-O" });
    const mine = await createTestDescription({ tenantId: A, repositoryId: repo.id, referenceCode: "FAN-R-1" });
    const theirs = await createTestDescription({ tenantId: A, repositoryId: other.id, referenceCode: "FAN-O-1" });
    await ageDescriptions([mine.id, theirs.id]);
    const out: any = await post(repositoryAction, { id: repo.id }, { _action: "update", city: "Duitama" });
    expect(out.ok).toBe(true);
    expect(await descriptionVersion(mine.id)).toBeGreaterThan(ahead);
    expect(await descriptionVersion(theirs.id)).toBe(ahead);
  });

  it("that changes no such field leaves their versions", async () => {
    const repo = await createTestRepository({ tenantId: A, code: "FAN-N" });
    const mine = await createTestDescription({ tenantId: A, repositoryId: repo.id, referenceCode: "FAN-N-1" });
    await ageDescriptions([mine.id]);
    const out: any = await post(repositoryAction, { id: repo.id }, { _action: "update", notes: "Nota de prueba" });
    expect(out.ok).toBe(true);
    expect(await descriptionVersion(mine.id)).toBe(ahead);
  });
});

describe("a function term's canonical name", () => {
  async function seedTermWithEntity(id: string) {
    const now = Math.floor(Date.now() / 1000);
    await db().insert(schema.vocabularyTerms).values({
      id, federationId: DEFAULT_TEST_FEDERATION_ID, canonical: "Notario", category: null,
      status: "approved", entityCount: 1, createdAt: now, updatedAt: now,
    });
    const linked = await createTestEntity({ entityCode: `ne-${id}` });
    const unlinked = await createTestEntity({ entityCode: `ne-${id}-x` });
    ahead = Date.now() + 10_000;
    await db().update(schema.entities).set({ primaryFunctionId: id, updatedAt: ahead }).where(eq(schema.entities.id, linked.id));
    await db().update(schema.entities).set({ updatedAt: ahead }).where(eq(schema.entities.id, unlinked.id));
    return { linked: linked.id, unlinked: unlinked.id };
  }

  it("changed on the term's page moves every entity whose primary function it is", async () => {
    const { linked, unlinked } = await seedTermWithEntity("fan-t1");
    await post(termAction, { id: "fan-t1" }, { intent: "save", canonical: "Escribano", status: "approved" });
    expect((await db().select().from(schema.vocabularyTerms).where(eq(schema.vocabularyTerms.id, "fan-t1")).get())!.canonical).toBe("Escribano");
    expect(await entityVersion(linked)).toBeGreaterThan(ahead);
    expect(await entityVersion(unlinked)).toBe(ahead);
  });

  it("kept on the term's page leaves the entities", async () => {
    const { linked } = await seedTermWithEntity("fan-t2");
    await post(termAction, { id: "fan-t2" }, { intent: "save", canonical: "Notario", status: "approved", notes: "Nota" });
    expect(await entityVersion(linked)).toBe(ahead);
  });

  it("saved from a stale read on the term's page is refused and writes nothing", async () => {
    const { linked } = await seedTermWithEntity("fan-t4");
    const raced = racedDb((d) => d.prepare("UPDATE vocabulary_terms SET canonical = 'Alcalde' WHERE id = 'fan-t4'").run());
    const out: any = await post(termAction, { id: "fan-t4" },
      { intent: "save", canonical: "Escribano", status: "approved" }, withDb(context(admin), raced));
    expect(out).toMatchObject({ error: "conflict" });
    expect((await db().select().from(schema.vocabularyTerms).where(eq(schema.vocabularyTerms.id, "fan-t4")).get())!.canonical).toBe("Alcalde");
    expect(await entityVersion(linked)).toBe(ahead);
  });

  it("renamed from a stale read on the list is refused and writes nothing", async () => {
    const { linked } = await seedTermWithEntity("fan-t5");
    const raced = racedDb((d) => d.prepare("UPDATE vocabulary_terms SET canonical = 'Alcalde' WHERE id = 'fan-t5'").run());
    const out: any = await post(termsAction, {},
      { intent: "rename", termId: "fan-t5", canonical: "Escribano" }, withDb(context(admin), raced));
    expect(out).toMatchObject({ error: "conflict" });
    expect((await db().select().from(schema.vocabularyTerms).where(eq(schema.vocabularyTerms.id, "fan-t5")).get())!.canonical).toBe("Alcalde");
    expect(await entityVersion(linked)).toBe(ahead);
  });

  it("renamed from the list moves every entity whose primary function it is", async () => {
    const { linked, unlinked } = await seedTermWithEntity("fan-t3");
    await post(termsAction, {}, { intent: "rename", termId: "fan-t3", canonical: "Escribano" });
    expect((await db().select().from(schema.vocabularyTerms).where(eq(schema.vocabularyTerms.id, "fan-t3")).get())!.canonical).toBe("Escribano");
    expect(await entityVersion(linked)).toBeGreaterThan(ahead);
    expect(await entityVersion(unlinked)).toBe(ahead);
  });
});

describe("a tenant's METS base URL", () => {
  function operatorContext(): any {
    const c = new RouterContextProvider();
    c.set(userContext, makeUserContext({
      id: OPERATOR_TEST_USER_ID, tenantId: PLATFORM_TENANT_ID, isSuperAdmin: true, email: OPERATOR_TEST_EMAIL,
    }));
    c.set(tenantContext, makeTenantContext({ id: PLATFORM_TENANT_ID }));
    (c as any).cloudflare = { env };
    return c;
  }

  async function seedTwoTenants() {
    await seedOperatorUser();
    const repoA = await createTestRepository({ tenantId: A, code: "FAN-MA" });
    const repoB = await createTestRepository({ tenantId: B, code: "FAN-MB" });
    const mine = await createTestDescription({ tenantId: A, repositoryId: repoA.id, referenceCode: "FAN-M-1" });
    const theirs = await createTestDescription({ tenantId: B, repositoryId: repoB.id, referenceCode: "FAN-M-2" });
    await ageDescriptions([mine.id, theirs.id]);
    return { mine: mine.id, theirs: theirs.id };
  }

  it("changed moves every description of the tenant", async () => {
    const { mine, theirs } = await seedTwoTenants();
    const out: any = await post(operatorAction, { slug: "neogranadina" },
      { intent: "set_manifest_fields", metsBaseUrl: "https://files.test/mets" }, operatorContext());
    expect(out).toEqual({ manifestSaved: true, noop: false });
    expect(await descriptionVersion(mine)).toBeGreaterThan(ahead);
    expect(await descriptionVersion(theirs)).toBe(ahead);
  });

  it("saved from a stale read is refused, keeping the URL another save wrote", async () => {
    const { mine } = await seedTwoTenants();
    const raced = racedDb((d) =>
      d.prepare("UPDATE tenants SET mets_base_url = 'https://other.test/mets' WHERE id = ?").bind(A).run());
    const out: any = await post(operatorAction, { slug: "neogranadina" },
      { intent: "set_manifest_fields", metsBaseUrl: "https://files.test/mets" }, withDb(operatorContext(), raced));
    expect(out).toMatchObject({ error: "conflict" });
    const row = await db().select({ url: schema.tenants.metsBaseUrl }).from(schema.tenants).where(eq(schema.tenants.id, A)).get();
    expect(row!.url).toBe("https://other.test/mets");
    expect(await descriptionVersion(mine)).toBe(ahead);
  });

  it("left as it is while another manifest field changes leaves them", async () => {
    const { mine } = await seedTwoTenants();
    const out: any = await post(operatorAction, { slug: "neogranadina" },
      { intent: "set_manifest_fields", providerName: "Provider" }, operatorContext());
    expect(out).toEqual({ manifestSaved: true, noop: false });
    expect(await descriptionVersion(mine)).toBe(ahead);
  });
});

describe("a reference code that starts or stops being live", () => {
  let repoA: string;
  let repoB: string;
  beforeEach(async () => {
    repoA = (await createTestRepository({ tenantId: A, code: "FAN-CA" })).id;
    repoB = (await createTestRepository({ tenantId: B, code: "FAN-CB" })).id;
  });

  it("moves exactly the federation's descriptions that record it as a former reference code", async () => {
    const hit = await holder(A, repoA, "FAN-H1", former("FAN-X"));
    const number = await holder(A, repoA, "FAN-H2", former(4417));
    const mixed = await holder(A, repoA, "FAN-H3",
      JSON.stringify([{ provider: "zasqua-2026-04", id: "ne-1" }, { provider: "former-reference-code", id: "FAN-X" }]));
    const otherProvider = await holder(A, repoA, "FAN-H4", JSON.stringify([{ provider: "zasqua-2026-04", id: "FAN-X" }]));
    const otherCode = await holder(A, repoA, "FAN-H5", former("FAN-Y"));
    const malformed = await holder(A, repoA, "FAN-H6", "not json former-reference-code");
    const notArray = await holder(A, repoA, "FAN-H7", JSON.stringify({ provider: "former-reference-code", id: "FAN-X" }));
    const otherFederation = await holder(B, repoB, "FAN-H8", former("FAN-X"));
    const all = [hit, number, mixed, otherProvider, otherCode, malformed, notArray, otherFederation];
    await ageDescriptions(all);
    await formerCodeHoldersFollow(db(), A, ["FAN-X", "4417"])!.run();
    const moved = [];
    for (const id of all) if ((await descriptionVersion(id)) > ahead) moved.push(id);
    expect(moved.sort()).toEqual([hit, number, mixed].sort());
  });

  it("never fails the write it follows, whatever a legacy_ids holds", async () => {
    const mixed = await holder(A, repoA, "FAN-S1", JSON.stringify(["bad", { provider: "former-reference-code", id: "FAN-Z" }]));
    const shapes = [
      "not json at all former-reference-code",
      "",
      JSON.stringify({ provider: "former-reference-code", id: "FAN-Z" }),
      JSON.stringify("former-reference-code FAN-Z"),
      JSON.stringify([1, null, true, [], "former-reference-code", { provider: "former-reference-code" }]),
      JSON.stringify([{ provider: "former-reference-code", id: { nested: "FAN-Z" } }, { provider: "former-reference-code", id: "" }]),
      JSON.stringify([[{ provider: "former-reference-code", id: "FAN-Z" }]]),
    ];
    const others = [];
    for (const [i, text] of shapes.entries()) others.push(await holder(A, repoA, `FAN-S${i + 2}`, text));
    await ageDescriptions([mixed, ...others]);
    const out: any = await post(createDescription, {}, {
      title: "Fondo de prueba", descriptionLevel: "fonds", referenceCode: "FAN-Z", localIdentifier: "fan-z",
      repositoryId: repoA, dateExpression: "1700", extent: "1 caja", scopeContent: "Contenido",
      creatorDisplay: "Cabildo",
    });
    expect(out?.errors ?? out?.error).toBeUndefined();
    const created = await db().select().from(schema.descriptions).where(eq(schema.descriptions.referenceCode, "FAN-Z")).all();
    expect(created).toHaveLength(1);
    expect(await descriptionVersion(mixed)).toBeGreaterThan(ahead);
    for (const id of others) expect(await descriptionVersion(id)).toBe(ahead);

    await post(descriptionPage, { id: created[0].id }, { _action: "delete" });
    expect(await db().select().from(schema.descriptions).where(eq(schema.descriptions.referenceCode, "FAN-Z")).all()).toEqual([]);
  });

  it("is moved by creating a description with it", async () => {
    const hit = await holder(A, repoA, "FAN-C1", former("FAN-NEW"));
    await ageDescriptions([hit]);
    const out: any = await post(createDescription, {}, {
      title: "Fondo de prueba", descriptionLevel: "fonds", referenceCode: "FAN-NEW", localIdentifier: "fan-new",
      repositoryId: repoA, dateExpression: "1700", extent: "1 caja", scopeContent: "Contenido",
      creatorDisplay: "Cabildo",
    });
    expect(out?.errors ?? out?.error).toBeUndefined();
    expect(await descriptionVersion(hit)).toBeGreaterThan(ahead);
  });

  it("is moved by deleting the description that holds it, from its page and from the tree", async () => {
    const pageHolder = await holder(A, repoA, "FAN-D1", former("FAN-GONE-1"));
    const treeHolder = await holder(A, repoA, "FAN-D2", former("FAN-GONE-2"));
    const gone1 = await createTestDescription({ tenantId: A, repositoryId: repoA, referenceCode: "FAN-GONE-1" });
    const gone2 = await createTestDescription({ tenantId: A, repositoryId: repoA, referenceCode: "FAN-GONE-2" });
    await ageDescriptions([pageHolder, treeHolder]);
    await post(descriptionPage, { id: gone1.id }, { _action: "delete" });
    await post(descriptionTree, {}, { _action: "delete", descriptionId: gone2.id });
    expect(await db().select().from(schema.descriptions).where(inArray(schema.descriptions.id, [gone1.id, gone2.id])).all()).toEqual([]);
    expect(await descriptionVersion(pageHolder)).toBeGreaterThan(ahead);
    expect(await descriptionVersion(treeHolder)).toBeGreaterThan(ahead);
  });
});

// @version v0.9.0
