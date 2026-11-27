/**
 * Tests — institution records schema
 *
 * This suite covers migrations 0119, 0120, 0121 and 0122: the publisher
 * record's columns and the hosting statement pair on `federations`, the
 * ISDIAH record's columns and the credit statement pair on `repositories`, and the four tables that hold
 * a federation's credit lines, a repository's funders, a federation's
 * controlled vocabularies and its authority sources. The migration file itself is run here, after the columns and
 * tables the test mirror in `tests/helpers/db.ts` builds have been taken
 * out again, so the constraints under test are the ones D1 will see; one
 * case compares the file-built shape with the mirror so the mirror the
 * other suites use cannot drift.
 *
 * What the constraints carry: a vocabulary value is unique per
 * federation, list and code, and the same list and code may exist in two
 * federations; an authority source is unique per federation and key; a
 * list, credit role or status outside its set is refused, as is a JSON
 * column that does not hold a list. Credits go with their federation and
 * funders with their repository; a federation that still has vocabulary
 * values or authority sources cannot be deleted.
 *
 * @version v0.9.0
 */
import { describe, it, expect, beforeAll } from "vitest";
import { env } from "cloudflare:test";
import { applyMigrations, cleanDatabase, DEFAULT_TEST_FEDERATION_ID, DEFAULT_TEST_TENANT_ID } from "../helpers/db";
import { migrationStatements, runMigrationFile } from "../helpers/migration-file";
import { insertRow } from "../helpers/media-pipeline";
import { createTestRepository } from "../helpers/repositories";
import { PLATFORM_FEDERATION_ID } from "../../app/lib/tenant";

const FEDERATION_COLUMNS = [
  "publisher_email", "publisher_logo_key",
  "description_es", "description_en",
  "catalogue_licence_uri",
  "terms_of_use_es", "terms_of_use_en",
  "privacy_es", "privacy_en",
  "takedown_es", "takedown_en",
  "citation_template_es", "citation_template_en",
];

/** What 0120 adds to `federations` and drops from it again. */
const FEDERATION_COLUMNS_0120 = [
  "citation_template_site_es", "citation_template_site_en",
  "citation_template_record_es", "citation_template_record_en",
];
const FEDERATION_COLUMNS_DROPPED_BY_0120 = [
  "catalogue_licence_uri", "citation_template_es", "citation_template_en",
];
const REPOSITORY_COLUMNS_0120 = ["catalogue_licence_uri", "home_order"];
/** What 0121 adds to `repositories`: the credit statement, one column per language. */
const REPOSITORY_COLUMNS_0121 = ["credit_statement_es", "credit_statement_en"];
/** What 0122 adds to `federations`: the hosting statement, one column per language. */
const FEDERATION_COLUMNS_0122 = ["hosting_statement_es", "hosting_statement_en"];

const REPOSITORY_COLUMNS = [
  "subtitle_en",
  "other_names", "institution_type", "logo_key",
  "region", "postal_code", "telephone", "email",
  "holdings_es", "holdings_en",
  "history_es", "history_en",
  "opening_times_es", "opening_times_en",
  "access_conditions_es", "access_conditions_en",
  "accessibility_es", "accessibility_en",
  "reproduction_services_es", "reproduction_services_en",
  "description_language",
];

const NEW_TABLES: Record<string, string[]> = {
  federation_credits: ["id", "federation_id", "name", "role", "url", "logo_key", "position"],
  repository_funders: ["id", "repository_id", "name", "programme", "project_id", "url", "position"],
  vocabulary_values: [
    "id", "federation_id", "list", "code", "label_es", "label_en", "group_code", "position",
    "external_scheme", "external_uri", "external_label", "status", "created_at", "updated_at",
    // Added by 0125, which the suite runs after 0122 for this table.
    "connector_es", "connector_en", "inverse_code", "hide_when_group",
    "label_es_female", "label_es_male", "label_es_unrecorded", "label_es_alone",
    "label_en_female", "label_en_male", "label_en_unrecorded", "label_en_alone",
  ],
  authority_sources: [
    "id", "federation_id", "key", "label_es", "label_en", "url_template", "applies_to", "position", "status",
  ],
};

