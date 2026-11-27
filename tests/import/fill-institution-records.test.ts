/**
 * Tests — filling the institution records
 *
 * This suite pins `scripts/lib/institution-records-fill.ts`, behind
 * `scripts/commands/fill-institution-records.ts`: the one-off pass that
 * writes today's hard-coded repository values, the funder named in an
 * attribution and the reproduction sentence of `rights_text` into the
 * repository records, and seeds each federation's controlled lists and
 * authority sources. The D1 is a `node:sqlite` twin holding the columns
 * the command reads and writes, with D1's expression depth limit of 100;
 * the providers read it, write files to a map and apply the SQL file as
 * one unit, as `wrangler d1 execute --file` does.
 *
 *   - the dry run reads only, and writes the SQL file, the report and the
 *     hero upload plan: per repository and field, the value held, the
 *     value proposed and its source;
 *   - only the federation's repositories are filled; another
 *     federation's are left alone, and a repository with no source entry
 *     is reported and skipped;
 *   - a value already held is never overwritten: a difference is
 *     reported; the federation's publisher email and hosting statement
 *     are set from the rulings in the data file, on that federation only;
 *   - `--apply` writes the values, the funders and one set of lists
 *     and authority sources per federation; a second run writes nothing;
 *   - a repository's funder list in the data file is the whole set: a
 *     held funder not listed is deleted and reported, a listed one not
 *     held is inserted in the order listed, one held under a listed name
 *     is left; a repository with no list keeps its funders; a web funder
 *     needs its page and quote, a D1 funder its evidence;
 *   - other names (a JSON list) and the history (Markdown, byte for byte)
 *     are written only where the column is empty, and a held value is
 *     reported and left; the one exception is co-ahjci's history, which
 *     replaces the previous approved text only while the column holds
 *     exactly that text, with the UPDATE guarded on it, and is reported
 *     and left when it holds anything else;
 *   - the wording rulings of 2026-11-03 (three subtitles, pe-bn's credit
 *     statement and history, co-cihjml's rights text and the reproduction
 *     sentence cut from it) replace the production text only while the
 *     column holds exactly that text, with the UPDATE guarded on it;
 *   - the credit statements, the histories of the other four
 *     repositories and the funders of co-cihjml and pe-bn are planned
 *     with their sources and written byte for byte;
 *   - the approved repository facts (short name, other names,
 *     institution type, address, email, website, telephone, opening
 *     times and access conditions) are each planned with their source and
 *     written; a column holding NULL or only whitespace counts as empty,
 *     both in the plan and in the update's guard, and a value held is
 *     reported and left; BNP's two paragraphs are stored byte for byte;
 *   - the English text approved on 2026-11-06 (every subtitle and
 *     reproduction sentence, co-cihjml's and BNP's access conditions,
 *     BNP's opening times) is planned with its source and written byte for
 *     byte only where the column is empty; a held value is reported and
 *     left;
 *   - a repository changed, recoded, moved to another tenant or whose
 *     tenant changed federation, a held funder, vocabulary value or
 *     authority source edited, renamed or deleted, or a row added
 *     (including beside a funder to be deleted),
 *     between the read and the apply, fails the whole file, whether or
 *     not that repository or federation has rows to insert;
 *   - the authority sources seeded are the six production holds, hgis
 *     with no link template and dbe with production's; a federation that
 *     holds them as production does gets no change, one that holds them
 *     as staging does gets dbe inserted and hgis's template set to none,
 *     guarded on the held template; tgn's and whg's held templates are
 *     replaced by the readable page and the record page in the same way;
 *     any other held template is reported and left;
 *   - inserts stay within D1's 100 bound parameters a statement;
 *   - hero URLs are written only with `--with-heroes`, and only for an
 *     object found at its public address with the planned digest; a
 *     hero run after a full apply is refused, not reported as having
 *     nothing to write, when an object is missing;
 *   - every value written names a source, and an entry without one stops
 *     the command;
 *   - the home order is written as an integer, and only where none is
 *     held;
 *   - without migration 0119, without 0120's `home_order`, without
 *     0121's credit statements, or without 0122's hosting statement, the
 *     dry run still plans, and `--apply` refuses;
 *   - a re-read that differs after an apply is written to the report as
 *     unverified, and the command exits non-zero;
 *   - the report renderers live apart from the planner;
 *   - the reader passes only SELECTs; production needs
 *     `--confirm-production`.
 *
 * @version v0.9.0
 */
import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  FillStop,
  MAX_PARAMS,
  fillInstitutionRecords,
  insertStatements,
  selectOnly,
  validateSources,
  vocabularySeed,
  type FillProviders,
} from "../../scripts/lib/institution-records-fill";
import { exitCode, parseArgs } from "../../scripts/commands/fill-institution-records";
import { renderHeroPlan, renderReport } from "../../scripts/lib/institution-records-report";
import { NEOGRANADINA, type InstitutionSource } from "../../scripts/data/institution-records/neogranadina";
import { AUTHORITY_SOURCES } from "../../scripts/data/institution-records/vocabularies";
import { SERVICE_URLS } from "../../app/components/forms/lod-link-field";
import { getTableConfig } from "drizzle-orm/sqlite-core";
import { repositories, vocabularyValues } from "../../app/db/schema";

const D1_LIMITS = { limits: { exprDepth: 100 } } as unknown as ConstructorParameters<typeof DatabaseSync>[1];
const NOW = 1_800_000_000_000;
const BASE = "https://manifests.example.org";

const AHJCI_RIGHTS =
  "Imágenes digitales disponibles en Zasqua mediante IIIF. CC BY-NC 4.0. Para obtener derechos de reproducción para publicaciones, por favor diríjase al Archivo Histórico del Juzgado del Circuito de Istmina.";
const AHJCI_ATTR_EN =
  "Archivo Histórico del Juzgado del Circuito de Istmina, Istmina, Colombia. Digitized under the Endangered Archives Programme (EAP 1477), funded by Arcadia and held at the British Library. CC BY-NC 4.0. Processed by Neogranadina and hosted on Zasqua (zasqua.org).";

const REPO_0119 = `subtitle_en TEXT, other_names TEXT, institution_type TEXT, logo_key TEXT, region TEXT, postal_code TEXT,
  telephone TEXT, email TEXT, holdings_es TEXT, holdings_en TEXT, history_es TEXT, history_en TEXT, opening_times_es TEXT,
  opening_times_en TEXT, access_conditions_es TEXT, access_conditions_en TEXT, accessibility_es TEXT, accessibility_en TEXT,
  reproduction_services_es TEXT, reproduction_services_en TEXT, description_language TEXT,`;

const TABLES_0119 = `
CREATE TABLE repository_funders (id TEXT PRIMARY KEY, repository_id TEXT NOT NULL, name TEXT NOT NULL, programme TEXT,
  project_id TEXT, url TEXT, position INTEGER NOT NULL DEFAULT 0);
CREATE TABLE vocabulary_values (id TEXT PRIMARY KEY, federation_id TEXT NOT NULL, list TEXT NOT NULL, code TEXT NOT NULL,
  label_es TEXT, label_en TEXT, group_code TEXT, position INTEGER NOT NULL DEFAULT 0, external_scheme TEXT, external_uri TEXT,
  external_label TEXT, status TEXT NOT NULL DEFAULT 'approved', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  connector_es TEXT, connector_en TEXT, inverse_code TEXT, hide_when_group TEXT, label_es_female TEXT, label_es_male TEXT,
  label_es_unrecorded TEXT, label_es_alone TEXT, label_en_female TEXT, label_en_male TEXT, label_en_unrecorded TEXT,
  label_en_alone TEXT);
CREATE UNIQUE INDEX vocabulary_values_federation_list_code_idx ON vocabulary_values (federation_id, list, code);
CREATE TABLE authority_sources (id TEXT PRIMARY KEY, federation_id TEXT NOT NULL, key TEXT NOT NULL, label_es TEXT,
  label_en TEXT, url_template TEXT, applies_to TEXT, position INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'approved');
CREATE UNIQUE INDEX authority_sources_federation_key_idx ON authority_sources (federation_id, key);
`;

function ddl(with0119: boolean, with0120: boolean, with0121: boolean, with0122: boolean): string {
  return `
CREATE TABLE federations (id TEXT PRIMARY KEY, slug TEXT NOT NULL, name TEXT NOT NULL, publisher_name TEXT,
  publisher_tax_id TEXT, publisher_location TEXT, publisher_url TEXT, manifest_bucket TEXT, manifest_base_url TEXT
  ${with0119 ? ", publisher_email TEXT" : ""}${with0122 ? ", hosting_statement_es TEXT, hosting_statement_en TEXT" : ""});
CREATE TABLE tenants (id TEXT PRIMARY KEY, slug TEXT NOT NULL, federation_id TEXT NOT NULL);
CREATE TABLE repositories (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, code TEXT NOT NULL, name TEXT NOT NULL,
  short_name TEXT, country_code TEXT, country TEXT, city TEXT, address TEXT, website TEXT, rights_text TEXT, display_title TEXT, subtitle TEXT, hero_image_url TEXT,
  attribution_en TEXT, attribution_es TEXT, ${with0119 ? REPO_0119 : ""} ${with0120 ? "home_order INTEGER," : ""}
  ${with0121 ? "credit_statement_es TEXT, credit_statement_en TEXT," : ""}
  updated_at INTEGER NOT NULL);
CREATE TABLE entities (id TEXT PRIMARY KEY, federation_id TEXT NOT NULL, entity_type TEXT NOT NULL);
CREATE TABLE places (id TEXT PRIMARY KEY, federation_id TEXT NOT NULL, place_type TEXT);
CREATE TABLE descriptions (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL);
CREATE TABLE description_entities (id TEXT PRIMARY KEY, description_id TEXT NOT NULL, role TEXT NOT NULL);
CREATE TABLE description_places (id TEXT PRIMARY KEY, description_id TEXT NOT NULL, role TEXT NOT NULL);
${with0119 ? TABLES_0119 : ""}
INSERT INTO federations (id, slug, name, publisher_name, publisher_tax_id, publisher_location, publisher_url,
  manifest_bucket, manifest_base_url) VALUES
  ('fed-n', 'neogranadina', 'Neogranadina', 'Fundación Histórica Neogranadina', 'NIT 900.861.407', 'Bogotá, Colombia',
   'https://neogranadina.org', 'manifests-bucket', '${BASE}'),
  ('fed-a', 'ampl', 'AMPL', NULL, NULL, NULL, NULL, NULL, NULL);
INSERT INTO tenants VALUES ('t-n', 'neogranadina', 'fed-n'), ('t-r', 'ahr', 'fed-n'), ('t-s', 'sbmal', 'fed-a');
INSERT INTO entities VALUES ('e1', 'fed-n', 'person'), ('e2', 'fed-n', 'person'), ('e3', 'fed-a', 'guild');
INSERT INTO places VALUES ('p1', 'fed-n', 'river'), ('p2', 'fed-a', NULL);
INSERT INTO descriptions VALUES ('d1', 't-n');
INSERT INTO description_entities VALUES ('de1', 'd1', 'creator');
INSERT INTO description_places VALUES ('dp1', 'd1', 'venue');
`;
}

function repo(db: DatabaseSync, id: string, tenant: string, code: string, over: Record<string, unknown> = {}) {
  const row: Record<string, unknown> = {
    id,
    tenant_id: tenant,
    code,
    name: `Name ${code}`,
    country: "Colombia",
    city: "Istmina",
    rights_text: AHJCI_RIGHTS,
    attribution_en: AHJCI_ATTR_EN,
    updated_at: 100,
    ...over,
  };
  const cols = Object.keys(row);
  db.prepare(`INSERT INTO repositories (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`).run(
    ...(Object.values(row) as Array<string | number | null>),
  );
}

function twin(with0119 = true, with0120 = with0119, with0121 = with0120, with0122 = with0121): DatabaseSync {
  const db = new DatabaseSync(":memory:", D1_LIMITS);
  db.exec(ddl(with0119, with0120, with0121, with0122));
  repo(db, "r-ahjci", "t-n", "co-ahjci");
  repo(db, "r-ahr", "t-r", "co-ahr", {
    city: "Rionegro",
    rights_text:
      "Imágenes digitales disponibles en Zasqua mediante IIIF. CC BY-NC 4.0. Para obtener derechos de reproducción para publicaciones, por favor diríjase al Archivo Histórico de Rionegro.",
    attribution_en: "Archivo Histórico de Rionegro, Rionegro, Colombia.",
    display_title: "A title already held",
  });
  repo(db, "r-cobos", "t-n", "cobos", { rights_text: null, attribution_en: null });
  repo(db, "r-sbmal", "t-s", "us-sbmal", { rights_text: null, attribution_en: null });
  return db;
}

interface Run {
  files: Map<string, string>;
  applied: string[][];
}

