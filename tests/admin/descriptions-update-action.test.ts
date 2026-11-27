/**
 * Tests — descriptions admin update action (characterization)
 *
 * This suite drives real FormData through the `_auth.admin.
 * descriptions.$id` update action and pins its write contract before
 * and after the field-registration consolidation (audit item 12): the
 * ~40 description columns flow from formData through the
 * standard-aware validator into the DB write, with a handful of
 * deliberate coercions (genre defaults to "[]", resourceType is
 * enum-gated to null) that must survive any refactor of the three
 * parallel registration blocks.
 *
 * OCR text is not a form field. A posted `ocrText` is ignored: it
 * neither writes the description row nor touches the description's
 * OCR page rows, which hold the transcript.
 *
 * The action writes only the fields a request carries. Each standard's
 * form renders a subset of the description columns, so a save through
 * the ISAD(G) form must leave the DACS- and RAD-only columns as stored,
 * and the reverse; a field the request does not carry (the digital
 * flag without its hidden marker, genre, a partial submission) is left
 * unchanged, and the changelog records only the fields that changed.
 *
 * Harness mirrors tests/admin/vocab-merge-split-action.test.ts.
 *
 * @version v0.9.0
 */
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { RouterContextProvider } from "react-router";
import * as schema from "../../app/db/schema";
import { applyMigrations, cleanDatabase } from "../helpers/db";
import { createTestRepository } from "../helpers/repositories";
import { createTestDescription } from "../helpers/descriptions";
import { tenantContext, userContext, type User } from "../../app/context";
import { makeTenantContext, makeUserContext } from "../helpers/context";
import { seedPage } from "../helpers/ocr-fixtures";
import { getStandardConfig } from "../../app/lib/standards/registry";
import type { Standard } from "../../app/lib/standards/types";
// Instantiate the route module graph at file load so the in-test
// `await import()` resolves from a warm module cache. A cold route-graph
// import inside a timed test body can exceed testTimeout when this file
// is scheduled late against a saturated Workers-pool module runner on a
// resource-constrained (2-core CI) runner.
import "../../app/routes/_auth.admin.descriptions.$id";

function buildContext(user: User, standard: Standard = "isadg"): any {
  const ctx = new RouterContextProvider();
  ctx.set(userContext, user);
  ctx.set(
    tenantContext,
    makeTenantContext({ id: user.tenantId, descriptiveStandard: standard }),
  );
  (ctx as any).cloudflare = { env };
  return ctx;
}

// A complete update payload for a fonds-level record under ISAD(G):
// every mandatory column filled, plus distinct sentinel values on the
// optional columns so per-column persistence is assertable.
function fullUpdateFields(repoId: string): Record<string, string> {
  return {
    _action: "update",
    title: "Fondo Cabildo de Tunja",
    descriptionLevel: "fonds",
    localIdentifier: "loc-upd-1",
    repositoryId: repoId,
    translatedTitle: "Cabildo of Tunja Fonds",
    uniformTitle: "Cabildo (uniform)",
    resourceType: "text",
    genre: '["actas"]',
    dateExpression: "1580-1810",
    dateStart: "1580",
    dateEnd: "1810",
    dateCertainty: "approximate",
    extent: "42 legajos",
    dimensions: "30 x 21 cm",
    medium: "papel",
    provenance: "Cabildo de Tunja",
    scopeContent: "Actas y acuerdos del cabildo.",
    arrangement: "Cronológico",
    accessConditions: "Sin restricciones",
    reproductionConditions: "Cita obligatoria",
    language: "es",
    locationOfOriginals: "AHRB",
    locationOfCopies: "Copias en microfilm",
    findingAids: "Índice mecanografiado",
    notes: "Nota pública",
    internalNotes: "Nota interna",
    imprint: "Imprenta del Cabildo",
    editionStatement: "1a ed.",
    seriesStatement: "Serie municipal",
    volumeNumber: "3",
    issueNumber: "7",
    pages: "245",
    sectionTitle: "Sección colonial",
    publicationTitle: "Gaceta",
    adminBiogHistory: "Historia administrativa del cabildo.",
    acquisitionInfo: "Transferencia 1954",
    preferredCitation: "AHRB, Fondo Cabildo",
    systemOfArrangement: "Por series",
    physicalCharacteristics: "Deterioro leve",
    creatorDisplay: "Cabildo de Tunja",
    iiifManifestUrl: "https://iiif.example.test/manifest.json",
    hasDigital: "on",
  };
}

