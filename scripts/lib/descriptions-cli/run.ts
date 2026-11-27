/**
 * Scripts — running the command line's descriptions
 *
 * This module runs a change file (`./change-file.ts`) against a target
 * D1: it reads and plans (`./plan.ts`), builds the SQL file
 * (`./statements.ts`), writes the report, and for `apply` applies the
 * file, reads everything again and plans again. `scripts/fisqua.ts` is
 * a thin shell around `runDescriptions`; the reads, the writes and the
 * clock are injected, so the tests run it against an in-memory SQLite
 * database (`tests/import/descriptions-cli.test.ts`).
 *
 * `plan` reads D1, writes the report (`.import/descriptions_<target>_
 * <stamp>-<suffix>.json` and `.md`) and, when there is anything to
 * write, creates the SQL file beside it, refusing to replace one; it
 * writes nothing to D1. `apply` does the same, checks that the SQL file
 * on disk hashes to the SQL the run holds, applies it as one unit, reads
 * back and plans again: the second plan must refuse nothing and find
 * nothing to write, and every row planned to write must read back
 * already updated or already created, or the outcome is "not verified"
 * and the exit code 1.
 * An apply to production needs `confirmProduction`, checked before
 * anything is read. The arguments, that check, the run's name and the
 * hash check are shared with the other nouns, in `../cli/run-file.ts`.
 *
 * The report gives the totals, every refusal, each row's status, each
 * record's version, the autosaved drafts left as they are on the
 * records written, for each field written a compact before and after
 * (the changed span with up to 40 characters either side), each record
 * created with its id, parent, position and local identifier, and each
 * child an `after` moves down with its old and new position.
 *
 * Who acts: the user of `--actor-email`, who must be a user of
 * `--tenant`, a platform admin, or the workspace admin of the lead tenant
 * of `--tenant`'s federation (`resolveActor` in `../authority-links.ts`),
 * and work in the records area, as the description editor's action
 * requires (`requireAreaWork(user, "records")`); the tenant must not be
 * disabled and must have a descriptive standard. Changelog rows and
 * `updated_by` carry that user, and each changelog row records in
 * `acted_as` whether they acted as the lead's admin or a platform admin
 * (NULL for a member); the report records how they acted (`actedAs`)
 * and their own tenant. The SQL file opens with a guard that everything this check
 * read still holds (`../cli/access-guards.ts`): the user, the tenant and
 * how the user acts there, the tenant not disabled, and the area flags.
 *
 * @version v0.9.0
 */

import { actedAsPhrase, changelogActedAsOf, reportActorOf, resolveActor, type ReportActor } from "../authority-links";
import { actorGuards } from "../cli/access-guards";
import { STATEMENT_BUDGET, oversizedStatements } from "../authority-merges";
import {
  applyCheckedSqlFile,
  assertProductionConfirmed,
  exitCodeOfOutcome,
  parseCliArgs,
  runNameOf,
  type CliArgs,
  type Outcome,
  type RunOptions,
  type RunProviders,
  type Target,
} from "../cli/run-file";
import { DescriptionsStop, type DescriptionChangeRow } from "./change-file";
import { manifestFile, uploadManifests, type FetchManifest, type PutObject } from "./images";
import {
  DONE,
  WRITES,
  changedSpan,
  hasWrites,
  planDescriptions,
  readDescriptionsState,
  type DescriptionsPlan,
  type Refusal,
  type RowStatus,
} from "./plan";
import { buildDescriptionStatements, type BuildResult } from "./statements";
import { maxOf } from "../arrays";

export { descriptionCreateId, descriptionCreateJournalId, descriptionJournalId } from "./plan";
export { descriptionDeleteJournalId } from "./images";
export { DescriptionsStop } from "./change-file";

/** `descriptions plan|apply <file> --target --tenant --actor-email [--confirm-production]`. */
export function parseDescriptionsArgs(argv: string[]): CliArgs {
  return parseCliArgs("descriptions", argv);
}

// ---------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------

