/**
 * Scripts — filling the institution records
 *
 * This module plans and writes the first values of the institution
 * records, for the command in
 * `scripts/commands/fill-institution-records.ts`. Migration 0119 gave
 * repositories the fields of an ISDIAH record and each federation its own
 * controlled lists and authority sources, 0120 the repositories the order
 * of their cards on the instance's home page, 0121 their credit
 * statements, and 0122 each federation its hosting statement, all empty.
 *
 * What is read, with SELECTs only (`selectOnly` refuses anything else):
 * the federation by slug and its public manifest address; which 0119,
 * 0120, 0121 and 0122 columns and tables exist; every repository with its
 * federation; the funders of the federation's repositories; every federation's
 * vocabulary values and authority sources; and, per federation, how many
 * records use each entity type, place type, entity role and place role.
 *
 * What is planned, per repository of the federation that has an entry in
 * the data file (`scripts/data/institution-records/`): the display title,
 * the Spanish subtitle, the region and the home-page order from the
 * instance theme (the order written as an integer); the approved facts
 * of the data file, as it holds them — short name, other names (a JSON
 * list), institution type, address, email, website, telephone, history
 * (Markdown, Spanish and English), opening times and access conditions
 * (Spanish and English), the credit statement (plain text, Spanish and
 * English), `rights_text`, and the English subtitle and reproduction
 * sentence; the Spanish reproduction sentence cut verbatim from
 * `rights_text` as it stands after the fill; and the
 * funders. `scripts/lib/institution-records-fields.ts` plans the
 * columns. A field is written only when it is empty — NULL, or nothing
 * but whitespace, as several columns hold "" — and each UPDATE is
 * guarded on the same test; a field that holds another value is
 * reported as differing and left alone. The one exception is a fact or
 * subtitle the data file marks with the exact text it `replaces`: it is
 * written over a held value equal to that text byte for byte, reported
 * as `replace`, and its UPDATE is guarded on the column holding that
 * text. Where `rights_text` is replaced so, a held reproduction sentence
 * equal to the one cut from the previous text is replaced by the one cut
 * from the new text, under the same guard.
 *
 * A funder's source is either D1 or a web page. A D1 funder is written
 * only while its evidence still appears verbatim in the column named; a
 * web funder carries the page's URL and a verbatim quote from it, which
 * the report copies; the page is not fetched. Where the data file lists
 * a repository's funders, the list is the whole set: a held funder whose
 * name is not listed is deleted, a listed one not held is inserted at its
 * place in the list, and a held one with a listed name is left (reported
 * as differing when its other values do). A repository with no list
 * keeps its funders. `scripts/lib/institution-records-funders.ts` plans
 * the funders. With `withHeroes`, the hero URL
 * (the federation's manifest address followed by
 * `institutions/<code>/hero.<ext>`) is written only for an object found
 * at that address with the size and SHA-256 planned; without it, the
 * upload is only planned.
 *
 * For the federation itself, the publisher email and the hosting
 * statement (Spanish and English) of the data file, each when its column
 * is empty. No other federation column is written, and no other
 * federation's row.
 *
 * For every federation, the lists are seeded from
 * `app/lib/validation/enums.ts` with labels from the locale files, and
 * the authority sources from the data file, skipping any code the
 * federation already holds. A held authority source whose label, link
 * template, record types or position differ from the data file's is
 * reported as differing and left alone, with one exception: a link
 * template the data file marks as replaced (hgis's, which becomes none)
 * is set to the data file's template while held byte for byte, its
 * UPDATE guarded on that text. Place types carry the three AAT terms of the
 * data file. Entity roles carry their group and their position within
 * it; role groups their position; the other lists the constant's order.
 * Positions start at 1.
 *
 * The SQL file opens with guards that every repository written still
 * holds what was read, including its tenant, its code and its tenant's
 * federation; that the funders of every repository filled, and the
 * values and sources of every federation, are still the rows read, with
 * the values read, and no more; and that no funder to be inserted is
 * there already. Each funder deleted is deleted by every value read. It
 * closes with guards on the values written, the counts after, and the
 * absence of the funders deleted. D1 applies the
 * file as one unit, so a failing guard leaves nothing written. Each
 * insert names at most `MAX_PARAMS` values. A run that finds nothing to
 * write writes no SQL, so a second run is harmless.
 *
 * Every value planned names its source, and the data file is checked for
 * entries without one before anything is read (`validateSources`).
 *
 * The report and the hero upload plan are written as JSON and as
 * Markdown; `scripts/lib/institution-records-report.ts` renders the
 * Markdown.
 *
 * @version v0.9.0
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { SQLiteTable } from "drizzle-orm/sqlite-core";
import { authoritySources, repositoryFunders, vocabularyValues } from "../../app/db/schema";
import {
  ENTITY_ROLE_GROUPS,
  ENTITY_TYPES,
  PLACE_ROLES,
  PLACE_TYPES,
} from "../../app/lib/validation/enums";
import esDescriptions from "../../app/locales/es/descriptions";
import enDescriptions from "../../app/locales/en/descriptions";
import esEntities from "../../app/locales/es/entities";
import enEntities from "../../app/locales/en/entities";
import esPlaces from "../../app/locales/es/places";
import enPlaces from "../../app/locales/en/places";
import {
  INSTITUTION_SOURCES,
  type InstitutionSource,
} from "../data/institution-records/neogranadina";
import { funderLine, planFunders, type FunderPlan } from "./institution-records-funders";
import { AUTHORITY_SOURCES, PLACE_TYPE_TERMS } from "../data/institution-records/vocabularies";
import { chunks, composer, guard, idList, matchingGuards, render } from "./authority-merges";
import { renderHeroPlan, renderReport } from "./institution-records-report";
import { escapeSql } from "./sql";
import { FACT_COLUMNS, REPOSITORY_FACTS, compare, emptyCondition, repositoryFields, isWrite, type FieldChange } from "./institution-records-fields";
import { appendAll } from "./arrays";

export type { FunderPlan } from "./institution-records-funders";
export type { FieldAction, FieldChange } from "./institution-records-fields";

export type Target = "local" | "staging" | "production";

/** D1's limit on bound parameters in one statement. */
export const MAX_PARAMS = 100;