async function runUpdate(
  user: User,
  descriptionId: string,
  fields: Record<string, string> | Array<[string, string]>,
  standard: Standard = "isadg",
) {
  const { action } = await import(
    "../../app/routes/_auth.admin.descriptions.$id"
  );
  const body = new URLSearchParams(fields);
  return (await action({
    request: new Request(
      `http://neogranadina.fisqua.test/admin/descriptions/${descriptionId}`,
      {
        method: "POST",
        body,
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
      },
    ),
    context: buildContext(user, standard),
    params: { id: descriptionId },
  } as any)) as any;
}

async function seedAdminAndDescription() {
  const admin = makeUserContext({ isAdmin: true });
  const db = drizzle(env.DB, { schema });
  await db.insert(schema.users).values({
    id: admin.id,
    tenantId: admin.tenantId,
    email: "admin-dua@example.test",
    isAdmin: true,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  const repoId = crypto.randomUUID();
  await createTestRepository({ id: repoId, code: "TEST" });
  const desc = await createTestDescription({
    descriptionLevel: "fonds",
    title: "Original Title",
    repositoryId: repoId,
  });
  return { admin, db, descId: desc.id as string, repoId };
}

// Every editable column populated with a valid value, so a record
// carries data in the columns each standard's form leaves out. Written
// straight to the row, as an import or an edit under another standard
// would have left it.
async function populateAll(db: any, descId: string, repoId: string) {
  const { _action, hasDigital, ...columns } = fullUpdateFields(repoId);
  await db
    .update(schema.descriptions)
    .set({ ...columns, hasDigital: hasDigital === "on" })
    .where(eq(schema.descriptions.id, descId));
}

async function readRow(db: any, descId: string) {
  return (await db
    .select()
    .from(schema.descriptions)
    .where(eq(schema.descriptions.id, descId))
    .get()) as Record<string, unknown>;
}

async function changelogDiffs(db: any, descId: string) {
  const rows = await db
    .select({ diff: schema.changelog.diff })
    .from(schema.changelog)
    .where(eq(schema.changelog.recordId, descId))
    .all();
  return rows.map((r: { diff: string }) => JSON.parse(r.diff));
}

// The columns a standard's edit form submits: every field its config
// renders, less the ones that render without an input (referenceCode
// is read-only, legacyIds is display-only, the linkers post their own
// intents).
function formColumns(standard: Standard): string[] {
  const NO_INPUT = new Set(["referenceCode", "legacyIds", "entities", "places"]);
  const cols = new Set<string>();
  for (const section of getStandardConfig(standard).sections) {
    for (const field of section.fields) {
      if (!NO_INPUT.has(field.column)) cols.add(field.column);
    }
  }
  return [...cols];
}

// The request a standard's form sends for the stored record, with
// `changes` applied: one pair per rendered input, the hidden marker
// before the digital checkbox, and "on" after it when it is checked.
function formPayload(
  standard: Standard,
  stored: Record<string, string>,
  changes: Record<string, string> = {},
  checked = true,
): Array<[string, string]> {
  const pairs: Array<[string, string]> = [["_action", "update"]];
  for (const col of formColumns(standard)) {
    if (col === "hasDigital") {
      pairs.push(["hasDigital", ""]);
      if (checked) pairs.push(["hasDigital", "on"]);
      continue;
    }
    pairs.push([col, changes[col] ?? stored[col] ?? ""]);
  }
  return pairs;
}

describe("descriptions admin update action", () => {
  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDatabase();
  });

  it("persists every field of a full update", async () => {
    const { admin, db, descId, repoId } = await seedAdminAndDescription();

    const res = await runUpdate(admin, descId, fullUpdateFields(repoId));
    expect(res).toMatchObject({ ok: true, message: "updated" });

    const row = await db
      .select()
      .from(schema.descriptions)
      .where(eq(schema.descriptions.id, descId))
      .get();
    expect(row).toBeDefined();
    expect(row!.title).toBe("Fondo Cabildo de Tunja");
    expect(row!.descriptionLevel).toBe("fonds");
    expect(row!.localIdentifier).toBe("loc-upd-1");
    expect(row!.translatedTitle).toBe("Cabildo of Tunja Fonds");
    expect(row!.uniformTitle).toBe("Cabildo (uniform)");
    expect(row!.resourceType).toBe("text");
    expect(row!.genre).toBe('["actas"]');
    expect(row!.dateExpression).toBe("1580-1810");
    expect(row!.dateStart).toBe("1580");
    expect(row!.dateEnd).toBe("1810");
    expect(row!.dateCertainty).toBe("approximate");
    expect(row!.extent).toBe("42 legajos");
    expect(row!.dimensions).toBe("30 x 21 cm");
    expect(row!.medium).toBe("papel");
    expect(row!.provenance).toBe("Cabildo de Tunja");
    expect(row!.scopeContent).toBe("Actas y acuerdos del cabildo.");
    expect(row!.arrangement).toBe("Cronológico");
    expect(row!.accessConditions).toBe("Sin restricciones");
    expect(row!.reproductionConditions).toBe("Cita obligatoria");
    expect(row!.language).toBe("es");
    expect(row!.locationOfOriginals).toBe("AHRB");
    expect(row!.locationOfCopies).toBe("Copias en microfilm");
    expect(row!.findingAids).toBe("Índice mecanografiado");
    expect(row!.notes).toBe("Nota pública");
    expect(row!.internalNotes).toBe("Nota interna");
    expect(row!.imprint).toBe("Imprenta del Cabildo");
    expect(row!.editionStatement).toBe("1a ed.");
    expect(row!.seriesStatement).toBe("Serie municipal");
    expect(row!.volumeNumber).toBe("3");
    expect(row!.issueNumber).toBe("7");
    expect(row!.pages).toBe("245");
    expect(row!.sectionTitle).toBe("Sección colonial");
    expect(row!.publicationTitle).toBe("Gaceta");
    expect(row!.adminBiogHistory).toBe("Historia administrativa del cabildo.");
    expect(row!.acquisitionInfo).toBe("Transferencia 1954");
    expect(row!.preferredCitation).toBe("AHRB, Fondo Cabildo");
    expect(row!.systemOfArrangement).toBe("Por series");
    expect(row!.physicalCharacteristics).toBe("Deterioro leve");
    expect(row!.creatorDisplay).toBe("Cabildo de Tunja");
    expect(row!.iiifManifestUrl).toBe(
      "https://iiif.example.test/manifest.json",
    );
    expect(row!.hasDigital).toBe(true);
  });

  it("leaves genre and resourceType as stored when the request does not carry them", async () => {
    const { admin, db, descId, repoId } = await seedAdminAndDescription();
    await populateAll(db, descId, repoId);

    const fields = fullUpdateFields(repoId);
    delete fields.genre;
    delete fields.resourceType;
    const res = await runUpdate(admin, descId, fields);
    expect(res).toMatchObject({ ok: true, message: "updated" });

    const row = await db
      .select({
        genre: schema.descriptions.genre,
        resourceType: schema.descriptions.resourceType,
      })
      .from(schema.descriptions)
      .where(eq(schema.descriptions.id, descId))
      .get();
    expect(row!.genre).toBe('["actas"]');
    expect(row!.resourceType).toBe("text");
  });

  it("writes [] for a submitted blank genre over a stored list", async () => {
    const { admin, db, descId, repoId } = await seedAdminAndDescription();
    await populateAll(db, descId, repoId);

    const res = await runUpdate(admin, descId, { ...fullUpdateFields(repoId), genre: "" });
    expect(res).toMatchObject({ ok: true, message: "updated" });
    expect((await readRow(db, descId)).genre).toBe("[]");
  });

  it("ignores an ocrText field in a posted form and leaves the page rows alone", async () => {
    const { admin, db, descId, repoId } = await seedAdminAndDescription();
    await seedPage({ descriptionId: descId, tenantId: admin.tenantId, pageSeq: 1, text: "texto intacto" });
    const cols = await env.DB.prepare("SELECT name FROM pragma_table_info('descriptions')").all<{ name: string }>();
    const hasColumn = cols.results.some((c) => c.name === "ocr_text");
    if (hasColumn) {
      await env.DB.prepare("UPDATE descriptions SET ocr_text = 'columna' WHERE id = ?").bind(descId).run();
    }

    const fields = { ...fullUpdateFields(repoId), title: "Título cambiado", ocrText: "sobrescrito" };
    const res = await runUpdate(admin, descId, fields);
    expect(res).toMatchObject({ ok: true, message: "updated" });

    const row = await db
      .select({ title: schema.descriptions.title })
      .from(schema.descriptions)
      .where(eq(schema.descriptions.id, descId))
      .get();
    expect(row!.title).toBe("Título cambiado");

    const pages = await env.DB.prepare(
      "SELECT page_seq, text FROM ocr_pages WHERE tenant_id = ? AND description_id = ? ORDER BY page_seq",
    ).bind(admin.tenantId, descId).all<{ page_seq: number; text: string }>();
    expect(pages.results).toEqual([{ page_seq: 1, text: "texto intacto" }]);

    if (hasColumn) {
      const col = await env.DB.prepare("SELECT ocr_text FROM descriptions WHERE id = ?")
        .bind(descId).first<{ ocr_text: string }>();
      expect(col!.ocr_text).toBe("columna");
    }
  });

  it("rejects an invalid resourceType at the validator (never silently nulled)", async () => {
    const { admin, db, descId, repoId } = await seedAdminAndDescription();

    const fields = fullUpdateFields(repoId);
    fields.resourceType = "not-a-real-type";
    const res = await runUpdate(admin, descId, fields);

    expect(res.ok).toBe(false);
    expect(res.errors?.resourceType?.length).toBeGreaterThan(0);

    const row = await db
      .select({ title: schema.descriptions.title })
      .from(schema.descriptions)
      .where(eq(schema.descriptions.id, descId))
      .get();
    expect(row!.title).toBe("Original Title");
  });

  it("returns field-scoped errors when mandatory fields are missing", async () => {
    const { admin, db, descId, repoId } = await seedAdminAndDescription();

    const fields = fullUpdateFields(repoId);
    fields.extent = "";
    fields.scopeContent = "";
    const res = await runUpdate(admin, descId, fields);

    expect(res.ok).toBe(false);
    expect(res.errors?.extent?.[0]).toBe("field_required");
    expect(res.errors?.scopeContent?.[0]).toBe("field_required");

    const row = await db
      .select({ title: schema.descriptions.title })
      .from(schema.descriptions)
      .where(eq(schema.descriptions.id, descId))
      .get();
    expect(row!.title).toBe("Original Title");
  });

  it("clearing a populated optional column writes NULL, not a stale value", async () => {
    const { admin, db, descId, repoId } = await seedAdminAndDescription();

    // Populate dimensions and medium first.
    let res = await runUpdate(admin, descId, fullUpdateFields(repoId));
    expect(res).toMatchObject({ ok: true, message: "updated" });

    // Then submit the same update with both fields cleared. The
    // validator sees them as absent (empty maps to undefined), but the
    // DB write must carry the null — updatedFields derives from the
    // raw record, not the validator payload, precisely so a cleared
    // field clears its column instead of being silently omitted from
    // the UPDATE and keeping its old value.
    const cleared = fullUpdateFields(repoId);
    cleared.dimensions = "";
    cleared.medium = "";
    res = await runUpdate(admin, descId, cleared);
    expect(res).toMatchObject({ ok: true, message: "updated" });

    const row = await db
      .select({
        dimensions: schema.descriptions.dimensions,
        medium: schema.descriptions.medium,
      })
      .from(schema.descriptions)
      .where(eq(schema.descriptions.id, descId))
      .get();
    expect(row!.dimensions).toBeNull();
    expect(row!.medium).toBeNull();
  });

  it("returns the conflict payload on a stale optimistic lock", async () => {
    const { admin, descId, repoId } = await seedAdminAndDescription();

    const fields = fullUpdateFields(repoId);
    fields._updatedAt = "1";
    const res = await runUpdate(admin, descId, fields);

    expect(res.ok).toBe(false);
    expect(res.error).toBe("conflict");
    expect(res).toHaveProperty("modifiedBy");
    expect(res).toHaveProperty("modifiedAt");
  });
});

