/**
 * Tests — the repository edit form writes only what the request carries
 *
 * This suite pins that a save from the repository edit page writes the
 * fields the request carries, and of those only the ones that change the
 * stored row; the changelog records the same set. A field the request does
 * not carry keeps its stored value, and so does the enabled flag unless
 * the request carries its hidden marker; with the marker and the box
 * unchecked, the repository is disabled. A blank field the request carries
 * is cleared, except the code and the name, which a blank leaves as
 * stored. After an edit conflict, a forced update that carries fields
 * writes them past the stale lock; one that carries none is refused,
 * writes nothing and keeps the autosaved draft.
 *
 * @version v0.9.0
 */
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { and, eq } from "drizzle-orm";
import { RouterContextProvider } from "react-router";
import { applyMigrations, cleanDatabase, seedTenants, DEFAULT_TEST_TENANT_ID } from "../helpers/db";
import { createTestUser } from "../helpers/auth";
import { createTestRepository } from "../helpers/repositories";
import { tenantContext, userContext, type User } from "../../app/context";
import { makeTenantContext, makeUserContext } from "../helpers/context";
import { saveDraft, getDraft } from "../../app/lib/drafts.server";
import * as schema from "../../app/db/schema";
import "../../app/routes/_auth.admin.repositories.$id";

function ctx(user: User): any {
  const c = new RouterContextProvider();
  c.set(userContext, user);
  c.set(tenantContext, makeTenantContext({ id: DEFAULT_TEST_TENANT_ID, multiRepositoryEnabled: true }));
  (c as any).cloudflare = { env };
  return c;
}

async function save(user: User, id: string, fields: Array<[string, string]>) {
  const { action } = await import("../../app/routes/_auth.admin.repositories.$id");
  const body = new FormData();
  for (const [k, v] of fields) body.append(k, v);
  return (await action({
    request: new Request(`http://neogranadina.fisqua.test/admin/repositories/${id}`, { method: "POST", body }),
    context: ctx(user),
    params: { id },
  } as any)) as any;
}

async function read(id: string) {
  return (await drizzle(env.DB, { schema })
    .select()
    .from(schema.repositories)
    .where(and(eq(schema.repositories.tenantId, DEFAULT_TEST_TENANT_ID), eq(schema.repositories.id, id)))
    .get()) as Record<string, unknown>;
}

async function changelogDiffs(id: string) {
  const rows = await env.DB.prepare("SELECT diff FROM changelog WHERE record_id = ?")
    .bind(id)
    .all<{ diff: string }>();
  return rows.results.map((r) => JSON.parse(r.diff));
}

const STORED = {
  code: "AHT",
  name: "Archivo Histórico de Tunja",
  shortName: "AHT",
  countryCode: "COL",
  country: "Colombia",
  city: "Tunja",
  address: "Calle 19",
  website: "https://example.test/aht",
  notes: "Nota guardada",
  rightsText: "Derechos reservados",
  displayTitle: "Archivo de Tunja",
  subtitle: "Fondos coloniales",
  heroImageUrl: "https://example.test/hero.jpg",
  enabled: true,
  manifestRights: "https://example.test/rights/",
  attributionEn: "Courtesy of the archive",
  attributionEs: "Cortesía del archivo",
};

describe("repository edit save", () => {
  let admin: User;
  beforeAll(async () => {
    await applyMigrations();
  });
  beforeEach(async () => {
    await cleanDatabase();
    await seedTenants();
    const u = await createTestUser({ isAdmin: true, tenantId: DEFAULT_TEST_TENANT_ID });
    admin = makeUserContext({ id: u.id, tenantId: DEFAULT_TEST_TENANT_ID, isAdmin: true });
  });

  it("a partial save changes only the field it carries and keeps the repository enabled", async () => {
    const repo = await createTestRepository(STORED);
    const before = await read(repo.id);

    const res = await save(admin, repo.id, [["_action", "update"], ["notes", "Nota cambiada"]]);
    expect(res).toMatchObject({ ok: true, message: "updated" });

    const after = await read(repo.id);
    for (const [col, value] of Object.entries(before)) {
      if (col === "notes" || col === "updatedAt") continue;
      expect(after[col], col).toEqual(value);
    }
    expect(after.notes).toBe("Nota cambiada");
    expect(after.enabled).toBe(true);
    expect(await changelogDiffs(repo.id)).toEqual([
      { notes: { old: "Nota guardada", new: "Nota cambiada" } },
    ]);
  });

  it("disables the repository when the marker is present and the box unchecked", async () => {
    const repo = await createTestRepository(STORED);
    const res = await save(admin, repo.id, [["_action", "update"], ["enabled", ""]]);
    expect(res).toMatchObject({ ok: true });
    expect((await read(repo.id)).enabled).toBe(false);
  });

  it("keeps the repository enabled when the marker and the box are both sent", async () => {
    const repo = await createTestRepository({ ...STORED, enabled: false });
    const res = await save(admin, repo.id, [["_action", "update"], ["enabled", ""], ["enabled", "on"]]);
    expect(res).toMatchObject({ ok: true });
    expect((await read(repo.id)).enabled).toBe(true);
  });

  it("clears a carried blank field and leaves a blank code and name as stored", async () => {
    const repo = await createTestRepository(STORED);
    const res = await save(admin, repo.id, [
      ["_action", "update"],
      ["code", ""],
      ["name", ""],
      ["city", ""],
      ["attributionEn", ""],
    ]);
    expect(res).toMatchObject({ ok: true });
    const after = await read(repo.id);
    expect(after.code).toBe("AHT");
    expect(after.name).toBe("Archivo Histórico de Tunja");
    expect(after.city).toBeNull();
    expect(after.attributionEn).toBeNull();
    expect(after.attributionEs).toBe("Cortesía del archivo");
  });

  it("a forced update with fields writes them past the stale lock", async () => {
    const repo = await createTestRepository(STORED);
    const stale = await save(admin, repo.id, [
      ["_action", "update"],
      ["_updatedAt", "1"],
      ["notes", "Nota editada"],
    ]);
    expect(stale.error).toBe("conflict");

    const res = await save(admin, repo.id, [
      ["_action", "update"],
      ["_force", "true"],
      ["_updatedAt", "1"],
      ["notes", "Nota editada"],
      ["enabled", ""],
      ["enabled", "on"],
    ]);
    expect(res).toMatchObject({ ok: true, message: "updated" });
    const after = await read(repo.id);
    expect(after.notes).toBe("Nota editada");
    expect(after.enabled).toBe(true);
    expect(after.city).toBe("Tunja");
  });

  it("refuses a forced update without fields, writes nothing and keeps the draft", async () => {
    const repo = await createTestRepository(STORED);
    const db = drizzle(env.DB);
    await saveDraft(db, DEFAULT_TEST_TENANT_ID, repo.id, "repository", admin.id, JSON.stringify({ notes: "Nota editada" }));
    const before = await read(repo.id);

    const res = await save(admin, repo.id, [
      ["_action", "update"],
      ["_force", "true"],
      ["_updatedAt", "1"],
    ]);
    expect(res.ok).toBe(false);
    expect(res.error).toBe("generic");
    expect(await read(repo.id)).toEqual(before);
    expect(await getDraft(db, DEFAULT_TEST_TENANT_ID, repo.id, "repository")).not.toBeNull();
  });
});

// @version v0.9.0
