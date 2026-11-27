/**
 * Tests — every write to an entity's functions, merge state or version
 * holds to the version it read
 *
 * This suite pins that every write to an entity's functions, merge state
 * or version holds to the version it read. A write that changes an
 * entity's function rows or its `merged_into` runs only while the entity
 * still holds the version the write read, and moves the version strictly
 * past it. A write that moves the version for another reason moves it
 * strictly up, in milliseconds. Pinned here, against the test D1, for the
 * writers outside the merge paths (those are in merge-functions.test.ts):
 *
 *   - the entity split workbench: a merge that lands on the original
 *     between the split's reads and its batch makes the split return the
 *     conflict, with nothing written; an original merged away before the
 *     split read it returns the conflict too;
 *   - the entity hard delete: a merge onto the record between the
 *     delete's reads and its batch makes the delete refuse it, the
 *     functions moved onto it kept; an edit between the reads and the
 *     batch returns the conflict; a record other records were merged
 *     into is not deleted, and the page's loader says which records
 *     those are;
 *   - the vocabulary function merge and split, on the term page and on
 *     the decisions surface: each entity they reassign takes a version in
 *     milliseconds past the one it held, so two such writes in one second
 *     leave a form that read the first one stale; an entity the form names
 *     that is linked to another term is not reassigned; and an edit to an
 *     entity they reassign, or an entity linked to the source term, that
 *     lands between their reads and their batch makes them return the
 *     conflict, with nothing written.
 *
 * @version v0.9.0
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { RouterContextProvider } from "react-router";
import * as schema from "../../app/db/schema";
import {
  applyMigrations,
  cleanDatabase,
  DEFAULT_TEST_FEDERATION_ID,
  DEFAULT_TEST_TENANT_ID,
} from "../helpers/db";
import { createTestUser } from "../helpers/auth";
import { createTestEntity } from "../helpers/entities";
import { tenantContext, userContext, type User } from "../../app/context";
import { makeTenantContext, makeUserContext } from "../helpers/context";
import { rulePairMerge } from "../../app/lib/pair-merge.server";
import { mergeWithEvidence } from "../helpers/merge-evidence";
// Warm the route module graph so the in-test `await import()` resolves
// from cache (see the note in vocab-merge-split-action.test.ts).
import "../../app/routes/_auth.admin.entities.$id";
import "../../app/routes/_auth.admin.entities.$id.split";
import "../../app/routes/_auth.admin.vocabularies.functions.$id";
import "../../app/routes/_auth.admin.decisions.vocabulary";

const S = "11111111-1111-4111-8111-111111111111";
const L = "22222222-2222-4222-8222-222222222222";

function db() {
  return drizzle(env.DB, { schema });
}

/**
 * The test D1, with `change` run once just before the first batch one
 * of whose statements matches `pattern`: what lands between a write's
 * reads and its batch.
 */
