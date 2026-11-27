#!/usr/bin/env npx tsx
/**
 * Compare Manifest Inputs with the Published Manifests
 *
 * This script is a read-only check, run by hand before the manifest
 * settings are seeded and before the first real pipeline run. It asks:
 * if the pipeline built the descriptive part of a manifest today, from
 * what the catalogue holds now and the values the seeding command would
 * write, would it say what the published manifest says?
 *
 * It takes a sample of descriptions with a published manifest, spread
 * evenly across the four Neogranadina repositories (the sample is every
 * n-th description of each repository in reference-code order, so a
 * rerun picks the same ones). For each, it reads the description and
 * repository rows from D1, builds the manifest block with the same
 * resolver dispatch uses (`resolveManifestInputs`) and the planned seed
 * values (`scripts/lib/manifest-seed.ts`), fetches the published
 * manifest over HTTPS, and compares every top-level field except
 * `items`, field by field after serialising, and the `metadata` block
 * entry by entry.
 *
 * Every difference is listed by reference code and field, with both
 * values. Two kinds are marked as expected: a difference in the Date
 * entry, because the pipeline writes `date_expression` as stored and
 * stored dates have changed since the manifests were generated; and a
 * metadata entry or summary the built block has and the published
 * manifest lacks, because the description gained that value after
 * generation and the generator's rule writes it. Every other difference is
 * listed for review before seeding. A summary counts differences by
 * field.
 *
 * It writes nothing: the D1 statements are SELECTs, and the manifests
 * are fetched with GET.
 *
 * Usage:
 *   npx tsx scripts/compare-manifest-inputs.ts                 # production, 50 descriptions
 *   npx tsx scripts/compare-manifest-inputs.ts --sample 200
 *   npx tsx scripts/compare-manifest-inputs.ts --env staging
 *
 * @version v0.9.0
 */

import { runD1Json } from "./lib/d1-cli";
import { pathToFileURL } from "node:url";
import { escapeSql } from "./lib/sql";
import { NEOGRANADINA_MANIFEST_TENANT, seededRepositoryValues } from "./lib/manifest-seed";
import { NEOGRANADINA_TENANT_ID } from "../app/lib/tenant";
import {
  DEFAULT_MANIFEST_BASE_URL,
  resolveManifestInputs,
} from "../app/lib/pipeline/manifest-inputs";
import { appendAll } from "./lib/arrays";

const REPOSITORY_CODES = ["co-ahrb", "co-cihjml", "pe-bn", "co-ahjci"] as const;

// Spec key, manifest key.
const FIELD_MAP: ReadonlyArray<[string, string]> = [
  ["id", "id"],
  ["label", "label"],
  ["homepage", "homepage"],
  ["rights", "rights"],
  ["required_statement", "requiredStatement"],
  ["provider", "provider"],
  ["see_also", "seeAlso"],
  ["summary", "summary"],
];

// Fields the runner writes itself rather than taking from the spec.
const RUNNER_FIELDS: Record<string, unknown> = {
  "@context": "http://iiif.io/api/presentation/3/context.json",
  type: "Manifest",
  behavior: ["paged"],
};

export interface Difference {
  field: string;
  built: unknown;
  published: unknown;
  expected: boolean;
  reason?: string;
}

interface MetadataEntry {
  label?: { en?: string[] };
  value?: unknown;
}

function metadataByLabel(list: unknown): Map<string, unknown> {
  const out = new Map<string, unknown>();
  if (!Array.isArray(list)) return out;
  for (const entry of list as MetadataEntry[]) {
    const key = entry?.label?.en?.[0] ?? JSON.stringify(entry?.label);
    out.set(key, entry);
  }
  return out;
}

const ser = (x: unknown) => (x === undefined ? undefined : JSON.stringify(x));

/**
 * `homepage.label` when the two homepages differ only in their label
 * (which repeats the title), `homepage` otherwise.
 */
function homepageField(built: unknown, published: unknown): string {
  const strip = (h: unknown) =>
    Array.isArray(h) ? h.map((e) => (e && typeof e === "object" ? { ...e, label: undefined } : e)) : h;
  return ser(strip(built)) === ser(strip(published)) ? "homepage.label" : "homepage";
}