export type RowReader = (sql: string) => Promise<Record<string, unknown>[]>;

export interface FillProviders {
  rows: RowReader;
  writeFile: (path: string, text: string) => void;
  /** Applies the SQL file as one unit; `statements` are its statements, in order. */
  applyFile: (path: string, statements: string[]) => Promise<void> | void;
  /** The object at a public URL, or null when there is none. */
  fetchObject: (url: string) => Promise<Uint8Array | null>;
  now: () => number;
  newId: () => string;
}

export interface FillOptions {
  target: Target;
  federation: string;
  apply: boolean;
  withHeroes: boolean;
  outDir: string;
}

/** A refusal that stops the command before anything is written. */
export class FillStop extends Error {}

export interface RepositoryPlan {
  code: string;
  id: string;
  tenant: string;
  fields: FieldChange[];
}

export interface HeroPlan {
  code: string;
  sourcePath: string;
  templatePath: string;
  size: number;
  sha256: string;
  bucket: string | null;
  key: string;
  url: string | null;
  source: string;
  /** Only with `withHeroes`: what was found at the URL. */
  found?: "match" | "differs" | "missing";
}

export interface UsageRow {
  list: string;
  code: string;
  count: number;
}

export interface VocabularyPlan {
  federation: string;
  federationId: string;
  existing: number;
  toInsert: number;
  differing: string[];
  usage: UsageRow[];
  orphans: UsageRow[];
  unset: Array<{ list: string; count: number }>;
}

export interface AuthoritySourcePlan {
  federation: string;
  federationId: string;
  existing: number;
  toInsert: number;
  /** Held link templates the data file replaces. */
  toUpdate: Array<{ key: string; id: string; from: string; to: string | null }>;
  differing: string[];
}

export interface FillReport {
  target: Target;
  federation: string;
  generatedAt: string;
  apply: boolean;
  withHeroes: boolean;
  schemaReady: boolean;
  missingSchema: string[];
  membership: Array<{ code: string; federation: string }>;
  repositories: RepositoryPlan[];
  withoutSource: string[];
  notFound: string[];
  funders: FunderPlan[];
  heroes: HeroPlan[];
  /** Fields of the federation's publisher record. */
  federationFields: FieldChange[];
  federationNotes: Array<{ setting: string; value: string; source: string; column: string | null; held: string | null; note: string }>;
  vocabularySeed: Array<VocabularySeedEntry>;
  vocabularies: VocabularyPlan[];
  authoritySourceSeed: Array<{ key: string; labelEs: string | null; labelEn: string | null; urlTemplate: string | null; appliesTo: string[]; source: string }>;
  authoritySources: AuthoritySourcePlan[];
  gaps: string[];
  statements: string[];
  applied: boolean;
  verified: boolean | null;
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/** Strips quoted strings, so a `;` inside a literal is not taken for a second statement. */
const unquoted = (sql: string) => sql.replace(/'(?:[^']|'')*'/g, "''").replace(/"(?:[^"]|"")*"/g, '""');

/** A reader that refuses any statement but a single SELECT. */
export function selectOnly(reader: RowReader): RowReader {
  return async (sql) => {
    const bare = unquoted(sql).trim().replace(/;\s*$/, "");
    if (!/^SELECT\b/i.test(bare) || bare.includes(";")) {
      throw new FillStop(`Only single SELECTs are read; refused: ${sql.slice(0, 120)}`);
    }
    return reader(sql);
  };
}

const text = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));

const REPO_BASE = [
  "id", "tenant_id", "code", "name", "short_name", "country", "city", "address", "website", "rights_text",
  "attribution_en", "attribution_es", "display_title", "subtitle", "hero_image_url", "updated_at",
] as const;
const REPO_0119 = [
  "subtitle_en", "other_names", "region", "history_es", "history_en", "reproduction_services_es", "reproduction_services_en",
  "institution_type", "telephone", "email", "opening_times_es", "opening_times_en", "access_conditions_es", "access_conditions_en",
] as const;
const REPO_0120 = ["home_order"] as const;
const REPO_0121 = ["credit_statement_es", "credit_statement_en"] as const;
/** The federation's hosting statement and the data-file key of each column. */
const FED_0122 = [
  ["hosting_statement_es", "hostingStatementEs"],
  ["hosting_statement_en", "hostingStatementEn"],
] as const;
const TABLES_0119 = ["repository_funders", "vocabulary_values", "authority_sources"] as const;

/** Repository columns that hold integers; their values are written and compared as numbers. */
const INTEGER_COLUMNS = new Set<string>(["home_order"]);
const sqlValue = (column: string, v: string | null) => (v !== null && INTEGER_COLUMNS.has(column) ? Number(v) : v);
/**
 * A held value as the guard compares it: an integer column's value is a
 * number only when it reads as one. SQLite keeps a blank or other text in
 * an INTEGER column as text, so converting it would make the guard fail on
 * a row nobody changed.
 */
const heldSqlValue = (column: string, v: string | null) =>
  v !== null && INTEGER_COLUMNS.has(column) && /^-?\d+$/.test(v.trim()) ? Number(v) : v;

/** The federation of a repository's tenant, as a guard reads it. */
const FEDERATION_OF_TENANT = "(SELECT tenants.federation_id FROM tenants WHERE tenants.id = t.tenant_id)";

/**
 * The repository columns the guards compare, before and after: its
 * identity (id, tenant, code and the tenant's federation), the source
 * text the values were cut from, and every column written.
 */
const GUARD_COLUMNS = [...new Set([
  "id", "tenant_id", "code", FEDERATION_OF_TENANT, "rights_text", "attribution_en", "display_title", "subtitle", "region", "reproduction_services_es", "hero_image_url",
  "home_order", ...FACT_COLUMNS,
])];

