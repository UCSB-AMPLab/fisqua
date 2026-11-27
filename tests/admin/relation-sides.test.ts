/**
 * Tests — relation sides through merges and link removal
 *
 * This suite pins that every path in the app that removes a link leaves no
 * link pointing at a link that is gone, through merges and link removal. A
 * relation is two links to one description, each naming the other in
 * `related_to` (migration 0125). The paths it covers:
 *
 *   - the pair merge (the duplicates worklist and the pair page both
 *     rule through `rulePairMerge`) and the merge workbench: a loser's
 *     relation side that only shares a role with a survivor's
 *     document-role link moves, it is not dropped; a loser's side that
 *     duplicates a survivor's side is dropped, and the link that pointed
 *     at it is repointed to the survivor's in the same write;
 *   - both merges abort with nothing written, and answer as stale data,
 *     when between their reads and their batch another write (a split's
 *     repoint, say) makes a link name a link the batch deletes: the
 *     binding below runs that write just before the batch;
 *   - a merge that drops a duplicate document-role link and moves a
 *     separate reciprocal relation, with no other write, succeeds: the
 *     guard covers only the links naming a link the batch deletes;
 *   - a removal on the description or entity page refuses, with nothing
 *     deleted, when a link comes to name the link between the page's
 *     check and its DELETE: the binding below runs that write just
 *     before the first DELETE;
 *   - an edit on the description or entity page refuses, with nothing
 *     written, when a link comes to name the link between the page's
 *     check and its UPDATE;
 *   - both merges abort with nothing written when the link they keep in
 *     place of a dropped one is removed between their reads and their
 *     batch: the repoint would name a link that is gone;
 *   - a link both repointed and moved in one merge is journaled as one
 *     continuous chain (each entry's content before equals the previous
 *     entry's content after) whose last content is the stored row;
 *   - the description page's remove and update of a link, and the
 *     entity page's unlink and edit: a relation side, or a link another
 *     link points at, is refused and left as it was (nothing would be
 *     kept to repoint to).
 *
 * Every value here is a test value.
 *
 * @version v0.9.0
 */
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { RouterContextProvider } from "react-router";
import * as schema from "../../app/db/schema";
import { applyMigrations, cleanDatabase, seedFederations, seedTenants, DEFAULT_TEST_TENANT_ID, SECOND_TEST_TENANT_ID } from "../helpers/db";
import { roleSetRows, seedRoleLists } from "../helpers/vocabulary";
import { NEOGRANADINA_ROLES } from "../../scripts/data/vocabularies/neogranadina-roles";
import { DEFAULT_TEST_FEDERATION_ID as ROLES_FEDERATION_A, SECOND_TEST_FEDERATION_ID as ROLES_FEDERATION_B } from "../helpers/db";
import { createTestUser } from "../helpers/auth";
import { createTestRepository } from "../helpers/repositories";
import { createTestDescription } from "../helpers/descriptions";
import { createTestEntity } from "../helpers/entities";
import { tenantContext, userContext, type User } from "../../app/context";
import { makeTenantContext, makeUserContext } from "../helpers/context";
import { action as entityMerge } from "../../app/routes/_auth.admin.entities.$id.merge";
import { action as descriptionAction } from "../../app/routes/_auth.admin.descriptions.$id";
import { action as entityAction } from "../../app/routes/_auth.admin.entities.$id";
import { action as duplicatesAction } from "../../app/routes/_auth.admin.decisions.duplicates";
import { loader as descriptionLoader } from "../../app/routes/_auth.admin.descriptions.$id";
import { loader as entityLoader } from "../../app/routes/_auth.admin.entities.$id";
import { LinkCollisionError, rulePairMerge } from "../../app/lib/pair-merge.server";
import { evidenceFields, evidenceFor, mergeWithEvidence } from "../helpers/merge-evidence";
import { rulePairKeepBoth } from "../../app/lib/pending-decisions.server";
import { migrationStatements } from "../helpers/migration-file";
import { deleteLinkOutsideRelations } from "../../app/lib/relation-sides.server";

const A = DEFAULT_TEST_TENANT_ID;

function db() {
  return drizzle(env.DB, { schema });
}

let admin: User;

function context(DB: D1Database = env.DB): any {
  const ctx = new RouterContextProvider();
  ctx.set(userContext, admin);
  ctx.set(tenantContext, makeTenantContext({ id: A }));
  (ctx as any).cloudflare = { env: { ...env, DB } };
  return ctx;
}

