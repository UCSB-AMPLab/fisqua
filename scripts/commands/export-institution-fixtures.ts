#!/usr/bin/env npx tsx
/**
 * Institution Records — Write the Export Records as Fixtures
 *
 * Each export will publish three institution records beside the catalogue:
 * the federation as publisher (`publisher.json`), the full record of every
 * repository (`repositories.json`), and the federation's controlled lists
 * and authority sources (`vocabulary.json`). Before the export pipeline
 * writes them, the site that reads them needs real examples to agree on.
 * This script reads one federation and one of its repositories from a
 * database and writes the three records as files, built by the same
 * functions the pipeline will use (`app/lib/export/institution-records.server.ts`).
 *
 * It only reads. Every query passes through `selectOnly`, which refuses
 * anything but a single SELECT, and goes to D1 through
 * `wrangler d1 execute --json --command`. The repository is looked up by
 * its code among the federation's own tenants, and the command stops when
 * the code is missing or names more than one repository there.
 *
 * Output, in the directory `--out` names:
 *   - `publisher.json`
 *   - `vocabulary.json`
 *   - `repository-<code>.json`, the one record as it would appear in the
 *     `repositories.json` array
 *
 * The repository fixture's `description_count` counts every description
 * whose `repository_id` is the repository's, whatever its publication
 * state, and its `root_descriptions` is left empty: building those is the
 * pipeline's work and the fixture omits them. The command says so when it
 * finishes.
 *
 * With `--compare`, it writes no files and needs no `--repository` or
 * `--out`. It prints a table with two rows for every repository of the
 * federation, one per language: the attribution line composed from the
 * stored facts and the federation's hosting statement, the stored
 * override (`attribution_es`, `attribution_en`), and whether the two are
 * identical. The table is for checking the composed lines against the
 * hand-written ones before the overrides are cleared.
 *
 * Both modes read the federation's hosting statement only where the
 * database has migration 0122's columns. Without them the line is
 * composed without the statement, and the command says so before the
 * table or the files, so a run against a database not yet migrated
 * still works.
 *
 * Credentials: wrangler's own login, for D1.
 *
 * Usage:
 *   npx tsx scripts/commands/export-institution-fixtures.ts --target production --federation neogranadina --repository co-ahr --out /path/to/dir
 *   npx tsx scripts/commands/export-institution-fixtures.ts --target production --federation neogranadina --compare
 *
 * @version v0.9.0
 */

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import type { CommandRunner } from "../lib/tenant-storage";
import { wranglerRows } from "../lib/capture-registration";
import { selectOnly, type RowReader, type Target } from "../lib/institution-records-fill";
import { escapeSql } from "../lib/sql";
import {
  buildPublisherJson,
  buildRepositoryRecord,
  buildVocabularyJson,
  composeAttribution,
  type AuthoritySourceSource,
  type FederationHosting,
  type CreditSource,
  type FunderSource,
  type PublisherSource,
  type RepositorySource,
  type VocabularyValueSource,
} from "../../app/lib/export/institution-records.server";

export interface FixtureOptions {
  target: Target;
  federation: string;
  repository: string;
  outDir: string;
  /** Print the attribution comparison instead of writing fixtures. */
  compare: boolean;
}

export interface FixtureProviders {
  rows: RowReader;
  writeFile: (file: string, text: string) => void;
}

export function parseArgs(argv: string[]): FixtureOptions {
  let target: string | null = null;
  let federation = "";
  let repository = "";
  let outDir = "";
  let compare = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === "--compare") compare = true;
    else if (a === "--target") target = value();
    else if (a === "--federation") federation = value();
    else if (a === "--repository") repository = value();
    else if (a === "--out") outDir = value();
    else throw new Error(`Unknown argument: ${a}`);
  }
  if (target !== "local" && target !== "staging" && target !== "production") {
    throw new Error("--target is local, staging or production");
  }
  if (!federation) throw new Error("--federation is required");
  if (!compare && !repository) throw new Error("--repository is required");
  if (!compare && !outDir) throw new Error("--out is required");
  return { target, federation, repository, outDir, compare };
}

/** A row with snake_case columns, renamed to the builders' camelCase. */
function camel<T>(row: Record<string, unknown>): T {
  return Object.fromEntries(
    Object.entries(row).map(([k, v]) => [k.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase()), v]),
  ) as T;
}

