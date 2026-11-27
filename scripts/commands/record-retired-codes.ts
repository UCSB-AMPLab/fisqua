#!/usr/bin/env npx tsx
/**
 * Record Retired Codes — zasqua.org's Published Codes in legacy_ids
 *
 * This script records zasqua.org's published codes in `legacy_ids`.
 * zasqua.org has published five-character entity and place codes since
 * April 2026, and reference codes some of which Fisqua has since
 * corrected. The site moves to Fisqua's own codes, and every old address
 * is to redirect to the new one; the map is read from `legacy_ids`. The
 * script writes that map's source: on each Fisqua record paired by Django
 * id with a record of the site's files of 2026-04-21, it appends the
 * published code (`zasqua-2026-04`) or the published reference code where
 * it differs (`former-reference-code`). It never changes an entity, place
 * or reference code. The pairing, the refusals and the SQL are in
 * `scripts/lib/retired-codes.ts`.
 *
 * Inputs are local copies of the site's files:
 *
 *   --entities <entities.json>  --places <places.json>
 *   --place-links <place_links.json>  --descriptions <descriptions.json>
 *
 * `place_links.json` supplies the place codes the site links to without a
 * place record (Palma's `nl-z9ruz`); each is recorded on the one Fisqua
 * place its links resolve to, or reported and left alone. Its links name
 * the reference codes the site published, so their descriptions are
 * paired through `descriptions.json` by Django id, and places through
 * merges to the live record. The descriptions and place-links files are
 * read one element at a time.
 *
 * The dry run is the default: it reads the target's entities, places and
 * descriptions (`wrangler d1 execute --remote --json --command`, in pages),
 * prints the plan and writes a report to
 * `.import/retired-codes_<target>_<timestamp>.{json,md}`. Any refusal (a
 * file record with no Fisqua pair or two, a code appearing twice, a code
 * equal to a live one, a file that does not parse) stops the run before
 * anything is written; an entry already recorded that equals a live code
 * is reported, not refused. `--apply` writes the statements to one SQL file,
 * applies it with `--file`, then reads the records back and prints the
 * counts. Production also needs `--confirm-production`, and waits for an
 * explicit go on the staging and production dry-run reports.
 *
 * Changelog rows are written under `user_001`, as for the other one-off
 * corrections; a target with no such user (staging, before the user was
 * copied there) gets no changelog rows, and the command says so. That
 * user acts on each workspace a write lands in as the command line's
 * other nouns resolve the actor (`retiredCodeActing`): a description's
 * or an owned record's workspace, and for a shared record its
 * federation's lead, where only a steward may change it. Each changelog
 * row records in `acted_as` how they acted there (`lead-admin` on a
 * member, NULL as a member), the file opens with the same guards, and a
 * workspace they may not act in stops the run before anything is
 * written.
 *
 * Usage:
 *   npx tsx scripts/commands/record-retired-codes.ts --target staging \
 *     --entities <dir>/entities.json --places <dir>/places.json \
 *     --place-links <dir>/place_links.json --descriptions <dir>/descriptions.json
 *   ... --target staging --apply
 *   ... --target production --apply --confirm-production
 *
 * @version v0.9.0
 */

import { runD1, runD1Json } from "../lib/d1-cli";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { escapeSql } from "../lib/sql";
import {
  FORMER_REFERENCE_PROVIDER,
  RETIRED_CODE_PROVIDER,
  buildStatements,
  danglingPlaceCodes,
  holdingCountSql,
  duplicateCodes,
  indexByDjangoId,
  liveCodesByFederation,
  pairSiteReferences,
  placeIdsBySiteCode,
  planAuthorities,
  planDescriptions,
  resolveDangling,
  retiredCodeActing,
  streamJsonArray,
  type AuthorityRow,
  type DanglingCode,
  type DescriptionRow,
  type FileAuthority,
  type FileDescription,
  type FisquaLink,
  type KindPlan,
  type Refusal,
  type SiteLink,
} from "../lib/retired-codes";
import { appendAll } from "../lib/arrays";