/** The columns of a held funder, vocabulary value or authority source the guards compare. */
const FUNDER_COLUMNS = ["id", "repository_id", "name", "programme", "project_id", "url", "position"] as const;
const VALUE_COLUMNS = [
  "id", "federation_id", "list", "code", "label_es", "label_en", "group_code", "position",
  "external_scheme", "external_uri", "external_label", "status",
] as const;
const SOURCE_COLUMNS = [
  "id", "federation_id", "key", "label_es", "label_en", "url_template", "applies_to", "position", "status",
] as const;
const INTEGER_HELD = new Set<string>(["position"]);

/** A held row's values in `columns` order, integers as numbers. */
const heldValuesOf = (row: Record<string, unknown>, columns: readonly string[]) =>
  columns.map((c) => {
    const v = row[c];
    if (v === null || v === undefined) return null;
    return INTEGER_HELD.has(c) ? Number(v) : String(v);
  });

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

/** Stops on any data-file value without a source. */
export function validateSources(src: InstitutionSource): void {
  const missing: string[] = [];
  const need = (where: string, s: string | undefined) => {
    if (!s || !s.trim()) missing.push(where);
  };
  for (const [code, r] of Object.entries(src.repositories)) {
    need(`${code}.displayTitle`, r.displayTitle.source);
    need(`${code}.subtitle`, r.subtitle.source);
    if (r.subtitle.replaces !== undefined) need(`${code}.subtitle.replaces`, r.subtitle.replaces);
    need(`${code}.homeOrder`, r.homeOrder.source);
    if (r.region) need(`${code}.region`, r.region.source);
    need(`${code}.hero`, r.hero.source);
    for (const { key } of REPOSITORY_FACTS) {
      const entry = r[key] as { source: string; replaces?: string } | undefined;
      if (entry) need(`${code}.${key}`, entry.source);
      if (entry?.replaces !== undefined) need(`${code}.${key}.replaces`, entry.replaces);
    }
    (r.funders ?? []).forEach((f, i) => {
      if (f.kind === "d1") {
        need(`${code}.funders[${i}]`, f.source);
        if (f.evidence.length === 0) missing.push(`${code}.funders[${i}].evidence`);
      } else {
        need(`${code}.funders[${i}].sourceUrl`, f.sourceUrl);
        need(`${code}.funders[${i}].quote`, f.quote);
        need(`${code}.funders[${i}].ruling`, f.ruling);
      }
    });
  }
  if (src.publisher.publisherEmail) need("publisher.publisherEmail", src.publisher.publisherEmail.source);
  for (const [, key] of FED_0122) {
    const entry = src.publisher[key];
    if (entry) need(`publisher.${key}`, entry.source);
  }
  need("reproductionServices", src.reproductionServices.source);
  src.federationNotes.forEach((n, i) => need(`federationNotes[${i}]`, n.source));
  for (const [code, t] of Object.entries(PLACE_TYPE_TERMS)) need(`placeTypeTerms.${code}`, t.source);
  for (const s of AUTHORITY_SOURCES) {
    need(`authoritySources.${s.key}.template`, s.templateSource);
    need(`authoritySources.${s.key}.appliesTo`, s.appliesToSource);
    if (s.replacesTemplate) need(`authoritySources.${s.key}.replacesTemplate`, s.replacesTemplate.source);
  }
  if (missing.length > 0) throw new FillStop(`Data entries without a source: ${missing.join(", ")}. Nothing written.`);
}

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/** `file:line` of a key in a locale file, or the file alone when the key is not found as written. */
function keySource(file: string, key: string): string {
  try {
    const lines = fs.readFileSync(path.join(REPO_ROOT, file), "utf8").split("\n");
    const pattern = new RegExp(`^\\s*(?:"${key.replace(/\./g, "\\.")}"|${key.replace(/\./g, "\\.")})\\s*:`);
    const i = lines.findIndex((l) => pattern.test(l));
    return i >= 0 ? `${file}:${i + 1}` : `${file} (${key})`;
  } catch {
    return `${file} (${key})`;
  }
}

type Labels = Record<string, unknown>;
const label = (bundle: Labels, key: string): string | null => {
  const v = bundle[key];
  return typeof v === "string" && v.length > 0 ? v : null;
};

export interface VocabularySeedEntry {
  list: "entity_type" | "place_type" | "entity_role" | "place_role" | "role_group";
  code: string;
  labelEs: string | null;
  labelEn: string | null;
  groupCode: string | null;
  position: number;
  externalScheme: string | null;
  externalUri: string | null;
  externalLabel: string | null;
  source: string;
}

/** The values every federation's lists start from, with the source of each label. */
export function vocabularyEntries(): VocabularySeedEntry[] {
  const out: VocabularySeedEntry[] = [];
  const add = (
    list: VocabularySeedEntry["list"],
    code: string,
    position: number,
    ns: "entities" | "places" | "descriptions",
    key: string,
    groupCode: string | null = null,
  ) => {
    const [es, en] =
      ns === "entities" ? [esEntities, enEntities] : ns === "places" ? [esPlaces, enPlaces] : [esDescriptions, enDescriptions];
    const term = list === "place_type" ? PLACE_TYPE_TERMS[code] : undefined;
    out.push({
      list,
      code,
      labelEs: label(es as Labels, key),
      labelEn: label(en as Labels, key),
      groupCode,
      position,
      externalScheme: term?.scheme ?? null,
      externalUri: term?.uri ?? null,
      externalLabel: term?.label ?? null,
      source:
        `code: app/lib/validation/enums.ts; labels: ${keySource(`app/locales/es/${ns}.ts`, key)}, ${keySource(`app/locales/en/${ns}.ts`, key)}` +
        (term ? `; external term: ${term.source}` : ""),
    });
  };
  ENTITY_TYPES.forEach((c, i) => add("entity_type", c, i + 1, "entities", c));
  PLACE_TYPES.forEach((c, i) => add("place_type", c, i + 1, "places", c));
  ENTITY_ROLE_GROUPS.forEach((g, i) => add("role_group", g.key, i + 1, "descriptions", `role_group_${g.key}`));
  for (const g of ENTITY_ROLE_GROUPS) g.roles.forEach((r, i) => add("entity_role", r, i + 1, "descriptions", `role_${r}`, g.key));
  PLACE_ROLES.forEach((c, i) => add("place_role", c, i + 1, "descriptions", `role_${c}`));
  return out;
}