describe("descriptions admin update action: only submitted fields are written", () => {
  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDatabase();
  });

  const DACS_RAD_ONLY = [
    "adminBiogHistory",
    "acquisitionInfo",
    "preferredCitation",
    "systemOfArrangement",
    "physicalCharacteristics",
  ];
  const ISADG_ONLY_UNDER_DACS = [
    "uniformTitle",
    "resourceType",
    "genre",
    "dateCertainty",
    "dimensions",
    "medium",
    "imprint",
    "editionStatement",
    "seriesStatement",
    "volumeNumber",
    "issueNumber",
    "pages",
    "sectionTitle",
    "publicationTitle",
  ];

  it("a save through the ISAD(G) form leaves the DACS and RAD columns as stored", async () => {
    const { admin, db, descId, repoId } = await seedAdminAndDescription();
    await populateAll(db, descId, repoId);
    const before = await readRow(db, descId);

    const payload = formPayload("isadg", fullUpdateFields(repoId), {
      title: "Título nuevo",
    });
    for (const col of DACS_RAD_ONLY) {
      expect(payload.some(([k]) => k === col)).toBe(false);
    }
    const res = await runUpdate(admin, descId, payload, "isadg");
    expect(res).toMatchObject({ ok: true, message: "updated" });

    const after = await readRow(db, descId);
    for (const col of DACS_RAD_ONLY) {
      expect(after[col], col).toBe(before[col]);
    }
    expect(after.title).toBe("Título nuevo");
    expect(await changelogDiffs(db, descId)).toEqual([
      { title: { old: "Fondo Cabildo de Tunja", new: "Título nuevo" } },
    ]);
  });

  it("a save through the DACS form leaves the ISAD(G)-only columns as stored", async () => {
    const { admin, db, descId, repoId } = await seedAdminAndDescription();
    await populateAll(db, descId, repoId);
    const before = await readRow(db, descId);

    const payload = formPayload("dacs", fullUpdateFields(repoId), {
      extent: "43 legajos",
    });
    for (const col of ISADG_ONLY_UNDER_DACS) {
      expect(payload.some(([k]) => k === col)).toBe(false);
    }
    const res = await runUpdate(admin, descId, payload, "dacs");
    expect(res).toMatchObject({ ok: true, message: "updated" });

    const after = await readRow(db, descId);
    for (const col of ISADG_ONLY_UNDER_DACS) {
      expect(after[col], col).toBe(before[col]);
    }
    expect(after.extent).toBe("43 legajos");
    expect(await changelogDiffs(db, descId)).toEqual([
      { extent: { old: "42 legajos", new: "43 legajos" } },
    ]);
  });

  it("a partial request changes only the field it carries", async () => {
    const { admin, db, descId, repoId } = await seedAdminAndDescription();
    await populateAll(db, descId, repoId);
    const before = await readRow(db, descId);

    const res = await runUpdate(admin, descId, {
      _action: "update",
      notes: "Nota cambiada",
    });
    expect(res).toMatchObject({ ok: true, message: "updated" });

    const after = await readRow(db, descId);
    for (const [col, value] of Object.entries(before)) {
      if (col === "notes" || col === "updatedAt" || col === "updatedBy") continue;
      expect(after[col], col).toEqual(value);
    }
    expect(after.notes).toBe("Nota cambiada");
    expect(await changelogDiffs(db, descId)).toEqual([
      { notes: { old: "Nota pública", new: "Nota cambiada" } },
    ]);
  });

  it("leaves hasDigital as stored when the request carries no marker", async () => {
    const { admin, db, descId, repoId } = await seedAdminAndDescription();
    await populateAll(db, descId, repoId);
    expect((await readRow(db, descId)).hasDigital).toBe(true);

    const fields = fullUpdateFields(repoId);
    delete (fields as Record<string, string>).hasDigital;
    const res = await runUpdate(admin, descId, fields);
    expect(res).toMatchObject({ ok: true, message: "updated" });
    expect((await readRow(db, descId)).hasDigital).toBe(true);
  });

  it("clears hasDigital when the marker is present and the box unchecked", async () => {
    const { admin, db, descId, repoId } = await seedAdminAndDescription();
    await populateAll(db, descId, repoId);

    const payload = formPayload("isadg", fullUpdateFields(repoId), {}, false);
    const res = await runUpdate(admin, descId, payload);
    expect(res).toMatchObject({ ok: true, message: "updated" });
    expect((await readRow(db, descId)).hasDigital).toBe(false);
    expect(await changelogDiffs(db, descId)).toEqual([
      { hasDigital: { old: true, new: false } },
    ]);
  });

  it("records no changelog entry when nothing submitted changed", async () => {
    const { admin, db, descId, repoId } = await seedAdminAndDescription();
    await populateAll(db, descId, repoId);

    const res = await runUpdate(admin, descId, formPayload("isadg", fullUpdateFields(repoId)));
    expect(res).toMatchObject({ ok: true, message: "updated" });
    expect(await changelogDiffs(db, descId)).toEqual([]);
  });

  it("refuses a blank title and leaves the stored one", async () => {
    const { admin, db, descId, repoId } = await seedAdminAndDescription();
    await populateAll(db, descId, repoId);

    const res = await runUpdate(admin, descId, { ...fullUpdateFields(repoId), title: "  " });
    expect(res.ok).toBe(false);
    expect(res.errors?.title?.[0]).toBe("field_required");
    expect((await readRow(db, descId)).title).toBe("Fondo Cabildo de Tunja");
  });

  it("refuses a blank repository and leaves the stored one", async () => {
    const { admin, db, descId, repoId } = await seedAdminAndDescription();
    await populateAll(db, descId, repoId);

    const res = await runUpdate(admin, descId, { ...fullUpdateFields(repoId), repositoryId: "" });
    expect(res.ok).toBe(false);
    expect(res.errors?.repositoryId?.length).toBeGreaterThan(0);
    expect((await readRow(db, descId)).repositoryId).toBe(repoId);
  });

  it("refuses a blanked mandatory field even when an untouched stored value is invalid", async () => {
    const { admin, db, descId, repoId } = await seedAdminAndDescription();
    await populateAll(db, descId, repoId);
    // A legacy value outside the resource-type enum, in a field the
    // request does not carry.
    await env.DB.prepare("UPDATE descriptions SET resource_type = 'legacy-kind' WHERE id = ?")
      .bind(descId)
      .run();

    const res = await runUpdate(admin, descId, { _action: "update", extent: "" });
    expect(res.ok).toBe(false);
    expect(res.errors?.extent?.[0]).toBe("field_required");
    expect(res.errors?.resourceType).toBeUndefined();
    expect((await readRow(db, descId)).extent).toBe("42 legajos");
  });

  it("still applies the optimistic lock to a partial request", async () => {
    const { admin, db, descId, repoId } = await seedAdminAndDescription();
    await populateAll(db, descId, repoId);

    const res = await runUpdate(admin, descId, {
      _action: "update",
      _updatedAt: "1",
      notes: "Nota cambiada",
    });
    expect(res.error).toBe("conflict");
    expect((await readRow(db, descId)).notes).toBe("Nota pública");
  });
});

// @version v0.9.0