export type Target = "local" | "staging" | "production";

const CHANGELOG_USER = "user_001";
const PAGE = 1_000;

/** Django place ids reported on every run: 99306 Zipaquira duplicates 96418 Zipaquirá. */
const WATCHED_PLACES = [{ djangoId: "99306", duplicateOf: "96418" }];

interface Args {
  target: Target;
  apply: boolean;
  confirmProduction: boolean;
  entities: string;
  places: string;
  placeLinks: string;
  descriptions: string;
}

function parseArgs(argv: string[]): Args {
  let target: Target | null = null;
  let apply = false;
  let confirmProduction = false;
  const paths: Record<string, string | undefined> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--apply") apply = true;
    else if (a === "--confirm-production") confirmProduction = true;
    else if (a === "--target") {
      const v = argv[++i];
      if (v !== "local" && v !== "staging" && v !== "production") {
        throw new Error(`--target must be local, staging or production; got ${v}`);
      }
      target = v;
    } else if (a === "--entities" || a === "--places" || a === "--place-links" || a === "--descriptions") {
      const v = argv[++i];
      if (!v) throw new Error(`${a} needs a path`);
      paths[a] = v;
    } else {
      throw new Error(`Unknown argument: ${a}`);
    }
  }
  if (target === null) throw new Error("--target is required (local, staging or production)");
  for (const flag of ["--entities", "--places", "--place-links", "--descriptions"]) {
    if (!paths[flag]) throw new Error(`${flag} <path> is required`);
  }
  if (apply && target === "production" && !confirmProduction) {
    throw new Error("Applying to production also needs --confirm-production.");
  }
  return {
    target, apply, confirmProduction,
    entities: paths["--entities"]!, places: paths["--places"]!,
    placeLinks: paths["--place-links"]!, descriptions: paths["--descriptions"]!,
  };
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
    maxBuffer: 512 * 1024 * 1024,
  });
  return parsed[0]?.results ?? [];
}

/** Read a whole table in pages ordered by id. */
function readAll<T extends { id: string }>(target: Target, select: string, table: string): T[] {
  const rows: T[] = [];
  let last = "";
  for (;;) {
    const page = query<T>(target, `SELECT ${select} FROM ${table} WHERE id > ${escapeSql(last)} ORDER BY id LIMIT ${PAGE}`);
    appendAll(rows, page);
    if (page.length < PAGE) return rows;
    last = page[page.length - 1].id;
  }
}

// NULL is read as '': the local database's JSON output gives a NULL as the string "null".
const orNull = (v: string | null | undefined): string | null => (v === null || v === undefined || v === "" ? null : v);

function readAuthorities(target: Target, table: "entities" | "places"): AuthorityRow[] {
  const codeColumn = table === "entities" ? "entity_code" : "place_code";
  const raw = readAll<{
    id: string; federation_id: string; tenant_id: string; code: string; merged_into: string; legacy_ids: string;
    updated_at: number;
  }>(
    target,
    `id, federation_id, IFNULL(tenant_id, '') AS tenant_id, IFNULL(${codeColumn}, '') AS code, ` +
      `IFNULL(merged_into, '') AS merged_into, legacy_ids, updated_at`,
    table,
  );
  return raw.map((r) => ({
    id: r.id, federationId: r.federation_id, tenantId: orNull(r.tenant_id), code: orNull(r.code),
    mergedInto: orNull(r.merged_into), legacyIds: r.legacy_ids, updatedAt: r.updated_at,
  }));
}

function readDescriptions(target: Target): DescriptionRow[] {
  return readAll<{ id: string; tenant_id: string; reference_code: string; legacy_ids: string; updated_at: number }>(
    target, "id, tenant_id, reference_code, legacy_ids, updated_at", "descriptions",
  ).map((r) => ({
    id: r.id, tenantId: r.tenant_id, referenceCode: r.reference_code, legacyIds: r.legacy_ids, updatedAt: r.updated_at,
  }));
}

