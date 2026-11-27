/**
 * Tests — the repository edit form's institution record fields
 *
 * This suite pins the fields of the repository's simplified ISDIAH record
 * that the repository edit page writes: the English subtitle, other names,
 * the type of institution, the contact fields beside the address, the
 * Spanish and English prose (holdings, history, opening times, access
 * conditions, accessibility, reproduction services), the language of the
 * description, the catalogue license URI and the home-page order; and the
 * credit statement, a Spanish and English pair of plain text.
 *
 * Each saves and reads back as written. A save that carries one of them
 * leaves every other column, old or new, as stored. A carried blank
 * clears its column to null. Other names are written one per line and
 * stored as a JSON array of the non-blank lines; no lines store null.
 * The home order must be an integer, and the catalogue licence an http
 * or https URI; a refused value writes nothing. A save on a stale version
 * gets the conflict response and writes nothing. The prose fields are
 * Markdown and are stored as given, apart from surrounding whitespace.
 * The changelog records the new fields as it records the others.
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
  body.append("_action", "update");
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

// Stored values for the institution record columns, written after the
// helper creates the row.
const STORED_RECORD = {
  subtitleEn: "Colonial fonds",
  otherNames: JSON.stringify(["Archivo Regional de Boyacá"]),
  institutionType: "Archivo histórico",
  region: "Boyacá",
  postalCode: "150001",
  telephone: "+57 608 000 0000",
  email: "archivo@example.test",
  holdingsEs: "Fondos coloniales.",
  holdingsEn: "Colonial fonds.",
  historyEs: "Fundado en 1890.",
  historyEn: "Founded in 1890.",
  openingTimesEs: "Lunes a viernes.",
  openingTimesEn: "Monday to Friday.",
  accessConditionsEs: "Con cita previa.",
  accessConditionsEn: "By appointment.",
  accessibilityEs: "Rampa de acceso.",
  accessibilityEn: "Step-free access.",
  reproductionServicesEs: "Fotografía digital.",
  reproductionServicesEn: "Digital photography.",
  descriptionLanguage: "spa",
  catalogueLicenceUri: "https://creativecommons.org/publicdomain/zero/1.0/",
  homeOrder: 3,
  creditStatementEs: "Digitalizado en alianza con Neogranadina.",
  creditStatementEn: "Digitized in partnership with Neogranadina.",
};

async function seedRepository() {
  const repo = await createTestRepository({
    code: "AHT",
    name: "Archivo Histórico de Tunja",
    city: "Tunja",
    subtitle: "Fondos coloniales",
    manifestRights: "https://example.test/rights/",
  });
  await drizzle(env.DB)
    .update(schema.repositories)
    .set(STORED_RECORD)
    .where(eq(schema.repositories.id, repo.id));
  return repo;
}

/** Every column of `before` and `after` except `changed` and the version is equal. */
function expectUnchangedExcept(before: Record<string, unknown>, after: Record<string, unknown>, changed: string[]) {
  for (const [col, value] of Object.entries(before)) {
    if (changed.includes(col) || col === "updatedAt") continue;
    expect(after[col], col).toEqual(value);
  }
}

// Each new text field, the form name it travels under, and a new value.
const TEXT_FIELDS: Array<[string, string]> = [
  ["subtitleEn", "Colonial and republican fonds"],
  ["institutionType", "Archivo universitario"],
  ["region", "Cauca"],
  ["postalCode", "190003"],
  ["telephone", "+57 602 000 0000"],
  ["email", "contacto@example.test"],
  ["holdingsEs", "Fondos coloniales y republicanos."],
  ["holdingsEn", "Colonial and republican fonds."],
  ["historyEs", "Fundado en 1891."],
  ["historyEn", "Founded in 1891."],
  ["openingTimesEs", "Lunes a jueves."],
  ["openingTimesEn", "Monday to Thursday."],
  ["accessConditionsEs", "Sin cita previa."],
  ["accessConditionsEn", "No appointment needed."],
  ["accessibilityEs", "Ascensor."],
  ["accessibilityEn", "Lift."],
  ["reproductionServicesEs", "Escaneo."],
  ["reproductionServicesEn", "Scanning."],
  ["descriptionLanguage", "eng"],
  ["catalogueLicenceUri", "https://creativecommons.org/licenses/by/4.0/"],
  ["creditStatementEs", "Digitalizado por el archivo, con el apoyo de la Universidad del Cauca."],
  ["creditStatementEn", "Digitized by the archive, with support from the Universidad del Cauca."],
];

