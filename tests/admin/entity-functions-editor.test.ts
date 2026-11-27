/**
 * Tests — the entity editor writes functions as entity_functions rows
 *
 * This suite pins that the entity pages read and write an entity's
 * functions only in `entity_functions`, one row per line of the
 * functions field; the `entities.functions` column is neither shown nor
 * written. The loader shows the rows one per line, in the order they
 * were entered. Saving replaces the entity's set in one batch: a line
 * that matches an existing row's trimmed text keeps that row (its id,
 * its other columns and its stored text), a line that matches none
 * adds a row, a row that no line matches goes, and the rows are entered
 * in the order of the lines. Blank lines are not functions. A line that
 * would add a function the record keeps or adds already (text compared
 * after trimming, collapsing whitespace and case-folding) is dropped,
 * and the changelog records the lines kept; rows the record held twice
 * before the save stay while their lines do. The same
 * batch sets the entity's `updated_at`. A save whose lines equal the
 * rows leaves the rows as they are.
 *
 * The new version is the clock, or one past the version read when the
 * clock has not passed it, so every save moves the version.
 *
 * The batch runs only at the version the form was loaded at: of two
 * saves from the same version, the second changes nothing, functions
 * included, and gets the conflict response. Creating an entity writes
 * its functions as rows too, each function once.
 *
 * @version v0.9.0
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { RouterContextProvider } from "react-router";
import * as schema from "../../app/db/schema";
import { applyMigrations, cleanDatabase, DEFAULT_TEST_FEDERATION_ID } from "../helpers/db";
import { createTestEntity } from "../helpers/entities";
import { tenantContext, userContext, type User } from "../../app/context";
import { makeTenantContext, makeUserContext } from "../helpers/context";
// Warm the route module graph at file load (see
// entities-primary-function-validation.test.ts).
import "../../app/routes/_auth.admin.entities.$id";
import "../../app/routes/_auth.admin.entities.new";

function buildContext(user: User): any {
  const ctx = new RouterContextProvider();
  ctx.set(userContext, user);
  ctx.set(tenantContext, makeTenantContext({ id: user.tenantId }));
  (ctx as any).cloudflare = { env };
  return ctx;
}

async function save(user: User, entityId: string, functions: string, updatedAt?: string) {
  const { action } = await import("../../app/routes/_auth.admin.entities.$id");
  const body = new URLSearchParams({
    _action: "update",
    displayName: "Juan de Castellanos",
    sortName: "Castellanos, Juan de",
    entityType: "person",
    nameVariants: "[]",
    functions,
    ...(updatedAt ? { _updatedAt: updatedAt } : {}),
  });
  return (await action({
    request: new Request(`http://neogranadina.fisqua.test/admin/entities/${entityId}`, {
      method: "POST",
      body,
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    }),
    context: buildContext(user),
    params: { id: entityId },
  } as any)) as any;
}

/** The entity's rows in entry order. */
async function rows(entityId: string) {
  return (
    await env.DB.prepare(
      "SELECT rowid AS r, id, function, source FROM entity_functions WHERE entity_id = ? ORDER BY rowid"
    ).bind(entityId).all<{ r: number; id: string; function: string; source: string | null }>()
  ).results;
}

async function addRow(entityId: string, id: string, fn: string, source: string | null = null) {
  await env.DB.prepare(
    "INSERT INTO entity_functions (id, entity_id, function, source, created_at, updated_at) VALUES (?, ?, ?, ?, 1, 1)"
  ).bind(id, entityId, fn, source).run();
}