/** The rows of one federation's seed, as `vocabulary_values` takes them. */
export function vocabularySeed(federationId: string, now: number, newId: () => string) {
  return vocabularyEntries().map((e) => ({
    id: newId(),
    federationId,
    list: e.list,
    code: e.code,
    labelEs: e.labelEs,
    labelEn: e.labelEn,
    groupCode: e.groupCode,
    position: e.position,
    externalScheme: e.externalScheme,
    externalUri: e.externalUri,
    externalLabel: e.externalLabel,
    status: "approved" as const,
    createdAt: now,
    updatedAt: now,
  }));
}

function authoritySourceEntries() {
  return AUTHORITY_SOURCES.map((s, i) => {
    const [es, en] = s.labelFile === "entities" ? [esEntities, enEntities] : [esPlaces, enPlaces];
    return {
      key: s.key,
      labelEs: label(es as Labels, s.labelKey),
      labelEn: label(en as Labels, s.labelKey),
      urlTemplate: s.urlTemplate,
      replaces: s.replacesTemplate?.value ?? null,
      appliesTo: [...s.appliesTo],
      position: i + 1,
      source:
        `template: ${s.templateSource}` +
        `${s.replacesTemplate ? `, replacing ${s.replacesTemplate.value} (${s.replacesTemplate.source})` : ""}; ` +
        `labels: ${keySource(`app/locales/es/${s.labelFile}.ts`, s.labelKey)}, ` +
        `${keySource(`app/locales/en/${s.labelFile}.ts`, s.labelKey)}; applies to: ${s.appliesToSource}`,
    };
  });
}

// ---------------------------------------------------------------------------
// Statements
// ---------------------------------------------------------------------------

/**
 * Multi-row inserts of `rows` into `table`, each naming at most
 * `MAX_PARAMS` values, rendered as SQL text.
 */
export function insertStatements(table: SQLiteTable, rows: Record<string, unknown>[]): Array<{ sql: string; params: number }> {
  if (rows.length === 0) return [];
  const db = composer();
  const perRow = db.insert(table).values(rows[0] as any).toSQL().params.length;
  const fit = Math.max(1, Math.floor(MAX_PARAMS / perRow));
  return chunks(rows, fit).map((part) => {
    const builder = db.insert(table).values(part as any);
    return { sql: render(builder), params: builder.toSQL().params.length };
  });
}

const bumpUpdatedAt = (now: number) => `updated_at = CASE WHEN updated_at >= ${now} THEN updated_at + 1 ELSE ${now} END`;

// ---------------------------------------------------------------------------
// The plan
// ---------------------------------------------------------------------------

interface RepoRead {
  values: Record<string, string | null>;
  updatedAt: number;
  federationId: string;
  federationSlug: string;
}

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

