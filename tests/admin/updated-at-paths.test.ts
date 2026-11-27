/**
 * Tests — tree and merge writes move the version of every record whose
 * published content they change
 *
 * This suite pins the writes that change what a record publishes
 * through a field another record's action sets. A description's
 * `child_count` (and with it `has_children` and `children_level`) is
 * stored on the parent, so creating, deleting or moving a child changes
 * the parent's published record; the order of a parent's children file
 * is the children's `position`, so swapping two siblings changes both;
 * and a merge hands the record merged away's retired codes to the
 * survivor's `former_codes`, so every merge changes the survivor. A
 * child's publication flag and level decide its parent's
 * `children_level`, so a toggle or a level change moves the parent. Each
 * case sets the records it watches to a version ahead of the clock, runs
 * the action through its route with real form data, and checks that
 * each of them now holds a version strictly past the one it held: a
 * write that set the clock's time would move the version back. A merge
 * whose survivor was merged away since the workbench opened is refused
 * and writes nothing.
 *
 * Every value here is a test value.
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
  DEFAULT_TEST_TENANT_ID,
} from "../helpers/db";
import { createTestUser } from "../helpers/auth";
import { createTestRepository } from "../helpers/repositories";
import { createTestDescription } from "../helpers/descriptions";
import { createTestEntity } from "../helpers/entities";
import { createTestPlace } from "../helpers/places";
import { tenantContext, userContext, type User } from "../../app/context";
import { makeTenantContext, makeUserContext } from "../helpers/context";
import { action as createDescription } from "../../app/routes/_auth.admin.descriptions.new";
import { action as descriptionPage } from "../../app/routes/_auth.admin.descriptions.$id";
import { action as descriptionTree } from "../../app/routes/_auth.admin.descriptions";
import { action as entityMergeAction } from "../../app/routes/_auth.admin.entities.$id.merge";
import { action as placeMerge } from "../../app/routes/_auth.admin.places.$id.merge";
import { action as placeSplit } from "../../app/routes/_auth.admin.places.$id.split";
import { withEvidence } from "../helpers/merge-evidence";
const entityMerge = withEvidence(entityMergeAction);

const A = DEFAULT_TEST_TENANT_ID;
/**
 * The version every watched record holds before the action: ten seconds
 * ahead of the clock, as a save that moved a version past the clock
 * leaves it. Set afresh by each `age` call.
 */
let ahead = 0;
function nextAhead() {
  ahead = Date.now() + 10_000;
  return ahead;
}

function db() {
  return drizzle(env.DB, { schema });
}

let admin: User;
let repoId: string;

function context(): any {
  const ctx = new RouterContextProvider();
  ctx.set(userContext, admin);
  ctx.set(tenantContext, makeTenantContext({ id: A }));
  (ctx as any).cloudflare = { env };
  return ctx;
}

async function post(
  action: (args: any) => Promise<unknown>,
  id: string | undefined,
  fields: Record<string, string>,
) {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.set(k, v);
  try {
    return await action({
      request: new Request("http://neogranadina.fisqua.test/admin/x", { method: "POST", body: form }),
      context: context(),
      params: id ? { id } : {},
    });
  } catch (thrown) {
    // A redirect is thrown or returned; either way the write is done.
    if (thrown instanceof Response) return thrown;
    throw thrown;
  }
}

async function ageDescriptions(ids: string[]) {
  await db().update(schema.descriptions).set({ updatedAt: nextAhead() }).where(inArray(schema.descriptions.id, ids));
}

async function descriptionRow(id: string) {
  return (await db().select().from(schema.descriptions).where(eq(schema.descriptions.id, id)).get())!;
}

async function versionOf(table: typeof schema.entities | typeof schema.places, id: string) {
  const row = await db().select({ updatedAt: table.updatedAt }).from(table).where(eq(table.id, id)).get();
  return row!.updatedAt;
}

/** A fonds with `n` series beneath it, child counts as stored. */
async function seedTree(n: number) {
  const fonds = await createTestDescription({
    tenantId: A, repositoryId: repoId, descriptionLevel: "fonds", referenceCode: "UAP-F", childCount: n,
  });
  const series = [];
  for (let i = 0; i < n; i++) {
    series.push(
      await createTestDescription({
        tenantId: A,
        repositoryId: repoId,
        descriptionLevel: "series",
        referenceCode: `UAP-F-S${i + 1}`,
        parentId: fonds.id,
        rootDescriptionId: fonds.id,
        depth: 1,
        position: i,
        pathCache: `${fonds.id}`,
      }),
    );
  }
  return { fonds, series };
}

