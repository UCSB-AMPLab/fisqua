/**
 * Tests — the place and entity edit forms write only what the form carries
 *
 * This suite pins that a save from the edit form of an authority record (a
 * place or an entity) writes the fields the form submitted and the user
 * can edit, and nothing else. A column the form does not carry
 * (`legacy_ids`, the record's ids in earlier systems) keeps its stored
 * value: the update schemas carry no defaults, so an absent field cannot
 * reach the UPDATE as "[]". A field the form leaves blank whose stored
 * value is already blank (an empty string or NULL) is not rewritten
 * either, so a stored `coordinate_precision` of '' survives a save that
 * did not touch it, and the changelog records no change for it. A field
 * the request leaves out altogether is never written: an entity saved with
 * whole sections missing from the request (Description, Control, Notes, or
 * Identity) keeps every field of those sections, its primary-function term
 * link and its function rows, and the changelog records only the field
 * that changed. A field the request carries empty is still cleared.
 *
 * @version v0.9.0
 */
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { RouterContextProvider } from "react-router";
import { applyMigrations, cleanDatabase, DEFAULT_TEST_FEDERATION_ID } from "../helpers/db";
import { createTestPlace } from "../helpers/places";
import { createTestEntity } from "../helpers/entities";
import { createTestUser } from "../helpers/auth";
import { tenantContext, userContext, type User } from "../../app/context";
import { makeTenantContext, makeUserContext } from "../helpers/context";
import { updatePlaceSchema } from "../../app/lib/validation/place";
import { updateEntitySchema } from "../../app/lib/validation/entity";
import "../../app/routes/_auth.admin.places.$id";
import "../../app/routes/_auth.admin.entities.$id";

const LEGACY =
  '[{"provider":"zasqua-django","id":"4711"},{"provider":"zasqua-precision","id":"v2_trn_H"}]';

function buildContext(user: User): any {
  const ctx = new RouterContextProvider();
  ctx.set(userContext, user);
  ctx.set(tenantContext, makeTenantContext({ id: user.tenantId }));
  (ctx as any).cloudflare = { env };
  return ctx;
}

function post(path: string, fields: Record<string, string>): Request {
  return new Request(`http://neogranadina.fisqua.test${path}`, {
    method: "POST",
    body: new URLSearchParams({ _action: "update", ...fields }),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
  });
}

/** Every field the place edit form submits, as the form renders them. */
function placeFormFields(updatedAt: number): Record<string, string> {
  return {
    _updatedAt: String(updatedAt),
    nameVariants: "[]",
    latitude: "4.6097",
    longitude: "-74.0817",
    coordinatePrecision: "",
    tgnId: "",
    hgisId: "",
    whgId: "",
    label: "Santa Fe",
    displayName: "Santa Fe de Bogotá",
    placeType: "city",
    parentId: "",
    notes: "",
    internalNotes: "",
    commitNote: "",
  };
}

async function placeRow(id: string) {
  return env.DB.prepare(
    "SELECT legacy_ids, coordinate_precision, notes, display_name FROM places WHERE id = ?"
  )
    .bind(id)
    .first<{
      legacy_ids: string;
      coordinate_precision: string | null;
      notes: string | null;
      display_name: string;
    }>();
}

describe("place edit form save", () => {
  let admin: User;
  beforeAll(async () => {
    await applyMigrations();
  });
  beforeEach(async () => {
    await cleanDatabase();
    const u = await createTestUser({ isAdmin: true });
    admin = makeUserContext({ id: u.id, isAdmin: true });
  });

  async function seed() {
    const place = await createTestPlace({
      label: "Santa Fe",
      displayName: "Santa Fe",
      placeCode: "nl-prs001",
      placeType: "city",
      latitude: 4.6097,
      longitude: -74.0817,
    });
    await env.DB.prepare(
      "UPDATE places SET legacy_ids = ?, coordinate_precision = '', notes = 'Seat of the audiencia' WHERE id = ?"
    )
      .bind(LEGACY, place.id)
      .run();
    return place;
  }

  async function save(id: string, fields: Record<string, string>) {
    const { action } = await import("../../app/routes/_auth.admin.places.$id");
    return (await action({
      request: post(`/admin/places/${id}`, fields),
      context: buildContext(admin),
      params: { id },
    } as any)) as any;
  }

  it("keeps legacy_ids and an empty coordinate_precision", async () => {
    const place = await seed();
    const fields = placeFormFields(place.updatedAt);
    fields.notes = "Seat of the audiencia";
    const result = await save(place.id, fields);
    expect(result).toMatchObject({ ok: true, message: "updated" });

    const after = await placeRow(place.id);
    expect(after!.display_name).toBe("Santa Fe de Bogotá");
    expect(after!.legacy_ids).toBe(LEGACY);
    expect(after!.coordinate_precision).toBe("");
  });

  it("records neither legacy_ids nor an unchanged blank field in the changelog", async () => {
    const place = await seed();
    const fields = placeFormFields(place.updatedAt);
    fields.notes = "Seat of the audiencia";
    await save(place.id, fields);

    const log = await env.DB.prepare(
      "SELECT diff FROM changelog WHERE record_id = ? AND record_type = 'place'"
    )
      .bind(place.id)
      .first<{ diff: string }>();
    const diff = JSON.parse(log!.diff);
    expect(Object.keys(diff)).toEqual(["displayName"]);
  });

  it("never writes a field the request leaves out", async () => {
    const place = await seed();
    const { notes: _notes, ...fields } = placeFormFields(place.updatedAt);
    const result = await save(place.id, fields);
    expect(result).toMatchObject({ ok: true });

    const after = await placeRow(place.id);
    expect(after!.notes).toBe("Seat of the audiencia");
  });

  it("still clears a field the user empties", async () => {
    const place = await seed();
    const result = await save(place.id, placeFormFields(place.updatedAt));
    expect(result).toMatchObject({ ok: true });

    const after = await placeRow(place.id);
    expect(after!.notes).toBeNull();
    expect(after!.legacy_ids).toBe(LEGACY);
  });
});

