#!/usr/bin/env npx tsx
/**
 * Manifest Settings — Seed the Seeded Tenants' Values
 *
 * This script fills the manifest settings of the Neogranadina tenant and
 * its four repositories (co-ahrb, co-cihjml, pe-bn, co-ahjci). A pipeline
 * manifest takes its rights and attribution from the volume's repository
 * and its public site, provider and METS link from the tenant. Every
 * repository and tenant starts with these settings empty, and dispatch
 * refuses the volumes of a repository without rights. The script fills
 * them with the values their published manifests carry now, so a pipeline
 * manifest for one of their volumes says what the existing ones say. Every
 * other tenant and repository is left alone; they set their own values on
 * the forms.
 *
 * The values come from `scripts/lib/manifest-seed.ts`: the five tenant
 * settings, the rights URI, and an English and Spanish attribution
 * filled from the retired generator's template for each repository's
 * code with the repository's name, city and country as D1 holds them,
 * and each repository's `rights_text`, the image reproduction text
 * zasqua.org shows today, verbatim. Nothing is written beyond those.
 *
 * The command reads each seeded tenant row and its repositories, prints what it
 * plans for each field (current value and planned value), and stops.
 * That dry run is the default. `--apply` writes the planned values with
 * one UPDATE per row. A field that already holds a value other than the
 * planned one is never overwritten: it was set on a form, and the plan
 * reports it as kept. A field already holding the planned value is
 * reported as unchanged and not written. A seed value that is not an
 * http or https URI where one is required stops the command before
 * anything is written. Before the migration that adds the columns has
 * reached a database, a dry run reads them as empty and says so, and
 * `--apply` refuses.
 *
 * Usage:
 *   npx tsx scripts/commands/manifest-fields.ts --target local
 *   npx tsx scripts/commands/manifest-fields.ts --target staging
 *   npx tsx scripts/commands/manifest-fields.ts --target production
 *   npx tsx scripts/commands/manifest-fields.ts --target local --apply
 *
 * `--target` picks the D1 database: `local` is the Wrangler dev
 * database, `staging` is `fisqua-staging-db` (`--env staging`), and
 * `production` is `fisqua-db`; staging and production are read with
 * `--remote`. Staging is applied before production, and applying to
 * production is a write to the live catalogue that waits for an
 * explicit go.
 *
 * @version v0.9.0
 */

import { runD1, runD1Json } from "../lib/d1-cli";
import { pathToFileURL } from "node:url";
import { escapeSql } from "../lib/sql";
import { REPOSITORY_RIGHTS_TEXT, SEEDED_MANIFEST_TENANTS, seededRepositoryValues } from "../lib/manifest-seed";
import { isHttpUri } from "../../app/lib/validation/manifest-fields";
import { appendAll } from "../lib/arrays";

export type Target = "local" | "staging" | "production";

const TENANT_COLUMNS = {
  publicSiteUrl: "public_site_url",
  publicSiteName: "public_site_name",
  providerName: "provider_name",
  providerUrl: "provider_url",
  metsBaseUrl: "mets_base_url",
} as const;

const REPOSITORY_COLUMNS = {
  manifestRights: "manifest_rights",
  attributionEn: "attribution_en",
  attributionEs: "attribution_es",
} as const;

const URI_COLUMNS = new Set(["public_site_url", "provider_url", "mets_base_url", "manifest_rights"]);

export interface TenantRow {
  id: string;
  slug: string;
  public_site_url: string | null;
  public_site_name: string | null;
  provider_name: string | null;
  provider_url: string | null;
  mets_base_url: string | null;
}

export interface RepositoryRow {
  id: string;
  code: string;
  name: string;
  city: string | null;
  country: string | null;
  manifest_rights: string | null;
  attribution_en: string | null;
  attribution_es: string | null;
  rights_text: string | null;
}

export type FieldAction = "write" | "unchanged" | "kept";