function str(value: unknown, what: string): string {
  if (typeof value === "string" && value !== "") return value;
  if (typeof value === "number") return String(value);
  throw new Error(`${what} is missing or not a string: ${JSON.stringify(value)}`);
}

async function readFileAuthorities(path: string, codeField: string): Promise<FileAuthority[]> {
  const out: FileAuthority[] = [];
  for await (const item of streamJsonArray(path)) {
    const r = item as Record<string, unknown>;
    out.push({ djangoId: str(r.id, `${path} id`), code: str(r[codeField], `${path} ${codeField}`) });
  }
  return out;
}

async function readFileDescriptions(path: string): Promise<FileDescription[]> {
  const out: FileDescription[] = [];
  for await (const item of streamJsonArray(path)) {
    const r = item as Record<string, unknown>;
    out.push({ djangoId: str(r.id, `${path} id`), referenceCode: str(r.reference_code, `${path} reference_code`) });
  }
  return out;
}

/** Two passes over the links file: the dangling links, then every link of the descriptions they touch. */
async function readDanglingLinks(
  path: string,
  placeCodes: Set<string>,
): Promise<{ dangling: Map<string, SiteLink[]>; byReference: Map<string, SiteLink[]>; total: number }> {
  const toLink = (item: unknown): SiteLink => {
    const r = item as Record<string, unknown>;
    return {
      referenceCode: str(r.reference_code, `${path} reference_code`),
      placeCode: str(r.place_code, `${path} place_code`),
      role: str(r.role, `${path} role`),
    };
  };
  const danglingLinks: SiteLink[] = [];
  let total = 0;
  for await (const item of streamJsonArray(path)) {
    total++;
    const link = toLink(item);
    if (!placeCodes.has(link.placeCode)) danglingLinks.push(link);
  }
  const dangling = danglingPlaceCodes(danglingLinks, placeCodes);
  const references = new Set(danglingLinks.map((l) => l.referenceCode));
  const byReference = new Map<string, SiteLink[]>();
  if (references.size > 0) {
    for await (const item of streamJsonArray(path)) {
      const link = toLink(item);
      if (!references.has(link.referenceCode)) continue;
      const list = byReference.get(link.referenceCode);
      if (list) list.push(link);
      else byReference.set(link.referenceCode, [link]);
    }
  }
  return { dangling, byReference, total };
}

/** Fisqua's place links of the given descriptions, by description id. */
function readFisquaLinks(target: Target, descriptionIds: string[]): FisquaLink[] {
  const out: FisquaLink[] = [];
  for (let i = 0; i < descriptionIds.length; i += 200) {
    const list = descriptionIds.slice(i, i + 200).map(escapeSql).join(", ");
    appendAll(out, query<FisquaLink>(
        target,
        `SELECT dp.description_id AS descriptionId, dp.place_id AS placeId, dp.role AS role ` +
          `FROM description_places dp WHERE dp.description_id IN (${list})`,
      ));
  }
  return out;
}

function countHolding(target: Target, table: string, provider: string): number {
  return query<{ n: number }>(target, holdingCountSql(table, provider))[0]?.n ?? 0;
}

interface Report {
  target: Target;
  generatedAt: string;
  apply: boolean;
  files: Record<string, string>;
  changelogUser: string | null;
  counts: Record<string, KindPlan["counts"] & { recordsWritten: number; holdingBefore: number; holdingAfter: number }>;
  refusals: Refusal[];
  warnings: Refusal[];
  dangling: DanglingCode[];
  danglingLinksTotal: number;
  placeLinksTotal: number;
  mergesFollowed: KindPlan["mergesFollowed"];
  watched: Array<Record<string, unknown>>;
  samples: Record<string, Array<Record<string, unknown>>>;
  statements: number;
  sqlBytes: number;
}

