/**
 * Tests — the place split and the place delete hold to the version they read
 *
 * This suite pins that the place split and the place delete hold to the
 * version they read. A write that changes a place's merge state, or
 * rewrites it from the values it read, runs only while the place still
 * holds the version the write read, and moves the version strictly past
 * it. Pinned here, against the test D1, for the two place writers outside
 * the merge paths:
 *
 *   - the place split workbench: a merge of the original away, or an
 *     edit of it, that lands between the split's reads and its batch
 *     makes the split return the conflict, with nothing written, and so
 *     does an unlink of a link the split was to move; an original merged
 *     away before the split read it returns the conflict too;
 *   - the place hard delete: a merge onto the record between the
 *     delete's reads and its batch makes the delete refuse it; an edit
 *     between the reads and the batch returns the conflict; a record
 *     other records were merged into is not deleted.
 *
 * @version v0.9.0
 */
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { and, eq } from "drizzle-orm";
import { RouterContextProvider } from "react-router";
import * as schema from "../../app/db/schema";
import { applyMigrations, cleanDatabase, DEFAULT_TEST_TENANT_ID } from "../helpers/db";
import { createTestUser } from "../helpers/auth";
import { createTestPlace } from "../helpers/places";
import { createTestDescription } from "../helpers/descriptions";
import { createTestRepository } from "../helpers/repositories";
import { tenantContext, userContext, type User } from "../../app/context";
import { makeTenantContext, makeUserContext } from "../helpers/context";
import { rulePairMerge } from "../../app/lib/pair-merge.server";
// Warm the route module graph so the in-test `await import()` resolves
// from cache (see the note in vocab-merge-split-action.test.ts).
import "../../app/routes/_auth.admin.places.$id";
import "../../app/routes/_auth.admin.places.$id.split";

const P = "33333333-3333-4333-8333-333333333333";
const Q = "44444444-4444-4444-8444-444444444444";

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

/** The place editor's save on `placeId`, at the version the form read. */
async function editorSave(user: User, placeId: string, label: string, updatedAt: number) {
  const { action } = await import("../../app/routes/_auth.admin.places.$id");
  return (await action({
    request: form({ _action: "update", label, displayName: label, _updatedAt: String(updatedAt) }),
    context: buildContext(user),
    params: { id: placeId },
  } as any)) as any;
}

async function place(id: string) {
  return db().select().from(schema.places).where(eq(schema.places.id, id)).get();
}