export interface FieldPlan {
  column: string;
  current: string | null;
  planned: string;
  action: FieldAction;
}

export interface RowPlan {
  table: "tenants" | "repositories";
  /** The tenant the row belongs to; for a tenant row, its own id. */
  tenantId: string;
  id: string;
  label: string;
  fields: FieldPlan[];
}

function fieldPlan(column: string, current: string | null, planned: string): FieldPlan {
  if (URI_COLUMNS.has(column) && !isHttpUri(planned)) {
    throw new Error(`Planned ${column} is not an http or https URI: ${planned}`);
  }
  const action: FieldAction =
    current === planned ? "unchanged" : current === null || current === "" ? "write" : "kept";
  return { column, current, planned, action };
}

/**
 * The plan for one seeded tenant row and its repositories. A tenant that
 * is not seeded is refused; repositories with no template are left out
 * of the plan.
 */
export function planManifestFields(tenant: TenantRow, repositories: RepositoryRow[]): RowPlan[] {
  const values = SEEDED_MANIFEST_TENANTS[tenant.id];
  if (!values) {
    throw new Error(`Only the Neogranadina and ahr tenants are seeded, not ${tenant.slug}`);
  }
  const plans: RowPlan[] = [
    {
      table: "tenants",
      tenantId: tenant.id,
      id: tenant.id,
      label: `tenant ${tenant.slug}`,
      fields: (Object.keys(TENANT_COLUMNS) as Array<keyof typeof TENANT_COLUMNS>).map((key) =>
        fieldPlan(TENANT_COLUMNS[key], tenant[TENANT_COLUMNS[key]], values[key]),
      ),
    },
  ];
  for (const repo of [...repositories].sort((a, b) => a.code.localeCompare(b.code))) {
    const repoValues = seededRepositoryValues(repo);
    if (repoValues === null) continue;
    plans.push({
      table: "repositories",
      tenantId: tenant.id,
      id: repo.id,
      label: `repository ${repo.code}`,
      fields: [
        ...(Object.keys(REPOSITORY_COLUMNS) as Array<keyof typeof REPOSITORY_COLUMNS>).map((key) =>
          fieldPlan(REPOSITORY_COLUMNS[key], repo[REPOSITORY_COLUMNS[key]], repoValues[key]),
        ),
        ...(REPOSITORY_RIGHTS_TEXT[repo.code]
          ? [fieldPlan("rights_text", repo.rights_text ?? null, REPOSITORY_RIGHTS_TEXT[repo.code])]
          : []),
      ],
    });
  }
  return plans;
}

/** One UPDATE per row with fields to write; rows with none are left out. */
export function planStatements(plans: RowPlan[], now: number): string[] {
  const out: string[] = [];
  for (const plan of plans) {
    const writes = plan.fields.filter((f) => f.action === "write");
    if (writes.length === 0) continue;
    const sets = writes.map((f) => `${f.column} = ${escapeSql(f.planned)}`).join(", ");
    const scope =
      plan.table === "tenants"
        ? `id = ${escapeSql(plan.id)}`
        : `tenant_id = ${escapeSql(plan.tenantId)} AND id = ${escapeSql(plan.id)}`;
    out.push(`UPDATE ${plan.table} SET ${sets}, updated_at = ${now} WHERE ${scope};`);
  }
  return out;
}

export function formatPlan(plans: RowPlan[]): string {
  const lines: string[] = [];
  for (const plan of plans) {
    lines.push(`${plan.label} (${plan.id})`);
    for (const f of plan.fields) {
      const current = f.current === null || f.current === "" ? "(empty)" : JSON.stringify(f.current);
      lines.push(`  ${f.column}: ${f.action}`);
      lines.push(`    current: ${current}`);
      lines.push(`    planned: ${JSON.stringify(f.planned)}`);
    }
  }
  return lines.join("\n");
}

