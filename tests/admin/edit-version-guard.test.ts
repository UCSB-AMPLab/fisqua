/**
 * Tests — the edit forms' version check guards the write itself
 *
 * This suite pins that the version check of the edit forms guards the
 * write itself. A save from the description, entity, place or repository
 * edit form carries the version (`updated_at`) its fields were loaded at.
 * The action compares it with the stored version, and the UPDATE it then
 * runs is itself conditioned on the version the action read, so a save
 * that another lands between that read and the write changes nothing,
 * writes no changelog entry and gets the conflict response; the other
 * save's values stay. Each save moves the version to at least one past the
 * version read, and a successful save returns the new version, which the
 * form submits with its next save. A forced overwrite after a conflict
 * writes past the form's stale version, but still only at the version the
 * action read for it.
 *
 * Publishing or unpublishing a description moves its version the same
 * way, at the version the toggle read, and returns the versions it moved
 * from and to. An edit form open on the description adopts the new
 * version only when it holds the one the toggle moved from, so a toggle
 * during an edit does not make the editor's own next save conflict, and
 * never hides another editor's save made before it.
 *
 * The other save is made to land between the action's read and its
 * write by handing the action a D1 binding that runs it just before the
 * first UPDATE of the record's table.
 *
 * @version v0.9.0
 */
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { RouterContextProvider } from "react-router";
import { applyMigrations, cleanDatabase } from "../helpers/db";
import { createTestUser } from "../helpers/auth";
import { createTestRepository } from "../helpers/repositories";
import { createTestDescription } from "../helpers/descriptions";
import { createTestEntity } from "../helpers/entities";
import { createTestPlace } from "../helpers/places";
import { tenantContext, userContext, type User } from "../../app/context";
import { makeTenantContext, makeUserContext } from "../helpers/context";
import { nextVersion } from "../../app/lib/record-version.server";
import { nextFormVersion } from "../../app/lib/use-form-version";
import "../../app/routes/_auth.admin.descriptions.$id";
import "../../app/routes/_auth.admin.entities.$id";
import "../../app/routes/_auth.admin.places.$id";
import "../../app/routes/_auth.admin.repositories.$id";

type Kind = "description" | "entity" | "place" | "repository";
const KINDS: Kind[] = ["description", "entity", "place", "repository"];
const TABLE: Record<Kind, string> = {
  description: "descriptions",
  entity: "entities",
  place: "places",
  repository: "repositories",
};

/** The version every seeded record holds. */
const LOADED = 1000;

function buildContext(user: User, DB: D1Database): any {
  const ctx = new RouterContextProvider();
  ctx.set(userContext, user);
  ctx.set(tenantContext, makeTenantContext({ id: user.tenantId, multiRepositoryEnabled: true }));
  (ctx as any).cloudflare = { env: { ...env, DB } };
  return ctx;
}

async function routeModule(kind: Kind) {
  switch (kind) {
    case "description":
      return import("../../app/routes/_auth.admin.descriptions.$id");
    case "entity":
      return import("../../app/routes/_auth.admin.entities.$id");
    case "place":
      return import("../../app/routes/_auth.admin.places.$id");
    case "repository":
      return import("../../app/routes/_auth.admin.repositories.$id");
  }
}

async function save(
  kind: Kind,
  user: User,
  id: string,
  fields: Record<string, string>,
  DB: D1Database = env.DB,
) {
  const mod = await routeModule(kind);
  return (await mod.action({
    request: new Request(`http://neogranadina.fisqua.test/admin/${TABLE[kind]}/${id}`, {
      method: "POST",
      body: new URLSearchParams({ _action: "update", ...fields }),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    }),
    context: buildContext(user, DB),
    params: { id },
  } as any)) as any;
}

/**
 * A D1 binding that, just before the first UPDATE of `table` runs
 * (alone or in a batch), lets another editor save `notes` at version
 * `version` through the real binding.
 */