function providers(
  db: DatabaseSync,
  run: Run,
  opts: { before?: () => void; objects?: Record<string, Uint8Array | null>; skipApply?: boolean } = {},
): FillProviders {
  let n = 0;
  return {
    rows: selectOnly(async (sql) => db.prepare(sql).all() as Record<string, unknown>[]),
    writeFile: (p, text) => run.files.set(p, text),
    applyFile: async (_p, statements) => {
      opts.before?.();
      run.applied.push(statements);
      if (opts.skipApply) return;
      db.exec("BEGIN");
      try {
        db.exec(statements.join("\n"));
        db.exec("COMMIT");
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
    },
    fetchObject: async (url) => opts.objects?.[url] ?? null,
    now: () => NOW,
    newId: () => `id-${++n}`,
  };
}

async function command(
  db: DatabaseSync,
  over: { apply?: boolean; withHeroes?: boolean; target?: "local" | "staging" | "production" } = {},
  opts: { before?: () => void; objects?: Record<string, Uint8Array | null>; source?: InstitutionSource; skipApply?: boolean } = {},
) {
  const run: Run = { files: new Map(), applied: [] };
  const lines: string[] = [];
  const report = await fillInstitutionRecords(
    {
      target: over.target ?? "local",
      federation: "neogranadina",
      apply: over.apply ?? false,
      withHeroes: over.withHeroes ?? false,
      outDir: "out",
    },
    providers(db, run, opts),
    (l) => lines.push(l),
    opts.source,
  );
  return { report, run, lines };
}

const one = (db: DatabaseSync, sql: string) => db.prepare(sql).get() as Record<string, unknown>;
const count = (db: DatabaseSync, sql: string) => Number(one(db, sql).n);
const SEED_SIZE = 3 + 12 + 33 + 7 + 7;

/** Authority sources as production held them on 2026-11-14: key, label (both languages), template, applies_to, position. */
type HeldSource = [string, string, string | null, string, number];
const PRODUCTION_SOURCES: HeldSource[] = [
  ["wikidata", "Wikidata", "https://www.wikidata.org/wiki/{id}", '["entity"]', 1],
  ["viaf", "VIAF", "https://viaf.org/viaf/{id}", '["entity"]', 2],
  ["tgn", "TGN", "https://vocab.getty.edu/tgn/{id}", '["place"]', 3],
  ["hgis", "HGIS", null, '["place"]', 4],
  ["whg", "WHG", "https://whgazetteer.org/places/{id}", '["place"]', 5],
  ["dbe", "DBE", "https://historia-hispanica.rah.es/biografias/{id}", '["entity"]', 6],
];
/** The seed's templates for tgn and whg, which replace the ones production and staging held on 2026-11-14. */
const SEEDED_SOURCES: HeldSource[] = PRODUCTION_SOURCES.map((r) =>
  r[0] === "tgn" ? ["tgn", "TGN", "https://vocab.getty.edu/page/tgn/{id}", r[3], r[4]]
  : r[0] === "whg" ? ["whg", "WHG", "https://whgazetteer.org/places/{id}/detail", r[3], r[4]]
  : r);
/** As staging held them on 2026-11-14: no dbe, and hgis with the app's link template. */
const STAGING_SOURCES: HeldSource[] = PRODUCTION_SOURCES.filter(([key]) => key !== "dbe")
  .map((r) => (r[0] === "hgis" ? ["hgis", "HGIS", "https://hgis-indias.net/place/{id}", r[3], r[4]] : r));

function holdSources(db: DatabaseSync, held: HeldSource[]): void {
  const insert = db.prepare(
    "INSERT INTO authority_sources (id, federation_id, key, label_es, label_en, url_template, applies_to, position) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  );
  for (const fed of ["fed-a", "fed-n"]) {
    for (const [key, label, urlTemplate, appliesTo, position] of held) insert.run(`s-${fed}-${key}`, fed, key, label, label, urlTemplate, appliesTo, position);
  }
}

describe("the dry run", () => {
  it("reads only and writes the SQL file, the report and the hero plan", async () => {
    const db = twin();
    const { report, run } = await command(db);
    expect(run.applied).toEqual([]);
    expect(one(db, "SELECT display_title FROM repositories WHERE id = 'r-ahjci'").display_title).toBeNull();
    const names = [...run.files.keys()].map((p) => path.basename(p));
    expect(names.some((n) => n.endsWith(".sql"))).toBe(true);
    expect(names.some((n) => n.endsWith(".md") && !n.includes("heroes"))).toBe(true);
    expect(names.some((n) => n.includes("heroes") && n.endsWith(".json"))).toBe(true);
    expect(report.statements.length).toBeGreaterThan(0);
  });

  it("takes the regions of co-ahrb and co-cihjml from the home page's card categories", () => {
    expect(NEOGRANADINA.repositories["co-ahrb"].region).toEqual({
      value: "Boyacá",
      source: 'Neogranadina instance, 2026-11-01, themes/neogranadina/layouts/index.html:91 ("Tunja, Boyacá")',
    });
    expect(NEOGRANADINA.repositories["co-cihjml"].region).toEqual({
      value: "Cauca",
      source: 'Neogranadina instance, 2026-11-01, themes/neogranadina/layouts/index.html:97 ("Popayán, Cauca")',
    });
    expect(NEOGRANADINA.repositories["pe-bn"].region).toBeUndefined();
  });

  it("proposes each field with the value held, the value proposed and its source", async () => {
    const { report } = await command(twin());
    const ahjci = report.repositories.find((r) => r.code === "co-ahjci")!;
    const field = (c: string) => ahjci.fields.find((f) => f.column === c)!;
    expect(field("display_title")).toMatchObject({
      current: null,
      proposed: "Archivo Histórico del Juzgado del Circuito de Istmina",
      action: "set",
    });
    expect(field("display_title").source).toContain("single.html");
    expect(field("subtitle").proposed).toBe(NEOGRANADINA.repositories["co-ahjci"].subtitle.value);
    expect(field("region")).toMatchObject({ proposed: "Chocó", action: "set" });
    expect(field("home_order")).toMatchObject({ proposed: "2", action: "set" });
    expect(field("home_order").source).toBe("Neogranadina instance, 2026-11-01, themes/neogranadina/layouts/index.html:57");
    expect(field("reproduction_services_es")).toMatchObject({
      proposed:
        "Para obtener derechos de reproducción para publicaciones, por favor diríjase al Archivo Histórico del Juzgado del Circuito de Istmina.",
      action: "set",
    });
    for (const r of report.repositories) for (const f of r.fields) if (f.action === "set") expect(f.source).toBeTruthy();
  });

  it("reports a value already held instead of overwriting it", async () => {
    const { report } = await command(twin());
    const ahr = report.repositories.find((r) => r.code === "co-ahr")!;
    expect(ahr.fields.find((f) => f.column === "display_title")).toMatchObject({
      current: "A title already held",
      proposed: "Archivo Histórico de Rionegro",
      action: "differs",
    });
    expect(report.statements.join("\n")).not.toContain("'Archivo Histórico de Rionegro'");
  });

  it("fills only the federation's repositories and reports one without a source entry", async () => {
    const { report } = await command(twin());
    const codes = report.repositories.map((r) => r.code).sort();
    expect(codes).toEqual(["co-ahjci", "co-ahr"]);
    expect(report.withoutSource).toEqual(["cobos"]);
    expect(report.notFound.sort()).toEqual(["co-ahrb", "co-cihjml", "pe-bn"]);
    expect(report.statements.join("\n")).not.toContain("r-sbmal");
  });

  it("names the post-0120 columns among the gaps", async () => {
    const { report } = await command(twin());
    expect(report.gaps.some((g) => g.includes("repositories.catalogue_licence_uri"))).toBe(true);
    expect(report.gaps.some((g) => g.includes("citation_template_site_es") && g.includes("citation_template_record_en"))).toBe(true);
    expect(report.gaps.some((g) => /citation_template_es|federations\.catalogue_licence_uri/.test(g))).toBe(false);
  });

  it("leaves hero URLs out of the SQL without --with-heroes but plans the upload", async () => {
    const { report } = await command(twin());
    expect(report.statements.join("\n")).not.toContain("hero_image_url =");
    const hero = report.heroes.find((h) => h.code === "co-ahjci")!;
    expect(hero).toMatchObject({
      bucket: "manifests-bucket",
      key: "institutions/co-ahjci/hero.jpg",
      url: `${BASE}/institutions/co-ahjci/hero.jpg`,
      size: 137133,
    });
  });

  it("plans one set of lists and authority sources for every federation, with the usage counts", async () => {
    const { report } = await command(twin());
    expect(report.vocabularies.map((v) => [v.federation, v.toInsert])).toEqual([
      ["ampl", SEED_SIZE],
      ["neogranadina", SEED_SIZE],
    ]);
    expect(report.authoritySources.map((v) => [v.federation, v.toInsert])).toEqual([
      ["ampl", 6],
      ["neogranadina", 6],
    ]);
    const neo = report.vocabularies.find((v) => v.federation === "neogranadina")!;
    expect(neo.usage).toContainEqual({ list: "entity_type", code: "person", count: 2 });
    const ampl = report.vocabularies.find((v) => v.federation === "ampl")!;
    expect(ampl.orphans).toEqual([{ list: "entity_type", code: "guild", count: 1 }]);
    expect(ampl.unset).toContainEqual({ list: "place_type", count: 1 });
  });
});

describe("--apply", () => {
  it("fills a blank home order without the guard reading the blank as 0", async () => {
    const db = twin();
    db.prepare("UPDATE repositories SET home_order = '' WHERE id = 'r-ahjci'").run();
    const { report } = await command(db, { apply: true });
    expect(report.verified).toBe(true);
    expect(one(db, "SELECT home_order, typeof(home_order) AS t FROM repositories WHERE id = 'r-ahjci'")).toEqual({ home_order: 2, t: "integer" });
  });

  it("writes the values, the funder and one seed per federation; a second run writes nothing", async () => {
    const db = twin();
    const first = await command(db, { apply: true });
    expect(first.run.applied).toHaveLength(1);
    expect(first.report.verified).toBe(true);
    const row = one(db, "SELECT * FROM repositories WHERE id = 'r-ahjci'");
    expect(row.display_title).toBe("Archivo Histórico del Juzgado del Circuito de Istmina");
    expect(row.region).toBe("Chocó");
    expect(row.rights_text).toBe(AHJCI_RIGHTS);
    expect(row.subtitle_en).toBe(NEOGRANADINA.repositories["co-ahjci"].subtitleEn!.value);
    expect(row.hero_image_url).toBeNull();
    expect(row.updated_at).toBe(NOW);
    expect(one(db, "SELECT home_order, typeof(home_order) AS t FROM repositories WHERE id = 'r-ahjci'")).toEqual({ home_order: 2, t: "integer" });
    expect(one(db, "SELECT home_order FROM repositories WHERE id = 'r-ahr'").home_order).toBe(3);
    expect(db.prepare("SELECT slug, publisher_email FROM federations ORDER BY slug").all()).toEqual([
      { slug: "ampl", publisher_email: null },
      { slug: "neogranadina", publisher_email: "contacto@neogranadina.org" },
    ]);
    expect(one(db, "SELECT display_title FROM repositories WHERE id = 'r-ahr'").display_title).toBe("A title already held");
    expect(db.prepare("SELECT repository_id, name, programme, project_id, url, position FROM repository_funders ORDER BY repository_id, position").all()).toEqual([
      { repository_id: "r-ahjci", name: "British Library", programme: "Endangered Archives Programme", project_id: "EAP1477", url: "https://doi.org/10.15130/EAP1477", position: 1 },
      { repository_id: "r-ahjci", name: "University of Michigan", programme: null, project_id: null, url: null, position: 2 },
      { repository_id: "r-ahr", name: "Alcaldía de Rionegro", programme: null, project_id: null, url: null, position: 1 },
    ]);
    expect(count(db, "SELECT count(*) AS n FROM vocabulary_values WHERE federation_id = 'fed-n'")).toBe(SEED_SIZE);
    expect(count(db, "SELECT count(*) AS n FROM vocabulary_values WHERE federation_id = 'fed-a'")).toBe(SEED_SIZE);
    expect(count(db, "SELECT count(*) AS n FROM authority_sources")).toBe(12);
    expect(db.prepare("SELECT key, label_es, label_en, url_template, applies_to, position FROM authority_sources WHERE federation_id = 'fed-a' ORDER BY position").all())
      .toEqual(SEEDED_SOURCES.map(([key, label, urlTemplate, appliesTo, position]) => ({ key, label_es: label, label_en: label, url_template: urlTemplate, applies_to: appliesTo, position })));
    expect(one(db, "SELECT external_uri, external_label FROM vocabulary_values WHERE federation_id = 'fed-a' AND list = 'place_type' AND code = 'river'"))
      .toEqual({ external_uri: "http://vocab.getty.edu/aat/300008707", external_label: "rivers" });
    expect(one(db, "SELECT group_code, position FROM vocabulary_values WHERE federation_id = 'fed-n' AND list = 'entity_role' AND code = 'sender'"))
      .toEqual({ group_code: "correspondence", position: 1 });
    expect(one(db, "SELECT label_es, label_en, position FROM vocabulary_values WHERE federation_id = 'fed-n' AND list = 'role_group' AND code = 'notarial'"))
      .toEqual({ label_es: "Actuación notarial", label_en: "Notarial attestation", position: 3 });

    const second = await command(db, { apply: true });
    expect(second.run.applied).toEqual([]);
    expect(second.report.statements).toEqual([]);
  });

  it("fails the whole file when a repository changed after the read", async () => {
    const db = twin();
    await expect(
      command(db, { apply: true }, { before: () => db.exec("UPDATE repositories SET rights_text = 'x' WHERE id = 'r-ahjci'") }),
    ).rejects.toThrow(/malformed JSON/);
    expect(one(db, "SELECT display_title FROM repositories WHERE id = 'r-ahjci'").display_title).toBeNull();
    expect(count(db, "SELECT count(*) AS n FROM vocabulary_values")).toBe(0);
  });

  it("fails the whole file when a federation's lists changed after the read", async () => {
    const db = twin();
    await expect(
      command(db, { apply: true }, {
        before: () =>
          db.exec("INSERT INTO vocabulary_values (id, federation_id, list, code, created_at, updated_at) VALUES ('z', 'fed-a', 'place_type', 'lake', 1, 1)"),
      }),
    ).rejects.toThrow(/malformed JSON/);
    expect(count(db, "SELECT count(*) AS n FROM repository_funders")).toBe(0);
  });

  it("fails the whole file when a funder was added after the read", async () => {
    const db = twin();
    await expect(
      command(db, { apply: true }, {
        before: () => db.exec("INSERT INTO repository_funders (id, repository_id, name) VALUES ('f', 'r-ahjci', 'Other')"),
      }),
    ).rejects.toThrow(/malformed JSON/);
  });

  it("refuses without migration 0120's home_order, though the dry run still plans it", async () => {
    const dry = await command(twin(true, false));
    expect(dry.report.schemaReady).toBe(false);
    expect(dry.report.missingSchema).toContain("repositories.home_order");
    expect(dry.report.repositories.find((r) => r.code === "co-ahjci")!.fields.find((f) => f.column === "home_order"))
      .toMatchObject({ current: null, proposed: "2", action: "set" });
    await expect(command(twin(true, false), { apply: true })).rejects.toThrow(FillStop);
  });

  it("leaves a home order already held and reports the difference", async () => {
    const db = twin();
    db.exec("UPDATE repositories SET home_order = 9 WHERE id = 'r-ahjci'");
    const { report } = await command(db, { apply: true });
    expect(report.repositories.find((r) => r.code === "co-ahjci")!.fields.find((f) => f.column === "home_order"))
      .toMatchObject({ current: "9", proposed: "2", action: "differs" });
    expect(one(db, "SELECT home_order FROM repositories WHERE id = 'r-ahjci'").home_order).toBe(9);
    expect(report.verified).toBe(true);
  });

  it("fails the whole file when a repository moved to another tenant, was recoded, or its tenant changed federation", async () => {
    const changes = [
      "UPDATE repositories SET tenant_id = 't-r' WHERE id = 'r-ahjci'",
      "UPDATE repositories SET code = 'co-ahjci-x' WHERE id = 'r-ahjci'",
      "UPDATE tenants SET federation_id = 'fed-a' WHERE id = 't-r'",
    ];
    for (const change of changes) {
      const db = twin();
      await expect(command(db, { apply: true }, { before: () => db.exec(change) })).rejects.toThrow(/malformed JSON/);
      expect(count(db, "SELECT count(*) AS n FROM vocabulary_values")).toBe(0);
    }
  });

  it("fails the whole file when a held funder was edited in place to the funder planned", async () => {
    const db = twin();
    db.exec("INSERT INTO repository_funders (id, repository_id, name, programme, project_id, position) VALUES ('f-old', 'r-ahjci', 'Other', NULL, 'X 1', 1)");
    await expect(
      command(db, { apply: true }, {
        before: () => db.exec("UPDATE repository_funders SET name = 'University of Michigan', project_id = NULL WHERE id = 'f-old'"),
      }),
    ).rejects.toThrow(/malformed JSON/);
    expect(count(db, "SELECT count(*) AS n FROM repository_funders")).toBe(1);
  });

  it("fails the whole file when a held vocabulary value or authority source was renamed", async () => {
    for (const [seedRow, rename] of [
      [
        "INSERT INTO vocabulary_values (id, federation_id, list, code, created_at, updated_at) VALUES ('v-old', 'fed-a', 'place_type', 'city', 1, 1)",
        "UPDATE vocabulary_values SET code = 'ciudad' WHERE id = 'v-old'",
      ],
      [
        "INSERT INTO authority_sources (id, federation_id, key) VALUES ('s-old', 'fed-a', 'viaf')",
        "UPDATE authority_sources SET key = 'viaf2' WHERE id = 's-old'",
      ],
    ]) {
      const db = twin();
      db.exec(seedRow);
      await expect(command(db, { apply: true }, { before: () => db.exec(rename) })).rejects.toThrow(/malformed JSON/);
    }
  });

  it("fails the whole file when a held funder of a repository with no funder list is deleted", async () => {
    const db = twin();
    const source: InstitutionSource = structuredClone(NEOGRANADINA);
    delete source.repositories["co-ahr"].funders;
    db.exec("INSERT INTO repository_funders (id, repository_id, name, programme, project_id, position) VALUES ('f-ahr', 'r-ahr', 'Someone', NULL, NULL, 1)");
    await expect(
      command(db, { apply: true }, { source, before: () => db.exec("DELETE FROM repository_funders WHERE id = 'f-ahr'") }),
    ).rejects.toThrow(/malformed JSON/);
    expect(one(db, "SELECT home_order FROM repositories WHERE id = 'r-ahr'").home_order).toBeNull();
  });

  it("fails the whole file when a fully seeded federation's values or sources change", async () => {
    for (const change of [
      "UPDATE vocabulary_values SET label_es = 'Otra' WHERE federation_id = 'fed-a' AND list = 'place_type' AND code = 'city'",
      "UPDATE authority_sources SET url_template = 'https://example.org/{id}' WHERE federation_id = 'fed-a' AND key = 'viaf'",
    ]) {
      const db = twin();
      await command(db, { apply: true });
      db.exec("UPDATE repositories SET display_title = NULL WHERE id = 'r-ahjci'");
      await expect(command(db, { apply: true }, { before: () => db.exec(change) })).rejects.toThrow(/malformed JSON/);
      expect(one(db, "SELECT display_title FROM repositories WHERE id = 'r-ahjci'").display_title).toBeNull();
    }
  });

  it("writes the report with verified false when the re-read differs, and the command exits non-zero", async () => {
    const { report, run } = await command(twin(), { apply: true }, { skipApply: true });
    expect(report.applied).toBe(true);
    expect(report.verified).toBe(false);
    const json = [...run.files.entries()].find(([p]) => p.endsWith(".json") && !p.includes("heroes"))![1];
    expect(JSON.parse(json).verified).toBe(false);
    expect(exitCode(report)).toBe(1);
    expect(exitCode({ ...report, verified: true })).toBe(0);
    expect(exitCode({ ...report, applied: false, verified: null })).toBe(0);
  });

  it("reads reproduction_services_en and reports a held value as held where the data file has none", async () => {
    const db = twin();
    db.exec("UPDATE repositories SET reproduction_services_en = 'Held text' WHERE id = 'r-ahjci'");
    const without: InstitutionSource = structuredClone(NEOGRANADINA);
    delete without.repositories["co-ahjci"].reproductionServicesEn;
    const { report } = await command(db, {}, { source: without });
    expect(report.repositories.find((r) => r.code === "co-ahjci")!.fields.find((f) => f.column === "reproduction_services_en"))
      .toMatchObject({ current: "Held text", proposed: null, action: "held" });
    expect(report.gaps.some((g) => g.startsWith("co-ahjci.reproduction_services_en"))).toBe(false);
  });

  it("refuses without migration 0119, though the dry run still plans", async () => {
    const dry = await command(twin(false));
    expect(dry.report.schemaReady).toBe(false);
    expect(dry.report.repositories.find((r) => r.code === "co-ahjci")!.fields.find((f) => f.column === "region"))
      .toMatchObject({ current: null, action: "set" });
    await expect(command(twin(false), { apply: true })).rejects.toThrow(FillStop);
  });
});

describe("--with-heroes", () => {
  const ahjciUrl = `${BASE}/institutions/co-ahjci/hero.jpg`;

  it("refuses to apply hero URLs for objects not found at their public address", async () => {
    await expect(command(twin(), { apply: true, withHeroes: true })).rejects.toThrow(FillStop);
  });

  it("refuses a hero run after a full apply when the objects are not there, instead of reporting nothing to write", async () => {
    const db = twin();
    await command(db, { apply: true });
    await expect(command(db, { apply: true, withHeroes: true })).rejects.toThrow(FillStop);
    expect(one(db, "SELECT hero_image_url FROM repositories WHERE id = 'r-ahjci'").hero_image_url).toBeNull();
  });

  it("writes the hero URL only for an object found with the planned digest", async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const source: InstitutionSource = structuredClone(NEOGRANADINA);
    source.repositories["co-ahjci"].hero.sha256 = createHash("sha256").update(bytes).digest("hex");
    source.repositories["co-ahjci"].hero.size = 3;
    source.repositories["co-ahr"].hero.sha256 = createHash("sha256").update(bytes).digest("hex");
    source.repositories["co-ahr"].hero.size = 3;
    const db = twin();
    const objects = { [ahjciUrl]: bytes, [`${BASE}/institutions/co-ahr/hero.jpg`]: bytes };
    await command(db, { apply: true }, { source });
    const { report } = await command(db, { apply: true, withHeroes: true }, { objects, source });
    expect(report.heroes.find((h) => h.code === "co-ahjci")!.found).toBe("match");
    expect(report.verified).toBe(true);
    expect(one(db, "SELECT hero_image_url FROM repositories WHERE id = 'r-ahjci'").hero_image_url).toBe(ahjciUrl);
  });
});

describe("funders", () => {
  const ARCADIA =
    "INSERT INTO repository_funders (id, repository_id, name, programme, project_id, url, position) " +
    "VALUES ('f-arc', 'r-ahjci', 'Arcadia', 'Endangered Archives Programme', 'EAP 1477', NULL, 1)";

  it("plans the data file's funders, in the order listed, each with its web source and quote", async () => {
    const { report } = await command(twin());
    expect(report.funders.map((f) => [f.code, f.name, f.action, f.position])).toEqual([
      ["co-ahjci", "British Library", "insert", 1],
      ["co-ahjci", "University of Michigan", "insert", 2],
      ["co-ahr", "Alcaldía de Rionegro", "insert", 1],
    ]);
    const bl = report.funders[0];
    expect(bl).toMatchObject({
      programme: "Endangered Archives Programme",
      projectId: "EAP1477",
      url: "https://doi.org/10.15130/EAP1477",
      sourceKind: "web",
      sourceUrl: "https://eap.bl.uk/project/EAP1477",
    });
    expect(report.funders[1].quote).toContain("In partnership with the University of Michigan");
    expect(report.funders.some((f) => /Pennsylvania|Arcadia/.test(f.name))).toBe(false);
    expect(renderReport(report)).toContain("https://eap.bl.uk/project/EAP1477");
    expect(NEOGRANADINA.repositories["co-ahrb"].funders!.map((f) => f.name)).toEqual([
      "University of California, Santa Barbara",
      "Yale University Library Digital Humanities Laboratory",
    ]);
  });

  it("plans the deletion of a held funder not in the data file's list, and reports it", async () => {
    const db = twin();
    db.exec(ARCADIA);
    const { report, lines } = await command(db);
    expect(report.funders.find((f) => f.name === "Arcadia")).toMatchObject({ code: "co-ahjci", action: "delete", id: "f-arc" });
    expect(report.statements.some((s) => /^DELETE FROM repository_funders WHERE id IS 'f-arc'/.test(s))).toBe(true);
    expect(lines).toContain("  delete funder Arcadia from co-ahjci");
    expect(renderReport(report)).toContain("delete funder Arcadia from co-ahjci");
    expect(count(db, "SELECT count(*) AS n FROM repository_funders")).toBe(1);
  });

  it("deletes the funder not listed, inserts the ones listed, and a second run writes nothing", async () => {
    const db = twin();
    db.exec(ARCADIA);
    const first = await command(db, { apply: true });
    expect(first.report.verified).toBe(true);
    expect(db.prepare("SELECT name, position FROM repository_funders WHERE repository_id = 'r-ahjci' ORDER BY position").all()).toEqual([
      { name: "British Library", position: 1 },
      { name: "University of Michigan", position: 2 },
    ]);
    const second = await command(db, { apply: true });
    expect(second.run.applied).toEqual([]);
    expect(second.report.statements).toEqual([]);
    expect(second.report.funders.map((f) => f.action)).toEqual(["unchanged", "unchanged", "unchanged"]);
  });

  it("leaves a held funder that matches a listed one by name", async () => {
    const db = twin();
    db.exec("INSERT INTO repository_funders (id, repository_id, name, programme, project_id, url, position) VALUES ('f-um', 'r-ahjci', 'University of Michigan', NULL, NULL, NULL, 2)");
    const { report } = await command(db, { apply: true });
    expect(report.funders.find((f) => f.name === "University of Michigan")).toMatchObject({ action: "unchanged", id: "f-um" });
    expect(db.prepare("SELECT name, position FROM repository_funders WHERE repository_id = 'r-ahjci' ORDER BY position").all()).toEqual([
      { name: "British Library", position: 1 },
      { name: "University of Michigan", position: 2 },
    ]);
    expect(one(db, "SELECT id FROM repository_funders WHERE name = 'University of Michigan'").id).toBe("f-um");
    expect(report.verified).toBe(true);
  });

  it("leaves the funders of a repository with no funder list in the data file", async () => {
    const db = twin();
    db.exec("INSERT INTO repository_funders (id, repository_id, name, position) VALUES ('f-ahr', 'r-ahr', 'Someone', 1)");
    const source: InstitutionSource = structuredClone(NEOGRANADINA);
    delete source.repositories["co-ahr"].funders;
    const { report } = await command(db, { apply: true }, { source });
    expect(report.funders.some((f) => f.code === "co-ahr")).toBe(false);
    expect(db.prepare("SELECT id FROM repository_funders WHERE repository_id = 'r-ahr'").all()).toEqual([{ id: "f-ahr" }]);
  });

  it("fails the whole file when a funder row is added or deleted between the read and the apply", async () => {
    for (const change of [
      "INSERT INTO repository_funders (id, repository_id, name, position) VALUES ('f-new', 'r-ahjci', 'Late', 3)",
      "DELETE FROM repository_funders WHERE id = 'f-arc'",
    ]) {
      const db = twin();
      db.exec(ARCADIA);
      await expect(command(db, { apply: true }, { before: () => db.exec(change) })).rejects.toThrow(/malformed JSON/);
      expect(count(db, "SELECT count(*) AS n FROM repository_funders WHERE name LIKE 'British Library%'")).toBe(0);
      expect(one(db, "SELECT display_title FROM repositories WHERE id = 'r-ahjci'").display_title).toBeNull();
    }
  });
});

describe("other names", () => {
  const NAMES = ["Istmina Circuit Court Archive", "Juzgado del Distrito de San Juan"];

  it("sets other_names as a JSON list where the column is null", async () => {
    const db = twin();
    const { report } = await command(db, { apply: true });
    const field = report.repositories.find((r) => r.code === "co-ahjci")!.fields.find((f) => f.column === "other_names")!;
    expect(field).toMatchObject({ current: null, proposed: JSON.stringify(NAMES), action: "set" });
    expect(field.source).toContain("https://eap.bl.uk/collection/EAP1477-1");
    expect(JSON.parse(String(one(db, "SELECT other_names FROM repositories WHERE id = 'r-ahjci'").other_names))).toEqual(NAMES);
    expect(one(db, "SELECT other_names FROM repositories WHERE id = 'r-ahr'").other_names).toBeNull();
  });

  it("reports a held value and leaves it", async () => {
    const db = twin();
    db.exec(`UPDATE repositories SET other_names = '["Another name"]' WHERE id = 'r-ahjci'`);
    const { report } = await command(db, { apply: true });
    expect(report.repositories.find((r) => r.code === "co-ahjci")!.fields.find((f) => f.column === "other_names"))
      .toMatchObject({ current: '["Another name"]', action: "differs" });
    expect(one(db, "SELECT other_names FROM repositories WHERE id = 'r-ahjci'").other_names).toBe('["Another name"]');
    expect(report.verified).toBe(true);
  });
});

describe("history", () => {
  const PREVIOUS_ES =
    "Los expedientes de este archivo los produjo el mismo Juzgado del Circuito de Istmina, que todavía los custodia. En la segunda mitad del siglo XIX, el juzgado se llamaba Juzgado del Distrito de San Juan y tenía su sede en Nóvita; era un juzgado de primera instancia y dependía de un tribunal superior con sede en Buga, creado en 1849. En la primera década del siglo XX se trasladó a Istmina, pasó a llamarse Juzgado del Circuito de Istmina y llevó consigo parte de su archivo. Hoy varios juzgados del circuito y municipales que funcionan en el palacio de justicia de Istmina comparten la responsabilidad del archivo.\n\n" +
    "Los expedientes estuvieron amontonados en sacos en el palacio de justicia, sin clasificar, hasta que entre 2021 y 2023 Daniel Varela y Angélica Agualimpia, con permiso del juzgado, los clasificaron por tema y por año en dos series, que hoy ocupan 37 cajas. En 2023 la colección se digitalizó con el proyecto piloto EAP1477, del Endangered Archives Programme de la British Library. Lo dirigió Ann Farnsworth-Alvear, de la Universidad de Pensilvania, en alianza con la Universidad de Michigan, la Fundación Muntú Bantú y la Fundación Histórica Neogranadina, que participó como socia archivística.";
  const PREVIOUS_EN =
    "The Circuit Court of Istmina produced the files in this archive and still holds them. In the second half of the nineteenth century the court was the San Juan District Court (Juzgado del Distrito de San Juan), seated in Nóvita; it was a court of first instance under a higher court in Buga created in 1849. In the first decade of the twentieth century it moved to Istmina, took the name Circuit Court of Istmina, and took part of its archive with it. Today several circuit and municipal courts in the Istmina courthouse share responsibility for the archive.\n\n" +
    "The files lay in sacks in the courthouse, unsorted, until 2021–2023, when Daniel Varela and Angélica Agualimpia, with the court's permission, sorted them by subject and year into two series, now in 37 boxes. In 2023 the collection was digitized in the pilot project EAP1477 of the British Library's Endangered Archives Programme, led by Ann Farnsworth-Alvear of the University of Pennsylvania with the University of Michigan, Fundación Muntú Bantú and Fundación Histórica Neogranadina, its archival partner.";
  const HISTORY_ES = "El Juzgado del Circuito de Istmina produjo los expedientes de este archivo y todavía los custodia. En la segunda mitad del siglo XIX se llamaba Juzgado del Distrito de San Juan y tenía su sede en Nóvita; en la primera década del siglo XX se trasladó a Istmina con parte de su archivo y tomó su nombre actual. Hoy varios juzgados del palacio de justicia de Istmina comparten la responsabilidad del archivo.\n\nLos expedientes estuvieron amontonados en sacos, sin clasificar, hasta que entre 2021 y 2023 Daniel Varela y Angélica Agualimpia los organizaron en dos series, que hoy ocupan 37 cajas. En 2023 se digitalizaron con el proyecto piloto EAP1477 del Endangered Archives Programme de la British Library. Lo dirigió Ann Farnsworth-Alvear, de la Universidad de Pensilvania, en alianza con la Universidad de Michigan, la Fundación Muntú Bantú y la Fundación Histórica Neogranadina como socia archivística.";
  const HISTORY_EN = "The Circuit Court of Istmina produced the files in this archive and still holds them. In the second half of the nineteenth century it was the San Juan District Court (Juzgado del Distrito de San Juan), seated in Nóvita; in the first decade of the twentieth century it moved to Istmina with part of its archive and took its present name. Today several courts in the Istmina courthouse share responsibility for the archive.\n\nThe files lay in sacks, unsorted, until 2021–2023, when Daniel Varela and Angélica Agualimpia arranged them in two series, now in 37 boxes. In 2023 they were digitized in the pilot project EAP1477 of the British Library's Endangered Archives Programme, led by Ann Farnsworth-Alvear of the University of Pennsylvania in partnership with the University of Michigan, Fundación Muntú Bantú and Fundación Histórica Neogranadina as archival partner.";
  const quoted = (t: string) => `'${t.replace(/'/g, "''")}'`;

  it("plans co-ahjci's history in both languages, byte for byte, and writes it where the column is null", async () => {
    const db = twin();
    const { report } = await command(db, { apply: true });
    const sql = report.statements.join("\n");
    expect(sql).toContain(`history_es = ${quoted(HISTORY_ES)}`);
    expect(sql).toContain(`history_en = ${quoted(HISTORY_EN)}`);
    expect(HISTORY_ES.split("\n\n")).toHaveLength(2);
    const fields = report.repositories.find((r) => r.code === "co-ahjci")!.fields;
    expect(fields.find((f) => f.column === "history_es")!.source).toContain("eap.bl.uk/collection/EAP1477-1");
    expect(one(db, "SELECT history_es, history_en FROM repositories WHERE id = 'r-ahjci'")).toEqual({ history_es: HISTORY_ES, history_en: HISTORY_EN });
    expect(one(db, "SELECT history_es FROM repositories WHERE id = 'r-ahr'").history_es).toBe(NEOGRANADINA.repositories["co-ahr"].historyEs!.value);
  });

  it("reports a held history and leaves it", async () => {
    const db = twin();
    db.exec("UPDATE repositories SET history_en = 'Held.' WHERE id = 'r-ahjci'");
    const { report } = await command(db, { apply: true });
    const fields = report.repositories.find((r) => r.code === "co-ahjci")!.fields;
    expect(fields.find((f) => f.column === "history_en")).toMatchObject({ current: "Held.", action: "differs" });
    expect(fields.find((f) => f.column === "history_es")).toMatchObject({ current: null, action: "set" });
    expect(one(db, "SELECT history_en FROM repositories WHERE id = 'r-ahjci'").history_en).toBe("Held.");
    expect(report.verified).toBe(true);
  });
  it("names the approved history and the exact previous text it replaces in the data file", () => {
    const r = NEOGRANADINA.repositories["co-ahjci"];
    expect(r.historyEs).toEqual({ value: HISTORY_ES, replaces: PREVIOUS_ES, source: "https://eap.bl.uk/collection/EAP1477-1; https://eap.bl.uk/project/EAP1477; text approved 2026-11-03" });
    expect(r.historyEn).toEqual({ value: HISTORY_EN, replaces: PREVIOUS_EN, source: "https://eap.bl.uk/collection/EAP1477-1; https://eap.bl.uk/project/EAP1477; text approved 2026-11-03" });
    for (const t of [HISTORY_ES, HISTORY_EN]) {
      expect(t.split("\n\n")).toHaveLength(2);
      expect(t).not.toMatch(/\r|\n\n\n|\n$/);
    }
  });

  it("replaces a held history only when it equals the previous text exactly, guarded in SQL on that text", async () => {
    const db = twin();
    db.prepare("UPDATE repositories SET history_es = ?, history_en = ? WHERE id = 'r-ahjci'").run(PREVIOUS_ES, PREVIOUS_EN);
    const { report, lines } = await command(db, { apply: true });
    const fields = report.repositories.find((r) => r.code === "co-ahjci")!.fields;
    expect(fields.find((f) => f.column === "history_es")).toMatchObject({ current: PREVIOUS_ES, proposed: HISTORY_ES, action: "replace" });
    expect(fields.find((f) => f.column === "history_en")).toMatchObject({ current: PREVIOUS_EN, proposed: HISTORY_EN, action: "replace" });
    const update = report.statements.find((s) => s.startsWith("UPDATE repositories") && s.includes("'r-ahjci'"))!;
    expect(update).toContain(`history_es = ${quoted(HISTORY_ES)}`);
    expect(update).toContain(`AND history_es = ${quoted(PREVIOUS_ES)}`);
    expect(update).toContain(`AND history_en = ${quoted(PREVIOUS_EN)}`);
    expect(update).not.toContain("(history_es IS NULL");
    expect(lines.some((l) => l.startsWith("  co-ahjci:") && l.includes("replace history_es, history_en"))).toBe(true);
    expect(renderReport(report)).toMatch(/\| history_es \| .* \| replace \|/);
    expect(one(db, "SELECT history_es, history_en FROM repositories WHERE id = 'r-ahjci'")).toEqual({ history_es: HISTORY_ES, history_en: HISTORY_EN });
    expect(report.verified).toBe(true);
    const second = await command(db, { apply: true });
    expect(second.run.applied).toEqual([]);
    expect(second.report.repositories.find((r) => r.code === "co-ahjci")!.fields.find((f) => f.column === "history_es")!.action).toBe("unchanged");
  });

  it("refuses the replacement when the held history is any other text, and reports it untouched", async () => {
    const db = twin();
    const edited = PREVIOUS_ES.replace("37 cajas", "38 cajas");
    db.prepare("UPDATE repositories SET history_es = ?, history_en = ? WHERE id = 'r-ahjci'").run(edited, PREVIOUS_EN + " ");
    const { report } = await command(db, { apply: true });
    const fields = report.repositories.find((r) => r.code === "co-ahjci")!.fields;
    expect(fields.find((f) => f.column === "history_es")).toMatchObject({ current: edited, proposed: HISTORY_ES, action: "differs" });
    expect(fields.find((f) => f.column === "history_en")).toMatchObject({ current: PREVIOUS_EN + " ", action: "differs" });
    expect(report.statements.join("\n")).not.toContain(quoted(HISTORY_ES));
    expect(one(db, "SELECT history_es, history_en FROM repositories WHERE id = 'r-ahjci'")).toEqual({ history_es: edited, history_en: PREVIOUS_EN + " " });
    expect(report.verified).toBe(true);
  });

  it("fails the whole file when the held history changes between the read and the apply", async () => {
    for (const change of [
      "UPDATE repositories SET history_es = history_es || '.' WHERE id = 'r-ahjci'",
      "UPDATE repositories SET history_en = NULL WHERE id = 'r-ahjci'",
    ]) {
      const db = twin();
      db.prepare("UPDATE repositories SET history_es = ?, history_en = ? WHERE id = 'r-ahjci'").run(PREVIOUS_ES, PREVIOUS_EN);
      await expect(command(db, { apply: true }, { before: () => db.exec(change) })).rejects.toThrow(/malformed JSON/);
      expect(one(db, "SELECT display_title FROM repositories WHERE id = 'r-ahjci'").display_title).toBeNull();
      expect(String(one(db, "SELECT history_es FROM repositories WHERE id = 'r-ahjci'").history_es).startsWith(PREVIOUS_ES)).toBe(true);
    }
  });

  it("guards the replacing UPDATE itself on the exact held text", async () => {
    const db = twin();
    db.prepare("UPDATE repositories SET history_es = ?, history_en = ? WHERE id = 'r-ahjci'").run(PREVIOUS_ES, PREVIOUS_EN);
    const { report } = await command(db);
    const update = report.statements.find((s) => s.startsWith("UPDATE repositories") && s.includes("'r-ahjci'"))!;
    db.prepare("UPDATE repositories SET history_es = ? WHERE id = 'r-ahjci'").run("Otro texto.");
    db.exec(update);
    expect(one(db, "SELECT history_es FROM repositories WHERE id = 'r-ahjci'").history_es).toBe("Otro texto.");
  });
});

describe("repository facts", () => {
  const UNICAUCA = "https://www.unicauca.edu.co/vicerrectoria-academica/facultad-de-ciencias-humanas-y-sociales/archivo-historico/";
  const BNP_ACCESS =
    "Solo necesita acercarse a nuestra sede en horario de atención y dirigirse a la Sala de Atención al Usuario portando su Documento Nacional de Identidad (DNI).\n\n" +
    "Usuario investigador: Debe apersonarse a la Sala de Atención al Usuario portando su DNI y una carta de presentación de su centro de estudios o centro laboral, membretada y firmada, que lo avale como investigador.";

  /** The approved values, column by column, for each repository. */
  const FACTS: Record<string, Record<string, string>> = {
    "co-ahr": {
      short_name: "AHR",
      website: "https://rionegro.gov.co/publicaciones/539/archivo-historico-de-rionegro/",
    },
    "co-ahrb": { short_name: "AHRB" },
    "co-cihjml": {
      other_names: JSON.stringify(["Archivo Central del Cauca"]),
      address: "Calle 3 No 5 – 38",
      email: "archivoh@unicauca.edu.co",
      website: UNICAUCA,
      access_conditions_es: "Previo diligenciamiento del formato de inscripción y aceptación del reglamento interno.",
    },
    "pe-bn": {
      short_name: "BNP",
      institution_type: "organismo público ejecutor adscrito al Ministerio de Cultura",
      address: "Av. De La Poesía 160, San Borja",
      telephone: "(511) 513-6900 - Anexo 7000",
      website: "https://www.bnp.gob.pe",
      opening_times_es: "Lunes a Sábado: 8:30 a.m. - 8:00 p.m.",
      access_conditions_es: BNP_ACCESS,
    },
  };

  /** The twin with all five repositories, their short name, address and website blank as production holds them. */
  function full(): DatabaseSync {
    const db = twin();
    db.exec("UPDATE repositories SET short_name = '', address = '', website = '' WHERE id = 'r-ahr'");
    repo(db, "r-ahrb", "t-n", "co-ahrb", { short_name: "", address: "", website: "" });
    repo(db, "r-cihjml", "t-n", "co-cihjml", { short_name: "CIHJML", address: "  ", website: "" });
    repo(db, "r-bn", "t-n", "pe-bn", { short_name: "", address: "", website: "" });
    return db;
  }
  const fieldOf = (report: Awaited<ReturnType<typeof command>>["report"], code: string, column: string) =>
    report.repositories.find((r) => r.code === code)!.fields.find((f) => f.column === column);

  it("checks that every column the fill writes exists in the schema", () => {
    const columns = Object.values(getTableConfig(repositories).columns).map((c) => c.name);
    for (const facts of Object.values(FACTS)) for (const c of Object.keys(facts)) expect(columns).toContain(c);
  });

  it("plans each approved value, with its source, and applies it; a second run writes nothing", async () => {
    const db = full();
    const first = await command(db, { apply: true });
    expect(first.report.verified).toBe(true);
    for (const [code, facts] of Object.entries(FACTS)) {
      for (const [column, value] of Object.entries(facts)) {
        expect(fieldOf(first.report, code, column), `${code}.${column}`).toMatchObject({ proposed: value, action: "set" });
        expect(fieldOf(first.report, code, column)!.source).toMatch(/^https:\/\//);
        const id = String((db.prepare("SELECT id FROM repositories WHERE code = ?").get(code) as Record<string, unknown>).id);
        expect(one(db, `SELECT ${column} AS v FROM repositories WHERE id = '${id}'`).v, `${code}.${column}`).toBe(value);
      }
    }
    expect(fieldOf(first.report, "co-ahr", "website")!.source).toBe(
      "https://rionegro.gov.co/publicaciones/539/archivo-historico-de-rionegro/ (page itself, published 26/06/2024)",
    );
    expect(fieldOf(first.report, "co-ahjci", "short_name")).toBeUndefined();
    expect(fieldOf(first.report, "co-ahr", "opening_times_es")).toBeUndefined();
    expect(fieldOf(first.report, "co-ahr", "access_conditions_es")).toBeUndefined();

    const second = await command(db, { apply: true });
    expect(second.run.applied).toEqual([]);
    expect(second.report.statements).toEqual([]);
  });

  it("stores BNP's two paragraphs of access conditions byte for byte", async () => {
    const db = full();
    const { report } = await command(db, { apply: true });
    expect(NEOGRANADINA.repositories["pe-bn"].accessConditionsEs!.value).toBe(BNP_ACCESS);
    expect(BNP_ACCESS.split("\n\n")).toHaveLength(2);
    expect(BNP_ACCESS).not.toMatch(/\r|\n\n\n/);
    expect(report.statements.join("\n")).toContain(`access_conditions_es = '${BNP_ACCESS}'`);
    expect(one(db, "SELECT access_conditions_es AS v FROM repositories WHERE id = 'r-bn'").v).toBe(BNP_ACCESS);
  });

  it("writes co-cihjml's address with its en dash", () => {
    expect(NEOGRANADINA.repositories["co-cihjml"].address!.value).toBe("Calle 3 No 5 – 38");
  });

  it("treats a NULL, empty or whitespace-only column as empty, and guards the update on either", async () => {
    const db = full();
    db.exec("UPDATE repositories SET short_name = NULL WHERE id = 'r-ahrb'");
    const { report } = await command(db, { apply: true });
    expect(fieldOf(report, "co-ahrb", "short_name")).toMatchObject({ current: null, action: "set" });
    expect(fieldOf(report, "pe-bn", "short_name")).toMatchObject({ current: "", action: "set" });
    expect(fieldOf(report, "co-cihjml", "address")).toMatchObject({ current: "  ", action: "set" });
    expect(fieldOf(report, "co-ahr", "website")).toMatchObject({ current: "", action: "set" });
    const update = report.statements.find((s) => s.startsWith("UPDATE repositories") && s.includes("'r-bn'"))!;
    expect(update).toContain("(short_name IS NULL OR trim(short_name, char(32, 9, 10, 13)) = '')");
    expect(update).toContain("(website IS NULL OR trim(website, char(32, 9, 10, 13)) = '')");
    expect(one(db, "SELECT short_name, website FROM repositories WHERE id = 'r-ahrb'")).toEqual({ short_name: "AHRB", website: "" });
  });

  it("reports a non-blank held short name or website and leaves it", async () => {
    const db = full();
    db.exec("UPDATE repositories SET short_name = 'Rionegro', website = 'https://example.org/ahr' WHERE id = 'r-ahr'");
    const { report } = await command(db, { apply: true });
    expect(fieldOf(report, "co-ahr", "short_name")).toMatchObject({ current: "Rionegro", proposed: "AHR", action: "differs" });
    expect(fieldOf(report, "co-ahr", "website")).toMatchObject({ current: "https://example.org/ahr", action: "differs" });
    expect(fieldOf(report, "co-cihjml", "short_name")).toBeUndefined();
    expect(one(db, "SELECT short_name, website FROM repositories WHERE id = 'r-ahr'")).toEqual({ short_name: "Rionegro", website: "https://example.org/ahr" });
    expect(one(db, "SELECT short_name FROM repositories WHERE id = 'r-cihjml'").short_name).toBe("CIHJML");
    expect(report.statements.join("\n")).not.toContain("'AHR'");
    expect(report.verified).toBe(true);
  });

  it("sets a blank publisher email on the federation", async () => {
    const db = full();
    db.exec("UPDATE federations SET publisher_email = '' WHERE id = 'fed-n'");
    const { report } = await command(db, { apply: true });
    expect(report.federationFields[0]).toMatchObject({ current: "", action: "set" });
    expect(one(db, "SELECT publisher_email FROM federations WHERE id = 'fed-n'").publisher_email).toBe("contacto@neogranadina.org");
  });

  for (const [label, change] of [
    ["a blank short name is filled", "UPDATE repositories SET short_name = 'Other' WHERE id = 'r-bn'"],
    ["a NULL telephone is filled", "UPDATE repositories SET telephone = '1' WHERE id = 'r-bn'"],
    ["a blank website is filled", "UPDATE repositories SET website = 'https://example.org' WHERE id = 'r-ahr'"],
    ["a NULL email is filled", "UPDATE repositories SET email = 'x@example.org' WHERE id = 'r-cihjml'"],
    ["a held short name is blanked", "UPDATE repositories SET short_name = '' WHERE id = 'r-cihjml'"],
  ] as const) {
    it(`fails the whole file when ${label} between the read and the apply`, async () => {
      const db = full();
      await expect(command(db, { apply: true }, { before: () => db.exec(change) })).rejects.toThrow(/malformed JSON/);
      expect(one(db, "SELECT institution_type FROM repositories WHERE id = 'r-bn'").institution_type).toBeNull();
      expect(one(db, "SELECT display_title FROM repositories WHERE id = 'r-ahjci'").display_title).toBeNull();
      expect(count(db, "SELECT count(*) AS n FROM vocabulary_values")).toBe(0);
    });
  }

  it("stops on any of the new values without a source", () => {
    const fields = ["shortName", "otherNames", "institutionType", "address", "email", "website", "telephone", "openingTimesEs", "accessConditionsEs"] as const;
    let checked = 0;
    for (const [code, r] of Object.entries(NEOGRANADINA.repositories)) {
      for (const f of fields) {
        if (!r[f]) continue;
        const bad: InstitutionSource = structuredClone(NEOGRANADINA);
        (bad.repositories[code][f] as { source: string }).source = " ";
        expect(() => validateSources(bad), `${code}.${f}`).toThrow(new RegExp(`${code}\\.${f}\\b`));
        checked++;
      }
    }
    expect(checked).toBe(16);
  });
});

describe("credit statements, histories and the 2026-11-03 funders", () => {
  const CREDIT_SOURCE = "approved text 2026-11-03, from neogranadina.org project pages and eap.bl.uk/project/EAP1477";
  /** pe-bn's statements name the project as the ruling of 2026-11-03 does; the others are the approved text. */
  const creditSource = (code: string) =>
    code === "pe-bn" ? `ruling 2026-11-03, on attribution (the project named as in the subtitle); the rest ${CREDIT_SOURCE}` : CREDIT_SOURCE;
  /** The approved credit statements, Spanish and English, byte for byte. */
  const CREDITS: Record<string, [string, string]> = {
    "co-ahjci": [
      "Digitalizado en el proyecto EAP1477 del Endangered Archives Programme de la British Library, con el apoyo de la University of Michigan. Neogranadina participó como socia archivística.",
      "Digitized in project EAP1477 of the British Library's Endangered Archives Programme, with support from the University of Michigan. Neogranadina took part as archival partner.",
    ],
    "co-ahr": [
      "Digitalizado en alianza con Neogranadina, con el apoyo de la Alcaldía de Rionegro.",
      "Digitized in partnership with Neogranadina, with support from the Alcaldía de Rionegro.",
    ],
    "co-ahrb": [
      "Digitalizado en alianza con Neogranadina, con el apoyo de la Universidad de California, Santa Bárbara, y del Yale University Library Digital Humanities Laboratory.",
      "Digitized in partnership with Neogranadina, with support from the University of California, Santa Barbara, and the Yale University Library Digital Humanities Laboratory.",
    ],
    "co-cihjml": [
      "Digitalizado en alianza con Neogranadina.",
      "Digitized in partnership with Neogranadina.",
    ],
    "pe-bn": [
      "Digitalizado por la Biblioteca Nacional del Perú. Neogranadina dirigió la catalogación colaborativa de la colección y la publicó en línea, en el marco del proyecto \"Narra la Independencia desde tu pueblo, tu distrito o tu ciudad\", que contó con el apoyo de la Universidad de California, Santa Bárbara; del Instituto Francés de Estudios Andinos; del Instituto de Estudios Peruanos; de la Universidad de París III Sorbonne-Nouvelle; de la Universidad Nacional San Cristóbal de Huamanga, y de la Universidad Nacional Mayor de San Marcos.",
      "Digitized by the Biblioteca Nacional del Perú. Neogranadina led the collaborative cataloging of the collection and published it online, as part of the project \"Narra la Independencia desde tu pueblo, tu distrito o tu ciudad\", which was supported by the University of California, Santa Barbara; the Instituto Francés de Estudios Andinos; the Instituto de Estudios Peruanos; the Université Paris III Sorbonne-Nouvelle; the Universidad Nacional San Cristóbal de Huamanga; and the Universidad Nacional Mayor de San Marcos.",
    ],
  };
  /**
   * The approved histories of the four repositories that hold none, with their sources, byte for byte;
   * pe-bn's names the project as the subtitle does and replaces the text that named it "del Perú".
   */
  const HISTORIES: Record<string, { es: string; en: string; source: string; replaces?: true }> = {
    "pe-bn": {
      es: "La Biblioteca Nacional del Perú es un organismo público ejecutor adscrito al Ministerio de Cultura. Se rige por la Ley 30570 y es el ente rector del Sistema Nacional de Bibliotecas. Es el centro depositario del patrimonio cultural bibliográfico, digital, documental, fílmico, fotográfico y musical del Perú.\n\nLa Biblioteca digitalizó la totalidad de la Colección documental del sesquicentenario de la independencia del Perú, que reúne documentos de los siglos XVIII al XX: legislación, informes oficiales, periódicos, manifiestos, correspondencia, memorias, relatos y obras literarias. En el proyecto \"Narra la Independencia desde tu pueblo, tu distrito o tu ciudad\", Neogranadina dirigió la catalogación colaborativa de la colección, con más de 30 voluntarios y estudiantes, e integró los 14.374 documentos a su plataforma en línea.",
      en: "The Biblioteca Nacional del Perú is a public executing agency attached to the Ministry of Culture. It is governed by Law 30570 and heads the National Library System. It is the repository of Peru's bibliographic, digital, documentary, film, photographic and musical cultural heritage.\n\nThe Library digitized the whole of the Colección documental del sesquicentenario de la independencia del Perú, which gathers records from the eighteenth to the twentieth century: legislation, official reports, newspapers, manifestos, correspondence, memoirs, accounts and literary works. In the project \"Narra la Independencia desde tu pueblo, tu distrito o tu ciudad\", Neogranadina led the collaborative cataloging of the collection, with more than 30 volunteers and students, and added its 14,374 documents to its online platform.",
      source:
        "ruling 2026-11-06 (the project named as in the subtitle); the rest https://www.bnp.gob.pe/institucion/quienes-somos/; https://neogranadina.org/proyectos/narra/; text approved 2026-11-03",
      replaces: true,
    },
    "co-ahr": {
      es: "El Archivo Histórico de Rionegro conserva documentos de 1649 a 1967 sobre la localidad y el Oriente Antioqueño. Tiene su origen en el archivo del cabildo, organizado en 1786 con el traslado de la ciudad de Arma a Rionegro. En la década de 1970 lo trasladaron al Museo Histórico Casa de la Convención, donde se encuentra hoy. Entre finales de los años ochenta y comienzos de los noventa, la Fundación Antioqueña para los Estudios Sociales lo organizó en cuatro fondos. El Concejo Municipal lo creó como institución en 1994, mediante el Acuerdo 073, y en 2020 el Archivo General de la Nación lo declaró Bien de Interés Cultural de Carácter Documental Archivístico del ámbito nacional. Hoy lo custodia la Subsecretaría de Cultura del municipio.\n\nDesde 2022, el archivo trabaja en alianza con Neogranadina para digitalizar y publicar en acceso abierto todas sus colecciones manuscritas y de prensa. El equipo del archivo ya digitalizó todo el fondo Notarial.",
      en: "The Archivo Histórico de Rionegro holds records from 1649 to 1967 on the town and the east of Antioquia. It originated in the town council's archive, organized in 1786 when the city of Arma was moved to Rionegro. In the 1970s it was moved to the Museo Histórico Casa de la Convención, where it remains. Between the late 1980s and the early 1990s, the Fundación Antioqueña para los Estudios Sociales arranged it in four fonds. The municipal council established it as an institution in 1994, by Acuerdo 073, and in 2020 the Archivo General de la Nación declared it a Bien de Interés Cultural de Carácter Documental Archivístico of national scope. Today the municipality's Subsecretaría de Cultura holds it.\n\nSince 2022 the archive has worked in partnership with Neogranadina to digitize and publish in open access all its manuscript and newspaper collections. The archive's team has already digitized the whole Notarial fonds.",
      source: "https://rionegro.gov.co/publicaciones/539/archivo-historico-de-rionegro/; https://neogranadina.org/proyectos/archivo-historico-de-rionegro/; text approved 2026-11-03",
    },
    "co-ahrb": {
      es: "El Archivo Histórico Regional de Boyacá, en Tunja, custodia una de las colecciones de documentos administrativos y notariales coloniales más completas de América Latina.\n\nEntre 2015 y 2018, el archivo digitalizó, en alianza con Neogranadina, más de 580 legajos, que suman unas 420.000 imágenes. Neogranadina diseñó e instaló el escáner y formó a un operario para manejarlo. Como la mayor parte del material carecía de descripciones archivísticas, se emprendió un programa de catalogación colaborativa, y los catálogos, los metadatos y las imágenes se publican en línea.",
      en: "The Archivo Histórico Regional de Boyacá, in Tunja, holds one of the most complete collections of colonial administrative and notarial records in Latin America.\n\nBetween 2015 and 2018 the archive digitized, in partnership with Neogranadina, more than 580 bundles, some 420,000 images. Neogranadina designed and installed the scanner and trained an operator to run it. As most of the material had no archival descriptions, a collaborative cataloging program was undertaken, and the catalogs, metadata and images are published online.",
      source: "https://neogranadina.org/proyectos/archivo-historico-regional-de-boyaca/; text approved 2026-11-03",
    },
    "co-cihjml": {
      es: "El Centro de Investigaciones Históricas José María Arboleda Llorente, también conocido por su antiguo nombre, Archivo Central del Cauca, se constituyó en 1970 y está adscrito a la Facultad de Ciencias Humanas y Sociales de la Universidad del Cauca, en Popayán. Custodia una de las colecciones documentales más ricas de Colombia. Entre los siglos XVI y XIX, Popayán fue un núcleo administrativo importante en la consolidación del imperio español en el norte de Suramérica.\n\nEntre 2015 y 2019, el Centro digitalizó parte de su colección en alianza con Neogranadina, que diseñó e instaló el escáner y formó a un operario para manejarlo. Hoy pueden consultarse en línea más de 1.800 documentos digitalizados. Además, se sistematizaron y publicaron en línea 26.343 registros de catálogo.",
      en: "The Centro de Investigaciones Históricas José María Arboleda Llorente, also known by its former name, Archivo Central del Cauca, was established in 1970 and belongs to the Facultad de Ciencias Humanas y Sociales of the Universidad del Cauca, in Popayán. It holds one of the richest documentary collections in Colombia. Between the sixteenth and nineteenth centuries, Popayán was an important administrative center in the consolidation of the Spanish empire in northern South America.\n\nBetween 2015 and 2019 the Centro digitized part of its collection in partnership with Neogranadina, which designed and installed the scanner and trained an operator to run it. More than 1,800 digitized documents can now be consulted online, and 26,343 catalog records were systematized and published online.",
      source: "https://neogranadina.org/proyectos/archivo-central-del-cauca/; https://www.unicauca.edu.co/vicerrectoria-academica/facultad-de-ciencias-humanas-y-sociales/archivo-historico/; text approved 2026-11-03",
    },
  };
  const NARRA = "Narra la Independencia desde tu pueblo, tu distrito o tu ciudad";
  const NARRA_PREVIOUS = "Narra la Independencia del Perú desde tu pueblo, tu distrito o tu ciudad";
  const quoted = (t: string) => `'${t.replace(/'/g, "''")}'`;
  const ID: Record<string, string> = { "co-ahjci": "r-ahjci", "co-ahr": "r-ahr", "co-ahrb": "r-ahrb", "co-cihjml": "r-cihjml", "pe-bn": "r-bn" };

  /** The twin with all five repositories. */
  function five(with0121 = true): DatabaseSync {
    const db = twin(true, true, with0121, true);
    repo(db, "r-ahrb", "t-n", "co-ahrb");
    repo(db, "r-cihjml", "t-n", "co-cihjml");
    repo(db, "r-bn", "t-n", "pe-bn");
    return db;
  }
  const fieldOf = (report: Awaited<ReturnType<typeof command>>["report"], code: string, column: string) =>
    report.repositories.find((r) => r.code === code)!.fields.find((f) => f.column === column);

  it("holds the approved values in the data file", () => {
    for (const [code, [es, en]] of Object.entries(CREDITS)) {
      const r = NEOGRANADINA.repositories[code];
      expect(r.creditStatementEs, code).toMatchObject({ value: es, source: creditSource(code) });
      expect(r.creditStatementEn, code).toMatchObject({ value: en, source: creditSource(code) });
    }
    expect(CREDITS["pe-bn"][0]).toContain('proyecto "Narra la Independencia desde tu pueblo');
    for (const [code, h] of Object.entries(HISTORIES)) {
      const r = NEOGRANADINA.repositories[code];
      const previous = (t: string) => (h.replaces ? { replaces: t.replace(NARRA, NARRA_PREVIOUS) } : {});
      expect(r.historyEs, code).toEqual({ value: h.es, source: h.source, ...previous(h.es) });
      expect(r.historyEn, code).toEqual({ value: h.en, source: h.source, ...previous(h.en) });
      for (const t of [h.es, h.en]) {
        expect(t.split("\n\n"), code).toHaveLength(2);
        expect(t, code).not.toMatch(/\r|\n\n\n|\n$|^\s|\s$/);
      }
    }
  });

  it("plans and writes every credit statement and history byte for byte; a second run writes nothing", async () => {
    const db = five();
    const first = await command(db, { apply: true });
    expect(first.report.verified).toBe(true);
    const sql = first.report.statements.join("\n");
    for (const [code, [es, en]] of Object.entries(CREDITS)) {
      expect(fieldOf(first.report, code, "credit_statement_es"), code).toMatchObject({ current: null, proposed: es, action: "set", source: creditSource(code) });
      expect(fieldOf(first.report, code, "credit_statement_en"), code).toMatchObject({ current: null, proposed: en, action: "set", source: creditSource(code) });
      expect(sql).toContain(`credit_statement_es = ${quoted(es)}`);
      expect(sql).toContain(`credit_statement_en = ${quoted(en)}`);
      expect(one(db, `SELECT credit_statement_es AS es, credit_statement_en AS en FROM repositories WHERE id = '${ID[code]}'`)).toEqual({ es, en });
    }
    for (const [code, h] of Object.entries(HISTORIES)) {
      expect(fieldOf(first.report, code, "history_es"), code).toMatchObject({ current: null, proposed: h.es, action: "set", source: h.source });
      expect(fieldOf(first.report, code, "history_en"), code).toMatchObject({ current: null, proposed: h.en, action: "set", source: h.source });
      expect(one(db, `SELECT history_es AS es, history_en AS en FROM repositories WHERE id = '${ID[code]}'`)).toEqual({ es: h.es, en: h.en });
    }
    const second = await command(db, { apply: true });
    expect(second.run.applied).toEqual([]);
    expect(second.report.statements).toEqual([]);
    for (const code of Object.keys(CREDITS)) {
      expect(fieldOf(second.report, code, "credit_statement_es")!.action).toBe("unchanged");
    }
  });

  it("reports a held credit statement and leaves it", async () => {
    const db = five();
    db.exec("UPDATE repositories SET credit_statement_en = 'Held.' WHERE id = 'r-ahr'");
    const { report } = await command(db, { apply: true });
    expect(fieldOf(report, "co-ahr", "credit_statement_en")).toMatchObject({ current: "Held.", action: "differs" });
    expect(one(db, "SELECT credit_statement_en AS v FROM repositories WHERE id = 'r-ahr'").v).toBe("Held.");
    expect(report.verified).toBe(true);
  });

  it("inserts the funders of co-cihjml and pe-bn in the order listed, each with its page and quote", async () => {
    const db = five();
    const { report } = await command(db, { apply: true });
    const planned = (code: string) => report.funders.filter((f) => f.code === code).map((f) => [f.name, f.action, f.position, f.sourceKind, f.sourceUrl, f.quote]);
    expect(planned("co-cihjml")).toEqual([
      ["Universidad del Cauca", "insert", 1, "web", "https://neogranadina.org/proyectos/archivo-central-del-cauca/", "Con el apoyo de"],
      ["Fundación Histórica Neogranadina", "insert", 2, "web", "https://neogranadina.org/proyectos/archivo-central-del-cauca/", "Con el apoyo de"],
    ]);
    const narra = [
      "Universidad de California, Santa Bárbara",
      "Instituto Francés de Estudios Andinos",
      "Instituto de Estudios Peruanos",
      "Universidad de París III Sorbonne-Nouvelle",
      "Universidad Nacional San Cristóbal de Huamanga",
      "Universidad Nacional Mayor de San Marcos",
    ];
    expect(planned("pe-bn")).toEqual(narra.map((n, i) => [n, "insert", i + 1, "web", "https://neogranadina.org/proyectos/narra/", "PATROCINADORES"]));
    for (const code of ["co-cihjml", "pe-bn"]) {
      for (const f of NEOGRANADINA.repositories[code].funders!) {
        expect(f.kind === "web" && f.ruling, `${code} ${f.name}`).toBe("confirmed as funders 2026-11-03");
      }
    }
    expect(db.prepare("SELECT name, position FROM repository_funders WHERE repository_id = 'r-bn' ORDER BY position").all())
      .toEqual(narra.map((name, i) => ({ name, position: i + 1 })));
    expect(db.prepare("SELECT name FROM repository_funders WHERE repository_id = 'r-cihjml' ORDER BY position").all())
      .toEqual([{ name: "Universidad del Cauca" }, { name: "Fundación Histórica Neogranadina" }]);
    const second = await command(db, { apply: true });
    expect(second.run.applied).toEqual([]);
  });

  it("treats the new funder lists as the whole set: a held funder not listed is deleted", async () => {
    const db = five();
    db.exec("INSERT INTO repository_funders (id, repository_id, name, position) VALUES ('f-old', 'r-bn', 'Someone else', 1)");
    const { report } = await command(db, { apply: true });
    expect(report.funders.find((f) => f.name === "Someone else")).toMatchObject({ code: "pe-bn", action: "delete" });
    expect(count(db, "SELECT count(*) AS n FROM repository_funders WHERE id = 'f-old'")).toBe(0);
  });

  it("without migration 0121, plans the credit statements in the dry run and refuses --apply", async () => {
    const dry = await command(five(false));
    expect(dry.report.schemaReady).toBe(false);
    expect(dry.report.missingSchema).toEqual(["repositories.credit_statement_es", "repositories.credit_statement_en"]);
    expect(fieldOf(dry.report, "pe-bn", "credit_statement_es")).toMatchObject({ current: null, proposed: CREDITS["pe-bn"][0], action: "set" });
    expect(dry.lines.some((l) => l.includes("repositories.credit_statement_es"))).toBe(true);
    expect(renderReport(dry.report)).toContain("repositories.credit_statement_en");
    const db = five(false);
    await expect(command(db, { apply: true })).rejects.toThrow(/0121/);
    expect(one(db, "SELECT display_title FROM repositories WHERE id = 'r-bn'").display_title).toBeNull();
  });

  it("stops on a credit statement without a source", () => {
    const bad: InstitutionSource = structuredClone(NEOGRANADINA);
    bad.repositories["co-ahr"].creditStatementEn!.source = "";
    expect(() => validateSources(bad)).toThrow(/co-ahr\.creditStatementEn\b/);
  });
});

describe("the wording rulings of 2026-11-03", () => {
  const RULING_SOURCE = /ruling 2026-11-03/;
  /** The texts production holds, byte for byte, and the ruled texts that replace them. */
  const SUBTITLES: Record<string, [string, string]> = {
    "co-ahr": [
      "Catálogos y materiales digitalizados por Neogranadina en el Archivo Histórico de Rionegro, Antioquia, Colombia.",
      "Catálogos y materiales digitalizados en alianza con Neogranadina en el Archivo Histórico de Rionegro, Antioquia, Colombia.",
    ],
    "co-ahrb": [
      "Materiales digitalizados por Neogranadina en el Archivo Histórico Regional de Boyacá, Tunja, Colombia.",
      "Materiales digitalizados en alianza con Neogranadina en el Archivo Histórico Regional de Boyacá, Tunja, Colombia.",
    ],
    "co-cihjml": [
      "Catálogos y materiales digitalizados por Neogranadina en el fondo Antiguo Archivo Central del Cauca, del Centro de Investigaciones Históricas José María Arboleda Llorente, Popayán, Colombia.",
      "Catálogos y materiales digitalizados en alianza con Neogranadina en el fondo Antiguo Archivo Central del Cauca, del Centro de Investigaciones Históricas José María Arboleda Llorente, Popayán, Colombia.",
    ],
  };
  const BN_CREDIT_ES_PREVIOUS =
    "Digitalizado por la Biblioteca Nacional del Perú. Neogranadina dirigió la catalogación colaborativa de la colección y la publicó en línea, en el marco del proyecto \"Narra la Independencia del Perú desde tu pueblo, tu distrito o tu ciudad\", que contó con el apoyo de la Universidad de California, Santa Bárbara; del Instituto Francés de Estudios Andinos; del Instituto de Estudios Peruanos; de la Universidad de París III Sorbonne-Nouvelle; de la Universidad Nacional San Cristóbal de Huamanga, y de la Universidad Nacional Mayor de San Marcos.";
  const BN_CREDIT_EN_PREVIOUS =
    "Digitized by the Biblioteca Nacional del Perú. Neogranadina led the collaborative cataloging of the collection and published it online, as part of the project \"Narra la Independencia del Perú desde tu pueblo, tu distrito o tu ciudad\", which was supported by the University of California, Santa Barbara; the Instituto Francés de Estudios Andinos; the Instituto de Estudios Peruanos; the Université Paris III Sorbonne-Nouvelle; the Universidad Nacional San Cristóbal de Huamanga; and the Universidad Nacional Mayor de San Marcos.";
  const BN_CREDIT_ES = BN_CREDIT_ES_PREVIOUS.replace("Narra la Independencia del Perú desde", "Narra la Independencia desde");
  const BN_CREDIT_EN = BN_CREDIT_EN_PREVIOUS.replace("Narra la Independencia del Perú desde", "Narra la Independencia desde");
  const CIHJML_RIGHTS_PREVIOUS =
    "Imágenes digitales disponibles en Zasqua mediante IIIF. CC BY-NC 4.0. Para obtener derechos de reproducción para publicaciones, por favor diríjase al CIHJML, Universidad del Cauca.";
  const CIHJML_RIGHTS =
    "Imágenes digitales disponibles en Zasqua mediante IIIF. CC BY-NC 4.0. Para obtener derechos de reproducción para publicaciones, por favor diríjase al Centro de Investigaciones Históricas José María Arboleda Llorente, Universidad del Cauca.";
  const CIHJML_REPRO_PREVIOUS = "Para obtener derechos de reproducción para publicaciones, por favor diríjase al CIHJML, Universidad del Cauca.";
  const CIHJML_REPRO =
    "Para obtener derechos de reproducción para publicaciones, por favor diríjase al Centro de Investigaciones Históricas José María Arboleda Llorente, Universidad del Cauca.";
  const quoted = (t: string) => `'${t.replace(/'/g, "''")}'`;

  /** The twin with all five repositories, holding the production texts the rulings replace. */
  function held(): DatabaseSync {
    const db = twin();
    repo(db, "r-ahrb", "t-n", "co-ahrb");
    repo(db, "r-cihjml", "t-n", "co-cihjml", { rights_text: CIHJML_RIGHTS_PREVIOUS, reproduction_services_es: CIHJML_REPRO_PREVIOUS });
    repo(db, "r-bn", "t-n", "pe-bn", { credit_statement_es: BN_CREDIT_ES_PREVIOUS, credit_statement_en: BN_CREDIT_EN_PREVIOUS });
    for (const [code, [previous]] of Object.entries(SUBTITLES)) {
      db.prepare("UPDATE repositories SET subtitle = ? WHERE code = ?").run(previous, code);
    }
    return db;
  }
  const fieldOf = (report: Awaited<ReturnType<typeof command>>["report"], code: string, column: string) =>
    report.repositories.find((r) => r.code === code)!.fields.find((f) => f.column === column);
  const updateOf = (report: Awaited<ReturnType<typeof command>>["report"], id: string) =>
    report.statements.find((s) => s.startsWith("UPDATE repositories") && s.includes(`'${id}'`))!;

  it("holds each ruled text in the data file with the exact previous text and the ruling as its source", () => {
    for (const [code, [previous, ruled]] of Object.entries(SUBTITLES)) {
      const s = NEOGRANADINA.repositories[code].subtitle;
      expect(s.value, code).toBe(ruled);
      expect(s.replaces, code).toBe(previous);
      expect(s.source, code).toMatch(RULING_SOURCE);
      expect(ruled, code).toBe(previous.replace("digitalizados por Neogranadina en", "digitalizados en alianza con Neogranadina en"));
    }
    const bn = NEOGRANADINA.repositories["pe-bn"];
    expect(bn.creditStatementEs).toMatchObject({ value: BN_CREDIT_ES, replaces: BN_CREDIT_ES_PREVIOUS });
    expect(bn.creditStatementEn).toMatchObject({ value: BN_CREDIT_EN, replaces: BN_CREDIT_EN_PREVIOUS });
    expect(bn.creditStatementEs!.source).toMatch(RULING_SOURCE);
    expect(bn.creditStatementEn!.source).toMatch(RULING_SOURCE);
    expect(BN_CREDIT_ES).toContain("Narra la Independencia desde tu pueblo, tu distrito o tu ciudad");
    expect(bn.subtitle.value).toContain("Narra la Independencia desde tu pueblo, tu distrito o tu ciudad");
    const rights = NEOGRANADINA.repositories["co-cihjml"].rightsText!;
    expect(rights).toMatchObject({ value: CIHJML_RIGHTS, replaces: CIHJML_RIGHTS_PREVIOUS });
    expect(rights.source).toMatch(RULING_SOURCE);
  });

  it("replaces each held previous text, guarded in SQL on it; a second run writes nothing", async () => {
    const db = held();
    const { report, lines } = await command(db, { apply: true });
    expect(report.verified).toBe(true);
    const ids: Record<string, string> = { "co-ahr": "r-ahr", "co-ahrb": "r-ahrb", "co-cihjml": "r-cihjml" };
    for (const [code, [previous, ruled]] of Object.entries(SUBTITLES)) {
      expect(fieldOf(report, code, "subtitle"), code).toMatchObject({ current: previous, proposed: ruled, action: "replace", replaces: previous });
      const update = updateOf(report, ids[code]);
      expect(update, code).toContain(`subtitle = ${quoted(ruled)}`);
      expect(update, code).toContain(`AND subtitle = ${quoted(previous)}`);
      expect(one(db, `SELECT subtitle FROM repositories WHERE id = '${ids[code]}'`).subtitle, code).toBe(ruled);
    }
    expect(fieldOf(report, "pe-bn", "credit_statement_es")).toMatchObject({ action: "replace", proposed: BN_CREDIT_ES });
    expect(fieldOf(report, "pe-bn", "credit_statement_en")).toMatchObject({ action: "replace", proposed: BN_CREDIT_EN });
    expect(updateOf(report, "r-bn")).toContain(`AND credit_statement_es = ${quoted(BN_CREDIT_ES_PREVIOUS)}`);
    expect(one(db, "SELECT credit_statement_es AS es, credit_statement_en AS en FROM repositories WHERE id = 'r-bn'"))
      .toEqual({ es: BN_CREDIT_ES, en: BN_CREDIT_EN });
    expect(fieldOf(report, "co-cihjml", "rights_text")).toMatchObject({ current: CIHJML_RIGHTS_PREVIOUS, proposed: CIHJML_RIGHTS, action: "replace" });
    expect(updateOf(report, "r-cihjml")).toContain(`AND rights_text = ${quoted(CIHJML_RIGHTS_PREVIOUS)}`);
    expect(one(db, "SELECT rights_text FROM repositories WHERE id = 'r-cihjml'").rights_text).toBe(CIHJML_RIGHTS);
    expect(fieldOf(report, "co-cihjml", "reproduction_services_es")).toMatchObject({
      current: CIHJML_REPRO_PREVIOUS, proposed: CIHJML_REPRO, action: "replace", replaces: CIHJML_REPRO_PREVIOUS,
    });
    expect(updateOf(report, "r-cihjml")).toContain(`AND reproduction_services_es = ${quoted(CIHJML_REPRO_PREVIOUS)}`);
    expect(one(db, "SELECT reproduction_services_es AS r FROM repositories WHERE id = 'r-cihjml'").r).toBe(CIHJML_REPRO);
    expect(lines.some((l) => l.startsWith("  co-cihjml:") && /replace .*subtitle/.test(l) && /replace .*rights_text/.test(l))).toBe(true);
    const second = await command(db, { apply: true });
    expect(second.run.applied).toEqual([]);
    expect(fieldOf(second.report, "co-cihjml", "rights_text")!.action).toBe("unchanged");
    expect(fieldOf(second.report, "co-cihjml", "reproduction_services_es")!.action).toBe("unchanged");
    expect(fieldOf(second.report, "co-ahr", "subtitle")!.action).toBe("unchanged");
  });

  it("leaves a held text that is not the previous one, reporting it as differing", async () => {
    const db = held();
    db.prepare("UPDATE repositories SET subtitle = ?, rights_text = ? WHERE id = 'r-cihjml'").run(SUBTITLES["co-cihjml"][0] + " ", "Otro texto.");
    const { report } = await command(db, { apply: true });
    expect(fieldOf(report, "co-cihjml", "subtitle")).toMatchObject({ action: "differs" });
    expect(fieldOf(report, "co-cihjml", "rights_text")).toMatchObject({ current: "Otro texto.", action: "differs" });
    expect(fieldOf(report, "co-cihjml", "reproduction_services_es")).toMatchObject({ current: CIHJML_REPRO_PREVIOUS, action: "held" });
    expect(one(db, "SELECT subtitle, rights_text, reproduction_services_es AS r FROM repositories WHERE id = 'r-cihjml'"))
      .toEqual({ subtitle: SUBTITLES["co-cihjml"][0] + " ", rights_text: "Otro texto.", r: CIHJML_REPRO_PREVIOUS });
    expect(report.verified).toBe(true);
  });

  it("sets rights_text where it is empty, and cuts the reproduction sentence from the text written", async () => {
    const db = held();
    db.exec("UPDATE repositories SET rights_text = NULL, reproduction_services_es = NULL WHERE id = 'r-cihjml'");
    const { report } = await command(db, { apply: true });
    expect(fieldOf(report, "co-cihjml", "rights_text")).toMatchObject({ current: null, proposed: CIHJML_RIGHTS, action: "set" });
    expect(one(db, "SELECT rights_text, reproduction_services_es AS r FROM repositories WHERE id = 'r-cihjml'")).toEqual({
      rights_text: CIHJML_RIGHTS,
      r: CIHJML_REPRO,
    });
    expect(report.verified).toBe(true);
  });

  it("leaves a reproduction sentence that is not the one cut from the previous rights text", async () => {
    const db = held();
    db.exec("UPDATE repositories SET reproduction_services_es = 'Escrita a mano.' WHERE id = 'r-cihjml'");
    const { report } = await command(db, { apply: true });
    expect(fieldOf(report, "co-cihjml", "rights_text")!.action).toBe("replace");
    expect(fieldOf(report, "co-cihjml", "reproduction_services_es")).toMatchObject({ current: "Escrita a mano.", proposed: CIHJML_REPRO, action: "differs" });
    expect(one(db, "SELECT reproduction_services_es AS r FROM repositories WHERE id = 'r-cihjml'").r).toBe("Escrita a mano.");
    expect(report.verified).toBe(true);
  });

  it("leaves rights_text alone for a repository whose entry sets none", async () => {
    const db = held();
    const { report } = await command(db, { apply: true });
    expect(fieldOf(report, "co-ahr", "rights_text")).toBeUndefined();
    expect(updateOf(report, "r-ahr")).not.toContain("rights_text =");
  });

  it("stops on a rights text without a source", () => {
    const bad: InstitutionSource = structuredClone(NEOGRANADINA);
    bad.repositories["co-cihjml"].rightsText!.source = " ";
    expect(() => validateSources(bad)).toThrow(/co-cihjml\.rightsText/);
  });
});

describe("the English text approved 2026-11-06", () => {
  const SOURCE = "English text approved 2026-11-06";
  /** The approved English values, column by column, for each repository. */
  const ENGLISH: Record<string, Record<string, string>> = {
    "co-ahjci": {
      subtitle_en: "Materials digitized at the Archivo Histórico del Juzgado del Circuito de Istmina, Chocó, Colombia, in project EAP1477.",
      reproduction_services_en: "For reproduction rights for publications, please contact the Archivo Histórico del Juzgado del Circuito de Istmina.",
    },
    "co-ahr": {
      subtitle_en: "Catalogs and materials digitized in partnership with Neogranadina at the Archivo Histórico de Rionegro, Antioquia, Colombia.",
      reproduction_services_en: "For reproduction rights for publications, please contact the Archivo Histórico de Rionegro.",
    },
    "co-ahrb": {
      subtitle_en: "Materials digitized in partnership with Neogranadina at the Archivo Histórico Regional de Boyacá, Tunja, Colombia.",
      reproduction_services_en: "For reproduction rights for publications, please contact the Archivo Histórico Regional de Boyacá.",
    },
    "co-cihjml": {
      subtitle_en:
        "Catalogs and materials digitized in partnership with Neogranadina in the Antiguo Archivo Central del Cauca fonds of the Centro de Investigaciones Históricas José María Arboleda Llorente, Popayán, Colombia.",
      reproduction_services_en:
        "For reproduction rights for publications, please contact the Centro de Investigaciones Históricas José María Arboleda Llorente, Universidad del Cauca.",
      access_conditions_en: "Readers must first fill in the registration form and accept the internal regulations.",
    },
    "pe-bn": {
      subtitle_en:
        "Digital edition of the Colección documental de la Independencia del Perú, created for the public history project Narra la Independencia desde tu pueblo, tu distrito o tu ciudad.",
      reproduction_services_en: "For reproduction rights for publications, please contact the Biblioteca Nacional del Perú.",
      access_conditions_en:
        "Visit the Library during opening hours and go to the User Services Room with your national identity document (DNI).\n\n" +
        "Researchers: go to the User Services Room with your DNI and a letter of introduction from your university or workplace, on letterhead and signed, vouching for you as a researcher.",
      opening_times_en: "Monday to Saturday: 8:30 a.m. \u2013 8:00 p.m.",
    },
  };
  const KEYS: Record<string, "subtitleEn" | "reproductionServicesEn" | "accessConditionsEn" | "openingTimesEn"> = {
    subtitle_en: "subtitleEn",
    reproduction_services_en: "reproductionServicesEn",
    access_conditions_en: "accessConditionsEn",
    opening_times_en: "openingTimesEn",
  };
  const IDS: Record<string, string> = { "co-ahjci": "r-ahjci", "co-ahr": "r-ahr", "co-ahrb": "r-ahrb", "co-cihjml": "r-cihjml", "pe-bn": "r-bn" };

  /** The twin with all five repositories, none holding English text. */
  function five(): DatabaseSync {
    const db = twin();
    repo(db, "r-ahrb", "t-n", "co-ahrb");
    repo(db, "r-cihjml", "t-n", "co-cihjml");
    repo(db, "r-bn", "t-n", "pe-bn");
    return db;
  }
  const fieldOf = (report: Awaited<ReturnType<typeof command>>["report"], code: string, column: string) =>
    report.repositories.find((r) => r.code === code)!.fields.find((f) => f.column === column);

  it("holds each approved value in the data file, byte for byte, with its source", () => {
    for (const [code, values] of Object.entries(ENGLISH)) {
      for (const [column, value] of Object.entries(values)) {
        const entry = NEOGRANADINA.repositories[code][KEYS[column]];
        expect(entry, `${code}.${column}`).toEqual({ value, source: SOURCE });
      }
    }
    expect(NEOGRANADINA.repositories["co-ahr"].accessConditionsEn).toBeUndefined();
    expect(NEOGRANADINA.repositories["co-cihjml"].openingTimesEn).toBeUndefined();
    const bnAccess = ENGLISH["pe-bn"].access_conditions_en;
    expect(bnAccess.split("\n\n")).toHaveLength(2);
    expect(bnAccess).not.toMatch(/\r|\n\n\n/);
    expect(ENGLISH["pe-bn"].opening_times_en).toContain(" \u2013 ");
  });

  it("checks that every column it writes exists in the schema", () => {
    const columns = Object.values(getTableConfig(repositories).columns).map((c) => c.name);
    for (const column of Object.keys(KEYS)) expect(columns).toContain(column);
  });

  it("plans and writes each value where the column is empty; a second run writes nothing", async () => {
    const db = five();
    db.exec("UPDATE repositories SET subtitle_en = '  ' WHERE id = 'r-ahr'");
    const first = await command(db, { apply: true });
    expect(first.report.verified).toBe(true);
    for (const [code, values] of Object.entries(ENGLISH)) {
      for (const [column, value] of Object.entries(values)) {
        expect(fieldOf(first.report, code, column), `${code}.${column}`).toMatchObject({ proposed: value, source: SOURCE, action: "set" });
        expect(one(db, `SELECT ${column} AS v FROM repositories WHERE id = '${IDS[code]}'`).v, `${code}.${column}`).toBe(value);
      }
    }
    expect(fieldOf(first.report, "co-ahr", "subtitle_en")!.current).toBe("  ");
    expect(fieldOf(first.report, "co-ahr", "access_conditions_en")).toBeUndefined();
    const update = first.report.statements.find((s) => s.startsWith("UPDATE repositories") && s.includes("'r-bn'"))!;
    expect(update).toContain("(opening_times_en IS NULL OR trim(opening_times_en, char(32, 9, 10, 13)) = '')");
    const second = await command(db, { apply: true });
    expect(second.run.applied).toEqual([]);
    expect(fieldOf(second.report, "pe-bn", "opening_times_en")!.action).toBe("unchanged");
  });

  it("keeps the Spanish reproduction sentence cut from rights_text", async () => {
    const { report } = await command(five());
    expect(fieldOf(report, "co-ahjci", "reproduction_services_es")).toMatchObject({
      proposed: "Para obtener derechos de reproducción para publicaciones, por favor diríjase al Archivo Histórico del Juzgado del Circuito de Istmina.",
      action: "set",
    });
  });

  it("reports a held value and leaves it", async () => {
    const db = five();
    db.exec("UPDATE repositories SET subtitle_en = 'Held.', access_conditions_en = 'Held too.' WHERE id = 'r-cihjml'");
    const { report } = await command(db, { apply: true });
    expect(fieldOf(report, "co-cihjml", "subtitle_en")).toMatchObject({ current: "Held.", action: "differs" });
    expect(fieldOf(report, "co-cihjml", "access_conditions_en")).toMatchObject({ current: "Held too.", action: "differs" });
    expect(one(db, "SELECT subtitle_en AS s, access_conditions_en AS a FROM repositories WHERE id = 'r-cihjml'")).toEqual({ s: "Held.", a: "Held too." });
    expect(report.verified).toBe(true);
  });

  it("fails the whole file when an English column is filled between the read and the apply", async () => {
    const db = five();
    const change = "UPDATE repositories SET opening_times_en = 'Other' WHERE id = 'r-bn'";
    await expect(command(db, { apply: true }, { before: () => db.exec(change) })).rejects.toThrow(/malformed JSON/);
    expect(one(db, "SELECT subtitle_en FROM repositories WHERE id = 'r-ahjci'").subtitle_en).toBeNull();
  });

  it("no longer reports these columns as having no English text in any source", async () => {
    const { report } = await command(five());
    expect(report.gaps.some((g) => /no English text/.test(g))).toBe(false);
  });

  it("stops on any of them without a source", () => {
    let checked = 0;
    for (const [code, values] of Object.entries(ENGLISH)) {
      for (const column of Object.keys(values)) {
        const bad: InstitutionSource = structuredClone(NEOGRANADINA);
        (bad.repositories[code][KEYS[column]] as { source: string }).source = " ";
        expect(() => validateSources(bad), `${code}.${column}`).toThrow(new RegExp(`${code}\\.${KEYS[column]}\\b`));
        checked++;
      }
    }
    expect(checked).toBe(13);
  });
});

describe("pe-bn's history names the project as the subtitle does", () => {
  const PREVIOUS_ES = NEOGRANADINA.repositories["pe-bn"].historyEs!.replaces!;
  const PREVIOUS_EN = NEOGRANADINA.repositories["pe-bn"].historyEn!.replaces!;
  const OLD_NAME = "Narra la Independencia del Perú desde tu pueblo, tu distrito o tu ciudad";
  const NEW_NAME = "Narra la Independencia desde tu pueblo, tu distrito o tu ciudad";

  it("holds the shorter name, the exact previous text and the ruling as its source", () => {
    for (const key of ["historyEs", "historyEn"] as const) {
      const h = NEOGRANADINA.repositories["pe-bn"][key]!;
      expect(h.replaces, key).toContain(OLD_NAME);
      expect(h.value, key).toBe(h.replaces!.replace(OLD_NAME, NEW_NAME));
      expect(h.value, key).not.toContain("Independencia del Perú desde");
      expect(h.source, key).toMatch(/^ruling 2026-11-06 \(the project named as in the subtitle\); the rest .*neogranadina\.org\/proyectos\/narra\/; text approved 2026-11-03$/);
    }
    expect(PREVIOUS_ES.startsWith("La Biblioteca Nacional del Perú es un organismo público ejecutor")).toBe(true);
    expect(PREVIOUS_EN.endsWith("and added its 14,374 documents to its online platform.")).toBe(true);
  });

  it("replaces the held previous history, guarded on it", async () => {
    const db = twin();
    repo(db, "r-bn", "t-n", "pe-bn", { history_es: PREVIOUS_ES, history_en: PREVIOUS_EN });
    const { report } = await command(db, { apply: true });
    const fields = report.repositories.find((r) => r.code === "pe-bn")!.fields;
    expect(fields.find((f) => f.column === "history_es")).toMatchObject({ action: "replace", replaces: PREVIOUS_ES });
    expect(fields.find((f) => f.column === "history_en")).toMatchObject({ action: "replace", replaces: PREVIOUS_EN });
    expect(one(db, "SELECT history_es AS es, history_en AS en FROM repositories WHERE id = 'r-bn'")).toEqual({
      es: NEOGRANADINA.repositories["pe-bn"].historyEs!.value,
      en: NEOGRANADINA.repositories["pe-bn"].historyEn!.value,
    });
    expect(report.verified).toBe(true);
  });
});

describe("the federation's hosting statement", () => {
  const ES = "Alojado en Zasqua (zasqua.org).";
  const EN = "Hosted on Zasqua (zasqua.org).";
  const hosting = (db: DatabaseSync) =>
    db.prepare("SELECT slug, hosting_statement_es AS es, hosting_statement_en AS en FROM federations ORDER BY slug").all();
  const fieldOf = (report: Awaited<ReturnType<typeof command>>["report"], column: string) =>
    report.federationFields.find((f) => f.column === column);

  it("holds the ruled text for Neogranadina in the data file, with its source", () => {
    expect(NEOGRANADINA.publisher.hostingStatementEs).toEqual({ value: ES, source: "ruling 2026-11-03" });
    expect(NEOGRANADINA.publisher.hostingStatementEn).toEqual({ value: EN, source: "ruling 2026-11-03" });
  });

  it("plans both languages in the dry run, with their source", async () => {
    const { report } = await command(twin());
    expect(fieldOf(report, "hosting_statement_es")).toMatchObject({ current: null, proposed: ES, action: "set", source: "ruling 2026-11-03" });
    expect(fieldOf(report, "hosting_statement_en")).toMatchObject({ current: null, proposed: EN, action: "set", source: "ruling 2026-11-03" });
    expect(renderReport(report)).toContain(`| hosting_statement_es | — | ${ES} | set | ruling 2026-11-03 |`);
  });

  it("sets it once, on the federation filled only, and a second run writes nothing", async () => {
    const db = twin();
    const first = await command(db, { apply: true });
    expect(first.report.verified).toBe(true);
    expect(hosting(db)).toEqual([
      { slug: "ampl", es: null, en: null },
      { slug: "neogranadina", es: ES, en: EN },
    ]);
    const second = await command(db, { apply: true });
    expect(second.run.applied).toEqual([]);
    expect(second.report.statements).toEqual([]);
    expect(fieldOf(second.report, "hosting_statement_es")!.action).toBe("unchanged");
  });

  it("sets a blank statement and leaves a held one, reporting the difference", async () => {
    const db = twin();
    db.exec("UPDATE federations SET hosting_statement_es = '  ', hosting_statement_en = 'Hosted elsewhere.' WHERE id = 'fed-n'");
    const { report } = await command(db, { apply: true });
    expect(fieldOf(report, "hosting_statement_es")).toMatchObject({ current: "  ", action: "set" });
    expect(fieldOf(report, "hosting_statement_en")).toMatchObject({ current: "Hosted elsewhere.", action: "differs" });
    expect(one(db, "SELECT hosting_statement_es AS es, hosting_statement_en AS en FROM federations WHERE id = 'fed-n'"))
      .toEqual({ es: ES, en: "Hosted elsewhere." });
  });

  it("fails the whole file when the statement is written between the read and the apply", async () => {
    const db = twin();
    await expect(
      command(db, { apply: true }, { before: () => db.exec("UPDATE federations SET hosting_statement_es = 'Otro.' WHERE id = 'fed-n'") }),
    ).rejects.toThrow();
    expect(one(db, "SELECT hosting_statement_en AS en FROM federations WHERE id = 'fed-n'").en).toBeNull();
    expect(one(db, "SELECT publisher_email FROM federations WHERE id = 'fed-n'").publisher_email).toBeNull();
  });

  it("without migration 0122, plans the statement in the dry run and refuses --apply", async () => {
    const dry = await command(twin(true, true, true, false));
    expect(dry.report.schemaReady).toBe(false);
    expect(dry.report.missingSchema).toEqual(["federations.hosting_statement_es", "federations.hosting_statement_en"]);
    expect(fieldOf(dry.report, "hosting_statement_es")).toMatchObject({ current: null, proposed: ES, action: "set" });
    const db = twin(true, true, true, false);
    await expect(command(db, { apply: true })).rejects.toThrow(/0122/);
    expect(one(db, "SELECT publisher_email FROM federations WHERE id = 'fed-n'").publisher_email).toBeNull();
  });

  it("stops on a hosting statement without a source", () => {
    const bad: InstitutionSource = structuredClone(NEOGRANADINA);
    bad.publisher.hostingStatementEn!.source = " ";
    expect(() => validateSources(bad)).toThrow(/publisher\.hostingStatementEn\b/);
  });
});

describe("statements", () => {
  it("keeps every insert within D1's bound parameters, splitting at the boundary", () => {
    const seed = vocabularySeed("fed-x", NOW, () => "id");
    const perRow = 14; // vocabulary_values has fourteen columns
    const fit = Math.floor(MAX_PARAMS / perRow);
    expect(insertStatements(vocabularyValues, seed.slice(0, fit))).toHaveLength(1);
    expect(insertStatements(vocabularyValues, seed.slice(0, fit + 1))).toHaveLength(2);
    for (const s of insertStatements(vocabularyValues, seed)) expect(s.params).toBeLessThanOrEqual(MAX_PARAMS);
  });

  it("holds the unique index: a second seed of one federation is refused by the database", async () => {
    const db = twin();
    await command(db, { apply: true });
    const again = insertStatements(vocabularyValues, vocabularySeed("fed-n", NOW, () => `dup-${Math.random()}`));
    expect(() => db.exec(again.map((s) => s.sql).join("\n"))).toThrow(/UNIQUE/);
  });

  it("seeds labels from the locale files and reports every code without one", () => {
    const seed = vocabularySeed("fed-x", NOW, () => "id");
    expect(seed).toHaveLength(SEED_SIZE);
    for (const v of seed) {
      expect(v.labelEs).toBeTruthy();
      expect(v.labelEn).toBeTruthy();
    }
    expect(seed.filter((v) => v.externalUri).map((v) => v.code).sort()).toEqual(["city", "region", "river"]);
  });
});

describe("sources", () => {
  it("stops on a data entry without a source", () => {
    const bad: InstitutionSource = structuredClone(NEOGRANADINA);
    bad.repositories["pe-bn"].subtitle.source = "";
    expect(() => validateSources(bad)).toThrow(FillStop);
    const noOrder: InstitutionSource = structuredClone(NEOGRANADINA);
    noOrder.repositories["co-ahr"].homeOrder.source = " ";
    expect(() => validateSources(noOrder)).toThrow(FillStop);
    expect(() => validateSources(NEOGRANADINA)).not.toThrow();
  });

  it("refuses a D1-evidenced funder whose evidence no longer appears in the column named", async () => {
    const source: InstitutionSource = structuredClone(NEOGRANADINA);
    source.repositories["co-ahjci"].funders = [{
      kind: "d1",
      name: "Arcadia",
      programme: null,
      projectId: null,
      url: null,
      column: "attribution_en",
      evidence: ["funded by Arcadia"],
      source: "D1 repositories.attribution_en of co-ahjci",
    }];
    const evidenced = await command(twin(), {}, { source });
    expect(evidenced.report.funders.filter((f) => f.code === "co-ahjci").map((f) => [f.name, f.action])).toEqual([["Arcadia", "insert"]]);
    const db = twin();
    db.exec("UPDATE repositories SET attribution_en = 'Istmina, Colombia.' WHERE id = 'r-ahjci'");
    const { report } = await command(db, {}, { source });
    expect(report.funders.filter((f) => f.code === "co-ahjci" && f.action === "insert")).toEqual([]);
    expect(report.gaps.some((g) => g.includes("Arcadia"))).toBe(true);
  });

  it("stops on a web-sourced funder without its URL or its quote", () => {
    for (const blank of ["sourceUrl", "quote"] as const) {
      const bad: InstitutionSource = structuredClone(NEOGRANADINA);
      const f = bad.repositories["co-ahjci"].funders![0];
      if (f.kind !== "web") throw new Error("expected a web-sourced funder");
      f[blank] = " ";
      expect(() => validateSources(bad)).toThrow(/co-ahjci\.funders\[0\]/);
    }
  });

  it("stops on other names without a source", () => {
    const bad: InstitutionSource = structuredClone(NEOGRANADINA);
    bad.repositories["co-ahjci"].otherNames!.source = "";
    expect(() => validateSources(bad)).toThrow(/co-ahjci\.otherNames/);
  });

  it("matches the app's link templates, with no template for hgis and production's for dbe", () => {
    for (const s of AUTHORITY_SOURCES) {
      if (s.key === "hgis") {
        expect(s.urlTemplate).toBeNull();
        expect(s.templateSource).toBe("ruled 2026-11-14: HGIS links are not shown");
        expect(s.replacesTemplate!.value.replace("{id}", "X1")).toBe(SERVICE_URLS.hgis("X1"));
      } else if (s.key === "dbe") {
        expect(s.urlTemplate).toBe("https://historia-hispanica.rah.es/biografias/{id}");
        expect(s).toMatchObject({ labelFile: "entities", labelKey: "field.dbeId", appliesTo: ["entity"] });
      } else {
        if (s.key === "tgn") expect(s.replacesTemplate!.value).toBe("https://vocab.getty.edu/tgn/{id}");
        if (s.key === "whg") expect(s.replacesTemplate!.value).toBe("https://whgazetteer.org/places/{id}");
        expect(s.urlTemplate!.replace("{id}", "X1")).toBe(SERVICE_URLS[s.key as keyof typeof SERVICE_URLS]("X1"));
      }
    }
    expect(AUTHORITY_SOURCES.map((s) => s.key)).toEqual(["wikidata", "viaf", "tgn", "hgis", "whg", "dbe"]);
  });

  it("stops on a replaced template without a source", () => {
    const hgis = AUTHORITY_SOURCES.find((s) => s.key === "hgis")!;
    const source = hgis.replacesTemplate!.source;
    hgis.replacesTemplate!.source = " ";
    try {
      expect(() => validateSources(NEOGRANADINA)).toThrow(/authoritySources\.hgis\.replacesTemplate/);
    } finally {
      hgis.replacesTemplate!.source = source;
    }
  });

  it("matches the hero files' size and digest where the instance is checked out", () => {
    const root = path.resolve(__dirname, "../../../zasqua-neogranadina");
    for (const r of Object.values(NEOGRANADINA.repositories)) {
      const file = path.join(root, r.hero.path);
      if (!fs.existsSync(file)) continue;
      const bytes = fs.readFileSync(file);
      expect(bytes.length).toBe(r.hero.size);
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(r.hero.sha256);
    }
  });

  it("passes only SELECTs to the database", async () => {
    const reader = selectOnly(async () => []);
    await expect(reader("SELECT 1")).resolves.toEqual([]);
    await expect(reader("UPDATE repositories SET code = 'x'")).rejects.toThrow(FillStop);
    await expect(reader("SELECT 1; DELETE FROM repositories")).rejects.toThrow(FillStop);
  });
});

describe("authority sources held", () => {
  const authorityWrites = (statements: string[]) =>
    statements.filter((s) => /^(insert into "authority_sources"|update authority_sources|delete from authority_sources)/i.test(s));

  it("plans no change where a federation holds the six sources as the seed has them", async () => {
    const db = twin();
    holdSources(db, SEEDED_SOURCES);
    const { report } = await command(db, { target: "production" });
    expect(report.authoritySources.map((a) => [a.federation, a.existing, a.toInsert, a.toUpdate, a.differing])).toEqual([
      ["ampl", 6, 0, [], []],
      ["neogranadina", 6, 0, [], []],
    ]);
    expect(authorityWrites(report.statements)).toEqual([]);
  });

  it("replaces tgn's and whg's held link templates where a federation holds the six sources as production did on 2026-11-14", async () => {
    const db = twin();
    holdSources(db, PRODUCTION_SOURCES);
    const { report } = await command(db, { target: "production" });
    for (const a of report.authoritySources) {
      expect(a).toMatchObject({ existing: 6, toInsert: 0, differing: [] });
      expect(a.toUpdate).toEqual([
        { key: "tgn", id: `s-${a.federationId}-tgn`, from: "https://vocab.getty.edu/tgn/{id}", to: "https://vocab.getty.edu/page/tgn/{id}" },
        { key: "whg", id: `s-${a.federationId}-whg`, from: "https://whgazetteer.org/places/{id}", to: "https://whgazetteer.org/places/{id}/detail" },
      ]);
    }
    expect(authorityWrites(report.statements).filter((s) => s.startsWith("UPDATE"))).toEqual([
      "UPDATE authority_sources SET url_template = 'https://vocab.getty.edu/page/tgn/{id}' WHERE id = 's-fed-a-tgn' AND url_template = 'https://vocab.getty.edu/tgn/{id}';",
      "UPDATE authority_sources SET url_template = 'https://whgazetteer.org/places/{id}/detail' WHERE id = 's-fed-a-whg' AND url_template = 'https://whgazetteer.org/places/{id}';",
      "UPDATE authority_sources SET url_template = 'https://vocab.getty.edu/page/tgn/{id}' WHERE id = 's-fed-n-tgn' AND url_template = 'https://vocab.getty.edu/tgn/{id}';",
      "UPDATE authority_sources SET url_template = 'https://whgazetteer.org/places/{id}/detail' WHERE id = 's-fed-n-whg' AND url_template = 'https://whgazetteer.org/places/{id}';",
    ]);
  });

  it("sets hgis's held link template to none, replaces tgn's and whg's, and inserts dbe where a federation holds the five sources staging does", async () => {
    const db = twin();
    holdSources(db, STAGING_SOURCES);
    const { report, lines } = await command(db);
    for (const a of report.authoritySources) {
      expect(a).toMatchObject({ existing: 5, toInsert: 1, differing: [] });
      expect(a.toUpdate).toEqual([
        { key: "tgn", id: `s-${a.federationId}-tgn`, from: "https://vocab.getty.edu/tgn/{id}", to: "https://vocab.getty.edu/page/tgn/{id}" },
        { key: "hgis", id: `s-${a.federationId}-hgis`, from: "https://hgis-indias.net/place/{id}", to: null },
        { key: "whg", id: `s-${a.federationId}-whg`, from: "https://whgazetteer.org/places/{id}", to: "https://whgazetteer.org/places/{id}/detail" },
      ]);
    }
    expect(lines).toContain("  ampl: 1 authority source(s) to insert, 3 template(s) to replace (tgn, hgis, whg), 5 held");
    expect(renderReport(report)).toContain("| ampl | 5 | 1 | tgn, hgis, whg |");
    const writes = authorityWrites(report.statements);
    expect(writes.filter((s) => s.startsWith("UPDATE")).filter((s) => s.includes("-hgis'"))).toEqual([
      "UPDATE authority_sources SET url_template = NULL WHERE id = 's-fed-a-hgis' AND url_template = 'https://hgis-indias.net/place/{id}';",
      "UPDATE authority_sources SET url_template = NULL WHERE id = 's-fed-n-hgis' AND url_template = 'https://hgis-indias.net/place/{id}';",
    ]);
    expect(writes.filter((s) => s.startsWith("UPDATE"))).toHaveLength(6);
    expect(writes.filter((s) => /^insert/i.test(s))).toHaveLength(1);
    expect(writes[0]).toContain("'dbe'");

    const applied = await command(db, { apply: true });
    expect(applied.report.verified).toBe(true);
    for (const fed of ["fed-a", "fed-n"]) {
      expect(db.prepare(`SELECT key, label_es, label_en, url_template, applies_to, position FROM authority_sources WHERE federation_id = '${fed}' ORDER BY position`).all())
        .toEqual(SEEDED_SOURCES.map(([key, label, urlTemplate, appliesTo, position]) => ({ key, label_es: label, label_en: label, url_template: urlTemplate, applies_to: appliesTo, position })));
    }
    const again = await command(db);
    expect(authorityWrites(again.report.statements)).toEqual([]);
    expect(again.report.authoritySources.every((a) => a.toInsert === 0 && a.toUpdate.length === 0 && a.differing.length === 0)).toBe(true);
  });

  it("reports and leaves a held template that is neither the seed's nor the one it replaces", async () => {
    const db = twin();
    holdSources(db, SEEDED_SOURCES.filter(([key]) => key !== "dbe").map((r) => (r[0] === "hgis" ? ["hgis", "HGIS", "https://example.org/{id}", r[3], r[4]] : r)));
    const { report } = await command(db, { apply: true });
    expect(report.authoritySources.map((a) => [a.toUpdate, a.differing])).toEqual([[[], ["hgis"]], [[], ["hgis"]]]);
    expect(count(db, "SELECT count(*) AS n FROM authority_sources WHERE key = 'hgis' AND url_template = 'https://example.org/{id}'")).toBe(2);
  });

  it("fails the whole file when hgis's template changes between the read and the apply", async () => {
    const db = twin();
    holdSources(db, STAGING_SOURCES);
    await expect(
      command(db, { apply: true }, { before: () => db.exec("UPDATE authority_sources SET url_template = 'https://example.org/{id}' WHERE id = 's-fed-a-hgis'") }),
    ).rejects.toThrow(/malformed JSON/);
    expect(count(db, "SELECT count(*) AS n FROM authority_sources WHERE key = 'dbe'")).toBe(0);
  });
});

describe("the report module", () => {
  it("renders the report and the hero plan apart from the planner, which stays within the size limit", async () => {
    const { report } = await command(twin());
    expect(renderReport(report)).toContain("## Repository fields");
    expect(renderHeroPlan(report)).toContain("institutions/co-ahjci/hero.jpg");
    const lines = fs.readFileSync(path.resolve(__dirname, "../../scripts/lib/institution-records-fill.ts"), "utf8").split("\n").length;
    expect(lines).toBeLessThanOrEqual(1000);
  });
});

describe("arguments", () => {
  it("needs --confirm-production to apply against production", () => {
    expect(() => parseArgs(["--target", "production", "--federation", "neogranadina", "--apply"])).toThrow(/confirm-production/);
    expect(parseArgs(["--target", "production", "--federation", "neogranadina"])).toMatchObject({ apply: false, withHeroes: false });
    expect(parseArgs(["--target", "local", "--federation", "neogranadina", "--apply", "--with-heroes", "--out", "x"]))
      .toMatchObject({ apply: true, withHeroes: true, outDir: "x" });
  });
});

// @version v0.9.0