async function plan(options: FillOptions, providers: FillProviders, src: InstitutionSource) {
  const rows = providers.rows;
  const now = providers.now();

  const feds = await rows("SELECT id, slug, name, publisher_name, publisher_tax_id, publisher_location, publisher_url, manifest_bucket, manifest_base_url FROM federations ORDER BY slug");
  const fed = feds.find((f) => f.slug === options.federation);
  if (!fed) throw new FillStop(`No federation ${options.federation} on ${options.target}. Nothing written.`);
  const fedId = String(fed.id);
  const slugOf = new Map(feds.map((f) => [String(f.id), String(f.slug)]));

  // Which 0119, 0120, 0121 and 0122 columns and tables are there.
  const repoColumns = new Set((await rows("SELECT name FROM pragma_table_info('repositories')")).map((r) => String(r.name)));
  const tables = new Set(
    (await rows(`SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (${idList([...TABLES_0119])})`)).map((r) => String(r.name)),
  );
  const missingSchema = [
    ...[...REPO_0119, ...REPO_0120, ...REPO_0121].filter((c) => !repoColumns.has(c)).map((c) => `repositories.${c}`),
    ...TABLES_0119.filter((t) => !tables.has(t)),
  ];
  const fedColumns = new Set((await rows("SELECT name FROM pragma_table_info('federations')")).map((r) => String(r.name)));
  if (!fedColumns.has("publisher_email")) missingSchema.push("federations.publisher_email");
  for (const [column] of FED_0122) if (!fedColumns.has(column)) missingSchema.push(`federations.${column}`);
  const schemaReady = missingSchema.length === 0;
  const fedReadCols = ["publisher_email", ...FED_0122.map(([c]) => c)].filter((c) => fedColumns.has(c));
  const fedHeld = fedReadCols.length > 0
    ? (await rows(`SELECT ${fedReadCols.join(", ")} FROM federations WHERE id = ${escapeSql(fedId)}`))[0] ?? {}
    : {};
  const fedField = (column: string, entry: { value: string; source: string } | undefined) =>
    entry ? compare(column, text(fedHeld[column]), entry.value, entry.source) : compare(column, text(fedHeld[column]), null, "none");
  const federationFields: FieldChange[] = [
    fedField("publisher_email", src.publisher.publisherEmail),
    ...FED_0122.map(([column, key]) => fedField(column, src.publisher[key])),
  ];

  // Repositories, with their federation.
  const readCols = [...REPO_BASE, ...REPO_0119, ...REPO_0120, ...REPO_0121].filter((c) => repoColumns.has(c));
  const repoRows = await rows(
    `SELECT ${readCols.map((c) => `r.${c}`).join(", ")}, t.federation_id AS federation_id FROM repositories r ` +
      `JOIN tenants t ON t.id = r.tenant_id ORDER BY r.code`,
  );
  const repos: RepoRead[] = repoRows.map((r) => {
    const values: Record<string, string | null> = {};
    for (const c of [...REPO_BASE, ...REPO_0119, ...REPO_0120, ...REPO_0121]) values[c] = c === "updated_at" ? null : text(r[c]);
    return {
      values,
      updatedAt: Number(r.updated_at),
      federationId: String(r.federation_id),
      federationSlug: slugOf.get(String(r.federation_id)) ?? "?",
    };
  });
  const membership = repos.map((r) => ({ code: r.values.code!, federation: r.federationSlug }));
  const own = repos.filter((r) => r.federationSlug === options.federation);
  const withoutSource = own.filter((r) => !src.repositories[r.values.code!]).map((r) => r.values.code!);
  const notFound = Object.keys(src.repositories).filter((c) => !own.some((r) => r.values.code === c));
  const targets = own.filter((r) => src.repositories[r.values.code!]);

  const funderRows = tables.has("repository_funders") && targets.length > 0
    ? await rows(`SELECT id, repository_id, name, programme, project_id, url, position FROM repository_funders WHERE repository_id IN (${idList(targets.map((r) => r.values.id!))})`)
    : [];

  const base = text(fed.manifest_base_url)?.replace(/\/+$/, "") ?? null;
  const gaps: string[] = [];
  const repositories: RepositoryPlan[] = [];
  const funders: FunderPlan[] = [];
  const heroes: HeroPlan[] = [];

  for (const r of targets) {
    const v = r.values;
    const code = v.code!;
    const s = src.repositories[code];
    const fields = repositoryFields(src, code, v);

    // Hero image.
    const key = `institutions/${code}/hero.${s.hero.ext}`;
    const url = base ? `${base}/${key}` : null;
    const hero: HeroPlan = {
      code,
      sourcePath: s.hero.path,
      templatePath: s.hero.templatePath,
      size: s.hero.size,
      sha256: s.hero.sha256,
      bucket: text(fed.manifest_bucket),
      key,
      url,
      source: s.hero.source,
    };
    if (options.withHeroes) {
      if (url === null) {
        fields.push(compare("hero_image_url", v.hero_image_url, null, "none: the federation has no manifest_base_url"));
      } else {
        const bytes = await providers.fetchObject(url);
        hero.found = bytes === null ? "missing" : bytes.length === s.hero.size && sha256(bytes) === s.hero.sha256 ? "match" : "differs";
        if (hero.found === "match") {
          fields.push(compare("hero_image_url", v.hero_image_url, url, `uploaded from ${s.hero.path} (${s.hero.source})`));
        } else {
          fields.push({ column: "hero_image_url", current: v.hero_image_url, proposed: null, source: s.hero.source, action: "gap", note: `object ${hero.found} at ${url}` });
        }
      }
    }
    heroes.push(hero);

    // Funders: the list, where there is one, is the whole set.
    if (s.funders) appendAll(funders, planFunders(code, v, s.funders, funderRows.filter((f) => String(f.repository_id) === v.id), gaps));
    repositories.push({ code, id: v.id!, tenant: v.tenant_id!, fields });
  }

  // Vocabularies and authority sources, for every federation.
  const entries = vocabularyEntries();
  const sourceEntries = authoritySourceEntries();
  const heldValues = tables.has("vocabulary_values")
    ? await rows(`SELECT ${VALUE_COLUMNS.join(", ")} FROM vocabulary_values`)
    : [];
  const heldSources = tables.has("authority_sources")
    ? await rows(`SELECT ${SOURCE_COLUMNS.join(", ")} FROM authority_sources`)
    : [];
  const usageRows = [
    ...(await rows("SELECT 'entity_type' AS list, federation_id, entity_type AS code, count(*) AS n FROM entities GROUP BY federation_id, entity_type")),
    ...(await rows("SELECT 'place_type' AS list, federation_id, place_type AS code, count(*) AS n FROM places GROUP BY federation_id, place_type")),
    ...(await rows(
      "SELECT 'entity_role' AS list, t.federation_id AS federation_id, de.role AS code, count(*) AS n FROM description_entities de " +
        "JOIN descriptions d ON d.id = de.description_id JOIN tenants t ON t.id = d.tenant_id GROUP BY t.federation_id, de.role",
    )),
    ...(await rows(
      "SELECT 'place_role' AS list, t.federation_id AS federation_id, dp.role AS code, count(*) AS n FROM description_places dp " +
        "JOIN descriptions d ON d.id = dp.description_id JOIN tenants t ON t.id = d.tenant_id GROUP BY t.federation_id, dp.role",
    )),
  ];
  const known = new Set(entries.map((e) => `${e.list}:${e.code}`));

  const vocabularies: VocabularyPlan[] = [];
  const authority: AuthoritySourcePlan[] = [];
  const vocabInserts: Array<ReturnType<typeof vocabularySeed>[number]> = [];
  const sourceInserts: Array<Record<string, unknown>> = [];
  for (const f of feds) {
    const id = String(f.id);
    const slug = String(f.slug);
    const mine = heldValues.filter((h) => String(h.federation_id) === id);
    const differing: string[] = [];
    let toInsert = 0;
    const seed = vocabularySeed(id, now, providers.newId);
    for (const row of seed) {
      const h = mine.find((x) => x.list === row.list && x.code === row.code);
      if (!h) {
        vocabInserts.push(row);
        toInsert++;
      } else if (text(h.label_es) !== row.labelEs || text(h.label_en) !== row.labelEn || text(h.group_code) !== row.groupCode || text(h.external_uri) !== row.externalUri) {
        differing.push(`${row.list}:${row.code}`);
      }
    }
    const usage = usageRows
      .filter((u) => String(u.federation_id) === id && u.code !== null)
      .map((u) => ({ list: String(u.list), code: String(u.code), count: Number(u.n) }));
    vocabularies.push({
      federation: slug,
      federationId: id,
      existing: mine.length,
      toInsert,
      differing,
      usage,
      orphans: usage.filter((u) => !known.has(`${u.list}:${u.code}`) && !mine.some((h) => h.list === u.list && h.code === u.code)),
      unset: usageRows
        .filter((u) => String(u.federation_id) === id && u.code === null)
        .map((u) => ({ list: String(u.list), count: Number(u.n) })),
    });

    const mineSources = heldSources.filter((h) => String(h.federation_id) === id);
    const srcDiffering: string[] = [];
    const srcUpdate: AuthoritySourcePlan["toUpdate"] = [];
    let srcInsert = 0;
    for (const e of sourceEntries) {
      const h = mineSources.find((x) => x.key === e.key);
      if (!h) {
        sourceInserts.push({
          id: providers.newId(),
          federationId: id,
          key: e.key,
          labelEs: e.labelEs,
          labelEn: e.labelEn,
          urlTemplate: e.urlTemplate,
          appliesTo: JSON.stringify(e.appliesTo),
          position: e.position,
          status: "approved",
        });
        srcInsert++;
      } else {
        const replace = e.replaces !== null && text(h.url_template) === e.replaces;
        if (replace) srcUpdate.push({ key: e.key, id: String(h.id), from: e.replaces!, to: e.urlTemplate });
        if (
          (!replace && text(h.url_template) !== e.urlTemplate) || text(h.label_es) !== e.labelEs || text(h.label_en) !== e.labelEn ||
          text(h.applies_to) !== JSON.stringify(e.appliesTo) || Number(h.position) !== e.position
        ) {
          srcDiffering.push(e.key);
        }
      }
    }
    authority.push({ federation: slug, federationId: id, existing: mineSources.length, toInsert: srcInsert, toUpdate: srcUpdate, differing: srcDiffering });
  }

  // Federation notes: what the instance names, against what the federation holds.
  const composedCreator = [
    text(fed.publisher_name),
    fed.publisher_tax_id ? ` (${fed.publisher_tax_id})` : "",
    fed.publisher_location ? `, ${fed.publisher_location}` : "",
  ].join("");
  const federationNotes = src.federationNotes.map((n) => {
    const held =
      n.setting === "mets_creator_name" ? composedCreator
        : n.column === "publisher_url" ? text(fed.publisher_url)
          : n.column === "publisher_name" ? text(fed.publisher_name)
            : null;
    return { ...n, held };
  });

  // Gaps that hold whatever was read.
  for (const e of entries) {
    if (!e.labelEs) gaps.push(`${e.list}:${e.code} has no Spanish label in the locale files`);
    if (!e.labelEn) gaps.push(`${e.list}:${e.code} has no English label in the locale files`);
  }
  for (const s of sourceEntries) {
    if (!s.labelEs || !s.labelEn) gaps.push(`authority source ${s.key} lacks a label in the locale files`);
  }
  for (const r of repositories) {
    for (const f of r.fields) if (f.action === "gap") gaps.push(`${r.code}.${f.column}: ${f.note ?? f.source}`);
  }
  for (const code of withoutSource) gaps.push(`${code}: no entry in the data file; nothing filled`);
  for (const f of federationFields) if (f.action === "gap") gaps.push(`federation.${f.column}: no source`);

  // The SQL file.
  const sql: string[] = [];
  const written = repositories.filter((r) => r.fields.some(isWrite));
  const funderInserts = funders.filter((f) => f.action === "insert");
  const funderDeletes = funders.filter((f) => f.action === "delete");
  const funderChanges = [...funderInserts, ...funderDeletes];
  const guarded = repositories.filter((r) => written.includes(r) || funderChanges.some((f) => f.code === r.code));
  const valuesOf = (r: RepositoryPlan, after: boolean) => {
    const target = targets.find((t) => t.values.id === r.id)!;
    const read = target.values;
    return GUARD_COLUMNS.map((c) => {
      if (c === FEDERATION_OF_TENANT) return target.federationId;
      const f = r.fields.find((x) => x.column === c);
      return after && f && isWrite(f) ? sqlValue(c, f.proposed) : heldSqlValue(c, read[c]);
    });
  };
  if (guarded.length > 0) {
    appendAll(sql, matchingGuards("repositories", GUARD_COLUMNS, guarded.map((r) => valuesOf(r, false)), "a repository has changed since it was read"));
  }
  const funderCount = (id: string) => funderRows.filter((f) => String(f.repository_id) === id).length;
  const funderRepos = [...new Set(funderChanges.map((f) => f.repositoryId))];
  // Held rows: each still there with the values read, and no row added,
  // for every repository filled and every federation, whether or not it
  // has rows to insert.
  const snapshotRepos = targets.map((t) => t.values.id!);
  for (const id of snapshotRepos) {
    const held = funderRows.filter((f) => String(f.repository_id) === id);
    sql.push(guard(`(SELECT count(*) FROM repository_funders WHERE repository_id = ${escapeSql(id)}) = ${held.length}`, "a repository's funders have changed since they were read"));
    if (held.length > 0) {
      appendAll(sql, matchingGuards("repository_funders", FUNDER_COLUMNS, held.map((h) => heldValuesOf(h, FUNDER_COLUMNS)), "a repository's funders have changed since they were read"));
    }
  }
  for (const f of funderInserts) {
    sql.push(guard(
      `(SELECT count(*) FROM repository_funders WHERE repository_id = ${escapeSql(f.repositoryId)} ` +
        `AND name IS ${escapeSql(f.name)}) = 0`,
      "a funder to be inserted is already there",
    ));
  }
  for (const v of vocabularies) {
    const held = heldValues.filter((h) => String(h.federation_id) === v.federationId);
    sql.push(guard(`(SELECT count(*) FROM vocabulary_values WHERE federation_id = ${escapeSql(v.federationId)}) = ${v.existing}`, "a federation's vocabulary values have changed since they were read"));
    if (held.length > 0) {
      appendAll(sql, matchingGuards("vocabulary_values", VALUE_COLUMNS, held.map((h) => heldValuesOf(h, VALUE_COLUMNS)), "a federation's vocabulary values have changed since they were read"));
    }
  }
  for (const a of authority) {
    const held = heldSources.filter((h) => String(h.federation_id) === a.federationId);
    sql.push(guard(`(SELECT count(*) FROM authority_sources WHERE federation_id = ${escapeSql(a.federationId)}) = ${a.existing}`, "a federation's authority sources have changed since they were read"));
    if (held.length > 0) {
      appendAll(sql, matchingGuards("authority_sources", SOURCE_COLUMNS, held.map((h) => heldValuesOf(h, SOURCE_COLUMNS)), "a federation's authority sources have changed since they were read"));
    }
  }
  const fedSets = federationFields.filter((f) => f.action === "set");
  if (fedSets.length > 0) {
    sql.push(guard(
      `(SELECT count(*) FROM federations WHERE id = ${escapeSql(fedId)} AND ${fedSets.map((f) => emptyCondition(f.column)).join(" AND ")}) = 1`,
      "the federation has changed since it was read",
    ));
    sql.push(
      `UPDATE federations SET ${fedSets.map((f) => `${f.column} = ${escapeSql(f.proposed)}`).join(", ")} ` +
        `WHERE id = ${escapeSql(fedId)} AND ${fedSets.map((f) => emptyCondition(f.column)).join(" AND ")};`,
    );
  }
  for (const r of written) {
    const sets = r.fields.filter(isWrite);
    // A set is guarded on the column being empty, a replacement on its holding the exact previous text.
    const held = (f: FieldChange) => (f.action === "replace" ? `${f.column} = ${escapeSql(f.replaces!)}` : emptyCondition(f.column));
    sql.push(
      `UPDATE repositories SET ${sets.map((f) => `${f.column} = ${escapeSql(sqlValue(f.column, f.proposed))}`).join(", ")}, ${bumpUpdatedAt(now)} ` +
        `WHERE id = ${escapeSql(r.id)} AND tenant_id = ${escapeSql(r.tenant)} AND code = ${escapeSql(r.code)} ` +
        `AND ${sets.map(held).join(" AND ")};`,
    );
  }
  for (const f of funderDeletes) {
    const read = funderRows.find((h) => String(h.id) === f.id)!;
    const values = heldValuesOf(read, FUNDER_COLUMNS);
    sql.push(`DELETE FROM repository_funders WHERE ${FUNDER_COLUMNS.map((c, i) => `${c} IS ${escapeSql(values[i])}`).join(" AND ")};`);
  }
  appendAll(sql, insertStatements(repositoryFunders, funderInserts.map((f) => ({
    id: providers.newId(),
    repositoryId: f.repositoryId,
    name: f.name,
    programme: f.programme,
    projectId: f.projectId,
    url: f.url,
    position: f.position,
  }))).map((s) => s.sql));
  appendAll(sql, insertStatements(vocabularyValues, vocabInserts).map((s) => s.sql));
  appendAll(sql, insertStatements(authoritySources, sourceInserts).map((s) => s.sql));
  const sourceUpdates = authority.flatMap((a) => a.toUpdate);
  for (const u of sourceUpdates) {
    sql.push(`UPDATE authority_sources SET url_template = ${escapeSql(u.to)} WHERE id = ${escapeSql(u.id)} AND url_template = ${escapeSql(u.from)};`);
  }
  if (written.length > 0) {
    appendAll(sql, matchingGuards("repositories", GUARD_COLUMNS, written.map((r) => valuesOf(r, true)), "a repository does not hold the values written"));
    for (const r of written) {
      const before = targets.find((t) => t.values.id === r.id)!.updatedAt;
      sql.push(guard(`(SELECT updated_at FROM repositories WHERE id = ${escapeSql(r.id)}) > ${before}`, "a repository's updated_at did not move"));
    }
  }
  if (fedSets.length > 0) {
    sql.push(guard(
      `(SELECT count(*) FROM federations WHERE id = ${escapeSql(fedId)} AND ${fedSets.map((f) => `${f.column} = ${escapeSql(f.proposed)}`).join(" AND ")}) = 1`,
      "the federation does not hold the values written",
    ));
  }
  for (const id of funderRepos) {
    const n = funderCount(id) + funderInserts.filter((f) => f.repositoryId === id).length - funderDeletes.filter((f) => f.repositoryId === id).length;
    sql.push(guard(`(SELECT count(*) FROM repository_funders WHERE repository_id = ${escapeSql(id)}) = ${n}`, "a repository's funders are not all there"));
  }
  if (funderDeletes.length > 0) {
    sql.push(guard(`(SELECT count(*) FROM repository_funders WHERE id IN (${idList(funderDeletes.map((f) => f.id!))})) = 0`, "a funder to be deleted is still there"));
  }
  for (const v of vocabularies.filter((x) => x.toInsert > 0)) {
    sql.push(guard(`(SELECT count(*) FROM vocabulary_values WHERE federation_id = ${escapeSql(v.federationId)}) = ${v.existing + v.toInsert}`, "a federation's vocabulary values are not all there"));
  }
  for (const a of authority.filter((x) => x.toInsert > 0)) {
    sql.push(guard(`(SELECT count(*) FROM authority_sources WHERE federation_id = ${escapeSql(a.federationId)}) = ${a.existing + a.toInsert}`, "a federation's authority sources are not all there"));
  }
  for (const u of sourceUpdates) {
    sql.push(guard(`(SELECT count(*) FROM authority_sources WHERE id = ${escapeSql(u.id)} AND url_template IS ${escapeSql(u.to)}) = 1`, "an authority source does not hold the template written"));
  }
  // Statements of the file other than the guards and inserts above only when there is something to write.
  const writes = fedSets.length + written.length + funderChanges.length + vocabInserts.length + sourceInserts.length + sourceUpdates.length;

  const report: FillReport = {
    target: options.target,
    federation: options.federation,
    generatedAt: new Date(now).toISOString(),
    apply: options.apply,
    withHeroes: options.withHeroes,
    schemaReady,
    missingSchema,
    membership,
    repositories,
    withoutSource,
    notFound,
    funders,
    heroes,
    federationFields,
    federationNotes,
    vocabularySeed: entries,
    vocabularies,
    authoritySourceSeed: sourceEntries.map(({ position: _p, replaces: _r, ...rest }) => rest),
    authoritySources: authority,
    gaps: [...gaps, ...STANDING_GAPS(src)],
    statements: writes > 0 ? sql : [],
    applied: false,
    verified: null,
  };
  return report;
}