const FEDERATION_COLUMNS = [
  "id", "slug", "name", "manifest_base_url",
  "publisher_name", "publisher_tax_id", "publisher_location", "publisher_url",
  "publisher_email", "publisher_logo_key",
  "description_es", "description_en", "terms_of_use_es", "terms_of_use_en",
  "privacy_es", "privacy_en", "takedown_es", "takedown_en",
  "citation_template_site_es", "citation_template_site_en",
  "citation_template_record_es", "citation_template_record_en",
];

const REPOSITORY_COLUMNS = [
  "id", "code", "name", "short_name", "country_code", "country", "city", "address", "website",
  "display_title", "subtitle", "subtitle_en", "hero_image_url", "other_names", "institution_type",
  "logo_key", "region", "postal_code", "telephone", "email",
  "holdings_es", "holdings_en", "history_es", "history_en",
  "opening_times_es", "opening_times_en", "access_conditions_es", "access_conditions_en",
  "accessibility_es", "accessibility_en", "reproduction_services_es", "reproduction_services_en",
  "manifest_rights", "catalogue_licence_uri", "attribution_es", "attribution_en",
  "credit_statement_es", "credit_statement_en", "rights_text",
  "description_language", "home_order", "created_at", "updated_at",
];

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

/** The federation's row, or a stop when the slug names none. */
async function federationRow(rows: RowReader, slug: string, columns: string[]): Promise<Record<string, unknown>> {
  const feds = await rows(`SELECT ${columns.join(", ")} FROM federations WHERE slug = ${escapeSql(slug)}`);
  if (feds.length !== 1) throw new Error(`No federation with slug '${slug}'`);
  return feds[0];
}

const HOSTING_COLUMNS = ["hosting_statement_es", "hosting_statement_en"];

/**
 * The federation's hosting statement, or null, with a line said when the
 * database lacks migration 0122's columns.
 */
async function federationHosting(
  rows: RowReader,
  federationId: string,
  log: (line: string) => void,
): Promise<FederationHosting | null> {
  const present = new Set((await rows("SELECT name FROM pragma_table_info('federations')")).map((r) => String(r.name)));
  const missing = HOSTING_COLUMNS.filter((c) => !present.has(c));
  if (missing.length > 0) {
    log(`federations has no ${missing.join(", ")} (migration 0122 not applied): the lines are composed without the hosting statement.`);
    return null;
  }
  const held = await rows(`SELECT ${HOSTING_COLUMNS.join(", ")} FROM federations WHERE id = ${escapeSql(federationId)}`);
  return held.length === 1 ? camel<FederationHosting>(held[0]) : null;
}

export interface AttributionComparison {
  code: string;
  lang: "es" | "en";
  composed: string | null;
  override: string | null;
  /** True only when an override is stored and is identical to the composed line. */
  same: boolean;
}

const cell = (v: string | null) => (v === null ? "(none)" : v.replace(/\|/g, "\\|").replace(/\s*\n\s*/g, " "));

export async function compareAttributions(
  options: Pick<FixtureOptions, "target" | "federation">,
  providers: Pick<FixtureProviders, "rows">,
  log: (line: string) => void,
): Promise<AttributionComparison[]> {
  const rows = selectOnly(providers.rows);
  const fed = await federationRow(rows, options.federation, ["id", "slug"]);
  const repos = await rows(
    `SELECT code, name, city, region, country, country_code, credit_statement_es, credit_statement_en, manifest_rights, attribution_es, attribution_en, home_order FROM repositories WHERE tenant_id IN (SELECT id FROM tenants WHERE federation_id = ${escapeSql(fed.id)}) ORDER BY home_order IS NULL, home_order, name, code`,
  );
  const hosting = await federationHosting(rows, String(fed.id), log);
  const result: AttributionComparison[] = [];
  for (const r of repos) {
    const composed = composeAttribution(camel<RepositorySource>(r), hosting);
    for (const lang of ["es", "en"] as const) {
      const stored = r[`attribution_${lang}`];
      const override = typeof stored === "string" && stored.trim() !== "" ? stored : null;
      result.push({ code: String(r.code), lang, composed: composed[lang], override, same: override !== null && override === composed[lang] });
    }
  }
  log("| Repository | Lang | Composed | Stored override | Same |");
  log("|---|---|---|---|---|");
  for (const c of result) {
    log(`| ${c.code} | ${c.lang} | ${cell(c.composed)} | ${cell(c.override)} | ${c.override === null ? "no override" : c.same ? "yes" : "no"} |`);
  }
  return result;
}