describe("repository edit save: institution record fields", () => {
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

  for (const [name, value] of TEXT_FIELDS) {
    it(`saves ${name} alone and leaves every other column as stored`, async () => {
      const repo = await seedRepository();
      const before = await read(repo.id);

      const res = await save(admin, repo.id, [[name, value]]);
      expect(res).toMatchObject({ ok: true, message: "updated" });

      const after = await read(repo.id);
      expect(after[name]).toBe(value);
      expectUnchangedExcept(before, after, [name]);
      expect(await changelogDiffs(repo.id)).toEqual([
        { [name]: { old: (STORED_RECORD as Record<string, unknown>)[name], new: value } },
      ]);
    });
  }

  it("saves all the new fields together and reads them back", async () => {
    const repo = await createTestRepository({ code: "AHT", name: "Archivo Histórico de Tunja" });
    const res = await save(admin, repo.id, [
      ...TEXT_FIELDS,
      ["otherNames", "Archivo de Tunja\nAHT"],
      ["homeOrder", "2"],
    ]);
    expect(res).toMatchObject({ ok: true, message: "updated" });

    const after = await read(repo.id);
    for (const [name, value] of TEXT_FIELDS) expect(after[name], name).toBe(value);
    expect(after.otherNames).toBe(JSON.stringify(["Archivo de Tunja", "AHT"]));
    expect(after.homeOrder).toBe(2);
  });

  it("clears each carried blank field to null", async () => {
    const repo = await seedRepository();
    const res = await save(admin, repo.id, [
      ...TEXT_FIELDS.map(([name]) => [name, "  "] as [string, string]),
      ["otherNames", ""],
      ["homeOrder", ""],
    ]);
    expect(res).toMatchObject({ ok: true });

    const after = await read(repo.id);
    for (const [name] of TEXT_FIELDS) expect(after[name], name).toBeNull();
    expect(after.otherNames).toBeNull();
    expect(after.homeOrder).toBeNull();
    expect(after.subtitle).toBe("Fondos coloniales");
    expect(after.manifestRights).toBe("https://example.test/rights/");
  });

  it("stores other names one per line as a JSON array, dropping blank lines", async () => {
    const repo = await seedRepository();
    const before = await read(repo.id);
    const res = await save(admin, repo.id, [
      ["otherNames", "  Archivo de Tunja \r\n\r\n   \nArchivo Histórico de Boyacá\n"],
    ]);
    expect(res).toMatchObject({ ok: true });

    const after = await read(repo.id);
    expect(after.otherNames).toBe(JSON.stringify(["Archivo de Tunja", "Archivo Histórico de Boyacá"]));
    expectUnchangedExcept(before, after, ["otherNames"]);
  });

  it("stores null when every other-names line is blank", async () => {
    const repo = await seedRepository();
    const res = await save(admin, repo.id, [["otherNames", "\n  \n"]]);
    expect(res).toMatchObject({ ok: true });
    expect((await read(repo.id)).otherNames).toBeNull();
  });

  it("does not rewrite other names that are unchanged", async () => {
    const repo = await seedRepository();
    const res = await save(admin, repo.id, [["otherNames", "Archivo Regional de Boyacá"]]);
    expect(res).toMatchObject({ ok: true });
    expect(await changelogDiffs(repo.id)).toEqual([]);
  });

  it("saves the home order alone as an integer", async () => {
    const repo = await seedRepository();
    const before = await read(repo.id);
    const res = await save(admin, repo.id, [["homeOrder", " 7 "]]);
    expect(res).toMatchObject({ ok: true });
    const after = await read(repo.id);
    expect(after.homeOrder).toBe(7);
    expectUnchangedExcept(before, after, ["homeOrder"]);
  });

  for (const bad of ["1.5", "first", "2a"]) {
    it(`refuses the home order "${bad}" and writes nothing`, async () => {
      const repo = await seedRepository();
      const before = await read(repo.id);
      const res = await save(admin, repo.id, [["homeOrder", bad], ["region", "Cauca"]]);
      expect(res.ok).toBe(false);
      expect(res.errors?.homeOrder?.length).toBeGreaterThan(0);
      expect(await read(repo.id)).toEqual(before);
    });
  }

  it("refuses a catalogue licence that is not an http or https URI", async () => {
    const repo = await seedRepository();
    const before = await read(repo.id);
    const res = await save(admin, repo.id, [["catalogueLicenceUri", "ftp://example.test/licence"]]);
    expect(res.ok).toBe(false);
    expect(res.errors?.catalogueLicenceUri?.length).toBeGreaterThan(0);
    expect(await read(repo.id)).toEqual(before);
  });

  it("refuses an email address that is not one", async () => {
    const repo = await seedRepository();
    const before = await read(repo.id);
    const res = await save(admin, repo.id, [["email", "archivo at example"]]);
    expect(res.ok).toBe(false);
    expect(res.errors?.email?.length).toBeGreaterThan(0);
    expect(await read(repo.id)).toEqual(before);
  });

  it("returns the conflict response on a stale version and writes nothing", async () => {
    const repo = await seedRepository();
    const before = await read(repo.id);
    const res = await save(admin, repo.id, [
      ["_updatedAt", "1"],
      ["holdingsEs", "Otro texto."],
      ["otherNames", "Otro nombre"],
      ["homeOrder", "9"],
    ]);
    expect(res.ok).toBe(false);
    expect(res.error).toBe("conflict");
    expect(await read(repo.id)).toEqual(before);
    expect(await changelogDiffs(repo.id)).toEqual([]);
  });

  it("returns the conflict response on a stale version of a credit statement save and writes nothing", async () => {
    const repo = await seedRepository();
    const before = await read(repo.id);
    const res = await save(admin, repo.id, [
      ["_updatedAt", String(Number(before.updatedAt) - 1)],
      ["creditStatementEs", "Otro crédito."],
      ["creditStatementEn", "Another credit."],
    ]);
    expect(res.ok).toBe(false);
    expect(res.error).toBe("conflict");
    expect(await read(repo.id)).toEqual(before);
    expect(await changelogDiffs(repo.id)).toEqual([]);
  });

  it("saves the credit statement pair together and leaves the attribution as stored", async () => {
    const repo = await seedRepository();
    await drizzle(env.DB)
      .update(schema.repositories)
      .set({ attributionEs: "Atribución guardada.", attributionEn: "Stored attribution." })
      .where(eq(schema.repositories.id, repo.id));
    const before = await read(repo.id);
    const es = "Digitalizado por la Biblioteca. Neogranadina dirigió la catalogación \"Narra\".";
    const en = "Digitized by the Library. Neogranadina led the cataloging of \"Narra\".";
    const res = await save(admin, repo.id, [
      ["_updatedAt", String(before.updatedAt)],
      ["creditStatementEs", es],
      ["creditStatementEn", en],
    ]);
    expect(res).toMatchObject({ ok: true, message: "updated" });
    const after = await read(repo.id);
    expect(after.creditStatementEs).toBe(es);
    expect(after.creditStatementEn).toBe(en);
    expectUnchangedExcept(before, after, ["creditStatementEs", "creditStatementEn"]);
  });

  it("stores the Markdown of a prose field as given", async () => {
    const repo = await seedRepository();
    const markdown = [
      "El archivo custodia **dos fondos**:",
      "",
      "- *Cabildo*, 1539–1810",
      "- [Notaría Primera](https://example.test/notaria) — 1600–1900",
      "",
      "    Un bloque sangrado, <b>sin</b> HTML & sin cambios.",
    ].join("\n");
    const res = await save(admin, repo.id, [["historyEs", markdown]]);
    expect(res).toMatchObject({ ok: true });
    expect((await read(repo.id)).historyEs).toBe(markdown);
  });
});

// @version v0.9.0