/** A D1 binding that runs `write` on the real database just before its first batch: a write landing between a reader's reads and its batch. */
function interleaved(write: () => Promise<unknown>): D1Database {
  let done = false;
  return new Proxy(env.DB, {
    get(target, prop) {
      if (prop === "batch") {
        return async (statements: D1PreparedStatement[]) => {
          if (!done) {
            done = true;
            await write();
          }
          return target.batch(statements);
        };
      }
      const value = (target as any)[prop];
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/** A D1 binding that runs `write` on the real database just before the first DELETE it is given. */
const beforeDelete = (write: () => Promise<unknown>) => beforeFirst(/^\s*delete/i, write);

/** A D1 binding that runs `write` on the real database just before the first statement whose SQL matches `pattern`. */
function beforeFirst(pattern: RegExp, write: () => Promise<unknown>): D1Database {
  let done = false;
  const wrap = (stmt: any, sqlText: string): any =>
    new Proxy(stmt, {
      get(target, prop) {
        const value = target[prop];
        if (typeof value !== "function") return value;
        if (prop === "bind") return (...args: unknown[]) => wrap(value.apply(target, args), sqlText);
        if (["run", "all", "first", "raw"].includes(String(prop)) && pattern.test(sqlText)) {
          return async (...args: unknown[]) => {
            if (!done) {
              done = true;
              await write();
            }
            return value.apply(target, args);
          };
        }
        return value.bind(target);
      },
    });
  return new Proxy(env.DB, {
    get(target, prop) {
      if (prop === "prepare") return (sqlText: string) => wrap(target.prepare(sqlText), sqlText);
      const value = (target as any)[prop];
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/**
 * Run `seed` with migration 0126's triggers dropped, then create them again
 * from the file. The suites below that test the code's own refusals of a
 * `related_to` across descriptions need such a row, which the database
 * otherwise refuses (as the last suite pins).
 */
async function withoutSameDescriptionTriggers(seed: () => Promise<unknown>): Promise<void> {
  const names = ["description_entities_related_to_insert", "description_entities_related_to_update", "description_entities_related_to_move", "description_entities_id_fixed"];
  for (const n of names) await env.DB.prepare(`DROP TRIGGER IF EXISTS ${n}`).run();
  try {
    await seed();
  } finally {
    for (const statement of migrationStatements("0126_relation_same_description.sql")) await env.DB.prepare(statement).run();
  }
}

/** The loser's relation side in the first fixture: the description page's forms take only a UUID link id. */
const LK = "1c1c1c1c-0000-4000-8000-000000000001";

/** Another session's write: a link of the survivor's description comes to name the loser's side lk. */
const concurrentRepoint = () => env.DB.prepare(`UPDATE description_entities SET related_to = '${LK}' WHERE id = 'sc'`).run();

async function post(action: (args: any) => Promise<unknown>, id: string, fields: Record<string, string>, DB?: D1Database): Promise<unknown> {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.set(k, v);
  // An entity merge carries its evidence, as the panel posts it.
  if (fields.survivorId) {
    for (const [k, v] of evidenceFields(await evidenceFor(fields.loserId || id, fields.survivorId, A))) form.append(k, v);
  }
  try {
    return await action({
      request: new Request("http://neogranadina.fisqua.test/admin/x", { method: "POST", body: form }),
      context: context(DB),
      params: { id },
    });
  } catch (e) {
    if (e instanceof Response) return { status: e.status };
    throw e;
  }
}

const row = (id: string) => db().select().from(schema.descriptionEntities).where(eq(schema.descriptionEntities.id, id)).get();

async function link(id: string, descriptionId: string, entityId: string, role: string, relatedTo: string | null = null) {
  await db().insert(schema.descriptionEntities).values({
    id, descriptionId, entityId, role: role as never, sequence: 0, relatedTo, createdAt: Date.now(),
  });
}

let desc: string;
let survivor: string;
let loser: string;
let other: string;

/**
 * In `desc`: the survivor is a parent of `other` (sk ↔ ok), the loser is
 * the same parent of `other` (lk → ok; ok names sk, so the loser's side
 * is the copy), and the loser is also a relation side `lr` with the role
 * `creator`, which the survivor holds as a document role (sc).
 */
async function seedRelations() {
  await link("ok", desc, other, "child", null);
  await link("sk", desc, survivor, "parent", "ok");
  await link(LK, desc, loser, "parent", "ok");
  await db().update(schema.descriptionEntities).set({ relatedTo: LK }).where(eq(schema.descriptionEntities.id, "ok"));
  await link("sc", desc, survivor, "creator", null);
  await link("lr", desc, loser, "creator", "ok");
}

describe("relation sides through merges and link removal", () => {
  beforeAll(async () => {
    await applyMigrations();
  });
  beforeEach(async () => {
    await cleanDatabase();
    await seedFederations();
    await seedTenants();
    // The link forms write only the roles the federation's list approves.
    await seedRoleLists(ROLES_FEDERATION_A, roleSetRows(NEOGRANADINA_ROLES));
    await seedRoleLists(ROLES_FEDERATION_B, roleSetRows(NEOGRANADINA_ROLES));
    const u = await createTestUser({ isAdmin: true });
    admin = makeUserContext({ id: u.id, tenantId: A, isAdmin: true });
    const repo = await createTestRepository({ tenantId: A, code: "repo-rel" });
    desc = (await createTestDescription({ tenantId: A, repositoryId: repo.id })).id;
    survivor = (await createTestEntity({ entityCode: "ne-rs-1" })).id;
    loser = (await createTestEntity({ entityCode: "ne-rl-1" })).id;
    other = (await createTestEntity({ entityCode: "ne-ro-1" })).id;
    await seedRelations();
  });

  it("the pair merge moves a side that only shares a role, drops a duplicate side and repoints its partner", async () => {
    const result = await mergeWithEvidence(db(), admin, makeTenantContext({ id: A }), "entity", survivor, loser, "same person");
    expect(result.droppedLinks).toBe(1);
    expect(await row(LK)).toBeUndefined();
    expect((await row("ok"))?.relatedTo).toBe("sk");
    expect((await row("lr"))?.entityId).toBe(survivor);
    expect((await row("sc"))?.entityId).toBe(survivor);
    // The repoint is journaled as a moved link is: the content before, then after.
    const { results } = await env.DB.prepare("SELECT kind, diff FROM changelog WHERE record_id = ? ORDER BY rowid").bind(desc).all<{ kind: string; diff: string }>();
    const repoint = results.map((r) => ({ kind: r.kind, ...JSON.parse(r.diff) })).filter((r) => r.id === "ok");
    expect(repoint.map((j) => [j.kind, j.relatedTo])).toEqual([["unlink", LK], ["link", "sk"]]);
  });

  it("the merge workbench does the same", async () => {
    await post(entityMerge, loser, {
      reason: "same person",
      loserId: loser,
      survivorId: survivor,
      linkIds: JSON.stringify([LK, "lr"]),
    });
    expect(await row(LK)).toBeUndefined();
    expect((await row("ok"))?.relatedTo).toBe("sk");
    expect((await row("lr"))?.entityId).toBe(survivor);
  });

  it("the pair merge aborts with nothing written when a link comes to name a link it deletes after its read", async () => {
    const dbWithWrite = drizzle(interleaved(concurrentRepoint), { schema });
    const status = await mergeWithEvidence(dbWithWrite, admin, makeTenantContext({ id: A }), "entity", survivor, loser, "same person").then(
      () => 200,
      (e) => (e instanceof Response ? e.status : Promise.reject(e)),
    );
    expect(status).toBe(409);
    expect(await row(LK)).toMatchObject({ entityId: loser });
    expect((await row("sc"))?.relatedTo).toBe(LK);
    expect(await db().select().from(schema.entities).where(eq(schema.entities.id, loser)).get()).toMatchObject({ mergedInto: null });
    // The pair had no decision row, and the refused merge files none.
    expect(await db().select().from(schema.pendingDecisions).all()).toEqual([]);
  });

  it("the pair merge aborts when another request rules the pair between its read and its batch, leaving that ruling as it was", async () => {
    // Another member rules the pair "keep both" after the merge read no decision row.
    const keepBoth = () => rulePairKeepBoth(db(), admin, makeTenantContext({ id: A }), "entity", survivor, loser, "two people");
    const status = await mergeWithEvidence(drizzle(interleaved(keepBoth), { schema }), admin, makeTenantContext({ id: A }), "entity", survivor, loser, "same person").then(
      () => 200,
      (e) => (e instanceof Response ? e.status : Promise.reject(e)),
    );
    expect(status).toBe(409);
    const decisions = await db().select().from(schema.pendingDecisions).all();
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({ status: "ruled", ruling: "kept_both", rulingNote: "two people" });
    const operations = await db().select().from(schema.authorityOperations).all();
    expect(operations.map((o) => o.operation)).toEqual(["separate"]);
    expect(await db().select().from(schema.entities).where(eq(schema.entities.id, loser)).get()).toMatchObject({ mergedInto: null });
    expect(await row(LK)).toMatchObject({ entityId: loser, relatedTo: "ok" });
    expect(await row("ok")).toMatchObject({ relatedTo: LK });
    expect(await row("lr")).toMatchObject({ entityId: loser });
  });

  it("the duplicates worklist answers the same race as a conflict", async () => {
    const keepBoth = () => rulePairKeepBoth(db(), admin, makeTenantContext({ id: A }), "entity", survivor, loser, "two people");
    const result = await post(duplicatesAction, "", {
      _action: "merge", recordKind: "entities", survivorId: survivor, loserId: loser, reason: "same person",
    }, interleaved(keepBoth));
    expect(result).toEqual({ ok: false, code: "conflict" });
    expect(await db().select().from(schema.pendingDecisions).all()).toMatchObject([{ status: "ruled", ruling: "kept_both" }]);
    expect(await db().select().from(schema.entities).where(eq(schema.entities.id, loser)).get()).toMatchObject({ mergedInto: null });
  });

  it("the merge workbench aborts with nothing written, as a conflict, when a link comes to name a link it deletes after its read", async () => {
    const result = await post(
      entityMerge,
      loser,
      { reason: "same person", loserId: loser, survivorId: survivor, linkIds: JSON.stringify([LK, "lr"]) },
      interleaved(concurrentRepoint),
    );
    expect(result).toMatchObject({ ok: false, error: "conflict" });
    expect(await row(LK)).toMatchObject({ entityId: loser });
    expect(await row("lr")).toMatchObject({ entityId: loser });
    expect(await db().select().from(schema.entities).where(eq(schema.entities.id, loser)).get()).toMatchObject({ mergedInto: null });
  });

  it("the description page refuses to remove or edit a relation side, or a link another points at", async () => {
    for (const id of [LK, "ok"]) {
      expect(await post(descriptionAction, desc, { _action: "remove_entity_link", linkId: id })).toMatchObject({ ok: false, error: "relation_side_remove" });
      expect(await row(id)).toBeDefined();
    }
    expect(await post(descriptionAction, desc, { _action: "update_entity_link", linkId: LK, role: "creator" })).toMatchObject({ ok: false, error: "relation_side_save" });
    expect((await row(LK))?.role).toBe("parent");
    // A plain document-role link is still removed.
    expect(await post(descriptionAction, desc, { _action: "remove_entity_link", linkId: "sc" })).toMatchObject({ ok: true });
    expect(await row("sc")).toBeUndefined();
  });

  it("the entity page refuses to unlink or edit a relation side, or a link another points at", async () => {
    expect(await post(entityAction, loser, { _action: "unlink_description", linkId: LK })).toMatchObject({ ok: false, error: "relation_side_remove" });
    expect(await post(entityAction, other, { _action: "unlink_description", linkId: "ok" })).toMatchObject({ ok: false, error: "relation_side_remove" });
    expect(await post(entityAction, loser, { _action: "edit_description_link", linkId: LK, role: "creator" })).toMatchObject({ ok: false, error: "relation_side_save" });
    expect(await row(LK)).toMatchObject({ role: "parent", relatedTo: "ok" });
    expect(await row("ok")).toBeDefined();
    expect(await post(entityAction, survivor, { _action: "unlink_description", linkId: "sc" })).toMatchObject({ ok: true });
    expect(await row("sc")).toBeUndefined();
  });

  it("the description page refuses a relation side as the form read it, with the refusal of the action, writing nothing", async () => {
    const asRead = { relatedToAsRead: "ok", namedByAsRead: "" };
    expect(await post(descriptionAction, desc, { _action: "remove_entity_link", linkId: LK, ...asRead })).toMatchObject({ ok: false, error: "relation_side_remove" });
    expect(await post(descriptionAction, desc, { _action: "update_entity_link", linkId: LK, role: "creator", ...asRead })).toMatchObject({ ok: false, error: "relation_side_save" });
    expect(await row(LK)).toMatchObject({ role: "parent", relatedTo: "ok" });
  });

  it("the entity page refuses a link another points at as the form read it, writing nothing", async () => {
    const asRead = { relatedToAsRead: LK, namedByAsRead: LK };
    expect(await post(entityAction, other, { _action: "unlink_description", linkId: "ok", ...asRead })).toMatchObject({ ok: false, error: "relation_side_remove" });
    expect(await post(entityAction, other, { _action: "edit_description_link", linkId: "ok", role: "creator", ...asRead })).toMatchObject({ ok: false, error: "relation_side_save" });
    expect(await row("ok")).toMatchObject({ role: "child", relatedTo: LK });
  });

  it("the description and entity pages give each link's relation as read", async () => {
    const args = (id: string, path: string) => ({
      request: new Request(`http://neogranadina.fisqua.test/admin/${path}/${id}`),
      context: context(),
      params: { id },
    });
    const described: any = await descriptionLoader(args(desc, "descriptions") as any);
    const byId = new Map<string, any>(described.entityLinks.map((l: any) => [l.id, l]));
    expect(byId.get(LK)).toMatchObject({ relatedTo: "ok", namedBy: ["ok"] });
    expect(byId.get("sc")).toMatchObject({ relatedTo: null, namedBy: [] });
    const entityPage: any = await entityLoader(args(other, "entities") as any);
    const ok = entityPage.links.find((l: any) => l.id === "ok");
    expect(ok).toMatchObject({ relatedTo: LK, namedBy: [LK, "lr", "sk"] });
  });
});

/** The survivor's document-role link in the second fixture: the description page's forms take only a UUID link id. */
const SC = "5c5c5c5c-0000-4000-8000-000000000001";

describe("relation sides: a drop beside a moved relation, and a removal raced by a repoint", () => {
  beforeAll(async () => {
    await applyMigrations();
  });
  beforeEach(async () => {
    await cleanDatabase();
    await seedFederations();
    await seedTenants();
    // The link forms write only the roles the federation's list approves.
    await seedRoleLists(ROLES_FEDERATION_A, roleSetRows(NEOGRANADINA_ROLES));
    await seedRoleLists(ROLES_FEDERATION_B, roleSetRows(NEOGRANADINA_ROLES));
    const u = await createTestUser({ isAdmin: true });
    admin = makeUserContext({ id: u.id, tenantId: A, isAdmin: true });
    const repo = await createTestRepository({ tenantId: A, code: "repo-rel2" });
    desc = (await createTestDescription({ tenantId: A, repositoryId: repo.id })).id;
    survivor = (await createTestEntity({ entityCode: "ne-rs-2" })).id;
    loser = (await createTestEntity({ entityCode: "ne-rl-2" })).id;
    other = (await createTestEntity({ entityCode: "ne-ro-2" })).id;
    // Both hold `creator` as a document role (the loser's lc is the
    // copy); the loser alone is a parent of `other` (lp <-> oc).
    await link(SC, desc, survivor, "creator", null);
    await link("lc", desc, loser, "creator", null);
    await link("oc", desc, other, "child", null);
    await link("lp", desc, loser, "parent", "oc");
    await db().update(schema.descriptionEntities).set({ relatedTo: "lp" }).where(eq(schema.descriptionEntities.id, "oc"));
  });

  it("the pair merge drops the duplicate document-role link and moves the reciprocal relation", async () => {
    const result = await mergeWithEvidence(db(), admin, makeTenantContext({ id: A }), "entity", survivor, loser, "same person");
    expect(result).toMatchObject({ movedLinks: 1, droppedLinks: 1 });
    expect(await row("lc")).toBeUndefined();
    expect(await row("lp")).toMatchObject({ entityId: survivor, relatedTo: "oc" });
    expect(await row("oc")).toMatchObject({ relatedTo: "lp" });
  });

  it("the merge workbench does the same", async () => {
    await post(entityMerge, loser, {
      reason: "same person",
      loserId: loser,
      survivorId: survivor,
      linkIds: JSON.stringify(["lc", "lp"]),
    });
    expect(await row("lc")).toBeUndefined();
    expect(await row("lp")).toMatchObject({ entityId: survivor, relatedTo: "oc" });
    expect(await db().select().from(schema.entities).where(eq(schema.entities.id, loser)).get()).toMatchObject({ mergedInto: survivor });
  });

  /** Another session's repoint, landing after the page checked sc: oc comes to name sc. */
  const repointOntoSc = () => env.DB.prepare(`UPDATE description_entities SET related_to = '${SC}' WHERE id = 'oc'`).run();

  it("the description page refuses a removal, deleting nothing, when a link comes to name it after the check", async () => {
    const result = await post(descriptionAction, desc, { _action: "remove_entity_link", linkId: SC }, beforeDelete(repointOntoSc));
    expect(result).toMatchObject({ ok: false });
    expect(await row(SC)).toBeDefined();
    expect(await row("oc")).toMatchObject({ relatedTo: SC });
  });

  it("the description page refuses an edit, writing nothing, when a link comes to name it after the check", async () => {
    const result = await post(
      descriptionAction,
      desc,
      { _action: "update_entity_link", linkId: SC, role: "author" },
      beforeFirst(/^\s*update/i, repointOntoSc),
    );
    expect(result).toMatchObject({ ok: false });
    expect(await row(SC)).toMatchObject({ role: "creator", relatedTo: null });
    expect(await row("oc")).toMatchObject({ relatedTo: SC });
  });

  it("the entity page refuses an edit, writing nothing, when a link comes to name it after the check", async () => {
    const result = await post(
      entityAction,
      survivor,
      { _action: "edit_description_link", linkId: SC, role: "author" },
      beforeFirst(/^\s*update/i, repointOntoSc),
    );
    expect(result).toMatchObject({ ok: false });
    expect(await row(SC)).toMatchObject({ role: "creator", relatedTo: null });
    expect(await row("oc")).toMatchObject({ relatedTo: SC });
  });

  /** The form's relation as read for SC: outside every relation. */
  const outside = { relatedToAsRead: "", namedByAsRead: "" };
  /** Another session's write, landing after the page read SC: SC itself comes to name oc. */
  const scPointsAtOc = () => env.DB.prepare(`UPDATE description_entities SET related_to = 'oc' WHERE id = '${SC}'`).run();

  it("the description page refuses an edit and a removal as changed since read when a link comes to name the link", async () => {
    const edit = await post(
      descriptionAction, desc, { _action: "update_entity_link", linkId: SC, role: "author", ...outside }, beforeFirst(/^\s*update/i, repointOntoSc),
    );
    expect(edit).toMatchObject({ ok: false, error: "relation_changed_save" });
    expect(await row(SC)).toMatchObject({ role: "creator", relatedTo: null });
    await env.DB.prepare("UPDATE description_entities SET related_to = 'lp' WHERE id = 'oc'").run();
    const removal = await post(descriptionAction, desc, { _action: "remove_entity_link", linkId: SC, ...outside }, beforeDelete(repointOntoSc));
    expect(removal).toMatchObject({ ok: false, error: "relation_changed_remove" });
    expect(await row(SC)).toBeDefined();
  });

  it("the description page refuses an edit as changed since read when the link itself comes to name another", async () => {
    const edit = await post(
      descriptionAction, desc, { _action: "update_entity_link", linkId: SC, role: "author", ...outside }, beforeFirst(/^\s*update/i, scPointsAtOc),
    );
    expect(edit).toMatchObject({ ok: false, error: "relation_changed_save" });
    expect(await row(SC)).toMatchObject({ role: "creator", relatedTo: "oc" });
  });

  it("the entity page refuses an edit and an unlink as changed since read when the relation changes after the read", async () => {
    const edit = await post(
      entityAction, survivor, { _action: "edit_description_link", linkId: SC, role: "author", ...outside }, beforeFirst(/^\s*update/i, scPointsAtOc),
    );
    expect(edit).toMatchObject({ ok: false, error: "relation_changed_save" });
    expect(await row(SC)).toMatchObject({ role: "creator", relatedTo: "oc" });
    await env.DB.prepare(`UPDATE description_entities SET related_to = NULL WHERE id = '${SC}'`).run();
    const unlink = await post(entityAction, survivor, { _action: "unlink_description", linkId: SC, ...outside }, beforeDelete(repointOntoSc));
    expect(unlink).toMatchObject({ ok: false, error: "relation_changed_remove" });
    expect(await row(SC)).toBeDefined();
  });

  it("the description and entity pages still save an edit on a link outside every relation", async () => {
    expect(await post(descriptionAction, desc, { _action: "update_entity_link", linkId: SC, role: "author" })).toMatchObject({ ok: true });
    expect(await row(SC)).toMatchObject({ role: "author" });
    expect(await post(entityAction, survivor, { _action: "edit_description_link", linkId: SC, role: "editor" })).toMatchObject({ ok: true });
    expect(await row(SC)).toMatchObject({ role: "editor" });
    expect(await post(entityAction, survivor, { _action: "edit_description_link", linkId: SC, role: "creator", ...outside })).toMatchObject({ ok: true });
    expect(await row(SC)).toMatchObject({ role: "creator" });
  });

  it("the entity page refuses an unlink, deleting nothing, when a link comes to name it after the check", async () => {
    const result = await post(entityAction, survivor, { _action: "unlink_description", linkId: SC }, beforeDelete(repointOntoSc));
    expect(result).toMatchObject({ ok: false });
    expect(await row(SC)).toBeDefined();
    expect(await row("oc")).toMatchObject({ relatedTo: SC });
  });
});

describe("relation sides: the kept link removed before the merge's batch", () => {
  beforeAll(async () => {
    await applyMigrations();
  });
  beforeEach(async () => {
    await cleanDatabase();
    await seedFederations();
    await seedTenants();
    // The link forms write only the roles the federation's list approves.
    await seedRoleLists(ROLES_FEDERATION_A, roleSetRows(NEOGRANADINA_ROLES));
    await seedRoleLists(ROLES_FEDERATION_B, roleSetRows(NEOGRANADINA_ROLES));
    const u = await createTestUser({ isAdmin: true });
    admin = makeUserContext({ id: u.id, tenantId: A, isAdmin: true });
    const repo = await createTestRepository({ tenantId: A, code: "repo-rel3" });
    desc = (await createTestDescription({ tenantId: A, repositoryId: repo.id })).id;
    survivor = (await createTestEntity({ entityCode: "ne-rs-3" })).id;
    loser = (await createTestEntity({ entityCode: "ne-rl-3" })).id;
    other = (await createTestEntity({ entityCode: "ne-ro-3" })).id;
    // Both hold `creator` as a document role (sd kept, ld the copy), and
    // `other`'s link op names ld, so the merge repoints op to sd.
    await link("sd", desc, survivor, "creator", null);
    await link("ld", desc, loser, "creator", null);
    await link("op", desc, other, "witness", "ld");
    // The survivor's evidence for the merges below, on a description of its own (its code sorts
    // first), so that the removal of sd leaves the citation standing.
    const cited = (await createTestDescription({ tenantId: A, repositoryId: repo.id, referenceCode: "a-cited-3" })).id;
    await link("sx", cited, survivor, "creator", null);
  });

  /** Another session's removal of the kept link sd, through the pages' own delete: nothing names sd, so it goes. */
  const removeKept = async () => expect(await deleteLinkOutsideRelations(db(), "sd", undefined)).toBe(true);

  it("the pair merge aborts with nothing written", async () => {
    const status = await mergeWithEvidence(drizzle(interleaved(removeKept), { schema }), admin, makeTenantContext({ id: A }), "entity", survivor, loser, "same person").then(
      () => 200,
      (e) => (e instanceof Response ? e.status : Promise.reject(e)),
    );
    expect(status).toBe(409);
    expect(await row("ld")).toMatchObject({ entityId: loser });
    expect(await row("op")).toMatchObject({ relatedTo: "ld" });
    expect(await db().select().from(schema.entities).where(eq(schema.entities.id, loser)).get()).toMatchObject({ mergedInto: null });
  });

  it("the merge workbench aborts with nothing written, as a conflict", async () => {
    const result = await post(
      entityMerge,
      loser,
      { reason: "same person", loserId: loser, survivorId: survivor, linkIds: JSON.stringify(["ld"]) },
      interleaved(removeKept),
    );
    expect(result).toMatchObject({ ok: false, error: "conflict" });
    expect(await row("ld")).toMatchObject({ entityId: loser });
    expect(await row("op")).toMatchObject({ relatedTo: "ld" });
    expect(await db().select().from(schema.entities).where(eq(schema.entities.id, loser)).get()).toMatchObject({ mergedInto: null });
  });
});

describe("relation sides: a link repointed and moved in the same merge", () => {
  beforeAll(async () => {
    await applyMigrations();
  });
  beforeEach(async () => {
    await cleanDatabase();
    await seedFederations();
    await seedTenants();
    // The link forms write only the roles the federation's list approves.
    await seedRoleLists(ROLES_FEDERATION_A, roleSetRows(NEOGRANADINA_ROLES));
    await seedRoleLists(ROLES_FEDERATION_B, roleSetRows(NEOGRANADINA_ROLES));
    const u = await createTestUser({ isAdmin: true });
    admin = makeUserContext({ id: u.id, tenantId: A, isAdmin: true });
    const repo = await createTestRepository({ tenantId: A, code: "repo-rel4" });
    desc = (await createTestDescription({ tenantId: A, repositoryId: repo.id })).id;
    survivor = (await createTestEntity({ entityCode: "ne-rs-4" })).id;
    loser = (await createTestEntity({ entityCode: "ne-rl-4" })).id;
    // Both hold `creator` (kc kept, dc the loser's copy, dropped); the
    // loser's own link pc names dc, so pc is repointed to kc and then
    // moves to the survivor in the same batch.
    await link("kc", desc, survivor, "creator", null);
    await link("dc", desc, loser, "creator", null);
    await link("pc", desc, loser, "parent", "dc");
  });

  /** pc's journal entries in order, and the row read back. */
  async function chainOf(id: string) {
    const { results } = await env.DB.prepare("SELECT kind, diff FROM changelog WHERE record_id = ? ORDER BY rowid").bind(desc).all<{ kind: string; diff: string }>();
    const entries = results.map((r) => ({ kind: r.kind, content: JSON.parse(r.diff) })).filter((e) => e.content.id === id);
    return { entries, stored: await row(id) };
  }

  /** Each unlink's content equals the content of the link entry before it, and the last link entry is the stored row. */
  function expectContinuous(entries: Array<{ kind: string; content: Record<string, unknown> }>, stored: unknown) {
    expect(entries.length).toBeGreaterThan(0);
    for (let i = 1; i < entries.length; i++) {
      if (entries[i].kind === "unlink") expect(entries[i].content).toEqual(entries[i - 1].content);
    }
    const last = entries[entries.length - 1];
    expect(last.kind).toBe("link");
    expect(last.content).toEqual(JSON.parse(JSON.stringify(stored)));
  }

  it("the pair merge journals pc as one continuous chain ending at the stored row", async () => {
    await mergeWithEvidence(db(), admin, makeTenantContext({ id: A }), "entity", survivor, loser, "same person");
    const { entries, stored } = await chainOf("pc");
    expect(stored).toMatchObject({ entityId: survivor, relatedTo: "kc" });
    expect(entries.map((e) => e.kind)).toEqual(["unlink", "link", "unlink", "link"]);
    expectContinuous(entries, stored);
  });

  it("the merge workbench journals pc's repoint ending at the stored row", async () => {
    await post(entityMerge, loser, {
      reason: "same person",
      loserId: loser,
      survivorId: survivor,
      linkIds: JSON.stringify(["dc", "pc"]),
    });
    const { entries, stored } = await chainOf("pc");
    expect(stored).toMatchObject({ entityId: survivor, relatedTo: "kc" });
    expectContinuous(entries, stored);
  });
});

describe("relation sides: a repoint that would collide under the unique index", () => {
  beforeAll(async () => {
    await applyMigrations();
  });
  beforeEach(async () => {
    await cleanDatabase();
    await seedFederations();
    await seedTenants();
    // The link forms write only the roles the federation's list approves.
    await seedRoleLists(ROLES_FEDERATION_A, roleSetRows(NEOGRANADINA_ROLES));
    await seedRoleLists(ROLES_FEDERATION_B, roleSetRows(NEOGRANADINA_ROLES));
    const u = await createTestUser({ isAdmin: true });
    admin = makeUserContext({ id: u.id, tenantId: A, isAdmin: true });
    const repo = await createTestRepository({ tenantId: A, code: "repo-rel5" });
    desc = (await createTestDescription({ tenantId: A, repositoryId: repo.id, referenceCode: "co-rel5-001" })).id;
    survivor = (await createTestEntity({ entityCode: "ne-rs-5" })).id;
    loser = (await createTestEntity({ entityCode: "ne-rl-5" })).id;
    other = (await createTestEntity({ entityCode: "ne-ro-5" })).id;
    // Both sides of one relation are recorded twice: the survivor's sk and
    // the loser's dl are parents naming other's child x1, and other holds a
    // second child side x2 naming dl. The merge drops dl (sk holds its key)
    // and repoints x2 to sk, which would give other two child links naming sk.
    await link("sk", desc, survivor, "parent", null);
    await link("dl", desc, loser, "parent", null);
    await link("x1", desc, other, "child", "sk");
    await link("x2", desc, other, "child", "dl");
    await db().update(schema.descriptionEntities).set({ relatedTo: "x1" }).where(eq(schema.descriptionEntities.id, "sk"));
    await db().update(schema.descriptionEntities).set({ relatedTo: "x1" }).where(eq(schema.descriptionEntities.id, "dl"));
  });

  const collision = { referenceCode: "co-rel5-001", entityCode: "ne-ro-5", role: "child" };

  async function expectNothingWritten() {
    expect(await row("dl")).toMatchObject({ entityId: loser, relatedTo: "x1" });
    expect(await row("x2")).toMatchObject({ relatedTo: "dl" });
    expect(await db().select().from(schema.entities).where(eq(schema.entities.id, loser)).get()).toMatchObject({ mergedInto: null });
    // The refusal comes before any write: not even the pair's decision row is filed.
    expect(await db().select().from(schema.pendingDecisions).all()).toEqual([]);
  }

  it("the pair merge refuses before its batch, naming the description, the entity and the role", async () => {
    const err = await mergeWithEvidence(db(), admin, makeTenantContext({ id: A }), "entity", survivor, loser, "same person").then(() => null, (e) => e);
    expect(err).toBeInstanceOf(LinkCollisionError);
    expect(err.collision).toEqual(collision);
    expect(err.message).toBe("the merge would leave ne-ro-5 with two links to co-rel5-001 as child that name the same link");
    await expectNothingWritten();
  });

  it("the duplicates worklist answers with the collision", async () => {
    const result = await post(duplicatesAction, "", {
      _action: "merge", recordKind: "entities", survivorId: survivor, loserId: loser, reason: "same person",
    });
    expect(result).toEqual({ ok: false, code: "relation_collision", collision });
    await expectNothingWritten();
  });

  it("the merge workbench answers with the collision", async () => {
    const result = await post(entityMerge, loser, {
      reason: "same person", loserId: loser, survivorId: survivor, linkIds: JSON.stringify(["dl"]),
    });
    expect(result).toEqual({ ok: false, error: "relation_collision", collision });
    await expectNothingWritten();
  });
});

describe("relation sides: a link on another tenant's description naming a local link", () => {
  let foreignDesc: string;
  beforeAll(async () => {
    await applyMigrations();
  });
  beforeEach(async () => {
    await cleanDatabase();
    await seedFederations();
    await seedTenants();
    // The link forms write only the roles the federation's list approves.
    await seedRoleLists(ROLES_FEDERATION_A, roleSetRows(NEOGRANADINA_ROLES));
    await seedRoleLists(ROLES_FEDERATION_B, roleSetRows(NEOGRANADINA_ROLES));
    const u = await createTestUser({ isAdmin: true });
    admin = makeUserContext({ id: u.id, tenantId: A, isAdmin: true });
    const repo = await createTestRepository({ tenantId: A, code: "repo-rel6" });
    desc = (await createTestDescription({ tenantId: A, repositoryId: repo.id, referenceCode: "co-rel6-001" })).id;
    const foreignRepo = await createTestRepository({ tenantId: SECOND_TEST_TENANT_ID, code: "repo-rel6-far" });
    foreignDesc = (await createTestDescription({ tenantId: SECOND_TEST_TENANT_ID, repositoryId: foreignRepo.id, referenceCode: "co-far-secret" })).id;
    survivor = (await createTestEntity({ entityCode: "ne-rs-6" })).id;
    loser = (await createTestEntity({ entityCode: "ne-rl-6" })).id;
    other = (await createTestEntity({ entityCode: "ne-ro-6" })).id;
    const far = (await createTestEntity({ entityCode: "ne-far-6" })).id;
    // In desc, the loser's dl duplicates the survivor's sk (both parents
    // naming x1). On the other tenant's description, f1 names sk and f2
    // names dl: repointing f2 would collide with f1 there.
    await link("sk", desc, survivor, "parent", null);
    await link("dl", desc, loser, "parent", null);
    await link("x1", desc, other, "child", "sk");
    await db().update(schema.descriptionEntities).set({ relatedTo: "x1" }).where(eq(schema.descriptionEntities.id, "sk"));
    await db().update(schema.descriptionEntities).set({ relatedTo: "x1" }).where(eq(schema.descriptionEntities.id, "dl"));
    await withoutSameDescriptionTriggers(async () => {
      await link("f1", foreignDesc, far, "child", "sk");
      await link("f2", foreignDesc, far, "child", "dl");
    });
  });

  it("the pair merge counts no link outside the tenant's descriptions and names none of its codes", async () => {
    const err = await mergeWithEvidence(db(), admin, makeTenantContext({ id: A }), "entity", survivor, loser, "same person").then(() => null, (e) => e);
    expect(err).not.toBeInstanceOf(LinkCollisionError);
    expect(err).toBeInstanceOf(Response);
    expect(String(err?.message ?? "")).not.toMatch(/co-far-secret|ne-far-6/);
    expect(await row("dl")).toMatchObject({ entityId: loser });
    expect(await row("f2")).toMatchObject({ relatedTo: "dl" });
    expect(await db().select().from(schema.pendingDecisions).all()).toEqual([]);
  });

  it("the duplicates worklist answers the guard's refusal as a conflict and files no decision row", async () => {
    const result = await post(duplicatesAction, "", {
      _action: "merge", recordKind: "entities", survivorId: survivor, loserId: loser, reason: "same person",
    });
    expect(result).toEqual({ ok: false, code: "conflict" });
    expect(await db().select().from(schema.pendingDecisions).all()).toEqual([]);
  });

  it("the merge workbench does not name the other tenant's codes", async () => {
    const result = await post(entityMerge, loser, {
      reason: "same person", loserId: loser, survivorId: survivor, linkIds: JSON.stringify(["dl"]),
    });
    expect(JSON.stringify(result)).not.toMatch(/co-far-secret|ne-far-6/);
    expect(result).not.toMatchObject({ error: "relation_collision" });
    expect(await row("dl")).toMatchObject({ entityId: loser });
  });

  it("the description page gives only the links on the same description as naming a link", async () => {
    const described: any = await descriptionLoader({
      request: new Request(`http://neogranadina.fisqua.test/admin/descriptions/${desc}`),
      context: context(),
      params: { id: desc },
    } as any);
    const byId = new Map<string, any>(described.entityLinks.map((l: any) => [l.id, l]));
    expect(byId.get("sk")).toMatchObject({ namedBy: ["x1"] });
    expect(byId.get("dl")).toMatchObject({ namedBy: [] });
  });
});

/** A local link naming a link on another tenant's description: the description page's forms take only a UUID link id. */
const LP = "7a7a7a7a-0000-4000-8000-000000000001";

describe("relation sides: a local link naming a link on another tenant's description", () => {
  beforeAll(async () => {
    await applyMigrations();
  });
  beforeEach(async () => {
    await cleanDatabase();
    await seedFederations();
    await seedTenants();
    // The link forms write only the roles the federation's list approves.
    await seedRoleLists(ROLES_FEDERATION_A, roleSetRows(NEOGRANADINA_ROLES));
    await seedRoleLists(ROLES_FEDERATION_B, roleSetRows(NEOGRANADINA_ROLES));
    const u = await createTestUser({ isAdmin: true });
    admin = makeUserContext({ id: u.id, tenantId: A, isAdmin: true });
    const repo = await createTestRepository({ tenantId: A, code: "repo-rel7" });
    desc = (await createTestDescription({ tenantId: A, repositoryId: repo.id, referenceCode: "co-rel7-001" })).id;
    const foreignRepo = await createTestRepository({ tenantId: SECOND_TEST_TENANT_ID, code: "repo-rel7-far" });
    const foreignDesc = (await createTestDescription({ tenantId: SECOND_TEST_TENANT_ID, repositoryId: foreignRepo.id, referenceCode: "co-far-7" })).id;
    survivor = (await createTestEntity({ entityCode: "ne-rs-7" })).id;
    const far = (await createTestEntity({ entityCode: "ne-far-7" })).id;
    // lp is on the local description and names f1, which is on the other tenant's: stale data.
    await link("f1-far-secret", foreignDesc, far, "child", null);
    await withoutSameDescriptionTriggers(() => link(LP, desc, survivor, "parent", "f1-far-secret"));
  });

  it("the description and entity pages give no relation for the link, and no id from the other description", async () => {
    const args = (id: string, path: string) => ({
      request: new Request(`http://neogranadina.fisqua.test/admin/${path}/${id}`),
      context: context(),
      params: { id },
    });
    const described: any = await descriptionLoader(args(desc, "descriptions") as any);
    expect(described.entityLinks.find((l: any) => l.id === LP)).toMatchObject({ relatedTo: null, namedBy: [] });
    const entityPage: any = await entityLoader(args(survivor, "entities") as any);
    expect(entityPage.links.find((l: any) => l.id === LP)).toMatchObject({ relatedTo: null, namedBy: [] });
    expect(JSON.stringify([described.entityLinks, entityPage.links])).not.toMatch(/f1-far-secret/);
  });

  it("the description and entity pages refuse a save or a removal with the generic refusal, writing nothing", async () => {
    const outside = { relatedToAsRead: "", namedByAsRead: "" };
    expect(await post(descriptionAction, desc, { _action: "update_entity_link", linkId: LP, role: "creator", ...outside })).toEqual({ ok: false, error: "generic" });
    expect(await post(descriptionAction, desc, { _action: "remove_entity_link", linkId: LP, ...outside })).toEqual({ ok: false, error: "generic" });
    expect(await post(entityAction, survivor, { _action: "edit_description_link", linkId: LP, role: "creator", ...outside })).toEqual({ ok: false, error: "generic" });
    expect(await post(entityAction, survivor, { _action: "unlink_description", linkId: LP, ...outside })).toEqual({ ok: false, error: "generic" });
    expect(await row(LP)).toMatchObject({ role: "parent", relatedTo: "f1-far-secret" });
  });
});

describe("relation sides: the database refuses a related_to across descriptions", () => {
  let foreignDesc: string;
  let far: string;
  const refused = /a relation side must name a link on its own description/;
  /** Drizzle reports a failed query with the database's own message as the cause. */
  const refusedByDatabase = (write: Promise<unknown>) =>
    write.then(
      () => "written",
      (e) => (refused.test(`${e?.message} ${e?.cause?.message ?? ""}`) ? "refused" : `failed: ${e?.message}`),
    );
  beforeAll(async () => {
    await applyMigrations();
  });
  beforeEach(async () => {
    await cleanDatabase();
    await seedFederations();
    await seedTenants();
    // The link forms write only the roles the federation's list approves.
    await seedRoleLists(ROLES_FEDERATION_A, roleSetRows(NEOGRANADINA_ROLES));
    await seedRoleLists(ROLES_FEDERATION_B, roleSetRows(NEOGRANADINA_ROLES));
    const u = await createTestUser({ isAdmin: true });
    admin = makeUserContext({ id: u.id, tenantId: A, isAdmin: true });
    const repo = await createTestRepository({ tenantId: A, code: "repo-rel8" });
    desc = (await createTestDescription({ tenantId: A, repositoryId: repo.id, referenceCode: "co-rel8-001" })).id;
    const foreignRepo = await createTestRepository({ tenantId: SECOND_TEST_TENANT_ID, code: "repo-rel8-far" });
    foreignDesc = (await createTestDescription({ tenantId: SECOND_TEST_TENANT_ID, repositoryId: foreignRepo.id, referenceCode: "co-far-8" })).id;
    survivor = (await createTestEntity({ entityCode: "ne-rs-8" })).id;
    loser = (await createTestEntity({ entityCode: "ne-rl-8" })).id;
    other = (await createTestEntity({ entityCode: "ne-ro-8" })).id;
    far = (await createTestEntity({ entityCode: "ne-far-8" })).id;
    // The loser is a parent of other on desc (lp <-> oc); the survivor holds nothing there.
    await link("oc", desc, other, "child", null);
    await link("lp", desc, loser, "parent", "oc");
    await db().update(schema.descriptionEntities).set({ relatedTo: "lp" }).where(eq(schema.descriptionEntities.id, "oc"));
    await link("fx", foreignDesc, far, "spouse", null);
  });

  it("refuses an outgoing link naming a link on the other tenant's description", async () => {
    expect(await refusedByDatabase(link(LP, desc, survivor, "parent", "fx"))).toBe("refused");
    expect(await refusedByDatabase(db().update(schema.descriptionEntities).set({ relatedTo: "fx" }).where(eq(schema.descriptionEntities.id, "oc")))).toBe("refused");
    expect(await row(LP)).toBeUndefined();
    expect(await row("oc")).toMatchObject({ relatedTo: "lp" });
  });

  it("refuses the other tenant's link naming a link a merge moves", async () => {
    expect(await refusedByDatabase(link("f-in", foreignDesc, far, "child", "lp"))).toBe("refused");
    expect(await refusedByDatabase(db().update(schema.descriptionEntities).set({ relatedTo: "lp" }).where(eq(schema.descriptionEntities.id, "fx")))).toBe("refused");
    expect(await row("f-in")).toBeUndefined();
    expect(await row("fx")).toMatchObject({ relatedTo: null });
  });

  it("leaves a merge that only moves links to run, its relation whole", async () => {
    const result = await mergeWithEvidence(db(), admin, makeTenantContext({ id: A }), "entity", survivor, loser, "same person");
    expect(result).toMatchObject({ movedLinks: 1, droppedLinks: 0 });
    expect(await row("lp")).toMatchObject({ entityId: survivor, relatedTo: "oc" });
    expect(await row("oc")).toMatchObject({ relatedTo: "lp" });
  });
});

// @version v0.9.0