describe("entity editor: functions as entity_functions rows", () => {
  let admin: User;
  beforeAll(async () => {
    await applyMigrations();
  });
  beforeEach(async () => {
    await cleanDatabase();
    admin = makeUserContext({ isAdmin: true });
    await drizzle(env.DB, { schema }).insert(schema.users).values({
      id: admin.id, tenantId: admin.tenantId, email: "admin-ef@example.test", isAdmin: true,
      createdAt: Date.now(), updatedAt: Date.now(),
    });
  });

  async function entity(): Promise<string> {
    const e = await createTestEntity({ federationId: DEFAULT_TEST_FEDERATION_ID });
    await env.DB.prepare("UPDATE entities SET updated_at = 5, functions = '' WHERE id = ?").bind(e.id).run();
    return e.id;
  }

  async function entityRow(id: string) {
    return drizzle(env.DB, { schema })
      .select({ updatedAt: schema.entities.updatedAt, functions: schema.entities.functions })
      .from(schema.entities)
      .where(eq(schema.entities.id, id))
      .get();
  }

  it("saves each non-blank line as a row, in order, sets updated_at and clears the column", async () => {
    const id = await entity();
    const res = await save(admin, id, "Capitán\n  escribano \r\n\n   \nCapitán");
    expect(res.ok).toBe(true);
    expect((await rows(id)).map((r) => r.function)).toEqual(["Capitán", "escribano"]);
    const e = await entityRow(id);
    expect(e!.updatedAt).toBeGreaterThan(5);
    expect(e!.functions).toBe("");
  });

  it("does not add a function the record holds or the lines add already, case and spacing aside", async () => {
    const id = await entity();
    await addRow(id, "f-a", "Cura", "acta 1");
    await save(admin, id, "Cura\ncura\n  CURA  \nAlcalde  ordinario\nalcalde ordinario");
    const after = await rows(id);
    expect(after.map((r) => [r.function, r.source])).toEqual([["Cura", "acta 1"], ["Alcalde  ordinario", null]]);
    expect(after[0].id).toBe("f-a");
    // The changelog records the lines kept, not the lines typed.
    const journal = await env.DB.prepare("SELECT diff FROM changelog WHERE record_id = ? ORDER BY rowid DESC LIMIT 1")
      .bind(id).first<{ diff: string }>();
    expect(JSON.parse(journal!.diff).functions).toEqual({ old: "Cura", new: "Cura\nAlcalde  ordinario" });
    // A line differing only in case from a held row it does not keep still adds nothing.
    await save(admin, id, "cura\nCura");
    expect((await rows(id)).map((r) => r.id)).toEqual(["f-a"]);
  });

  it("keeps rows the record held twice before the save while their lines do", async () => {
    const id = await entity();
    await addRow(id, "f-a", "Cura");
    await addRow(id, "f-b", "Cura");
    const before = await rows(id);
    await save(admin, id, "Cura\nCura");
    expect(await rows(id)).toEqual(before);
  });

  it("matches existing rows by their trimmed text, keeping their id, metadata and stored text", async () => {
    const id = await entity();
    await addRow(id, "f-a", "  Alcalde ", "acta 1");
    await addRow(id, "f-b", "Regidor");
    await save(admin, id, "Regidor\nAlcalde");
    const after = await rows(id);
    expect(after.map((r) => [r.id, r.function, r.source])).toEqual([
      ["f-b", "Regidor", null],
      ["f-a", "  Alcalde ", "acta 1"],
    ]);
    // The same lines in the same order: nothing is written.
    const before = await rows(id);
    await save(admin, id, " Regidor\nAlcalde  ");
    expect(await rows(id)).toEqual(before);
  });

  it("refuses the second of two saves from the same version, functions included", async () => {
    const id = await entity();
    await addRow(id, "f-a", "Alcalde");
    const first = await save(admin, id, "Alcalde\nRegidor", "5");
    expect(first.ok).toBe(true);
    const second = await save(admin, id, "Notario", "5");
    expect(second.ok).toBe(false);
    expect(second.error).toBe("conflict");
    expect((await rows(id)).map((r) => r.function)).toEqual(["Alcalde", "Regidor"]);
    const e = await entityRow(id);
    expect(e!.updatedAt).toBe(second.modifiedAt);
  });

  it("moves the version past the one read when the clock has not", async () => {
    // A save in the same millisecond as the version it read still gives
    // the entity a new version, so a merge's guard sees the change.
    const id = await entity();
    await addRow(id, "f-a", "Alcalde");
    const clock = vi.spyOn(Date, "now").mockReturnValue(5);
    try {
      const res = await save(admin, id, "Regidor", "5");
      expect(res.ok).toBe(true);
    } finally {
      clock.mockRestore();
    }
    expect((await entityRow(id))!.updatedAt).toBe(6);
    expect((await rows(id)).map((r) => r.function)).toEqual(["Regidor"]);
  });

  it("refuses a save that loses a race after its version check, functions included", async () => {
    // The batch itself carries the version: a write that lands between
    // the action's read and its batch makes the whole batch a no-op.
    const id = await entity();
    await addRow(id, "f-a", "Alcalde");
    const { readEntityFunctionRows, entityFunctionsReplacement } = await import(
      "../../app/lib/entity-functions.server"
    );
    const db = drizzle(env.DB, { schema });
    const existing = await readEntityFunctionRows(db, id);
    await env.DB.prepare("UPDATE entities SET updated_at = 6 WHERE id = ?").bind(id).run();
    const { functionStatements, touch } = entityFunctionsReplacement(db, id, ["Notario"], existing, 5, 7);
    const results = await db.batch([...functionStatements, touch] as any);
    expect((results.at(-1) as any).meta.changes).toBe(0);
    expect((await rows(id)).map((r) => r.function)).toEqual(["Alcalde"]);
    expect((await entityRow(id))!.updatedAt).toBe(6);
  });

  it("keeps the row of each kept line, drops removed lines and enters the rows in the order given", async () => {
    const id = await entity();
    await addRow(id, "f-a", "Alcalde", "acta 1");
    await addRow(id, "f-b", "Regidor");
    await addRow(id, "f-c", "Escribano");
    await save(admin, id, "Escribano\nAlcalde\nNotario");
    const after = await rows(id);
    expect(after.map((r) => r.function)).toEqual(["Escribano", "Alcalde", "Notario"]);
    expect(after[0].id).toBe("f-c");
    expect(after[1].id).toBe("f-a");
    expect(after[1].source).toBe("acta 1");
    expect(["f-a", "f-b", "f-c"]).not.toContain(after[2].id);
  });

  it("leaves the rows as they are when the lines equal them, and still sets updated_at", async () => {
    const id = await entity();
    await addRow(id, "f-a", "Alcalde");
    await addRow(id, "f-b", "Regidor");
    const before = await rows(id);
    await save(admin, id, "Alcalde\nRegidor\n");
    expect(await rows(id)).toEqual(before);
    expect((await entityRow(id))!.updatedAt).toBeGreaterThan(5);
  });

  it("removes every row when the field is emptied", async () => {
    const id = await entity();
    await addRow(id, "f-a", "Alcalde");
    await save(admin, id, "  \n");
    expect(await rows(id)).toEqual([]);
  });

  it("shows the rows one per line in the loader, and never the column", async () => {
    const { loader } = await import("../../app/routes/_auth.admin.entities.$id");
    const load = async (id: string) => {
      const res: any = await loader({
        request: new Request(`http://neogranadina.fisqua.test/admin/entities/${id}`),
        context: buildContext(admin),
        params: { id },
      } as any);
      return res instanceof Response ? await res.json() : res;
    };
    const id = await entity();
    await env.DB.prepare("UPDATE entities SET functions = 'texto viejo' WHERE id = ?").bind(id).run();
    expect((await load(id)).entity.functions).toBeNull();
    await addRow(id, "f-b", "Regidor");
    await addRow(id, "f-a", "Alcalde");
    expect((await load(id)).entity.functions).toBe("Regidor\nAlcalde");
  });

  it("writes a new entity's functions as rows, not to the column", async () => {
    const { action } = await import("../../app/routes/_auth.admin.entities.new");
    const res: any = await action({
      request: new Request("http://neogranadina.fisqua.test/admin/entities/new", {
        method: "POST",
        body: new URLSearchParams({
          _action: "create",
          displayName: "Nueva Persona",
          sortName: "Persona, Nueva",
          entityType: "person",
          nameVariants: "[]",
          functions: "Escribano\n\n Alcalde \nescribano",
        }),
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
      }),
      context: buildContext(admin),
      params: {},
    } as any);
    expect(res.status).toBe(302);
    const made = await env.DB.prepare("SELECT id, functions FROM entities WHERE display_name = 'Nueva Persona'")
      .first<{ id: string; functions: string | null }>();
    expect(made!.functions).toBeNull();
    expect((await rows(made!.id)).map((r) => r.function)).toEqual(["Escribano", "Alcalde"]);
  });
});

// @version v0.9.0