function withSaveBetween(table: string, id: string, notes: string, version: number): D1Database {
  const real = env.DB;
  let landed = false;
  const land = async () => {
    if (landed) return;
    landed = true;
    await real
      .prepare(`UPDATE ${table} SET notes = ?, updated_at = ? WHERE id = ?`)
      .bind(notes, version, id)
      .run();
  };
  const isTarget = (query: string) =>
    query.trimStart().toLowerCase().startsWith(`update "${table}"`);
  type Wrapped = { __real: D1PreparedStatement; __target: boolean };
  const wrap = (stmt: D1PreparedStatement, target: boolean): any => ({
    __real: stmt,
    __target: target,
    bind: (...args: unknown[]) => wrap(stmt.bind(...args), target),
    run: async () => {
      if (target) await land();
      return stmt.run();
    },
    all: async () => {
      if (target) await land();
      return stmt.all();
    },
    raw: async (opts?: any) => {
      if (target) await land();
      return stmt.raw(opts);
    },
    first: async (col?: any) => {
      if (target) await land();
      return stmt.first(col);
    },
  });
  return new Proxy(real, {
    get(target, prop) {
      if (prop === "prepare") {
        return (query: string) => wrap(target.prepare(query), isTarget(query));
      }
      if (prop === "batch") {
        return async (stmts: Array<D1PreparedStatement | Wrapped>) => {
          if (stmts.some((s) => (s as Wrapped).__target)) await land();
          return target.batch(stmts.map((s) => (s as Wrapped).__real ?? s) as D1PreparedStatement[]);
        };
      }
      const value = (target as any)[prop];
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

async function seed(kind: Kind): Promise<string> {
  let id: string;
  if (kind === "description") {
    const repoId = crypto.randomUUID();
    await createTestRepository({ id: repoId, code: "TEST" });
    const d = await createTestDescription({ repositoryId: repoId });
    id = d.id as string;
    // The fields ISAD(G) requires at fonds level, so a save can pass
    // validation and reach the lock.
    await env.DB.prepare(
      "UPDATE descriptions SET extent = '2 legajos', scope_content = 'Actas', date_expression = '1600', creator_display = 'Cabildo' WHERE id = ?",
    )
      .bind(id)
      .run();
  } else if (kind === "entity") {
    id = (await createTestEntity({ entityCode: "ne-ver001" })).id;
  } else if (kind === "place") {
    id = (await createTestPlace({ label: "Tunja", displayName: "Tunja", placeCode: "nl-ver001" })).id;
  } else {
    id = crypto.randomUUID();
    await createTestRepository({ id, code: "AHT", name: "Archivo Histórico de Tunja" });
  }
  await env.DB.prepare(`UPDATE ${TABLE[kind]} SET notes = 'Nota guardada', updated_at = ? WHERE id = ?`)
    .bind(LOADED, id)
    .run();
  return id;
}

async function stored(kind: Kind, id: string) {
  return (await env.DB.prepare(`SELECT notes, updated_at FROM ${TABLE[kind]} WHERE id = ?`)
    .bind(id)
    .first<{ notes: string | null; updated_at: number }>())!;
}

async function changelogCount(id: string) {
  return (await env.DB.prepare("SELECT count(*) AS n FROM changelog WHERE record_id = ?")
    .bind(id)
    .first<{ n: number }>())!.n;
}

describe("nextVersion", () => {
  it("is the time of the save when that is past the version read", () => {
    expect(nextVersion(1000, 5000)).toBe(5000);
  });
  it("is one past the version read when the clock has not moved past it", () => {
    expect(nextVersion(1000, 1000)).toBe(1001);
    expect(nextVersion(1000, 400)).toBe(1001);
  });
});

describe("the edit forms' version check guards the write", () => {
  let admin: User;
  beforeAll(async () => {
    await applyMigrations();
  });
  beforeEach(async () => {
    await cleanDatabase();
    const u = await createTestUser({ isAdmin: true });
    admin = makeUserContext({ id: u.id, isAdmin: true });
  });

  for (const kind of KINDS) {
    it(`${kind}: of two saves from the same version, the second gets the conflict and the first's values stay`, async () => {
      const id = await seed(kind);
      const first = await save(kind, admin, id, { _updatedAt: String(LOADED), notes: "Nota de A" });
      expect(first).toMatchObject({ ok: true, message: "updated" });
      const second = await save(kind, admin, id, { _updatedAt: String(LOADED), notes: "Nota de B" });
      expect(second).toMatchObject({ ok: false, error: "conflict" });
      expect((await stored(kind, id)).notes).toBe("Nota de A");
    });

    it(`${kind}: a save that another lands between its version check and its write changes nothing and logs nothing`, async () => {
      const id = await seed(kind);
      const before = await changelogCount(id);
      const res = await save(
        kind,
        admin,
        id,
        { _updatedAt: String(LOADED), notes: "Nota de B" },
        withSaveBetween(TABLE[kind], id, "Nota de A", 2000),
      );
      expect(res).toMatchObject({ ok: false, error: "conflict", modifiedAt: 2000 });
      expect(await stored(kind, id)).toEqual({ notes: "Nota de A", updated_at: 2000 });
      expect(await changelogCount(id)).toBe(before);
    });

    it(`${kind}: a successful save returns the new version, and the form's next save at that version succeeds`, async () => {
      const id = await seed(kind);
      const first = await save(kind, admin, id, { _updatedAt: String(LOADED), notes: "Nota uno" });
      expect(first).toMatchObject({ ok: true, message: "updated" });
      expect(first.updatedAt).toBeGreaterThan(LOADED);
      expect(first.updatedAt).toBe((await stored(kind, id)).updated_at);
      const second = await save(kind, admin, id, { _updatedAt: String(first.updatedAt), notes: "Nota dos" });
      expect(second).toMatchObject({ ok: true, message: "updated" });
      expect(second.updatedAt).toBeGreaterThan(first.updatedAt);
      expect((await stored(kind, id)).notes).toBe("Nota dos");
    });

    it(`${kind}: a forced overwrite writes past the form's stale version`, async () => {
      const id = await seed(kind);
      const res = await save(kind, admin, id, { _updatedAt: "1", _force: "true", notes: "Nota forzada" });
      expect(res).toMatchObject({ ok: true, message: "updated" });
      expect((await stored(kind, id)).notes).toBe("Nota forzada");
    });

    it(`${kind}: a forced overwrite is refused when the record changes between its own read and write`, async () => {
      const id = await seed(kind);
      const before = await changelogCount(id);
      const res = await save(
        kind,
        admin,
        id,
        { _updatedAt: "1", _force: "true", notes: "Nota forzada" },
        withSaveBetween(TABLE[kind], id, "Nota de A", 2000),
      );
      expect(res).toMatchObject({ ok: false, error: "conflict", modifiedAt: 2000 });
      expect(await stored(kind, id)).toEqual({ notes: "Nota de A", updated_at: 2000 });
      expect(await changelogCount(id)).toBe(before);
    });
  }
});

async function togglePublish(user: User, id: string, DB: D1Database = env.DB) {
  const mod = await routeModule("description");
  return (await mod.action({
    request: new Request(`http://neogranadina.fisqua.test/admin/descriptions/${id}`, {
      method: "POST",
      body: new URLSearchParams({ _action: "toggle_publish", descriptionId: id }),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    }),
    context: buildContext(user, DB),
    params: { id },
  } as any)) as any;
}

describe("publishing a description while its edit form is open", () => {
  let admin: User;
  beforeAll(async () => {
    await applyMigrations();
  });
  beforeEach(async () => {
    await cleanDatabase();
    const u = await createTestUser({ isAdmin: true });
    admin = makeUserContext({ id: u.id, isAdmin: true });
  });

  it("moves the version on from the one it read and returns both", async () => {
    const id = await seed("description");
    const res = await togglePublish(admin, id);
    expect(res).toMatchObject({ ok: true, from: LOADED });
    expect(res.to).toBeGreaterThan(LOADED);
    expect((await stored("description", id)).updated_at).toBe(res.to);
  });

  it("lets the editor's own save through after a toggle during the edit", async () => {
    const id = await seed("description");
    let form = nextFormVersion(null, `${id}:true`, LOADED, undefined, undefined);
    const toggled = await togglePublish(admin, id);
    // The loader revalidates to the toggle's version; the form takes it
    // from the toggle's response because it held the version moved from.
    form = nextFormVersion(form, `${id}:true`, toggled.to, undefined, toggled);
    expect(form.version).toBe(toggled.to);
    const res = await save("description", admin, id, { _updatedAt: String(form.version), notes: "Nota editada" });
    expect(res).toMatchObject({ ok: true, message: "updated" });
    expect((await stored("description", id)).notes).toBe("Nota editada");
  });

  it("still meets the conflict when another editor saved before the toggle", async () => {
    const id = await seed("description");
    let form = nextFormVersion(null, `${id}:true`, LOADED, undefined, undefined);
    const other = await save("description", admin, id, { _updatedAt: String(LOADED), notes: "Nota de A" });
    expect(other.ok).toBe(true);
    const toggled = await togglePublish(admin, id);
    expect(toggled.from).toBe(other.updatedAt);
    form = nextFormVersion(form, `${id}:true`, toggled.to, undefined, toggled);
    expect(form.version).toBe(LOADED);
    const res = await save("description", admin, id, { _updatedAt: String(form.version), notes: "Nota de B" });
    expect(res).toMatchObject({ ok: false, error: "conflict" });
    expect((await stored("description", id)).notes).toBe("Nota de A");
  });

  it("changes nothing when another save lands between the toggle's read and its write", async () => {
    const id = await seed("description");
    const before = (await env.DB.prepare("SELECT is_published FROM descriptions WHERE id = ?")
      .bind(id)
      .first<{ is_published: number }>())!.is_published;
    const res = await togglePublish(admin, id, withSaveBetween("descriptions", id, "Nota de A", 2000));
    expect(res.ok).toBe(false);
    expect(res.to).toBeUndefined();
    const row = (await env.DB.prepare("SELECT is_published, notes, updated_at FROM descriptions WHERE id = ?")
      .bind(id)
      .first<{ is_published: number; notes: string; updated_at: number }>())!;
    expect(row).toEqual({ is_published: before, notes: "Nota de A", updated_at: 2000 });
  });
});

// @version v0.9.0
