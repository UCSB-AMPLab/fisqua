/**
 * Tests — overwriting after an edit conflict
 *
 * This suite pins the overwrite that the conflict dialog offers when a
 * save meets a newer version of the record. The overwrite resubmits the
 * editor's current fields with `_force=true`, so the edits the user made
 * are what the forced save writes. On each of the three admin editors
 * (descriptions, entities, places) a forced update that carries fields
 * writes them past the stale lock; a forced update that carries none of
 * the editable fields is refused, writes nothing and keeps the autosaved
 * draft, which still holds the user's edits.
 *
 * @version v0.9.0
 */
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { RouterContextProvider } from "react-router";
import { applyMigrations, cleanDatabase } from "../helpers/db";
import { createTestUser } from "../helpers/auth";
import { createTestRepository } from "../helpers/repositories";
import { createTestDescription } from "../helpers/descriptions";
import { createTestEntity } from "../helpers/entities";
import { createTestPlace } from "../helpers/places";
import { tenantContext, userContext, type User } from "../../app/context";
import { makeTenantContext, makeUserContext } from "../helpers/context";
import { saveDraft, getDraft } from "../../app/lib/drafts.server";
import { buildOverwriteData } from "../../app/components/admin/conflict-dialog";
import "../../app/routes/_auth.admin.descriptions.$id";
import "../../app/routes/_auth.admin.entities.$id";
import "../../app/routes/_auth.admin.places.$id";

function buildContext(user: User): any {
  const ctx = new RouterContextProvider();
  ctx.set(userContext, user);
  ctx.set(tenantContext, makeTenantContext({ id: user.tenantId }));
  (ctx as any).cloudflare = { env };
  return ctx;
}

type Kind = "description" | "entity" | "place";
const ROUTE: Record<Kind, string> = {
  description: "descriptions",
  entity: "entities",
  place: "places",
};

async function run(kind: Kind, user: User, id: string, fields: Record<string, string>) {
  const mod =
    kind === "description"
      ? await import("../../app/routes/_auth.admin.descriptions.$id")
      : kind === "entity"
        ? await import("../../app/routes/_auth.admin.entities.$id")
        : await import("../../app/routes/_auth.admin.places.$id");
  return (await mod.action({
    request: new Request(`http://neogranadina.fisqua.test/admin/${ROUTE[kind]}/${id}`, {
      method: "POST",
      body: new URLSearchParams(fields),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    }),
    context: buildContext(user),
    params: { id },
  } as any)) as any;
}

// A stale lock: the editor loaded the record at updatedAt 1.
const FORCED = { _action: "update", _force: "true", _updatedAt: "1" };

async function seed(kind: Kind): Promise<{ id: string; read: () => Promise<string | null> }> {
  if (kind === "description") {
    const repoId = crypto.randomUUID();
    await createTestRepository({ id: repoId, code: "TEST" });
    const d = await createTestDescription({ repositoryId: repoId });
    // The fields ISAD(G) requires at fonds level, so a save can pass
    // validation and reach the lock.
    await env.DB.prepare(
      "UPDATE descriptions SET notes = 'Nota guardada', extent = '2 legajos', scope_content = 'Actas', date_expression = '1600', creator_display = 'Cabildo' WHERE id = ?",
    )
      .bind(d.id)
      .run();
    return {
      id: d.id as string,
      read: async () =>
        (await env.DB.prepare("SELECT notes FROM descriptions WHERE id = ?")
          .bind(d.id)
          .first<{ notes: string | null }>())!.notes,
    };
  }
  if (kind === "entity") {
    const e = await createTestEntity({ entityCode: "ne-ovr001" });
    await env.DB.prepare("UPDATE entities SET notes = 'Nota guardada' WHERE id = ?")
      .bind(e.id)
      .run();
    return {
      id: e.id,
      read: async () =>
        (await env.DB.prepare("SELECT notes FROM entities WHERE id = ?")
          .bind(e.id)
          .first<{ notes: string | null }>())!.notes,
    };
  }
  const p = await createTestPlace({ label: "Tunja", displayName: "Tunja", placeCode: "nl-ovr001" });
  await env.DB.prepare("UPDATE places SET notes = 'Nota guardada' WHERE id = ?")
    .bind(p.id)
    .run();
  return {
    id: p.id,
    read: async () =>
      (await env.DB.prepare("SELECT notes FROM places WHERE id = ?")
        .bind(p.id)
        .first<{ notes: string | null }>())!.notes,
  };
}

describe("the conflict dialog's overwrite request", () => {
  it("carries the editor's fields with the force flag", () => {
    const form = new FormData();
    form.append("_updatedAt", "1");
    form.append("title", "Título editado");
    form.append("hasDigital", "");
    form.append("hasDigital", "on");
    const data = buildOverwriteData(form);
    expect(data.get("_action")).toBe("update");
    expect(data.get("_force")).toBe("true");
    expect(data.get("title")).toBe("Título editado");
    expect(data.getAll("hasDigital")).toEqual(["", "on"]);
  });
});

describe("forced update after a conflict", () => {
  let admin: User;
  beforeAll(async () => {
    await applyMigrations();
  });
  beforeEach(async () => {
    await cleanDatabase();
    const u = await createTestUser({ isAdmin: true });
    admin = makeUserContext({ id: u.id, isAdmin: true });
  });

  for (const kind of ["description", "entity", "place"] as const) {
    it(`${kind}: a forced update with fields writes them past the stale lock`, async () => {
      const { id, read } = await seed(kind);
      const unforced = await run(kind, admin, id, {
        ...FORCED,
        _force: "",
        notes: "Nota editada",
      });
      expect(unforced.error).toBe("conflict");

      const res = await run(kind, admin, id, { ...FORCED, notes: "Nota editada" });
      expect(res).toMatchObject({ ok: true, message: "updated" });
      expect(await read()).toBe("Nota editada");
    });

    it(`${kind}: a forced update without fields is refused and keeps the draft`, async () => {
      const { id, read } = await seed(kind);
      const db = drizzle(env.DB);
      await saveDraft(db, admin.tenantId, id, kind, admin.id, JSON.stringify({ notes: "Nota editada" }));

      const res = await run(kind, admin, id, FORCED);
      expect(res.ok).toBe(false);
      expect(res.error).toBe("generic");
      expect(await read()).toBe("Nota guardada");
      expect(await getDraft(db, admin.tenantId, id, kind)).not.toBeNull();
    });
  }
});

// @version v0.9.0