describe("entity edit form save", () => {
  let admin: User;
  beforeAll(async () => {
    await applyMigrations();
  });
  beforeEach(async () => {
    await cleanDatabase();
    const u = await createTestUser({ isAdmin: true });
    admin = makeUserContext({ id: u.id, isAdmin: true });
  });

  it("keeps legacy_ids", async () => {
    const entity = await createTestEntity({ entityCode: "ne-prs001" });
    await env.DB.prepare("UPDATE entities SET legacy_ids = ? WHERE id = ?")
      .bind(LEGACY, entity.id)
      .run();
    const current = await env.DB.prepare("SELECT updated_at FROM entities WHERE id = ?")
      .bind(entity.id)
      .first<{ updated_at: number }>();

    const { action } = await import("../../app/routes/_auth.admin.entities.$id");
    const result = (await action({
      request: post(`/admin/entities/${entity.id}`, {
        _updatedAt: String(current!.updated_at),
        displayName: "Juan de Castellanos",
        sortName: "Castellanos, Juan de",
        entityType: "person",
        nameVariants: "[]",
        functions: "",
      }),
      context: buildContext(admin),
      params: { id: entity.id },
    } as any)) as any;
    expect(result).toMatchObject({ ok: true });

    const after = await env.DB.prepare("SELECT legacy_ids FROM entities WHERE id = ?")
      .bind(entity.id)
      .first<{ legacy_ids: string }>();
    expect(after!.legacy_ids).toBe(LEGACY);
  });
});

/** The entity row's columns an edit could change, and its function rows. */
async function entityState(id: string) {
  const row = await env.DB.prepare(
    `SELECT display_name, sort_name, surname, given_name, honorific, entity_type,
            dates_of_existence, date_start, date_end, history, primary_function,
            primary_function_id, sources, wikidata_id, viaf_id, notes, internal_notes,
            name_variants, legacy_ids
       FROM entities WHERE id = ?`
  )
    .bind(id)
    .first<Record<string, unknown>>();
  const functions = await env.DB.prepare(
    "SELECT id, function, honorific, source FROM entity_functions WHERE entity_id = ? ORDER BY rowid"
  )
    .bind(id)
    .all();
  return { row: row!, functions: functions.results };
}