/** Fills the columns ISAD(G) requires of a series, so an update validates. */
async function completeForUpdate(id: string) {
  await db()
    .update(schema.descriptions)
    .set({ dateExpression: "1700", extent: "1 legajo", scopeContent: "Contenido de prueba" })
    .where(eq(schema.descriptions.id, id));
}

function expectMoved(version: number) {
  expect(version).toBeGreaterThan(ahead);
}

describe("writes that change another record's published content move its version", () => {
  beforeAll(async () => {
    await applyMigrations();
  });
  beforeEach(async () => {
    await cleanDatabase();
    await seedFederations();
    await seedTenants();
    const row = await createTestUser({ isAdmin: true });
    admin = makeUserContext({ id: row.id, tenantId: A, isAdmin: true });
    repoId = (await createTestRepository({ tenantId: A, code: "uap-repo" })).id;
  });

  it("creating a child moves the parent's version with its child count", async () => {
    const { fonds } = await seedTree(0);
    await ageDescriptions([fonds.id]);
    const result: any = await post(createDescription, undefined, {
      title: "Serie de prueba",
      descriptionLevel: "series",
      referenceCode: "UAP-F-NEW",
      localIdentifier: "uap-new",
      repositoryId: repoId,
      parentId: fonds.id,
      dateExpression: "1700",
      extent: "1 legajo",
      scopeContent: "Contenido de prueba",
    });
    expect(result?.errors ?? result?.error).toBeUndefined();
    const parent = await descriptionRow(fonds.id);
    expect(parent.childCount).toBe(1);
    expectMoved(parent.updatedAt);
  });

  it("deleting a description from its page moves the parent's version with its child count", async () => {
    const { fonds, series } = await seedTree(2);
    await ageDescriptions([fonds.id]);
    await post(descriptionPage, series[1].id, { _action: "delete" });
    const parent = await descriptionRow(fonds.id);
    expect(parent.childCount).toBe(1);
    expectMoved(parent.updatedAt);
  });

  it("deleting a description from the tree moves the parent's version with its child count", async () => {
    const { fonds, series } = await seedTree(2);
    await ageDescriptions([fonds.id]);
    await post(descriptionTree, undefined, { _action: "delete", descriptionId: series[1].id });
    const parent = await descriptionRow(fonds.id);
    expect(parent.childCount).toBe(1);
    expectMoved(parent.updatedAt);
  });

  it("moving a description moves the old and the new parent's versions with their child counts", async () => {
    const { fonds, series } = await seedTree(2);
    const file = await createTestDescription({
      tenantId: A,
      repositoryId: repoId,
      descriptionLevel: "file",
      referenceCode: "UAP-F-S1-1",
      parentId: series[0].id,
      rootDescriptionId: fonds.id,
      depth: 2,
      position: 0,
    });
    await db().update(schema.descriptions).set({ childCount: 1 }).where(eq(schema.descriptions.id, series[0].id));
    await ageDescriptions([series[0].id, series[1].id, file.id]);
    await post(descriptionTree, undefined, {
      _action: "move", descriptionId: file.id, newParentId: series[1].id,
    });
    const oldParent = await descriptionRow(series[0].id);
    const newParent = await descriptionRow(series[1].id);
    expect((await descriptionRow(file.id)).parentId).toBe(series[1].id);
    expect(oldParent.childCount).toBe(0);
    expect(newParent.childCount).toBe(1);
    expectMoved(oldParent.updatedAt);
    expectMoved(newParent.updatedAt);
    expectMoved((await descriptionRow(file.id)).updatedAt);
  });

  it("reordering two siblings moves both their versions with their positions", async () => {
    const { series } = await seedTree(2);
    await ageDescriptions([series[0].id, series[1].id]);
    await post(descriptionTree, undefined, {
      _action: "reorder", descriptionId: series[1].id, direction: "up",
    });
    const first = await descriptionRow(series[0].id);
    const second = await descriptionRow(series[1].id);
    expect(first.position).toBe(1);
    expect(second.position).toBe(0);
    expectMoved(first.updatedAt);
    expectMoved(second.updatedAt);
  });

  it("an entity merge without folded names moves the survivor's version", async () => {
    const survivor = await createTestEntity({ entityCode: "ne-uap-sv" });
    const loser = await createTestEntity({ entityCode: "ne-uap-ls" });
    await db().update(schema.entities).set({ updatedAt: nextAhead() }).where(inArray(schema.entities.id, [survivor.id, loser.id]));
    await post(entityMerge, loser.id, {
      reason: "same person",
      loserId: loser.id,
      survivorId: survivor.id,
      linkIds: JSON.stringify([]),
    });
    expect((await db().select().from(schema.entities).where(eq(schema.entities.id, loser.id)).get())!.mergedInto).toBe(survivor.id);
    expectMoved(await versionOf(schema.entities, survivor.id));
  });

  it("a place merge without folded names moves the survivor's version", async () => {
    const survivor = await createTestPlace({ placeCode: "nl-uap-sv" });
    const loser = await createTestPlace({ placeCode: "nl-uap-ls" });
    await db().update(schema.places).set({ updatedAt: nextAhead() }).where(inArray(schema.places.id, [survivor.id, loser.id]));
    await post(placeMerge, loser.id, {
      reason: "same place",
      loserId: loser.id,
      survivorId: survivor.id,
      linkIds: JSON.stringify([]),
    });
    expect((await db().select().from(schema.places).where(eq(schema.places.id, loser.id)).get())!.mergedInto).toBe(survivor.id);
    expectMoved(await versionOf(schema.places, survivor.id));
    expectMoved(await versionOf(schema.places, loser.id));
  });

  it("a place split moves the original's version", async () => {
    const source = await createTestPlace({ placeCode: "nl-uap-sp", displayName: "Two Places" });
    await db().update(schema.places).set({ updatedAt: nextAhead() }).where(eq(schema.places.id, source.id));
    await post(placeSplit, source.id, {
      reason: "two places",
      nameA: "North",
      nameB: "South",
      choices: JSON.stringify({ coordinates: "original", tgnId: "original", hgisId: "original", whgId: "original" }),
      linkIds: JSON.stringify([]),
    });
    expect((await db().select().from(schema.places).where(eq(schema.places.id, source.id)).get())!.label).toBe("North");
    expectMoved(await versionOf(schema.places, source.id));
  });

  it("publishing or unpublishing a child moves the parent's version", async () => {
    const { fonds, series } = await seedTree(2);
    await ageDescriptions([fonds.id]);
    const out: any = await post(descriptionPage, series[0].id, { _action: "toggle_publish" });
    expect(out.ok).toBe(true);
    expect((await descriptionRow(series[0].id)).isPublished).toBe(false);
    expectMoved((await descriptionRow(fonds.id)).updatedAt);
  });

  it("changing a child's level moves the parent's version", async () => {
    const { fonds, series } = await seedTree(1);
    await ageDescriptions([fonds.id]);
    await completeForUpdate(series[0].id);
    const child = await descriptionRow(series[0].id);
    const out: any = await post(descriptionPage, series[0].id, {
      _action: "update",
      _updatedAt: String(child.updatedAt),
      descriptionLevel: "subseries",
    });
    expect(out?.errors ?? out?.error).toBeUndefined();
    expect((await descriptionRow(series[0].id)).descriptionLevel).toBe("subseries");
    expectMoved((await descriptionRow(fonds.id)).updatedAt);
  });

  it("an update that leaves a child's level and publication as they are leaves the parent's version", async () => {
    const { fonds, series } = await seedTree(1);
    await ageDescriptions([fonds.id]);
    await completeForUpdate(series[0].id);
    const child = await descriptionRow(series[0].id);
    const out: any = await post(descriptionPage, series[0].id, {
      _action: "update",
      _updatedAt: String(child.updatedAt),
      title: "Otro título",
    });
    expect(out?.errors ?? out?.error).toBeUndefined();
    expect((await descriptionRow(series[0].id)).title).toBe("Otro título");
    expect((await descriptionRow(fonds.id)).updatedAt).toBe(ahead);
  });

  it("a place merge whose survivor was merged away since the workbench opened is refused", async () => {
    const third = await createTestPlace({ placeCode: "nl-uap-th" });
    const survivor = await createTestPlace({ placeCode: "nl-uap-sv2" });
    const loser = await createTestPlace({ placeCode: "nl-uap-ls2" });
    await db().update(schema.places).set({ mergedInto: third.id }).where(eq(schema.places.id, survivor.id));
    const before = await db().select().from(schema.places).where(eq(schema.places.id, loser.id)).get();
    const out: any = await post(placeMerge, loser.id, {
      reason: "same place",
      loserId: loser.id,
      survivorId: survivor.id,
      linkIds: JSON.stringify([]),
    });
    expect(out).not.toBeInstanceOf(Response);
    expect(out.ok).toBe(false);
    expect(await db().select().from(schema.places).where(eq(schema.places.id, loser.id)).get()).toEqual(before);
  });

  it("a place merge whose survivor is merged away after the action reads it and before its batch writes nothing", async () => {
    const third = await createTestPlace({ placeCode: "nl-uap-th3" });
    const survivor = await createTestPlace({ placeCode: "nl-uap-sv3" });
    const loser = await createTestPlace({ placeCode: "nl-uap-ls3" });
    const description = await createTestDescription({ tenantId: A, repositoryId: repoId, referenceCode: "UAP-PL-1" });
    await db().insert(schema.descriptionPlaces).values({
      id: "uap-pl-link", descriptionId: description.id, placeId: loser.id, role: "created", createdAt: Date.now(),
    });
    const placesBefore = await db().select().from(schema.places).where(inArray(schema.places.id, [survivor.id, loser.id])).all();
    // The concurrent merge lands between the action's reads and its batch.
    const raced = new Proxy(env.DB, {
      get(target, prop) {
        if (prop === "batch") {
          return async (statements: D1PreparedStatement[]) => {
            await target.prepare("UPDATE places SET merged_into = ? WHERE id = ?").bind(third.id, survivor.id).run();
            return target.batch(statements);
          };
        }
        const value = Reflect.get(target, prop);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const ctx = context();
    ctx.cloudflare = { env: { ...env, DB: raced } };
    const form = new FormData();
    for (const [k, v] of Object.entries({
      reason: "same place", loserId: loser.id, survivorId: survivor.id, linkIds: JSON.stringify(["uap-pl-link"]),
    })) form.set(k, v);
    const out: any = await placeMerge({
      request: new Request("http://neogranadina.fisqua.test/admin/x", { method: "POST", body: form }),
      context: ctx,
      params: { id: loser.id },
    } as any);
    expect(out).not.toBeInstanceOf(Response);
    expect(out).toMatchObject({ ok: false, error: "conflict" });
    const placesAfter = await db().select().from(schema.places).where(inArray(schema.places.id, [survivor.id, loser.id])).all();
    expect(placesAfter.map((p) => ({ ...p, mergedInto: p.id === survivor.id ? null : p.mergedInto })))
      .toEqual(placesBefore);
    expect((await db().select().from(schema.descriptionPlaces).where(eq(schema.descriptionPlaces.id, "uap-pl-link")).get())!.placeId)
      .toBe(loser.id);
    expect(await db().select().from(schema.authorityOperations).where(eq(schema.authorityOperations.sourceId, loser.id)).all())
      .toEqual([]);
  });

  it("an entity merge whose survivor was merged away since the workbench opened writes nothing", async () => {
    const third = await createTestEntity({ entityCode: "ne-uap-th" });
    const survivor = await createTestEntity({ entityCode: "ne-uap-sv2" });
    const loser = await createTestEntity({ entityCode: "ne-uap-ls2" });
    await db().update(schema.entities).set({ mergedInto: third.id }).where(eq(schema.entities.id, survivor.id));
    const before = await db().select().from(schema.entities).where(eq(schema.entities.id, loser.id)).get();
    await post(entityMerge, loser.id, {
      reason: "same person",
      loserId: loser.id,
      survivorId: survivor.id,
      linkIds: JSON.stringify([]),
    });
    expect(await db().select().from(schema.entities).where(eq(schema.entities.id, loser.id)).get()).toEqual(before);
  });
});

// @version v0.9.0