export interface DescriptionsReport {
  stamp: string;
  target: Target;
  tenant: { id: string; slug: string };
  actor: ReportActor;
  file: string;
  standard: string | null;
  applied: boolean;
  outcome: Outcome;
  problems: string[];
  totals: {
    rows: number;
    update: number;
    alreadyUpdated: number;
    same: number;
    create: number;
    alreadyCreated: number;
    delete: number;
    alreadyDeleted: number;
    /** Manifests set-images rows give, those to upload, and those whose address holds the manifest built. */
    manifests: number;
    uploads: number;
    manifestsSame: number;
    /** Of those, the ones whose address holds the bytes built. */
    manifestBytesSame: number;
    /** Children an `after` moves down. */
    moved: number;
    refused: number;
    /** Refused rows whose current_value would match after normalisation or whitespace (counted, never passed). */
    nearMisses: number;
    descriptionsVersioned: number;
    statements: number;
    sqlBytes: number;
    largestStatement: number;
  };
  refusals: Refusal[];
  rows: Array<{ line: number; op: string; id: string; code: string; field: string; rule: string; status: RowStatus }>;
  updates: Array<{ line: number; id: string; code: string; field: string; before: string; after: string }>;
  creates: Array<{ line: number; id: string; code: string; parentCode: string; position: number; localIdentifier: string | null }>;
  moves: Array<{ code: string; id: string; from: number; to: number }>;
  manifests: Array<{
    line: number; code: string; url: string; canvases: number; held: "absent" | "same"; bytes: "same" | "differ" | null; upload: boolean;
  }>;
  deletes: Array<{ line: number; code: string; id: string; mergedInto: string; links: { entities: number; places: number } }>;
  /** The federation's manifest address and bucket, when the file gives images. */
  manifestBaseUrl: string | null;
  bucket: string | null;
  versions: Array<{ code: string; id: string; from: number; to: number }>;
  drafts: Array<{ code: string; id: string; userId: string; updatedAt: number }>;
}

const text = (v: unknown) => (v === null || v === undefined ? "" : String(v));

function reportOf(
  plan: DescriptionsPlan,
  built: BuildResult | null,
  drafts: Map<string, { userId: string; updatedAt: number }>,
  base: Pick<DescriptionsReport, "stamp" | "target" | "tenant" | "actor" | "file" | "standard">,
): DescriptionsReport {
  const count = (s: RowStatus) => plan.rows.filter((r) => r.status === s).length;
  const written = plan.rows.filter((r) => r.status === "update" && r.description);
  const writtenIds = [...new Set(written.map((r) => text(r.description!.id)))];
  const codeOf = new Map(plan.creates.map((c) => [c.id, c.code]));
  return {
    ...base,
    applied: false,
    outcome: "dry run",
    problems: [],
    totals: {
      rows: plan.rows.length,
      update: count("update"),
      alreadyUpdated: count("already updated"),
      same: count("same"),
      create: count("create"),
      alreadyCreated: count("already created"),
      delete: count("delete"),
      alreadyDeleted: count("already deleted"),
      manifests: plan.ops.images.length,
      uploads: plan.ops.uploads.length,
      manifestsSame: plan.ops.images.filter((m) => m.held === "same").length,
      manifestBytesSame: plan.ops.images.filter((m) => m.bytes === "same").length,
      moved: plan.moves.length,
      refused: plan.refusals.length,
      nearMisses: plan.rows.filter((r) => r.nearMiss).length,
      // Every record read that takes a new version: fields changed, a child count raised, a position moved.
      descriptionsVersioned: built ? built.records.length : writtenIds.length,
      statements: built?.sql.length ?? 0,
      sqlBytes: built ? Buffer.byteLength(built.sql.join("\n") + "\n") : 0,
      largestStatement: built ? maxOf([0, ...built.sql.map((s) => Buffer.byteLength(s))]) : 0,
    },
    refusals: plan.refusals,
    rows: plan.rows.map((r) => ({
      line: r.row.line, op: r.row.cells.op || "update-field", id: text(r.description?.id ?? r.create?.id),
      code: text(r.description?.reference_code) || r.row.cells.reference_code, field: r.row.cells.field, rule: r.row.cells.rule, status: r.status,
    })),
    updates: written.filter((r) => r.spec).map((r) => ({
      line: r.row.line, id: text(r.description!.id), code: text(r.description!.reference_code), field: r.spec!.field,
      ...changedSpan(text(r.description![r.spec!.column]), text(r.next)),
    })),
    creates: plan.creates.map((c) => ({
      line: c.row.line, id: c.id, code: c.code, parentCode: c.row.cells.parent_code, position: c.position, localIdentifier: c.localIdentifier,
    })),
    moves: plan.moves.map((m) => ({ code: m.code, id: m.id, from: m.from, to: m.to })),
    manifests: plan.rows.filter((r) => r.images && r.status !== "refused").map((r) => ({
      line: r.row.line, code: r.images!.code, url: r.images!.url, canvases: r.images!.canvases, held: r.images!.held, bytes: r.images!.bytes,
      upload: r.images!.upload,
    })),
    deletes: plan.ops.deletes.map((x) => ({ line: x.row.line, code: x.code, id: x.id, mergedInto: x.survivorCode, links: x.links })),
    manifestBaseUrl: null,
    bucket: null,
    versions: (built?.records ?? []).map((w) => ({ code: w.code || codeOf.get(w.id) || "", id: w.id, from: w.from, to: w.to })),
    drafts: writtenIds.filter((id) => drafts.has(id)).map((id) => ({
      code: text(written.find((r) => text(r.description!.id) === id)!.description!.reference_code), id, ...drafts.get(id)!,
    })),
  };
}