const SHAPED_TABLES = ["federations", "repositories", ...Object.keys(NEW_TABLES)];

type Shape = Record<string, { columns: unknown[]; indexes: unknown[]; fks: unknown[] }>;

async function columns(table: string): Promise<string[]> {
  const { results } = await env.DB.prepare(`PRAGMA table_info(${table})`).all<{ name: string }>();
  return results.map((r) => r.name);
}

async function shape(): Promise<Shape> {
  const out: Shape = {};
  for (const table of SHAPED_TABLES) {
    const cols = await env.DB.prepare(`PRAGMA table_info(${table})`).all();
    const idx = await env.DB.prepare(`PRAGMA index_list(${table})`).all<{
      name: string;
      unique: number;
      partial: number;
    }>();
    const fks = await env.DB.prepare(`PRAGMA foreign_key_list(${table})`).all<{
      table: string;
      from: string;
      to: string;
      on_delete: string;
    }>();
    out[table] = {
      columns: cols.results,
      indexes: idx.results
        .map((r) => ({ name: r.name, unique: r.unique, partial: r.partial }))
        .sort((a, b) => a.name.localeCompare(b.name)),
      fks: fks.results
        .map((r) => ({ table: r.table, from: r.from, to: r.to, onDelete: r.on_delete.toUpperCase() }))
        .sort((a, b) => a.from.localeCompare(b.from)),
    };
  }
  return out;
}

/** Takes out what migrations 0119 to 0122 add, so the files can be run on the mirror. */
async function removeMigrations(): Promise<void> {
  for (const table of Object.keys(NEW_TABLES)) {
    await env.DB.prepare(`DROP TABLE IF EXISTS ${table}`).run();
  }
  for (const [table, added] of [
    ["federations", [...FEDERATION_COLUMNS, ...FEDERATION_COLUMNS_0120, ...FEDERATION_COLUMNS_0122]],
    ["repositories", [...REPOSITORY_COLUMNS, ...REPOSITORY_COLUMNS_0120, ...REPOSITORY_COLUMNS_0121]],
  ] as const) {
    const present = await columns(table);
    for (const column of added) {
      if (present.includes(column)) {
        await env.DB.prepare(`ALTER TABLE ${table} DROP COLUMN ${column}`).run();
      }
    }
  }
}

function vocabularyValue(over: Record<string, unknown> = {}): Record<string, unknown> {
  const now = Date.now();
  return {
    id: crypto.randomUUID(),
    federation_id: DEFAULT_TEST_FEDERATION_ID,
    list: "place_type",
    code: "river",
    label_es: "Río",
    label_en: "River",
    created_at: now,
    updated_at: now,
    ...over,
  };
}

function authoritySource(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: crypto.randomUUID(),
    federation_id: DEFAULT_TEST_FEDERATION_ID,
    key: "viaf",
    label_es: "VIAF",
    label_en: "VIAF",
    url_template: "https://viaf.org/viaf/{id}",
    applies_to: JSON.stringify(["entity"]),
    ...over,
  };
}

function credit(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: crypto.randomUUID(),
    federation_id: DEFAULT_TEST_FEDERATION_ID,
    name: "Credit",
    role: "partner",
    ...over,
  };
}

async function count(table: string, where: string, value: string): Promise<number> {
  const row = await env.DB.prepare(`SELECT count(*) AS n FROM ${table} WHERE ${where} = ?`)
    .bind(value)
    .first<{ n: number }>();
  return row!.n;
}