function formatMarkdown(r: Report): string {
  const lines: string[] = [];
  lines.push(`# Retired codes — ${r.target}${r.apply ? "" : " (dry run)"}`, "");
  lines.push(`Generated ${r.generatedAt}.`, "");
  lines.push(`Changelog user: ${r.changelogUser ?? "none (no user_001 on this target; no changelog rows)"}.`, "");
  lines.push("| Kind | File records | To write | Already present | Reference code unchanged | Refused | Records written | Holding before | Holding after |");
  lines.push("|---|---|---|---|---|---|---|---|---|");
  for (const [kind, c] of Object.entries(r.counts)) {
    lines.push(
      `| ${kind} | ${c.fileRecords} | ${c.toWrite} | ${c.alreadyPresent} | ${c.unchanged} | ${c.refused} | ${c.recordsWritten} | ${c.holdingBefore} | ${c.holdingAfter} |`,
    );
  }
  lines.push("", `Statements: ${r.statements} (${(r.sqlBytes / 1_048_576).toFixed(1)} MiB).`, "");
  lines.push("## Refusals", "");
  if (r.refusals.length === 0) lines.push("None.");
  for (const f of r.refusals.slice(0, 200)) lines.push(`- ${f.kind}: ${f.reason} — ${f.detail}`);
  if (r.refusals.length > 200) lines.push(`- … and ${r.refusals.length - 200} more (see JSON)`);
  lines.push("", "## Already recorded, and equal to a live code", "");
  if (r.warnings.length === 0) lines.push("None.");
  for (const f of r.warnings) lines.push(`- ${f.kind}: ${f.detail}`);
  lines.push("", "## Dangling place codes", "");
  lines.push(`${r.danglingLinksTotal} of ${r.placeLinksTotal} site place links name a code places.json has no record for.`, "");
  if (r.dangling.length === 0) lines.push("None.");
  for (const d of r.dangling) {
    lines.push(
      `- \`${d.code}\` (${d.links} link(s)): ${d.placeId ? `resolves to ${d.placeCode} (${d.placeId}); recorded` : `not recorded — ${d.note}`}` +
        (d.candidates.length > 0 && !d.placeId ? `; candidates ${d.candidates.join(", ")}` : ""),
    );
  }
  lines.push("", "## Codes recorded on the record a paired record was merged into", "");
  if (r.mergesFollowed.length === 0) lines.push("None.");
  for (const m of r.mergesFollowed) {
    lines.push(`- ${m.kind} \`${m.retiredCode}\` (Django ${m.djangoId || "—"}): paired ${m.pairedCode} merged into ${m.survivorCode} (${m.survivorId})`);
  }
  lines.push("", "## Watched records", "");
  for (const w of r.watched) lines.push(`- ${JSON.stringify(w)}`);
  lines.push("", "## Samples", "");
  for (const [kind, list] of Object.entries(r.samples)) {
    lines.push(`### ${kind}`, "");
    for (const s of list) lines.push(`- ${JSON.stringify(s)}`);
    lines.push("");
  }
  return lines.join("\n") + "\n";
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const { target } = args;

  console.log("Reading the site's files…");
  const fileEntities = await readFileAuthorities(args.entities, "entity_code");
  const filePlaces = await readFileAuthorities(args.places, "place_code");
  const placeCodes = new Set(filePlaces.map((p) => p.code));
  const links = await readDanglingLinks(args.placeLinks, placeCodes);
  const fileDescriptions = await readFileDescriptions(args.descriptions);
  console.log(
    `  ${fileEntities.length} entities, ${filePlaces.length} places, ${links.total} place links ` +
      `(${links.dangling.size} dangling code(s)), ${fileDescriptions.length} descriptions`,
  );

  console.log(`Reading ${target}…`);
  const entityRows = readAuthorities(target, "entities");
  const placeRows = readAuthorities(target, "places");
  const descriptionRows = readDescriptions(target);
  console.log(`  ${entityRows.length} entities, ${placeRows.length} places, ${descriptionRows.length} descriptions`);

  // Dangling place codes: resolve each to one Fisqua place, or report it.
  // The links name the site's reference codes; the descriptions they
  // belong to are paired through the site's file by Django id.
  const placeIndex = indexByDjangoId(placeRows);
  const descriptionBySiteReference = pairSiteReferences(links.byReference.keys(), fileDescriptions, descriptionRows);
  const fisquaLinks = readFisquaLinks(target, [...new Set(descriptionBySiteReference.values())]);
  const dangling = resolveDangling({
    dangling: links.dangling,
    siteLinksByReference: links.byReference,
    descriptionBySiteReference,
    fisquaLinks,
    placeIdBySiteCode: placeIdsBySiteCode(filePlaces, placeRows),
    places: placeRows,
  });
  const resolved = dangling.filter((d) => d.placeId !== null).map((d) => ({ code: d.code, recordId: d.placeId! }));

  const live = liveCodesByFederation(entityRows, placeRows);
  const entityPlan = planAuthorities("entity", fileEntities, entityRows, live);
  const placePlan = planAuthorities("place", filePlaces, placeRows, live, resolved);
  const descriptionPlan = planDescriptions(fileDescriptions, descriptionRows);
  const plans = [entityPlan, placePlan, descriptionPlan];
  const refusals = [
    ...duplicateCodes([
      ...fileEntities.map((e) => ({ kind: "entity" as const, code: e.code })),
      ...filePlaces.map((p) => ({ kind: "place" as const, code: p.code })),
      ...resolved.map((d) => ({ kind: "place" as const, code: d.code })),
    ]),
    ...plans.flatMap((p) => p.refusals),
  ];

  const users = query<{ id: string; email: string }>(target, `SELECT id, email FROM users WHERE id = ${escapeSql(CHANGELOG_USER)}`);
  const changelogUser = users.length === 1 ? CHANGELOG_USER : null;
  if (changelogUser === null) console.log(`No ${CHANGELOG_USER} on ${target}: no changelog rows will be written.`);

  // The changelog user acts on each workspace a write lands in as the
  // other nouns' actor does; a workspace they may not act in stops the run.
  const acting = changelogUser === null
    ? null
    : await retiredCodeActing(async (sql) => query<Record<string, unknown>>(target, sql), users[0].email, plans.flatMap((p) => p.writes));

  const now = Date.now();
  const built = buildStatements(plans, { userId: changelogUser, now, newId: randomUUID, actedAs: acting?.actedAs });
  const statements = built.length > 0 && acting ? [...acting.guards, ...built] : built;
  const sql = statements.join("\n") + "\n";

  const placeById = new Map(placeRows.map((p) => [p.id, p]));
  const watched = WATCHED_PLACES.map((w) => {
    const rows = placeIndex.get(w.djangoId) ?? [];
    const dup = placeIndex.get(w.duplicateOf) ?? [];
    const row = rows[0];
    const survivor = row?.mergedInto ? placeById.get(row.mergedInto) : undefined;
    return {
      djangoPlace: w.djangoId,
      fisquaCode: row?.code ?? null,
      mergedInto: survivor ? survivor.code : row?.mergedInto ?? null,
      duplicateOf: `Django ${w.duplicateOf} (${dup[0]?.code ?? "not found"})`,
      retiredCodeRecordedOn: row ? (survivor ? `${survivor.code} (merge survivor)` : `${row.code} (its own record; unmerged)`) : "not found",
    };
  });

  const sample = (p: KindPlan) =>
    p.writes.slice(0, 10).map((w) => ({ id: w.id, code: w.code, added: w.added, old: w.oldLegacyIds, new: w.newLegacyIds }));
  const report: Report = {
    target,
    generatedAt: new Date(now).toISOString(),
    apply: args.apply,
    files: { entities: args.entities, places: args.places, placeLinks: args.placeLinks, descriptions: args.descriptions },
    changelogUser,
    counts: Object.fromEntries(
      plans.map((p) => [
        p.kind,
        { ...p.counts, recordsWritten: p.writes.length, holdingBefore: p.holdingBefore, holdingAfter: p.holdingAfter },
      ]),
    ),
    refusals,
    warnings: plans.flatMap((p) => p.warnings),
    dangling,
    danglingLinksTotal: [...links.dangling.values()].reduce((n, l) => n + l.length, 0),
    placeLinksTotal: links.total,
    mergesFollowed: [...entityPlan.mergesFollowed, ...placePlan.mergesFollowed],
    watched,
    samples: {
      entity: sample(entityPlan),
      place: sample(placePlan),
      description: descriptionPlan.writes.map((w) => ({ id: w.id, code: w.code, added: w.added })),
      alreadyPresent: plans.flatMap((p) => p.presentSamples.map((s) => ({ kind: p.kind, ...s }))),
    },
    statements: statements.length,
    sqlBytes: Buffer.byteLength(sql),
  };

  const stamp = new Date(now).toISOString().replace(/:/g, "-").replace(/\.\d+Z$/, "Z");
  const dir = join(process.cwd(), ".import");
  mkdirSync(dir, { recursive: true });
  const base = join(dir, `retired-codes_${target}_${stamp}`);
  writeFileSync(`${base}.json`, JSON.stringify(report, null, 2) + "\n");
  writeFileSync(`${base}.md`, formatMarkdown(report));

  console.log(`\nRetired codes for ${target}${args.apply ? "" : " (dry run)"}`);
  for (const [kind, c] of Object.entries(report.counts)) {
    console.log(
      `  ${kind}: ${c.fileRecords} in file, ${c.toWrite} to write on ${c.recordsWritten} record(s), ` +
        `${c.alreadyPresent} already present, ${c.unchanged} unchanged, ${c.refused} refused`,
    );
  }
  for (const d of dangling) {
    console.log(`  dangling ${d.code}: ${d.placeId ? `→ ${d.placeCode}` : `not recorded (${d.note})`}`);
  }
  for (const m of report.mergesFollowed) {
    console.log(`  merged: ${m.kind} ${m.retiredCode} → ${m.survivorCode} (paired ${m.pairedCode})`);
  }
  for (const f of report.warnings) console.log(`  already recorded, and a live code: ${f.kind} ${f.detail}`);
  for (const w of watched) console.log(`  watched: ${JSON.stringify(w)}`);
  console.log(`  ${statements.length} statement(s), ${(report.sqlBytes / 1_048_576).toFixed(1)} MiB`);
  console.log(`Report: ${base}.md`);

  if (refusals.length > 0) {
    for (const f of refusals.slice(0, 50)) console.error(`  refused ${f.kind}: ${f.reason} — ${f.detail}`);
    throw new Error(`${refusals.length} refusal(s); nothing written.`);
  }
  if (statements.length === 0) {
    console.log("\nNothing to write.");
    return;
  }
  if (!args.apply) {
    console.log("\nRun with --apply to write.");
    return;
  }

  const sqlPath = `${base}.sql`;
  writeFileSync(sqlPath, sql);
  runD1([...wranglerArgs(target), "--file", sqlPath, ...(target === "local" ? [] : ["--yes"])], {
    stdio: "inherit",
  });
  console.log("\nRead back:");
  for (const [table, provider] of [
    ["entities", RETIRED_CODE_PROVIDER],
    ["places", RETIRED_CODE_PROVIDER],
    ["descriptions", FORMER_REFERENCE_PROVIDER],
  ] as const) {
    console.log(`  ${table} holding ${provider}: ${countHolding(target, table, provider)}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error((err as Error).message);
    process.exit(1);
  });
}

// @version v0.9.0