function markdownOf(r: DescriptionsReport): string {
  const cell = (v: unknown) => String(v ?? "").replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
  const t = r.totals;
  const outcome: Record<Outcome, string> = {
    verified: "**Verified: everything written reads back as planned, and a second plan finds nothing to write.**",
    "not verified": `**Not verified.** ${r.problems.join(" ")}`,
    refused: `**Refused: ${t.refused} refusals. Nothing was written.**`,
    "dry run": "**Dry run: nothing was written.**",
    "nothing to write": "**Nothing to write: every row is done or already holds its new value.**",
    "stopped during the write": "**Stopped during the write: run the file again, and read what it reports.**",
  };
  return [
    `# Descriptions: ${r.target}, ${r.stamp}`,
    "",
    outcome[r.outcome],
    "",
    `Tenant ${r.tenant.slug} (standard ${r.standard ?? "none"}), acting as ${r.actor.email}${actedAsPhrase(r.actor)}. File ${r.file}.`,
    "",
    "| Total | |",
    "|---|---|",
    `| Rows | ${t.rows} |`,
    `| Update | ${t.update} |`,
    `| Already updated | ${t.alreadyUpdated} |`,
    `| Same (already holds the new value, no changelog row of this file) | ${t.same} |`,
    `| Create | ${t.create} |`,
    `| Already created | ${t.alreadyCreated} |`,
    `| Delete | ${t.delete} |`,
    `| Already deleted | ${t.alreadyDeleted} |`,
    `| Manifests | ${t.manifests} (to upload: ${t.uploads}; held at their address: ${t.manifestsSame}, byte for byte: ${t.manifestBytesSame}) |`,
    `| Children moved down by an after | ${t.moved} |`,
    `| Refusals | ${t.refused} (near misses: ${t.nearMisses}) |`,
    `| Descriptions taking a new version | ${t.descriptionsVersioned} |`,
    `| Statements | ${t.statements} (${(t.sqlBytes / 1_048_576).toFixed(2)} MiB; largest ${t.largestStatement} bytes) |`,
    "",
    "## Refusals",
    "",
    ...(r.refusals.length === 0 ? ["None."] : r.refusals.map((f) => `- ${f.ref}: ${cell(f.reason)}`)),
    "",
    "## Autosaved drafts, left as they are",
    "",
    ...(r.drafts.length === 0 ? ["None."] : r.drafts.map((d) => `- ${d.code}: draft of ${d.userId}, ${new Date(d.updatedAt).toISOString()}`)),
    "",
    "## Updates",
    "",
    ...(r.updates.length === 0 ? ["None."] : r.updates.flatMap((u) => [
      `- ${u.code} ${u.field} (line ${u.line})`,
      `  - before: ${cell(u.before)}`,
      `  - after: ${cell(u.after)}`,
    ])),
    "",
    "## Creates",
    "",
    ...(r.creates.length === 0 ? ["None."] : r.creates.map((c) =>
      `- ${c.code} (line ${c.line}): under ${c.parentCode} at position ${c.position}, local identifier ${c.localIdentifier ?? "none"}, id ${c.id}`)),
    "",
    "## Manifests",
    "",
    ...(r.manifests.length === 0 ? ["None."] : [
      `Under ${r.manifestBaseUrl}, bucket ${r.bucket}.`,
      "",
      ...r.manifests.map((m) => `- ${m.code} (line ${m.line}): ${m.canvases} canvases; the address holds ` +
        (m.held === "same" ? `the manifest built (${m.bytes === "same" ? "byte for byte" : "as JSON, not byte for byte"})` : "nothing") +
        (m.upload ? "; to upload" : "")),
    ]),
    "",
    "## Deletes",
    "",
    ...(r.deletes.length === 0 ? ["None."] : r.deletes.map((x) =>
      `- ${x.code} (line ${x.line}), id ${x.id}: joined into ${x.mergedInto}; ${x.links.entities} entity and ${x.links.places} place links go with it`)),
    "",
    "## Children moved down",
    "",
    ...(r.moves.length === 0 ? ["None."] : r.moves.map((m) => `- ${m.code}: position ${m.from} to ${m.to}`)),
    "",
    "## Rows",
    "",
    "| Line | Description | Field | Rule | Status |",
    "|---|---|---|---|---|",
    ...r.rows.map((x) => `| ${x.line} | ${x.code} | ${x.field || x.op} | ${cell(x.rule)} | ${x.status} |`),
  ].join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

export type DescriptionsOptions = RunOptions;
export interface DescriptionsProviders extends RunProviders {
  /** GETs a manifest's address: needed when the file has set-images rows. */
  fetchManifest?: FetchManifest;
  /** Puts a manifest in the federation's bucket: needed when an apply uploads one. */
  putObject?: PutObject;
}

/** The exit code: 0 for a dry run without refusals, nothing to write, or a write that read back as planned. */
export function exitCodeOf(report: DescriptionsReport): number {
  return exitCodeOfOutcome(report.outcome);
}

/**
 * Reads, plans, writes the report and the SQL file, and with `apply`
 * and no refusal applies the file, reads everything again and plans
 * again. Returns the report.
 */
export async function runDescriptions(
  input: { file: string; rows: DescriptionChangeRow[] },
  options: DescriptionsOptions,
  providers: DescriptionsProviders,
  log: (line: string) => void,
): Promise<DescriptionsReport> {
  const stop = (message: string) => new DescriptionsStop(message);
  assertProductionConfirmed(options, stop);
  const { rows } = providers;
  const now = providers.now();
  const { stamp, name } = runNameOf("descriptions", options.target, providers, now);

  const actor = await resolveActor(rows, options.actorEmail, options.tenant);
  const scope = { tenantId: actor.tenantId, tenantSlug: actor.tenantSlug };

  let reads = 0;
  const planOnce = async () => {
    reads += 1;
    const state = await readDescriptionsState(rows, input, scope, { fetchManifest: providers.fetchManifest, bust: `${stamp}-${reads}`, stop });
    if (state.standard === null) throw stop(`The tenant ${actor.tenantSlug} has no descriptive standard`);
    return { state, plan: planDescriptions(input, state) };
  };
  const { state, plan } = await planOnce();

  let built: BuildResult | null = null;
  if (plan.refusals.length === 0 && hasWrites(plan)) {
    built = buildDescriptionStatements(plan, state, { userId: actor.id, actedAs: changelogActedAsOf(actor), now, tenantId: actor.tenantId });
    // Who acts is checked once, here; the file opens by checking it again.
    built.sql = [...actorGuards(actor), ...built.sql];
    built.oversized = oversizedStatements(built.sql);
    for (const o of built.oversized) {
      plan.refusals.push({ ref: "sql", reason: `statement ${o.index + 1} is ${o.bytes} bytes, over the ${STATEMENT_BUDGET}-byte budget: ${o.head}` });
    }
  }

  const report = reportOf(plan, built, state.drafts, {
    stamp, target: options.target, tenant: { id: actor.tenantId, slug: actor.tenantSlug }, actor: reportActorOf(actor),
    file: input.file, standard: state.standard,
  });
  report.manifestBaseUrl = state.ops?.place?.baseUrl ?? null;
  report.bucket = state.ops?.place?.bucket ?? null;
  const writes = hasWrites(plan);
  report.outcome = plan.refusals.length > 0 ? "refused" : !writes ? "nothing to write" : options.apply ? "stopped during the write" : "dry run";
  const t = report.totals;
  log(`Descriptions in ${actor.tenantSlug} on ${options.target}, acting as ${actor.email}${actedAsPhrase(reportActorOf(actor))}${options.apply ? "" : " (dry run)"}`);
  log(`  ${t.rows} rows: ${t.update} update, ${t.alreadyUpdated} already updated, ${t.same} same, ${t.create} create, ` +
    `${t.alreadyCreated} already created, ${t.delete} delete, ${t.alreadyDeleted} already deleted, ${t.refused} refused ` +
    `(${t.nearMisses} near misses); ${t.moved} children moved down`);
  if (t.manifests > 0) {
    log(`  ${t.manifests} manifests: ${t.uploads} to upload, ${t.manifestsSame} held at their address (${t.manifestBytesSame} byte for byte)`);
  }
  log(`  ${t.descriptionsVersioned} descriptions take a new version; ${report.drafts.length} of them have an autosaved draft, left as it is`);
  log(`  ${t.statements} statements, ${(t.sqlBytes / 1_048_576).toFixed(2)} MiB, largest ${t.largestStatement} bytes`);
  for (const f of plan.refusals) log(`  refused ${f.ref}: ${f.reason}`);

  const finish = () => {
    providers.writeFile(`${name}.json`, JSON.stringify(report, null, 2) + "\n");
    providers.writeFile(`${name}.md`, markdownOf(report));
    log(`Report: ${name}.json, ${name}.md`);
    return report;
  };
  const sqlFile = `${name}.sql`;
  const sqlText = built ? built.sql.join("\n") + "\n" : "";
  if (built && writes && plan.refusals.length === 0) {
    providers.createFile(sqlFile, sqlText);
    log(`SQL: ${sqlFile}`);
    // The manifests an apply uploads, kept beside the SQL file.
    for (const u of plan.ops.uploads) providers.writeFile(manifestFile(name, u.key), u.body);
    if (plan.ops.uploads.length > 0) log(`Manifests to upload: ${name}/manifests/`);
  }
  if (report.outcome !== "stopped during the write") return finish();

  // The report is written before the apply, so a run stopped there still has it.
  finish();
  // The manifests first, then the SQL file as one unit: a SQL file that is
  // refused leaves the manifests at addresses no record names.
  if (plan.ops.uploads.length > 0) {
    if (providers.readFile(sqlFile) !== sqlText) throw stop(`${sqlFile} does not hold the SQL this run planned; nothing was uploaded or applied`);
    log(`\nUploading ${plan.ops.uploads.length} manifests to ${state.ops!.place!.bucket}`);
    await uploadManifests(plan.ops.uploads, state.ops!.place!, actor.tenantId, providers, name, `${stamp}-upload`, log, stop);
  }
  await applyCheckedSqlFile(providers, sqlFile, sqlText, built!.sql, log, stop);
  report.applied = true;

  // Read back: everything again, planned again; nothing may be left to write.
  const again = await planOnce();
  const problems: string[] = [];
  for (const f of again.plan.refusals) problems.push(`refused on read-back: ${f.ref}: ${f.reason}`);
  for (const r of plan.rows) {
    const a = again.plan.rows.find((x) => x.row === r.row)!;
    if (WRITES.includes(a.status)) problems.push(`${r.row.file} line ${r.row.line}: still to ${a.status}`);
    const want = DONE[r.status];
    if (want && a.status !== want) problems.push(`${r.row.file} line ${r.row.line}: reads back as ${a.status}, not ${want}`);
  }
  report.problems = [...new Set(problems)];
  report.outcome = report.problems.length === 0 ? "verified" : "not verified";
  if (report.problems.length === 0) log("Verified: everything planned reads back, and a second plan finds nothing to write.");
  else log(report.problems.join("\n"));
  return finish();
}

// @version v0.9.0