/** Gaps no source in reach fills, whatever the database holds. */
function STANDING_GAPS(src: InstitutionSource): string[] {
  const out = [
    "every repository the data file names none for: short_name, other_names, institution_type, address, email, website, telephone, history_es, history_en, opening_times_es, opening_times_en, access_conditions_es, access_conditions_en, credit_statement_es, credit_statement_en, subtitle_en, reproduction_services_en",
    "every repository: logo_key, postal_code, holdings, accessibility, description_language (no source)",
    "every repository: repositories.catalogue_licence_uri (no source; mets_default_rights is prose, not a licence URI, and no URI is stored anywhere)",
    "federation: publisher_logo_key, description_es/en, terms_of_use_es/en, privacy_es/en, takedown_es/en, federation_credits (no source)",
    "federation: citation_template_site_es, citation_template_site_en, citation_template_record_es, citation_template_record_en (no source)",
    `place types without an external term: ${PLACE_TYPES.filter((t) => !PLACE_TYPE_TERMS[t]).join(", ")}`,
    "the three AAT URIs are taken from the engine script and have not been checked against the AAT",
    "authority sources not seeded: lcnaf, lcsh, geonames (link templates at app/routes/_auth.admin.decisions.$id.tsx:80-83, for reconciliation candidates; no locale labels; the record types they apply to are not fixed in code)",
  ];
  for (const [code, r] of Object.entries(src.repositories)) {
    for (const f of r.funders ?? []) if (!f.url) out.push(`${code}: funder ${f.name} has no URL in any source`);
  }
  return out;
}