function wranglerArgs(target: Target): string[] {
  if (target === "local") return ["wrangler", "d1", "execute", "fisqua-db", "--local"];
  if (target === "staging") {
    return ["wrangler", "d1", "execute", "fisqua-staging-db", "--env", "staging", "--remote"];
  }
  return ["wrangler", "d1", "execute", "fisqua-db", "--remote"];
}

function query<T>(target: Target, sql: string): T[] {
  const parsed = runD1Json<T>([...wranglerArgs(target), "--json", "--command", sql], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  return parsed[0]?.results ?? [];
}

function parseArgs(argv: string[]): { target: Target; apply: boolean } {
  let target: Target | null = null;
  let apply = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--apply") apply = true;
    else if (a === "--target") {
      const v = argv[++i];
      if (v !== "local" && v !== "staging" && v !== "production") {
        throw new Error(`--target must be local, staging or production; got ${v}`);
      }
      target = v;
    } else {
      throw new Error(`Unknown argument: ${a}`);
    }
  }
  if (target === null) throw new Error("--target is required (local, staging or production)");
  return { target, apply };
}

/**
 * A select list reading each column with NULL as '', or '' for a column
 * the database does not have yet (the migration not yet applied), with
 * the names of the missing ones.
 */
function selectList(target: Target, table: string, columns: string[]): { list: string; missing: string[] } {
  const present = new Set(query<{ name: string }>(target, `PRAGMA table_info(${table})`).map((c) => c.name));
  const missing = columns.filter((c) => !present.has(c));
  // NULL is read as '': the local database's JSON output gives a NULL as
  // the string "null", which would read as a value.
  const list = columns.map((c) => (present.has(c) ? `IFNULL(${c}, '') AS ${c}` : `'' AS ${c}`)).join(", ");
  return { list, missing };
}

function main(): void {
  const { target, apply } = parseArgs(process.argv.slice(2));
  const tenantSelect = selectList(target, "tenants", ["id", "slug", ...Object.values(TENANT_COLUMNS)]);
  const repositorySelect = selectList(target, "repositories", [
    "id", "code", "name", "city", "country", ...Object.values(REPOSITORY_COLUMNS), "rights_text",
  ]);
  const missing = [...tenantSelect.missing, ...repositorySelect.missing];
  if (missing.length > 0) {
    console.log(`The ${target} database has no ${missing.join(", ")} column yet; read as empty.`);
    if (apply) throw new Error("Apply the manifest settings migration before writing.");
  }
  const plans: RowPlan[] = [];
  const unseeded: string[] = [];
  for (const id of Object.keys(SEEDED_MANIFEST_TENANTS)) {
    const tenantId = escapeSql(id);
    const tenants = query<TenantRow>(target, `SELECT ${tenantSelect.list} FROM tenants WHERE id = ${tenantId}`);
    if (tenants.length !== 1) throw new Error(`The tenant ${id} was not found in ${target}`);
    const repositories = query<RepositoryRow>(
      target,
      `SELECT ${repositorySelect.list} FROM repositories WHERE tenant_id = ${tenantId} ORDER BY code`,
    );
    appendAll(plans, planManifestFields(tenants[0], repositories));
    for (const r of repositories) {
      if (seededRepositoryValues(r) === null) unseeded.push(r.code);
    }
  }

  console.log(`Manifest settings for ${target}${apply ? "" : " (dry run)"}\n`);
  console.log(formatPlan(plans));
  if (unseeded.length > 0) console.log(`\nLeft alone (no template): ${unseeded.join(", ")}`);

  const statements = planStatements(plans, Date.now());
  if (statements.length === 0) {
    console.log("\nNothing to write.");
    return;
  }
  if (!apply) {
    console.log(`\n${statements.length} row(s) would be written. Run with --apply to write them.`);
    return;
  }
  runD1([...wranglerArgs(target), "--command", statements.join("\n")], {
    stdio: "inherit",
  });
  console.log(`\nWrote ${statements.length} row(s).`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }
}

// @version v0.9.0