/** A federation no tenant points at, so it can be deleted. */
async function spareFederation(): Promise<string> {
  const id = crypto.randomUUID();
  await insertRow("federations", {
    id,
    slug: `spare-${id.slice(0, 8)}`,
    name: "Spare",
    lead_tenant_id: DEFAULT_TEST_TENANT_ID,
    created_at: Date.now(),
  });
  return id;
}

let mirror: Shape;

describe("migrations 0119, 0120, 0121 and 0122", () => {
  beforeAll(async () => {
    await applyMigrations();
    mirror = await shape();
    await cleanDatabase();
    await removeMigrations();
    await runMigrationFile("0119_institution_records.sql");
    await runMigrationFile("0120_institution_records_licence_citations.sql");
    await runMigrationFile("0121_repository_credit_statements.sql");
    await runMigrationFile("0122_federation_hosting_statement.sql");
    // 0125 rebuilds vocabulary_values with the relation lists and columns;
    // the mirror holds that shape, so its vocabulary statements run too.
    for (const statement of migrationStatements("0125_relations.sql")) {
      if (/\bvocabulary_values/.test(statement)) await env.DB.prepare(statement).run();
    }
  });

  it("adds the hosting statement pair to federations as nullable text, null by default", async () => {
    const federations = await columns("federations");
    for (const column of FEDERATION_COLUMNS_0122) expect(federations).toContain(column);
    const id = await spareFederation();
    const read = () =>
      env.DB.prepare(
        "SELECT hosting_statement_es AS es, hosting_statement_en AS en, typeof(hosting_statement_es) AS t FROM federations WHERE id = ?",
      )
        .bind(id)
        .first<{ es: string | null; en: string | null; t: string }>();
    expect(await read()).toEqual({ es: null, en: null, t: "null" });
    await env.DB.prepare("UPDATE federations SET hosting_statement_es = ?, hosting_statement_en = ? WHERE id = ?")
      .bind("Alojado en Zasqua (zasqua.org).", "Hosted on Zasqua (zasqua.org).", id)
      .run();
    expect(await read()).toEqual({ es: "Alojado en Zasqua (zasqua.org).", en: "Hosted on Zasqua (zasqua.org).", t: "text" });
  });

  it("adds the credit statement pair to repositories as nullable text, null by default", async () => {
    const repositories = await columns("repositories");
    for (const column of REPOSITORY_COLUMNS_0121) expect(repositories).toContain(column);
    const repo = await createTestRepository();
    const read = () =>
      env.DB.prepare(
        "SELECT credit_statement_es AS es, credit_statement_en AS en, typeof(credit_statement_es) AS t FROM repositories WHERE id = ?",
      )
        .bind(repo.id)
        .first<{ es: string | null; en: string | null; t: string }>();
    expect(await read()).toEqual({ es: null, en: null, t: "null" });
    await env.DB.prepare("UPDATE repositories SET credit_statement_es = ?, credit_statement_en = ? WHERE id = ?")
      .bind("Digitalizado en alianza con Neogranadina.", "Digitized in partnership with Neogranadina.", repo.id)
      .run();
    expect(await read()).toEqual({
      es: "Digitalizado en alianza con Neogranadina.",
      en: "Digitized in partnership with Neogranadina.",
      t: "text",
    });
  });

  it("adds the publisher record's columns to federations", async () => {
    const present = await columns("federations");
    for (const column of FEDERATION_COLUMNS) {
      if (!FEDERATION_COLUMNS_DROPPED_BY_0120.includes(column)) expect(present).toContain(column);
    }
  });

  it("moves the catalogue licence URI to repositories and splits the citation template into site and record templates", async () => {
    const federations = await columns("federations");
    for (const column of FEDERATION_COLUMNS_DROPPED_BY_0120) expect(federations).not.toContain(column);
    for (const column of FEDERATION_COLUMNS_0120) expect(federations).toContain(column);
    const repositories = await columns("repositories");
    for (const column of REPOSITORY_COLUMNS_0120) expect(repositories).toContain(column);
  });

  it("adds home_order to repositories as a nullable integer, null by default", async () => {
    const repo = await createTestRepository();
    const read = () =>
      env.DB.prepare("SELECT home_order AS n, typeof(home_order) AS t FROM repositories WHERE id = ?")
        .bind(repo.id)
        .first<{ n: number | null; t: string }>();
    expect(await read()).toEqual({ n: null, t: "null" });
    await env.DB.prepare("UPDATE repositories SET home_order = 3 WHERE id = ?").bind(repo.id).run();
    expect(await read()).toEqual({ n: 3, t: "integer" });
  });

  it("stores a repository's catalogue licence URI and a federation's four citation templates", async () => {
    const repo = await createTestRepository();
    await env.DB.prepare("UPDATE repositories SET catalogue_licence_uri = ? WHERE id = ?")
      .bind("https://creativecommons.org/licenses/by/4.0/", repo.id)
      .run();
    const stored = await env.DB.prepare("SELECT catalogue_licence_uri AS uri FROM repositories WHERE id = ?")
      .bind(repo.id)
      .first<{ uri: string }>();
    expect(stored!.uri).toBe("https://creativecommons.org/licenses/by/4.0/");
    await env.DB.prepare(
      "UPDATE federations SET citation_template_site_es = 'a', citation_template_site_en = 'b', " +
        "citation_template_record_es = 'c', citation_template_record_en = 'd' WHERE id = ?",
    )
      .bind(DEFAULT_TEST_FEDERATION_ID)
      .run();
    const row = await env.DB.prepare(
      "SELECT citation_template_record_en AS r FROM federations WHERE id = ?",
    )
      .bind(DEFAULT_TEST_FEDERATION_ID)
      .first<{ r: string }>();
    expect(row!.r).toBe("d");
  });

  it("adds the ISDIAH record's columns to repositories", async () => {
    const present = await columns("repositories");
    for (const column of REPOSITORY_COLUMNS) expect(present).toContain(column);
  });

  it("creates the four tables with the agreed columns", async () => {
    for (const [table, expected] of Object.entries(NEW_TABLES)) {
      expect(await columns(table)).toEqual(expected);
    }
  });

  it("builds the same shape as the test mirror", async () => {
    expect(await shape()).toEqual(mirror);
  });

  it("keeps a vocabulary value unique per federation, list and code, across federations independently", async () => {
    await insertRow("vocabulary_values", vocabularyValue());
    await expect(insertRow("vocabulary_values", vocabularyValue())).rejects.toThrow();
    // The same code in another list, and the same list and code in another federation.
    await insertRow("vocabulary_values", vocabularyValue({ list: "entity_type" }));
    await insertRow("vocabulary_values", vocabularyValue({ federation_id: PLATFORM_FEDERATION_ID }));
    expect(await count("vocabulary_values", "code", "river")).toBe(3);
  });

  it("defaults a vocabulary value's status to approved, and refuses an unknown list or status", async () => {
    const row = vocabularyValue({ code: "town" });
    await insertRow("vocabulary_values", row);
    const stored = await env.DB.prepare("SELECT status, position FROM vocabulary_values WHERE id = ?")
      .bind(row.id)
      .first<{ status: string; position: number }>();
    expect(stored).toEqual({ status: "approved", position: 0 });
    for (const status of ["approved", "proposed", "deprecated"]) {
      await insertRow("vocabulary_values", vocabularyValue({ code: `s-${status}`, status }));
    }
    await expect(insertRow("vocabulary_values", vocabularyValue({ code: "x1", list: "colour" }))).rejects.toThrow();
    await expect(insertRow("vocabulary_values", vocabularyValue({ code: "x2", status: "retired" }))).rejects.toThrow();
    await expect(insertRow("vocabulary_values", vocabularyValue({ code: "x3", list: null }))).rejects.toThrow();
  });

  it("accepts every list the spec names", async () => {
    for (const list of ["entity_type", "place_type", "entity_role", "place_role", "role_group"]) {
      await insertRow("vocabulary_values", vocabularyValue({ code: `l-${list}`, list }));
    }
  });

  it("keeps an authority source unique per federation and key, and checks its status and list of record kinds", async () => {
    await insertRow("authority_sources", authoritySource());
    await expect(insertRow("authority_sources", authoritySource())).rejects.toThrow();
    await insertRow("authority_sources", authoritySource({ federation_id: PLATFORM_FEDERATION_ID }));
    await expect(insertRow("authority_sources", authoritySource({ key: "a1", status: "retired" }))).rejects.toThrow();
    await expect(insertRow("authority_sources", authoritySource({ key: "a2", applies_to: "entity" }))).rejects.toThrow();
    await expect(insertRow("authority_sources", authoritySource({ key: "a3", applies_to: '{"entity":1}' }))).rejects.toThrow();
    await insertRow("authority_sources", authoritySource({ key: "a4", applies_to: null }));
  });

  it("accepts the four credit roles and refuses any other", async () => {
    for (const role of ["partner", "funder", "developer", "host"]) {
      await insertRow("federation_credits", credit({ role }));
    }
    await expect(insertRow("federation_credits", credit({ role: "sponsor" }))).rejects.toThrow();
  });

  it("checks that a repository's other names are a JSON list", async () => {
    const repo = await createTestRepository();
    const set = (value: string | null) =>
      env.DB.prepare("UPDATE repositories SET other_names = ? WHERE id = ?").bind(value, repo.id).run();
    await set(JSON.stringify(["Archivo Central del Cauca"]));
    await set(null);
    await expect(set("Archivo Central del Cauca")).rejects.toThrow();
    await expect(set('{"es":"x"}')).rejects.toThrow();
  });

  it("refuses rows that name a federation or repository that does not exist", async () => {
    const missing = crypto.randomUUID();
    await expect(insertRow("federation_credits", credit({ federation_id: missing }))).rejects.toThrow();
    await expect(insertRow("vocabulary_values", vocabularyValue({ federation_id: missing, code: "fk" }))).rejects.toThrow();
    await expect(insertRow("authority_sources", authoritySource({ federation_id: missing, key: "fk" }))).rejects.toThrow();
    await expect(
      insertRow("repository_funders", { id: crypto.randomUUID(), repository_id: missing, name: "Funder" }),
    ).rejects.toThrow();
  });

  it("deletes a federation's credits and a repository's funders with them", async () => {
    const federationId = await spareFederation();
    await insertRow("federation_credits", credit({ federation_id: federationId }));
    await env.DB.prepare("DELETE FROM federations WHERE id = ?").bind(federationId).run();
    expect(await count("federation_credits", "federation_id", federationId)).toBe(0);

    const repo = await createTestRepository();
    await insertRow("repository_funders", {
      id: crypto.randomUUID(),
      repository_id: repo.id,
      name: "Endangered Archives Programme",
      programme: "EAP",
      project_id: "EAP 1477",
    });
    await env.DB.prepare("DELETE FROM repositories WHERE id = ?").bind(repo.id).run();
    expect(await count("repository_funders", "repository_id", repo.id)).toBe(0);
  });

  it("refuses to delete a federation that still has vocabulary values or authority sources", async () => {
    const withValue = await spareFederation();
    await insertRow("vocabulary_values", vocabularyValue({ federation_id: withValue }));
    await expect(env.DB.prepare("DELETE FROM federations WHERE id = ?").bind(withValue).run()).rejects.toThrow();

    const withSource = await spareFederation();
    await insertRow("authority_sources", authoritySource({ federation_id: withSource }));
    await expect(env.DB.prepare("DELETE FROM federations WHERE id = ?").bind(withSource).run()).rejects.toThrow();
  });
});