function d1Interleaving(pattern: RegExp, change: () => Promise<unknown>): D1Database {
  let done = false;
  return new Proxy(env.DB, {
    get(target, prop) {
      if (prop === "batch") {
        return async (statements: D1PreparedStatement[]) => {
          const matches = statements.some((s) => pattern.test(String((s as any).statement ?? "")));
          if (matches && !done) {
            done = true;
            await change();
          }
          return target.batch(statements);
        };
      }
      const value = (target as any)[prop];
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function buildContext(user: User, DB: D1Database = env.DB): any {
  const ctx = new RouterContextProvider();
  ctx.set(userContext, user);
  ctx.set(tenantContext, makeTenantContext({ id: user.tenantId }));
  (ctx as any).cloudflare = { env: { ...env, DB } };
  return ctx;
}

function form(fields: Record<string, string>): Request {
  return new Request("http://neogranadina.fisqua.test/admin/x", {
    method: "POST",
    body: new URLSearchParams(fields),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
  });
}

/** The entity editor's save on `entityId`, at the version the form read. */
async function editorSave(user: User, entityId: string, displayName: string, functions: string, updatedAt: number) {
  const { action } = await import("../../app/routes/_auth.admin.entities.$id");
  return (await action({
    request: form({
      _action: "update",
      displayName,
      sortName: displayName,
      entityType: "person",
      nameVariants: "[]",
      functions,
      _updatedAt: String(updatedAt),
    }),
    context: buildContext(user),
    params: { id: entityId },
  } as any)) as any;
}

async function addRow(entityId: string, id: string, fn: string) {
  await env.DB.prepare(
    "INSERT INTO entity_functions (id, entity_id, function, certainty, created_at, updated_at) VALUES (?, ?, ?, 'probable', 11, 12)",
  )
    .bind(id, entityId, fn)
    .run();
}

async function functionIds(entityId: string): Promise<string[]> {
  const rows = await env.DB.prepare("SELECT id FROM entity_functions WHERE entity_id = ? ORDER BY rowid")
    .bind(entityId)
    .all<{ id: string }>();
  return rows.results.map((r) => r.id);
}

async function entity(id: string) {
  return db().select().from(schema.entities).where(eq(schema.entities.id, id)).get();
}

async function ledger(operation: "split" | "delete" | "merge") {
  return db()
    .select()
    .from(schema.authorityOperations)
    .where(eq(schema.authorityOperations.operation, operation))
    .all();
}

let admin: User;

beforeAll(async () => {
  await applyMigrations();
});

beforeEach(async () => {
  await cleanDatabase();
  const user = await createTestUser({ isAdmin: true });
  admin = makeUserContext({ id: user.id, tenantId: DEFAULT_TEST_TENANT_ID, isAdmin: true });
});

/** S and L at version 5, S with one function row and L with two. */
async function pair() {
  await createTestEntity({ id: S, entityCode: "ne-s00001", displayName: "Survivor" });
  await createTestEntity({ id: L, entityCode: "ne-l00001", displayName: "Loser" });
  await env.DB.prepare("UPDATE entities SET updated_at = 5 WHERE id IN (?, ?)").bind(S, L).run();
  await addRow(S, "fs-1", "Maestre de Campo");
  await addRow(L, "fl-1", "Alcalde ordinario");
  await addRow(L, "fl-2", "Regidor");
}

/** L merged into S on the decisions surface, at clock 9,000. */
const mergeLIntoS = () => mergeWithEvidence(db(), admin, makeTenantContext(), "entity", S, L, null, 9_000);

describe("the entity split holds to the version it read", () => {
  async function split(DB: D1Database = env.DB, version = "5") {
    const { action } = await import("../../app/routes/_auth.admin.entities.$id.split");
    return (await action({
      request: form({
        _action: "split",
        reason: "two people",
        nameA: "Survivor",
        nameB: "Survivor bis",
        choices: JSON.stringify({
          datesOfExistence: "original",
          history: "original",
          wikidataId: "original",
          viafId: "original",
          dbeId: "original",
        }),
        linkIds: "[]",
        _updatedAt: version,
      }),
      context: buildContext(admin, DB),
      params: { id: S },
    } as any)) as any;
  }

  it("a merge onto the original between the split's reads and its batch returns the conflict and writes nothing", async () => {
    await pair();
    const res = await split(d1Interleaving(/insert into "entities"/i, mergeLIntoS));
    const merged = await entity(S);
    expect(res).toMatchObject({ ok: false, error: "conflict", modifiedAt: merged!.updatedAt });
    expect(merged!.updatedAt).toBe(9_000);
    expect(merged!.displayName).toBe("Survivor");
    expect(await functionIds(S)).toEqual(["fs-1", "fl-1", "fl-2"]);
    expect(await ledger("split")).toEqual([]);
    const all = await db().select({ id: schema.entities.id }).from(schema.entities).all();
    expect(all.map((e) => e.id).sort()).toEqual([S, L]);
  });

  it("an original merged away before the split read it returns the conflict and writes nothing", async () => {
    await pair();
    await mergeWithEvidence(db(), admin, makeTenantContext(), "entity", L, S, null, 9_000);
    const before = await entity(S);
    // The form carries the version the merge wrote, so only the merged-away check can refuse it.
    const res = await split(env.DB, String(before!.updatedAt));
    expect(res).toMatchObject({ ok: false, error: "conflict" });
    expect(await entity(S)).toEqual(before);
    expect(await ledger("split")).toEqual([]);
  });

  it("an undisturbed split still writes the original past the version read and copies its rows", async () => {
    await pair();
    const res = (await split()) as Response;
    expect(res.status).toBe(302);
    expect((await entity(S))!.updatedAt).toBeGreaterThan(5);
    const [row] = await ledger("split");
    expect((await functionIds(row.targetId!)).length).toBe(1);
  });
});

describe("the entity hard delete holds to the version it read", () => {
  async function del(DB: D1Database = env.DB) {
    const { action } = await import("../../app/routes/_auth.admin.entities.$id");
    return action({
      request: form({ _action: "delete" }),
      context: buildContext(admin, DB),
      params: { id: S },
    } as any).then(
      (r) => r as any,
      (thrown) => thrown,
    );
  }

  it("a merge onto the record between the delete's reads and its batch refuses the delete and keeps the moved rows", async () => {
    await pair();
    const res = await del(d1Interleaving(/delete from "entities"/i, mergeLIntoS));
    expect(res).toMatchObject({ ok: false, error: "merge_survivor" });
    expect(await entity(S)).toBeTruthy();
    expect(await functionIds(S)).toEqual(["fs-1", "fl-1", "fl-2"]);
    expect((await entity(L))!.mergedInto).toBe(S);
    expect(await ledger("delete")).toEqual([]);
  });

  it("an edit between the delete's reads and its batch returns the conflict and deletes nothing", async () => {
    await pair();
    const res = await del(
      d1Interleaving(/delete from "entities"/i, async () => {
        const saved = await editorSave(admin, S, "Survivor", "Maestre de Campo\nRegidor", 5);
        expect(saved).toMatchObject({ ok: true });
      }),
    );
    const current = await entity(S);
    expect(res).toMatchObject({ ok: false, error: "conflict", modifiedAt: current!.updatedAt });
    expect(await functionIds(S)).toHaveLength(2);
    expect(await ledger("delete")).toEqual([]);
  });

  it("a record other records were merged into is not deleted", async () => {
    await pair();
    await mergeLIntoS();
    // The merge's evidence gave the survivor links; without them only the merge refuses the delete.
    await env.DB.prepare("DELETE FROM description_entities WHERE entity_id = ?").bind(S).run();
    const res = await del();
    expect(res).toMatchObject({ ok: false, error: "merge_survivor" });
    expect(await entity(S)).toBeTruthy();
    expect(await functionIds(S)).toEqual(["fs-1", "fl-1", "fl-2"]);
    expect(await ledger("delete")).toEqual([]);
  });

  it("the page's loader tells a record others were merged into from one they were not", async () => {
    await pair();
    const { loader } = await import("../../app/routes/_auth.admin.entities.$id");
    const load = async () =>
      (await loader({
        request: new Request(`http://neogranadina.fisqua.test/admin/entities/${S}`),
        context: buildContext(admin),
        params: { id: S },
      } as any)) as any;
    expect((await load()).isMergeSurvivor).toBe(false);
    await mergeLIntoS();
    expect((await load()).isMergeSurvivor).toBe(true);
  });

  it("an undisturbed delete still deletes the record and writes the ledger row", async () => {
    await pair();
    const res = (await del()) as Response;
    expect(res.status).toBe(302);
    expect(await entity(S)).toBeUndefined();
    expect(await ledger("delete")).toHaveLength(1);
  });
});

describe("the vocabulary function merge and split move an entity's version up, in milliseconds", () => {
  const CLOCK = 1_900_000_000_000;

  async function seedTerm(id: string, canonical: string, status: "approved" | "proposed" = "approved") {
    await db().insert(schema.vocabularyTerms).values({
      id,
      federationId: DEFAULT_TEST_FEDERATION_ID,
      canonical,
      status,
      entityCount: 0,
      createdAt: 1,
      updatedAt: 1,
    });
  }

  /** S linked to term-a at version 5, L linked to term-b at version 5. */
  async function linked() {
    await pair();
    await seedTerm("term-a", "Notario");
    await seedTerm("term-b", "Escribano");
    await seedTerm("term-c", "Amanuense", "proposed");
    await env.DB.prepare("UPDATE entities SET primary_function_id = 'term-a' WHERE id = ?").bind(S).run();
    await env.DB.prepare("UPDATE entities SET primary_function_id = 'term-b' WHERE id = ?").bind(L).run();
  }

  async function termPage(termId: string, fields: Record<string, string>) {
    const { action } = await import("../../app/routes/_auth.admin.vocabularies.functions.$id");
    return action({ request: form(fields), context: buildContext(admin), params: { id: termId } } as any).then(
      (r) => r as any,
      (thrown) => thrown,
    );
  }

  async function decisionsMerge(sourceId: string, targetId: string) {
    const { action } = await import("../../app/routes/_auth.admin.decisions.vocabulary");
    return (await action({
      request: form({ _action: "merge", sourceId, targetId }),
      context: buildContext(admin),
      params: {},
    } as any)) as any;
  }

  it("the term page's merge gives each entity it reassigns a version in milliseconds past the one it held", async () => {
    await linked();
    const res = await termPage("term-a", { intent: "merge", targetId: "term-b", linkIds: JSON.stringify([S]) });
    expect((res as Response).status).toBe(302);
    const after = await entity(S);
    expect(after!.primaryFunctionId).toBe("term-b");
    expect(after!.updatedAt).toBeGreaterThan(5);
    expect(after!.updatedAt).toBeGreaterThan(1e12);
  });

  it("the term page's split gives each entity it moves a version in milliseconds past the one it held", async () => {
    await linked();
    const res = await termPage("term-a", { intent: "split", newName: "Notario mayor", linkIds: JSON.stringify([S]) });
    expect((res as Response).status).toBe(302);
    const after = await entity(S);
    expect(after!.primaryFunctionId).not.toBe("term-a");
    expect(after!.updatedAt).toBeGreaterThan(1e12);
  });

  it("the decisions surface's merge gives each entity it reassigns a version in milliseconds past the one it held", async () => {
    await linked();
    const res = await decisionsMerge("term-a", "term-b");
    expect(res).toMatchObject({ ok: true, action: "merged" });
    const after = await entity(S);
    expect(after!.primaryFunctionId).toBe("term-b");
    expect(after!.updatedAt).toBeGreaterThan(5);
    expect(after!.updatedAt).toBeGreaterThan(1e12);
  });

  it("two term-page merges in one second leave a form that read the first one stale", async () => {
    await linked();
    const clock = vi.spyOn(Date, "now").mockReturnValue(CLOCK);
    try {
      await termPage("term-a", { intent: "merge", targetId: "term-b", linkIds: JSON.stringify([S]) });
      const read = (await entity(S))!.updatedAt;
      await termPage("term-b", { intent: "merge", targetId: "term-c", linkIds: JSON.stringify([S]) });
      expect((await entity(S))!.updatedAt).toBeGreaterThan(read);
      const stale = await editorSave(admin, S, "Survivor", "Maestre de Campo", read);
      expect(stale).toMatchObject({ ok: false, error: "conflict" });
    } finally {
      clock.mockRestore();
    }
    expect((await entity(S))!.primaryFunctionId).toBe("term-c");
  });

  it("two decisions-surface merges in one second leave a form that read the first one stale", async () => {
    await linked();
    const clock = vi.spyOn(Date, "now").mockReturnValue(CLOCK);
    try {
      await decisionsMerge("term-a", "term-b");
      const read = (await entity(S))!.updatedAt;
      await decisionsMerge("term-b", "term-c");
      expect((await entity(S))!.updatedAt).toBeGreaterThan(read);
      const stale = await editorSave(admin, S, "Survivor", "Maestre de Campo", read);
      expect(stale).toMatchObject({ ok: false, error: "conflict" });
    } finally {
      clock.mockRestore();
    }
  });

  /** An editor save on S, at version 5, between the reads of `write` and its batch. */
  const editS = () =>
    d1Interleaving(/update "entities" set "primary_function_id"/i, async () => {
      const saved = await editorSave(admin, S, "Survivor (edited)", "Maestre de Campo", 5);
      expect(saved).toMatchObject({ ok: true });
    });

  async function termPageOn(DB: D1Database, termId: string, fields: Record<string, string>) {
    const { action } = await import("../../app/routes/_auth.admin.vocabularies.functions.$id");
    return action({ request: form(fields), context: buildContext(admin, DB), params: { id: termId } } as any).then(
      (r) => r as any,
      (thrown) => thrown,
    );
  }

  async function decisionsMergeOn(DB: D1Database, sourceId: string, targetId: string) {
    const { action } = await import("../../app/routes/_auth.admin.decisions.vocabulary");
    return (await action({
      request: form({ _action: "merge", sourceId, targetId }),
      context: buildContext(admin, DB),
      params: {},
    } as any)) as any;
  }

  async function term(id: string) {
    return db().select().from(schema.vocabularyTerms).where(eq(schema.vocabularyTerms.id, id)).get();
  }

  async function vocabLedger() {
    return db()
      .select()
      .from(schema.authorityOperations)
      .where(eq(schema.authorityOperations.recordType, "vocabulary_term"))
      .all();
  }

  it("an edit between the term page merge's reads and its batch returns the conflict and writes nothing", async () => {
    await linked();
    const res = await termPageOn(editS(), "term-a", { intent: "merge", targetId: "term-b", linkIds: JSON.stringify([S]) });
    expect(res).toMatchObject({ error: "conflict" });
    const s = await entity(S);
    expect(s!.displayName).toBe("Survivor (edited)");
    expect(s!.primaryFunctionId).toBe("term-a");
    expect((await term("term-a"))!.mergedInto).toBeNull();
    expect((await term("term-a"))!.status).toBe("approved");
    expect(await vocabLedger()).toEqual([]);
  });

  it("an edit between the term page split's reads and its batch returns the conflict and writes nothing", async () => {
    await linked();
    const res = await termPageOn(editS(), "term-a", { intent: "split", newName: "Notario mayor", linkIds: JSON.stringify([S]) });
    expect(res).toMatchObject({ error: "conflict" });
    const s = await entity(S);
    expect(s!.displayName).toBe("Survivor (edited)");
    expect(s!.primaryFunctionId).toBe("term-a");
    const terms = await db().select({ canonical: schema.vocabularyTerms.canonical }).from(schema.vocabularyTerms).all();
    expect(terms.map((t) => t.canonical)).not.toContain("Notario mayor");
    expect(await vocabLedger()).toEqual([]);
  });

  it("an edit between the decisions surface merge's reads and its batch returns the conflict and writes nothing", async () => {
    await linked();
    const res = await decisionsMergeOn(editS(), "term-a", "term-b");
    expect(res).toMatchObject({ ok: false, error: "conflict" });
    const s = await entity(S);
    expect(s!.displayName).toBe("Survivor (edited)");
    expect(s!.primaryFunctionId).toBe("term-a");
    expect((await term("term-a"))!.mergedInto).toBeNull();
    expect(await vocabLedger()).toEqual([]);
  });

  it("an entity linked to the source term between the decisions surface merge's reads and its batch returns the conflict", async () => {
    await linked();
    const res = await decisionsMergeOn(
      d1Interleaving(/update "entities" set "primary_function_id"/i, () =>
        env.DB.prepare("UPDATE entities SET primary_function_id = 'term-a', updated_at = 6 WHERE id = ?").bind(L).run(),
      ),
      "term-a",
      "term-b",
    );
    expect(res).toMatchObject({ ok: false, error: "conflict" });
    expect((await entity(S))!.primaryFunctionId).toBe("term-a");
    expect((await entity(L))!.primaryFunctionId).toBe("term-a");
    expect((await term("term-a"))!.mergedInto).toBeNull();
    expect(await vocabLedger()).toEqual([]);
  });

  it("the term page's merge leaves alone an entity the form names that is linked to another term", async () => {
    await linked();
    // L was listed for term-a's merge but is linked to term-b.
    await termPage("term-a", { intent: "merge", targetId: "term-c", linkIds: JSON.stringify([S, L]) });
    const l = await entity(L);
    expect(l!.primaryFunctionId).toBe("term-b");
    expect(l!.updatedAt).toBe(5);
    expect((await entity(S))!.primaryFunctionId).toBe("term-c");
  });
});

/* @version v0.9.0 */