export async function exportInstitutionFixtures(
  options: Omit<FixtureOptions, "compare">,
  providers: FixtureProviders,
  log: (line: string) => void,
): Promise<string[]> {
  const rows = selectOnly(providers.rows);

  const fed = await federationRow(rows, options.federation, FEDERATION_COLUMNS);
  const fedId = escapeSql(fed.id);
  const manifestBaseUrl = (fed.manifest_base_url as string | null) ?? null;

  const credits = await rows(
    `SELECT name, role, url, logo_key, position FROM federation_credits WHERE federation_id = ${fedId} ORDER BY position`,
  );
  const values = await rows(
    `SELECT list, code, label_es, label_en, group_code, position, external_scheme, external_uri, external_label, status, connector_es, connector_en, inverse_code, hide_when_group, label_es_female, label_es_male, label_es_unrecorded, label_es_alone, label_en_female, label_en_male, label_en_unrecorded, label_en_alone FROM vocabulary_values WHERE federation_id = ${fedId}`,
  );
  const sources = await rows(
    `SELECT key, label_es, label_en, url_template, applies_to, position, status FROM authority_sources WHERE federation_id = ${fedId}`,
  );

  const repos = await rows(
    `SELECT ${REPOSITORY_COLUMNS.join(", ")} FROM repositories WHERE code = ${escapeSql(options.repository)} AND tenant_id IN (SELECT id FROM tenants WHERE federation_id = ${fedId})`,
  );
  if (repos.length === 0) {
    throw new Error(`No repository '${options.repository}' in federation '${options.federation}'`);
  }
  if (repos.length > 1) {
    throw new Error(`Repository code '${options.repository}' names ${repos.length} repositories in federation '${options.federation}'`);
  }
  const repo = repos[0];
  const repoId = escapeSql(repo.id);
  const funders = await rows(
    `SELECT name, programme, project_id, url, position FROM repository_funders WHERE repository_id = ${repoId} ORDER BY position`,
  );
  const counted = await rows(`SELECT COUNT(*) AS n FROM descriptions WHERE repository_id = ${repoId}`);
  const descriptionCount = Number(counted[0]?.n ?? 0);
  const hosting = await federationHosting(rows, String(fed.id), log);

  const publisher = buildPublisherJson(
    camel<PublisherSource>(fed),
    credits.map((r) => camel<CreditSource>(r)),
    manifestBaseUrl,
  );
  const vocabulary = buildVocabularyJson(
    values.map((r) => camel<VocabularyValueSource>(r)),
    sources.map((r) => camel<AuthoritySourceSource>(r)),
  );
  const record = buildRepositoryRecord(
    camel<RepositorySource>(repo),
    funders.map((r) => camel<FunderSource>(r)),
    { descriptionCount, rootDescriptions: [] },
    manifestBaseUrl,
    hosting,
  );

  const written = [
    [path.join(options.outDir, "publisher.json"), json(publisher)],
    [path.join(options.outDir, "vocabulary.json"), json(vocabulary)],
    [path.join(options.outDir, `repository-${options.repository}.json`), json(record)],
  ] as const;
  for (const [file, text] of written) {
    providers.writeFile(file, text);
    log(`Wrote ${file}`);
  }
  log(
    `${options.repository}: description_count is ${descriptionCount}, every description with this repository_id; root_descriptions is omitted from the fixture ([]).`,
  );
  return written.map(([file]) => file);
}

const runWrangler: CommandRunner = (command, args, opts) =>
  execFileSync(command, args, {
    encoding: "utf8",
    input: opts.input,
    env: { ...process.env, ...(opts.env ?? {}) },
    stdio: ["pipe", "pipe", "pipe"],
    maxBuffer: 256 * 1024 * 1024,
  });

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.compare) {
    await compareAttributions(options, { rows: wranglerRows(options.target, runWrangler) }, (line) => console.log(line));
    return;
  }
  await exportInstitutionFixtures(
    options,
    {
      rows: wranglerRows(options.target, runWrangler),
      writeFile: (file, text) => {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, text, "utf8");
      },
    },
    (line) => console.log(line),
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error((err as Error).message);
    process.exit(1);
  });
}

// @version v0.9.0