/**
 * The differences between a built manifest block and a published
 * manifest (without `items`). `metadata` is compared entry by entry,
 * named `metadata.<English label>`, and its order is checked once the
 * entries agree.
 */
export function compareManifest(
  built: Record<string, unknown>,
  published: Record<string, unknown>,
): Difference[] {
  const out: Difference[] = [];
  const seen = new Set<string>(["items", "metadata"]);
  for (const [specKey, manifestKey] of FIELD_MAP) {
    seen.add(manifestKey);
    // The runner leaves a null rights or required statement out.
    const value = built[specKey] === null ? undefined : built[specKey];
    if (ser(value) !== ser(published[manifestKey])) {
      const added = manifestKey === "summary" && published.summary === undefined;
      out.push({
        field: manifestKey === "homepage" ? homepageField(built.homepage, published.homepage) : manifestKey,
        built: value,
        published: published[manifestKey],
        expected: added,
        ...(added ? { reason: "added since publication" } : {}),
      });
    }
  }
  for (const [key, value] of Object.entries(RUNNER_FIELDS)) {
    seen.add(key);
    if (ser(value) !== ser(published[key])) {
      out.push({ field: key, built: value, published: published[key], expected: false });
    }
  }
  for (const key of Object.keys(published)) {
    if (!seen.has(key)) out.push({ field: key, built: undefined, published: published[key], expected: false });
  }

  const b = metadataByLabel(built.metadata);
  const p = metadataByLabel(published.metadata);
  let entriesAgree = true;
  for (const label of new Set([...b.keys(), ...p.keys()])) {
    if (ser(b.get(label)) !== ser(p.get(label))) {
      entriesAgree = false;
      const reason =
        !p.has(label) ? "added since publication" : label === "Date" ? "stored date changed" : undefined;
      out.push({
        field: `metadata.${label}`,
        built: b.get(label),
        published: p.get(label),
        expected: reason !== undefined,
        ...(reason ? { reason } : {}),
      });
    }
  }
  if (entriesAgree && ser(built.metadata) !== ser(published.metadata)) {
    out.push({ field: "metadata (order)", built: built.metadata, published: published.metadata, expected: false });
  }
  return out;
}

/** Every n-th item of a list, `count` of them, starting in the middle of the first stride. */
export function evenSample<T>(items: T[], count: number): T[] {
  if (items.length <= count) return [...items];
  const stride = items.length / count;
  return Array.from({ length: count }, (_, i) => items[Math.floor(stride * i + stride / 2)]);
}

type Env = "production" | "staging";

function query<T>(env: Env, sql: string): T[] {
  const args =
    env === "production"
      ? ["wrangler", "d1", "execute", "fisqua-db", "--remote"]
      : ["wrangler", "d1", "execute", "fisqua-staging-db", "--env", "staging", "--remote"];
  const parsed = runD1Json<T>([...args, "--json", "--command", sql], {
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 256 * 1024 * 1024,
  });
  return parsed[0]?.results ?? [];
}

interface Row {
  reference_code: string;
  title: string;
  date_expression: string | null;
  extent: string | null;
  language: string | null;
  access_conditions: string | null;
  scope_content: string | null;
  iiif_manifest_url: string;
  repository_id: string;
  code: string;
  name: string;
  city: string | null;
  country: string | null;
}

function parseArgs(argv: string[]): { env: Env; sample: number } {
  let env: Env = "production";
  let sample = 50;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--env") {
      const v = argv[++i];
      if (v !== "production" && v !== "staging") throw new Error(`--env must be production or staging; got ${v}`);
      env = v;
    } else if (argv[i] === "--sample") {
      sample = Number(argv[++i]);
      if (!Number.isInteger(sample) || sample < REPOSITORY_CODES.length) {
        throw new Error(`--sample must be an integer of at least ${REPOSITORY_CODES.length}`);
      }
    } else {
      throw new Error(`Unknown argument: ${argv[i]}`);
    }
  }
  return { env, sample };
}

function show(x: unknown): string {
  return x === undefined ? "(absent)" : JSON.stringify(x);
}