async function ledger(operation: "split" | "delete") {
  return db()
    .select()
    .from(schema.authorityOperations)
    .where(and(eq(schema.authorityOperations.recordType, "place"), eq(schema.authorityOperations.operation, operation)))
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

/** P and Q at version 5. */
async function pair() {
  await createTestPlace({ id: P, placeCode: "nl-p00001", label: "Popayán", displayName: "Popayán" });
  await createTestPlace({ id: Q, placeCode: "nl-q00001", label: "Quito", displayName: "Quito" });
  await env.DB.prepare("UPDATE places SET updated_at = 5 WHERE id IN (?, ?)").bind(P, Q).run();
}

/** `loser` merged into `survivor` on the decisions surface, at clock 9,000. */
const merge = (survivor: string, loser: string) => () =>
  rulePairMerge(db(), admin, makeTenantContext(), "place", survivor, loser, null, 9_000);

async function placeIds() {
  const all = await db().select({ id: schema.places.id }).from(schema.places).all();
  return all.map((p) => p.id).sort();
}

describe("the place split holds to the version it read", () => {
  async function split(DB: D1Database = env.DB, version = "5", linkIds: string[] = []) {
    const { action } = await import("../../app/routes/_auth.admin.places.$id.split");
    return (await action({
      request: form({
        _action: "split",
        reason: "two towns",
        nameA: "Popayán",
        nameB: "Popayán viejo",
        choices: JSON.stringify({ coordinates: "original", tgnId: "original", hgisId: "original", whgId: "original" }),
        linkIds: JSON.stringify(linkIds),
        _updatedAt: version,
      }),
      context: buildContext(admin, DB),
      params: { id: P },
    } as any)) as any;
  }

  it("a merge of the original away between the split's reads and its batch returns the conflict and writes nothing", async () => {
    await pair();
    const res = await split(d1Interleaving(/insert into "places"/i, merge(Q, P)));
    const merged = await place(P);
    expect(res).toMatchObject({ ok: false, error: "conflict", modifiedAt: merged!.updatedAt });
    expect(merged!.mergedInto).toBe(Q);
    expect(merged!.label).toBe("Popayán");
    expect(await placeIds()).toEqual([P, Q]);
    expect(await ledger("split")).toEqual([]);
  });

  it("an edit between the split's reads and its batch returns the conflict and keeps the edit", async () => {
    await pair();
    const res = await split(
      d1Interleaving(/insert into "places"/i, async () => {
        expect(await editorSave(admin, P, "Popayán (edited)", 5)).toMatchObject({ ok: true });
      }),
    );
    const edited = await place(P);
    expect(res).toMatchObject({ ok: false, error: "conflict", modifiedAt: edited!.updatedAt });
    expect(edited!.label).toBe("Popayán (edited)");
    expect(await placeIds()).toEqual([P, Q]);
    expect(await ledger("split")).toEqual([]);
  });

  it("an unlink of a link the split was to move, between its reads and its batch, returns the conflict and writes nothing", async () => {
    await pair();
    const repository = await createTestRepository();
    const description = await createTestDescription({ repositoryId: repository.id, referenceCode: "SPLIT-1", title: "Litigio" });
    const linkId = crypto.randomUUID();
    await db().insert(schema.descriptionPlaces).values({
      id: linkId,
      descriptionId: description.id,
      placeId: P,
      role: "mentioned",
      createdAt: Date.now(),
    });
    const res = await split(
      d1Interleaving(/insert into "places"/i, () =>
        env.DB.prepare("DELETE FROM description_places WHERE id = ?").bind(linkId).run(),
      ),
      "5",
      [linkId],
    );
    expect(res).toMatchObject({ ok: false, error: "conflict" });
    expect((await place(P))!.updatedAt).toBe(5);
    expect(await placeIds()).toEqual([P, Q]);
    expect(await ledger("split")).toEqual([]);
  });

  it("an original merged away before the split read it returns the conflict and writes nothing", async () => {
    await pair();
    await merge(Q, P)();
    const before = await place(P);
    // The form carries the version the merge wrote, so only the merged-away check can refuse it.
    const res = await split(env.DB, String(before!.updatedAt));
    expect(res).toMatchObject({ ok: false, error: "conflict" });
    expect(await place(P)).toEqual(before);
    expect(await placeIds()).toEqual([P, Q]);
    expect(await ledger("split")).toEqual([]);
  });

  it("an undisturbed split still writes the original past the version read", async () => {
    await pair();
    const res = (await split()) as Response;
    expect(res.status).toBe(302);
    expect((await place(P))!.updatedAt).toBeGreaterThan(5);
    expect(await ledger("split")).toHaveLength(1);
  });
});

describe("the place hard delete holds to the version it read", () => {
  async function del(DB: D1Database = env.DB) {
    const { action } = await import("../../app/routes/_auth.admin.places.$id");
    return action({
      request: form({ _action: "delete" }),
      context: buildContext(admin, DB),
      params: { id: P },
    } as any).then(
      (r) => r as any,
      (thrown) => thrown,
    );
  }

  it("a merge onto the record between the delete's reads and its batch refuses the delete", async () => {
    await pair();
    const res = await del(d1Interleaving(/delete from "places"/i, merge(P, Q)));
    expect(res).toMatchObject({ ok: false, error: "merge_survivor" });
    expect(await place(P)).toBeTruthy();
    expect((await place(Q))!.mergedInto).toBe(P);
    expect(await ledger("delete")).toEqual([]);
  });

  it("an edit between the delete's reads and its batch returns the conflict and deletes nothing", async () => {
    await pair();
    const res = await del(
      d1Interleaving(/delete from "places"/i, async () => {
        expect(await editorSave(admin, P, "Popayán (edited)", 5)).toMatchObject({ ok: true });
      }),
    );
    const current = await place(P);
    expect(res).toMatchObject({ ok: false, error: "conflict", modifiedAt: current!.updatedAt });
    expect(current!.label).toBe("Popayán (edited)");
    expect(await ledger("delete")).toEqual([]);
  });

  it("a record other records were merged into is not deleted", async () => {
    await pair();
    await merge(P, Q)();
    const res = await del();
    expect(res).toMatchObject({ ok: false, error: "merge_survivor" });
    expect(await place(P)).toBeTruthy();
    expect(await ledger("delete")).toEqual([]);
  });

  it("an undisturbed delete still deletes the record and writes the ledger row", async () => {
    await pair();
    const res = (await del()) as Response;
    expect(res.status).toBe(302);
    expect(await place(P)).toBeUndefined();
    expect(await ledger("delete")).toHaveLength(1);
  });
});

/* @version v0.9.0 */