// ---------------------------------------------------------------------------
// The files
// ---------------------------------------------------------------------------

/** The files' path, without extension. */
export function reportBase(options: FillOptions, now: number): string {
  const stamp = new Date(now).toISOString().replace(/:/g, "-").replace(/\.\d+Z$/, "Z");
  return path.join(options.outDir, `fill-institution-records_${options.federation}_${options.target}_${stamp}`);
}

// ---------------------------------------------------------------------------
// The command
// ---------------------------------------------------------------------------

/**
 * Plan the fill and, with `apply`, write it. Writes the SQL file (when
 * there is anything to write), the report and the hero upload plan, and
 * returns the report.
 */
export async function fillInstitutionRecords(
  options: FillOptions,
  providers: FillProviders,
  log: (line: string) => void,
  source?: InstitutionSource,
): Promise<FillReport> {
  const src = source ?? INSTITUTION_SOURCES[options.federation];
  if (!src) throw new FillStop(`No data file for the federation ${options.federation}. Nothing written.`);
  validateSources(src);
  const guarded: FillProviders = { ...providers, rows: selectOnly(providers.rows) };
  const report = await plan(options, guarded, src);
  const now = providers.now();
  const base = reportBase(options, now);

  log(`Fill institution records — ${options.federation}, ${options.target}${options.apply ? "" : " (dry run)"}`);
  if (!report.schemaReady) log(`  schema incomplete (0119/0120/0121/0122): ${report.missingSchema.join(", ")}`);
  for (const r of report.repositories) {
    const of = (a: string) => r.fields.filter((f) => f.action === a).map((f) => f.column);
    const [set, replace, differs] = [of("set"), of("replace"), of("differs")];
    log(
      `  ${r.code}: set ${set.join(", ") || "nothing"}${replace.length ? `; replace ${replace.join(", ")}` : ""}` +
        `${differs.length ? `; differs, left alone: ${differs.join(", ")}` : ""}`,
    );
  }
  for (const f of report.federationFields) log(`  federation ${f.column}: ${f.action}`);
  log(`  funders to insert: ${report.funders.filter((f) => f.action === "insert").length}; to delete: ${report.funders.filter((f) => f.action === "delete").length}`);
  for (const f of report.funders) if (f.action === "insert" || f.action === "delete") log(`  ${funderLine(f)}`);
  for (const v of report.vocabularies) log(`  ${v.federation}: ${v.toInsert} vocabulary value(s) to insert, ${v.existing} held`);
  for (const a of report.authoritySources) {
    const replaced = a.toUpdate.length ? `, ${a.toUpdate.length} template(s) to replace (${a.toUpdate.map((u) => u.key).join(", ")})` : "";
    log(`  ${a.federation}: ${a.toInsert} authority source(s) to insert${replaced}, ${a.existing} held`);
  }
  log(`  gaps: ${report.gaps.length}`);

  const writeReport = () => {
    providers.writeFile(`${base}.json`, JSON.stringify(report, null, 2) + "\n");
    providers.writeFile(`${base}.md`, renderReport(report));
    providers.writeFile(`${base}_heroes.json`, JSON.stringify(report.heroes, null, 2) + "\n");
    providers.writeFile(`${base}_heroes.md`, renderHeroPlan(report));
  };
  const file = `${base}.sql`;
  if (report.statements.length > 0) providers.writeFile(file, report.statements.join("\n") + "\n");
  writeReport();
  log(`Report: ${base}.md`);

  // A hero run checks its objects whether or not anything else is left to write.
  if (options.apply && options.withHeroes) {
    const bad = report.heroes.filter((h) => h.found !== "match");
    if (bad.length > 0) {
      throw new FillStop(`Hero object(s) not found as planned: ${bad.map((h) => `${h.code} (${h.found ?? "no URL"})`).join(", ")}. Nothing written.`);
    }
  }
  if (report.statements.length === 0) {
    log("Nothing to write.");
    return report;
  }
  log(`SQL: ${file} (${report.statements.length} statements)`);
  if (!options.apply) return report;

  if (!report.schemaReady) throw new FillStop(`Migrations 0119, 0120, 0121 and 0122 are not all applied on ${options.target} (missing: ${report.missingSchema.join(", ")}). Nothing written.`);
  await providers.applyFile(file, report.statements);
  report.applied = true;

  const again = await plan({ ...options, apply: false }, guarded, src);
  report.verified = again.statements.length === 0;
  log(report.verified ? "Re-read: nothing left to write." : `Re-read: ${again.statements.length} statement(s) still planned.`);
  writeReport();
  return report;
}

// @version v0.9.0