describe("entity edit form save with sections the request leaves out", () => {
  let admin: User;
  beforeAll(async () => {
    await applyMigrations();
  });
  beforeEach(async () => {
    await cleanDatabase();
    const u = await createTestUser({ isAdmin: true });
    admin = makeUserContext({ id: u.id, isAdmin: true });
  });

  /** An entity with every field the edit form shows filled in. */
  async function seed() {
    const entity = await createTestEntity({
      entityCode: "ne-prs002",
      displayName: "Juan de Castellanos",
      sortName: "Castellanos, Juan de",
      surname: "Castellanos",
      givenName: "Juan",
      honorific: "don",
      entityType: "person",
      primaryFunction: "Escribano",
      datesOfExistence: "1522-1607",
      dateStart: "1522",
      dateEnd: "1607",
      wikidataId: "Q1373427",
      viafId: "12345",
    });
    const termId = crypto.randomUUID();
    const now = Date.now();
    await env.DB.prepare(
      `INSERT INTO vocabulary_terms (id, federation_id, canonical, status, entity_count, created_at, updated_at)
       VALUES (?, ?, 'Escribano', 'approved', 1, ?, ?)`
    )
      .bind(termId, DEFAULT_TEST_FEDERATION_ID, now, now)
      .run();
    await env.DB.prepare(
      `UPDATE entities SET history = 'Poet and chronicler of Tunja', sources = 'AGI, Santa Fe 56',
         notes = 'Public note', internal_notes = 'Internal note', primary_function_id = ?,
         legacy_ids = ? WHERE id = ?`
    )
      .bind(termId, LEGACY, entity.id)
      .run();
    for (const [n, fn] of [["1", "Escribano"], ["2", "Beneficiado"]] as const) {
      await env.DB.prepare(
        `INSERT INTO entity_functions (id, entity_id, honorific, function, source, created_at, updated_at)
         VALUES (?, ?, 'don', ?, ?, ?, ?)`
      )
        .bind(crypto.randomUUID(), entity.id, fn, `source ${n}`, now, now)
        .run();
    }
    const current = await env.DB.prepare("SELECT updated_at FROM entities WHERE id = ?")
      .bind(entity.id)
      .first<{ updated_at: number }>();
    return { id: entity.id, updatedAt: current!.updated_at };
  }

  async function save(id: string, fields: Record<string, string>) {
    const { action } = await import("../../app/routes/_auth.admin.entities.$id");
    return (await action({
      request: post(`/admin/entities/${id}`, fields),
      context: buildContext(admin),
      params: { id },
    } as any)) as any;
  }

  /**
   * What the form submits with only the Identity section in the
   * request: the hidden inputs outside the sections and the Identity
   * fields. Description, Control and Notes are left out, as a closed
   * section that unmounts its inputs leaves them out.
   */
  function identityOnly(updatedAt: number): Record<string, string> {
    return {
      _updatedAt: String(updatedAt),
      nameVariants: "[]",
      wikidataId: "Q1373427",
      viafId: "12345",
      displayName: "Juan de Castellanos y Valdés",
      sortName: "Castellanos, Juan de",
      surname: "Castellanos",
      givenName: "Juan",
      honorific: "don",
      entityType: "person",
      commitNote: "",
    };
  }

  it("leaves every field and function row the request leaves out as stored", async () => {
    const { id, updatedAt } = await seed();
    const before = await entityState(id);

    const result = await save(id, identityOnly(updatedAt));
    expect(result).toMatchObject({ ok: true, message: "updated" });

    const after = await entityState(id);
    expect(after.row).toEqual({
      ...before.row,
      display_name: "Juan de Castellanos y Valdés",
    });
    expect(after.functions).toEqual(before.functions);
  });

  it("records only the changed field in the changelog", async () => {
    const { id, updatedAt } = await seed();
    await save(id, identityOnly(updatedAt));

    const log = await env.DB.prepare(
      "SELECT diff FROM changelog WHERE record_id = ? AND record_type = 'entity'"
    )
      .bind(id)
      .first<{ diff: string }>();
    expect(Object.keys(JSON.parse(log!.diff))).toEqual(["displayName"]);
  });

  it("leaves the Identity fields as stored when only the other sections are sent", async () => {
    const { id, updatedAt } = await seed();
    const before = await entityState(id);

    const result = await save(id, {
      _updatedAt: String(updatedAt),
      nameVariants: "[]",
      wikidataId: "Q1373427",
      viafId: "12345",
      sources: "AGI, Santa Fe 57",
    });
    expect(result).toMatchObject({ ok: true, message: "updated" });

    const after = await entityState(id);
    expect(after.row).toEqual({ ...before.row, sources: "AGI, Santa Fe 57" });
    expect(after.functions).toEqual(before.functions);
  });

  it("still clears a field the request carries empty", async () => {
    const { id, updatedAt } = await seed();
    const before = await entityState(id);

    const result = await save(id, {
      ...identityOnly(updatedAt),
      displayName: "Juan de Castellanos",
      surname: "",
      history: "",
      notes: "",
      primaryFunction: "",
      primaryFunctionId: "",
      functions: "",
    });
    expect(result).toMatchObject({ ok: true, message: "updated" });

    const after = await entityState(id);
    expect(after.row).toEqual({
      ...before.row,
      surname: null,
      history: null,
      notes: null,
      primary_function: null,
      primary_function_id: null,
    });
    expect(after.functions).toEqual([]);
  });
});

describe("update schemas", () => {
  it("return no field the input did not carry", () => {
    const id = crypto.randomUUID();
    expect(updatePlaceSchema.parse({ id })).toEqual({ id });
    expect(updateEntitySchema.parse({ id })).toEqual({ id });
    expect(updatePlaceSchema.safeParse({}).success).toBe(false);
  });
});