async function main(): Promise<void> {
  const { env, sample } = parseArgs(process.argv.slice(2));
  const tenant = escapeSql(NEOGRANADINA_TENANT_ID);
  const published = `d.iiif_manifest_url LIKE ${escapeSql(`${DEFAULT_MANIFEST_BASE_URL}/iiif/%/manifest.json`)}`;

  const refs: string[] = [];
  REPOSITORY_CODES.forEach((code, i) => {
    const share = Math.floor(sample / REPOSITORY_CODES.length) + (i < sample % REPOSITORY_CODES.length ? 1 : 0);
    const rows = query<{ reference_code: string }>(
      env,
      `SELECT d.reference_code FROM descriptions d JOIN repositories r ON r.id = d.repository_id ` +
        `WHERE d.tenant_id = ${tenant} AND r.tenant_id = ${tenant} AND r.code = ${escapeSql(code)} AND ${published} ` +
        `ORDER BY d.reference_code`,
    );
    appendAll(refs, evenSample(rows.map((r) => r.reference_code), share));
  });

  const rows = query<Row>(
    env,
    `SELECT d.reference_code, d.title, d.date_expression, d.extent, d.language, d.access_conditions, ` +
      `d.scope_content, d.iiif_manifest_url, r.id AS repository_id, r.code, r.name, r.city, r.country ` +
      `FROM descriptions d JOIN repositories r ON r.id = d.repository_id ` +
      `WHERE d.tenant_id = ${tenant} AND r.tenant_id = ${tenant} AND d.reference_code IN (${refs.map(escapeSql).join(", ")}) ` +
      `ORDER BY r.code, d.reference_code`,
  );

  const counts = new Map<string, { expected: number; review: number }>();
  let compared = 0;
  const failures: string[] = [];
  console.log(`Comparing ${rows.length} descriptions (${env}) with their published manifests\n`);
  for (const row of rows) {
    const seed = seededRepositoryValues(row);
    if (seed === null) {
      failures.push(`${row.reference_code}: repository ${row.code} has no seed values`);
      continue;
    }
    const block = resolveManifestInputs(
      DEFAULT_MANIFEST_BASE_URL,
      row.reference_code,
      {
        referenceCode: row.reference_code,
        title: row.title,
        dateExpression: row.date_expression,
        extent: row.extent,
        language: row.language,
        accessConditions: row.access_conditions,
        scopeContent: row.scope_content,
      },
      {
        id: row.repository_id,
        code: row.code,
        name: row.name,
        city: row.city,
        region: null,
        country: row.country,
        countryCode: null,
        creditStatementEs: null,
        creditStatementEn: null,
        ...seed,
      },
      NEOGRANADINA_MANIFEST_TENANT,
      // The seed values carry an attribution in both languages, which wins
      // over the composed line, so the hosting statement is not read.
      null,
    );
    let doc: Record<string, unknown>;
    try {
      const res = await fetch(row.iiif_manifest_url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      doc = (await res.json()) as Record<string, unknown>;
    } catch (err) {
      failures.push(`${row.reference_code}: could not fetch ${row.iiif_manifest_url}: ${(err as Error).message}`);
      continue;
    }
    delete doc.items;
    compared++;
    const diffs = compareManifest(block as Record<string, unknown>, doc);
    if (diffs.length === 0) {
      console.log(`${row.reference_code}: identical`);
      continue;
    }
    console.log(`${row.reference_code}:`);
    for (const d of diffs) {
      const c = counts.get(d.field) ?? { expected: 0, review: 0 };
      if (d.expected) c.expected++;
      else c.review++;
      counts.set(d.field, c);
      console.log(`  ${d.field}${d.expected ? ` (expected: ${d.reason})` : ""}`);
      console.log(`    built:     ${show(d.built)}`);
      console.log(`    published: ${show(d.published)}`);
    }
  }

  console.log(`\nCompared ${compared} of ${rows.length} sampled descriptions.`);
  if (counts.size === 0) console.log("No differences.");
  for (const [field, c] of [...counts.entries()].sort()) {
    console.log(`  ${field}: ${c.expected + c.review} (${c.expected} expected, ${c.review} for review)`);
  }
  for (const f of failures) console.log(`  not compared: ${f}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error((err as Error).message);
    process.exit(1);
  });
}

// @version v0.9.0
