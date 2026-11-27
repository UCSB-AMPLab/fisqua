/**
 * Scripts — running the command line's authority changes
 *
 * This module runs a change file (`./change-file.ts`) against a target
 * D1: it reads and plans (`./plan.ts`), builds the SQL file
 * (`./statements.ts`), writes the report, and for `apply` applies the
 * file, reads everything again and plans again. `scripts/fisqua.ts` is
 * a thin shell around `runAuthorities`; the reads, the writes and the
 * clock are injected, so the tests run it against an in-memory SQLite
 * database (`tests/import/authorities-cli.test.ts`).
 *
 * The report gives, for each create-entity and create-place row, its
 * `new_key` and the code of its record (`minted`). Codes are minted at
 * random each time the plan reads D1, so the code a dry run would mint is
 * not the one a later apply mints: a dry run reports "minted on apply"
 * (`MINTED_ON_APPLY`), an apply reports the code its SQL file wrote, in
 * the JSON and the Markdown report and on the console, and a rerun the
 * code the record holds.
 *
 * `plan` reads D1, writes the report (`.import/authorities_<target>_
 * <stamp>-<suffix>.json` and `.md`, the suffix eight random hex
 * characters, so no two runs share a name) and, when there is anything
 * to write, the SQL file beside it, created so that an existing file of
 * that name stops the run; it writes nothing to D1. Before `apply` hands
 * the file to wrangler, it reads the file back and checks that its
 * SHA-256 is that of the SQL the run holds, and applies nothing when it
 * is not. `apply` does the same,
 * then applies the SQL file as one unit, reads back and plans again: the
 * second plan must refuse nothing and find nothing to write, and every
 * row planned to write must read back done, or the outcome is "not
 * verified" and the exit code 1. An apply to production needs
 * `confirmProduction`, checked here and nowhere else.
 *
 * The arguments, the production check, the run's name and the hash
 * check before the apply are shared with the other nouns of the command
 * line, in `../cli/run-file.ts`.
 *
 * Who acts: the user of `--actor-email`, who must be a user of
 * `--tenant`, a platform admin, or the workspace admin of the lead tenant
 * of `--tenant`'s federation (`resolveActor` in `../authority-links.ts`),
 * and work in the records and authorities areas; a shared record, entity
 * or place, is changed, and a record made in the federation's shared
 * space, only by a steward of the federation. A link move or drop changes
 * the description, not the records it names, and needs no steward, as
 * the description editor's link actions need none.
 *
 * The report and the console count the split and separate ledger rows
 * the file writes (`./ledger.ts`), and the backfill rows among them.
 *
 * A file is known by its name. The ids of the records and links an
 * addition makes are made from it, so a renamed file finds none of the
 * ones it made before: it mints new records for its keys, and its links
 * to existing records are refused as duplicates. Changelog and ledger rows
 * carry that user, and each changelog row records in `acted_as` whether
 * they acted as the lead's admin or a platform admin (NULL for a member);
 * the report records how they acted (`actedAs`) and their own tenant.
 * The SQL file opens with guards that everything this check read still
 * holds (`../cli/access-guards.ts`): the user, the tenant and how the
 * user acts there, the tenant not disabled, the area flags, the tenant's
 * federation, authorities on and the steward test.
 *
 * @version v0.9.0
 */

import { canWorkInArea } from "../../../app/lib/user-access.server";
import { COMPARED_FIELD_COLUMNS, FUNCTION_FIELD_COLUMNS, type FillableFunctionField } from "../../../app/lib/function-duplicates";
import { actedAsPhrase, changelogActedAsOf, readScope, reportActorOf, resolveActor, type ReportActor } from "../authority-links";
import { actorGuards, scopeGuards } from "../cli/access-guards";
import { STATEMENT_BUDGET, oversizedStatements } from "../authority-merges";
import { blank, text } from "../entity-splits";
import {
  applyCheckedSqlFile,
  assertProductionConfirmed,
  exitCodeOfOutcome,
  OUTPUT_DIR,
  parseCliArgs,
  runNameOf,
  type CliArgs,
  type Outcome,
  type RunOptions,
  type RunProviders,
  type Target,
} from "../cli/run-file";
import { AuthoritiesStop, type ChangeRow } from "./change-file";
import {
  DONE,
  WRITES,
  hasWrites,
  planAuthorities,
  readAuthoritiesState,
  type AuthoritiesPlan,
  type AuthoritiesState,
  type Refusal,
  type RowStatus,
} from "./plan";
import { buildAuthorityStatements, type BuildResult } from "./statements";
import { entityIdentity } from "./additions";
import { maxOf } from "../arrays";

export { functionRowId } from "./plan";
export { AuthoritiesStop } from "./change-file";

export type { Target };

export type AuthoritiesArgs = CliArgs;

/** `authorities plan|apply <file> --target --tenant --actor-email [--confirm-production]`. */
export function parseAuthoritiesArgs(argv: string[]): AuthoritiesArgs {
  return parseCliArgs("authorities", argv);
}

// ---------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------

export type { Outcome };

export interface AuthoritiesReport {
  stamp: string;
  target: Target;
  tenant: { id: string; slug: string };
  federation: { id: string; slug: string };
  actor: ReportActor;
  file: string;
  applied: boolean;
  outcome: Outcome;
  problems: string[];
  totals: {
    rows: number;
    keep: number;
    move: number;
    copy: number;
    delete: number;
    rename: number;
    update: number;
    merge: number;
    cover: number;
    create: number;
    link: number;
    placeLink: number;
    relate: number;
    moveLink: number;
    dropLink: number;
    updateLink: number;
    dropRelation: number;
    deleteEntity: number;
    deletePlace: number;
    /** Backfill rows that write a split or a separate ledger row. */
    recordSplit: number;
    recordSeparate: number;
    alreadyDone: number;
    /** Update and rename rows whose record already holds what they give, with no changelog row of this file: nothing to write, nothing done. */
    same: number;
    refused: number;
    functionRowsMoved: number;
    functionRowsInserted: number;
    functionRowsDeleted: number;
    /** Function rows whose text or honorific a rename sets. */
    functionRowsRenamed: number;
    /** Function rows the merges move from losers to survivors. */
    functionRowsMovedByMerges: number;
    /** Rows a target holds that take fields from a row moved or copied onto it. */
    functionRowsFilled: number;
    /** Losers' rows the merges fold into a row of the same function on their survivor. */
    functionRowsFoldedByMerges: number;
    entitiesVersioned: number;
    /** Places created, updated and merged away; links the place merges move and drop. */
    placesCreated: number;
    placesUpdated: number;
    placesMerged: number;
    placeLinksMovedByMerges: number;
    placeLinksDroppedByMerges: number;
    placesVersioned: number;
    /** Ledger rows of operation `split` and `separate` written: by the link moves, one per pair of records, and by the backfill rows. */
    splitsRecorded: number;
    separatesRecorded: number;
    statements: number;
    sqlBytes: number;
    largestStatement: number;
  };
  refusals: Refusal[];
  /** `newFunction` is the text a rename gives, '' on other rows. */
  rows: Array<{ line: number; op: string; code: string; status: RowStatus; functionId: string; function: string; newFunction: string; targets: string[] }>;
  /**
   * Targets that hold the function by then (`foldInto`): the row does not
   * arrive, and the held row is "filled" with the fields it lacked or
   * "skipped" when it lacked none; and targets holding a row that differs
   * only in accents, where the row "arrives". `conflicts` are the fields
   * both held with different values, where the held value stays.
   */
  alreadyHas: Array<{
    line: number; functionId: string; function: string; target: string; held: string; heldId: string;
    outcome: "filled" | "skipped" | "arrives"; filled: string[]; conflicts: Array<{ field: string; held: string; incoming: string }>;
  }>;
  /** The merges' folds: each loser's row of a function its survivor holds, the row it folds into and what that takes. */
  mergeFolded: BuildResult["mergeFolded"];
  /** Records whose version the file changes. */
  versions: Array<{ code: string; id: string; name: string; from: number; to: number }>;
  updates: Array<{ line: number; code: string; changes: Record<string, { old: unknown; new: unknown }> }>;
  /**
   * Each create-entity and create-place row: its `new_key` and the code of
   * its record. A code is minted at random each time the file is planned,
   * and the one written is the applying run's, so a dry run gives
   * `MINTED_ON_APPLY` for a record still to make; a record an earlier run
   * made gives the code it holds; a refused row gives ''.
   */
  minted: Array<{ line: number; op: string; newKey: string; status: RowStatus; code: string }>;
}

/** The code a dry run reports for a record still to make. */
export const MINTED_ON_APPLY = "minted on apply";

/** The new_key and code of each create-entity and create-place row; `applied` once the SQL file that mints them is applied. */
function mintedOf(plan: AuthoritiesPlan, state: AuthoritiesState, applied: boolean): AuthoritiesReport["minted"] {
  return plan.rows.filter((r) => r.op === "create-entity" || r.op === "create-place").map((r) => {
    const key = r.row.cells.new_key;
    const entity = r.op === "create-entity";
    const id = (entity ? state.additions.ids.get(entityIdentity(r.row.file, key)) : state.places.keyIds.get(key)) ?? "";
    const minted = (entity ? state.additions.minted : state.places.minted).get(id) ?? "";
    const found = entity ? text(state.additions.found.get(id)?.entity_code) : text(state.places.found.get(id)?.place_code);
    const code = r.status === "create" ? (applied ? minted : MINTED_ON_APPLY) : r.status.startsWith("already") ? found : "";
    return { line: r.row.line, op: r.op, newKey: key, status: r.status, code };
  });
}

function reportOf(
  plan: AuthoritiesPlan,
  state: AuthoritiesState,
  built: BuildResult | null,
  base: Pick<AuthoritiesReport, "stamp" | "target" | "tenant" | "federation" | "actor" | "file">,
): AuthoritiesReport {
  const count = (s: RowStatus) => plan.rows.filter((r) => r.status === s).length;
  return {
    ...base,
    applied: false,
    outcome: "dry run",
    problems: [],
    totals: {
      rows: plan.rows.length,
      keep: count("keep"), move: count("move"), copy: count("copy"), delete: count("delete"), rename: count("rename"), update: count("update"), merge: count("merge"),
      cover: count("cover"),
      create: count("create"), link: count("link"), placeLink: count("place-link"), relate: count("relate"),
      moveLink: count("move link"), dropLink: count("drop link"), updateLink: count("update link"), dropRelation: count("drop relation"),
      deleteEntity: count("delete entity"), deletePlace: count("delete place"),
      recordSplit: count("record split"), recordSeparate: count("record separate"),
      alreadyDone: plan.rows.filter((r) => r.status.startsWith("already")).length,
      same: count("same"),
      refused: plan.refusals.length,
      functionRowsMoved: built?.movedRows ?? 0,
      functionRowsInserted: built?.insertedRows ?? 0,
      functionRowsDeleted: built?.deletedRows ?? 0,
      functionRowsRenamed: built?.renamedRows ?? 0,
      functionRowsMovedByMerges: built?.mergeMovedRows ?? 0,
      functionRowsFilled: built?.filledRows ?? 0,
      functionRowsFoldedByMerges: built?.mergeFolded.length ?? 0,
      entitiesVersioned: built?.versions.size ?? 0,
      placesCreated: built?.placesCreated ?? 0,
      placesUpdated: built?.placesUpdated ?? 0,
      placesMerged: built?.placesMerged ?? 0,
      placeLinksMovedByMerges: built?.placeLinksMovedByMerges ?? 0,
      placeLinksDroppedByMerges: built?.placeLinksDroppedByMerges ?? 0,
      placesVersioned: built?.placeVersions.size ?? 0,
      splitsRecorded: built?.splitsRecorded ?? 0,
      separatesRecorded: built?.separatesRecorded ?? 0,
      statements: built?.sql.length ?? 0,
      sqlBytes: built ? Buffer.byteLength(built.sql.join("\n") + "\n") : 0,
      largestStatement: built ? maxOf([0, ...built.sql.map((s) => Buffer.byteLength(s))]) : 0,
    },
    refusals: plan.refusals,
    rows: plan.rows.map((r) => ({
      line: r.row.line, op: r.row.cells.op, code: r.row.cells.authority_code || r.row.cells.new_key || r.row.cells.description_code, status: r.status, functionId: r.row.cells.function_id,
      function: r.row.cells.function, newFunction: r.row.cells.new_function, targets: r.targets.map((t) => t.code),
    })),
    alreadyHas: plan.rows.filter((r) => WRITES.includes(r.status) || (r.status === "same" && r.op === "copy-function")).flatMap((r) =>
      r.targets.filter((t) => t.alreadyHas !== undefined || t.foldInto !== undefined).map((t) => {
        const fold = t.foldInto;
        const filled = fold ? Object.keys(fold.set).map((k) => FUNCTION_FIELD_COLUMNS[k as FillableFunctionField]) : [];
        return {
          line: r.row.line, functionId: r.row.cells.function_id, function: text(r.fn?.function), target: t.code,
          held: fold ? fold.function : t.alreadyHas!, heldId: fold ? fold.id : "",
          outcome: !fold ? "arrives" as const : filled.length > 0 ? "filled" as const : "skipped" as const, filled,
          conflicts: (fold?.conflicts ?? []).map((x) => ({ field: COMPARED_FIELD_COLUMNS[x.field], held: x.held, incoming: x.incoming })),
        };
      }),
    ),
    mergeFolded: built?.mergeFolded ?? [],
    versions: [...(built?.versions ?? new Map())].map(([id, v]) => ({
      code: text(state.byId.get(id)?.entity_code), id, name: text(state.byId.get(id)?.display_name), from: v.from, to: v.to,
    })),
    updates: plan.rows.filter((r) => r.status === "update").map((r) => ({
      line: r.row.line, code: r.row.cells.authority_code,
      changes: r.fields?.changes ?? plan.places.updates.find((u) => u.row === r.row)?.changes ?? {},
    })),
    minted: mintedOf(plan, state, false),
  };
}

/** The fields a held row and an incoming one both hold with different values, for the report. */
function conflictsText(conflicts: Array<{ field: string; held: string; incoming: string }>): string {
  if (conflicts.length === 0) return "";
  return `; kept the held ${conflicts.map((c) => `${c.field} ${JSON.stringify(c.held)} (the row has ${JSON.stringify(c.incoming)})`).join(", ")}`;
}

function markdownOf(r: AuthoritiesReport): string {
  const cell = (v: unknown) => String(v ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");
  const t = r.totals;
  const outcome: Record<Outcome, string> = {
    verified: "**Verified: everything written reads back as planned, and a second plan finds nothing to write.**",
    "not verified": `**Not verified.** ${r.problems.join(" ")}`,
    refused: `**Refused: ${t.refused} refusals. Nothing was written.**`,
    "dry run": "**Dry run: nothing was written.**",
    "nothing to write": "**Nothing to write: every row is done.**",
    "stopped during the write": "**Stopped during the write: run the file again, and read what it reports.**",
  };
  return [
    `# Authorities: ${r.target}, ${r.stamp}`,
    "",
    outcome[r.outcome],
    "",
    `Tenant ${r.tenant.slug}, federation ${r.federation.slug}, acting as ${r.actor.email}${actedAsPhrase(r.actor)}. File ${r.file}.`,
    "",
    "| Total | |",
    "|---|---|",
    `| Rows | ${t.rows} |`,
    `| Keep | ${t.keep} |`,
    `| Move / copy / delete / rename | ${t.move} / ${t.copy} / ${t.delete} / ${t.rename} |`,
    `| Update / merge / cover | ${t.update} / ${t.merge} / ${t.cover} |`,
    `| Create / link / place link / relation | ${t.create} / ${t.link} / ${t.placeLink} / ${t.relate} |`,
    `| Links moved / dropped / updated | ${t.moveLink} / ${t.dropLink} / ${t.updateLink} |`,
    `| Relations dropped | ${t.dropRelation} |`,
    `| Entities / places deleted | ${t.deleteEntity} / ${t.deletePlace} |`,
    `| Ledger rows written: split / separate (backfill rows: split / separate) | ${t.splitsRecorded} / ${t.separatesRecorded} (${t.recordSplit} / ${t.recordSeparate}) |`,
    `| Places created / updated / merged away | ${t.placesCreated} / ${t.placesUpdated} / ${t.placesMerged} |`,
    `| Place links moved / dropped by merges | ${t.placeLinksMovedByMerges} / ${t.placeLinksDroppedByMerges} |`,
    `| Places taking a new version | ${t.placesVersioned} |`,
    `| Already done | ${t.alreadyDone} |`,
    `| Same (already holds what the row gives, no changelog row of this file) | ${t.same} |`,
    `| Function rows moved / inserted / deleted / renamed | ${t.functionRowsMoved} / ${t.functionRowsInserted} / ${t.functionRowsDeleted} / ${t.functionRowsRenamed} |`,
    `| Function rows moved by merges | ${t.functionRowsMovedByMerges} |`,
    `| Held function rows filled by moves and copies / rows folded by merges | ${t.functionRowsFilled} / ${t.functionRowsFoldedByMerges} |`,
    `| Records taking a new version | ${t.entitiesVersioned} |`,
    `| Refusals | ${t.refused} |`,
    `| Statements | ${t.statements} (${(t.sqlBytes / 1_048_576).toFixed(2)} MiB; largest ${t.largestStatement} bytes) |`,
    "",
    "## Refusals",
    "",
    ...(r.refusals.length === 0 ? ["None."] : r.refusals.map((f) => `- ${f.ref}: ${f.reason}`)),
    "",
    "## Target already has this function",
    "",
    "A row of a function its target holds, case and spacing aside, does not arrive: the held row is filled with the fields it lacks, or skipped when it lacks none. A field both hold with different values keeps the held value.",
    "",
    ...(r.alreadyHas.length === 0 && r.mergeFolded.length === 0 ? ["None."] : [
      ...r.alreadyHas.map((a) => `- line ${a.line}: ${a.functionId} ${cell(a.function)} → ${a.target}, which holds ${cell(a.held)}${a.heldId ? ` (${a.heldId})` : ""}: ` +
        (a.outcome === "arrives" ? "differs only in accents; the row arrives" : a.outcome === "filled" ? `filled ${a.filled.join(", ")}` : "skipped, nothing to fill") +
        conflictsText(a.conflicts)),
      ...r.mergeFolded.map((m) => `- merge of ${m.loserCode} into ${m.survivorCode}: ${m.functionId} ${cell(m.function)} folds into ${m.into}: ` +
        (m.filled.length > 0 ? `filled ${m.filled.join(", ")}` : "skipped, nothing to fill") + conflictsText(m.conflicts)),
    ]),
    "",
    "## New records and their codes",
    "",
    ...(r.minted.length === 0 ? ["None."] : [
      "| Line | Op | new_key | Code | Status |",
      "|---|---|---|---|---|",
      ...r.minted.map((m) => `| ${m.line} | ${m.op} | ${cell(m.newKey)} | ${m.code} | ${m.status} |`),
    ]),
    "",
    "## Records taking a new version",
    "",
    ...(r.versions.length === 0 ? ["None."] : r.versions.map((v) => `- ${v.code} ${cell(v.name)}: ${v.from} → ${v.to}`)),
    "",
    "## Field updates",
    "",
    ...(r.updates.length === 0 ? ["None."] : r.updates.flatMap((u) => [
      `- ${u.code} (line ${u.line})`,
      ...Object.entries(u.changes).map(([k, c]) => `  - ${k}: ${JSON.stringify(c.old)} → ${JSON.stringify(c.new)}`),
    ])),
    "",
    "## Rows",
    "",
    "| Line | Op | Authority | Function row | Function | Targets | Status |",
    "|---|---|---|---|---|---|---|",
    ...r.rows.map((x) => `| ${x.line} | ${x.op} | ${x.code} | ${x.functionId} | ${cell(x.newFunction ? `${x.function} → ${x.newFunction}` : x.function)} | ${x.targets.join(" ")} | ${x.status} |`),
  ].join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

export type AuthoritiesOptions = RunOptions;
export type AuthoritiesProviders = RunProviders;
export { OUTPUT_DIR };

/** The exit code: 0 for a dry run without refusals, nothing to write, or a write that read back as planned. */
export function exitCodeOf(report: AuthoritiesReport): number {
  return exitCodeOfOutcome(report.outcome);
}

/**
 * Reads, plans, writes the report and the SQL file, and with `apply`
 * and no refusal applies the file, reads everything again and plans
 * again. Returns the report.
 */
export async function runAuthorities(
  input: { file: string; rows: ChangeRow[] },
  options: AuthoritiesOptions,
  providers: AuthoritiesProviders,
  log: (line: string) => void,
): Promise<AuthoritiesReport> {
  const stop = (message: string) => new AuthoritiesStop(message);
  // The one place an apply to production is confirmed.
  assertProductionConfirmed(options, stop);
  const { rows } = providers;
  const now = providers.now();
  const { stamp, name } = runNameOf("authorities", options.target, providers, now);

  const actor = await resolveActor(rows, options.actorEmail, options.tenant);
  const scope = await readScope(rows, actor);
  if (!canWorkInArea(actor.access, "authorities")) throw new AuthoritiesStop(`${actor.email} may not work in authorities in ${actor.tenantSlug}`);
  const ctx = { tenantId: actor.tenantId, federationId: scope.federationId, owner: scope.owner, tenantSlug: actor.tenantSlug };
  const base = {
    stamp, target: options.target, tenant: { id: actor.tenantId, slug: actor.tenantSlug },
    federation: { id: scope.federationId, slug: scope.federationSlug }, actor: reportActorOf(actor), file: input.file,
  };

  const planOnce = async () => {
    const state = await readAuthoritiesState(rows, input, ctx);
    return { state, plan: planAuthorities(input, state) };
  };
  const { state, plan } = await planOnce();

  // A shared record is changed only by a steward of the federation.
  const changed = [
    ...plan.rows.filter((r) => WRITES.includes(r.status)).flatMap((r) => [r.entityId, ...r.targets.filter((t) => t.arrives).map((t) => t.id)]),
    // A backfill row's two records: its target is in no row's targets. A moved link is the description's, so the moves' own ledger rows need no steward.
    ...plan.ledger.rows.filter((l) => l.backfill).flatMap((l) => [l.sourceId, l.targetId]),
  ].filter((id): id is string => !!id).map((id) => state.byId.get(id)).filter((e) => !!e);
  if (hasWrites(plan) && !scope.steward && (changed.some((e) => blank(e!.tenant_id)) || plan.places.changed.some((p) => blank(p.tenant_id)))) {
    throw new AuthoritiesStop(`${actor.email} is not a steward of ${scope.federationSlug}, whose shared records the file changes`);
  }
  // As the editor's create (`requireAuthorityMint`): a record that joins the shared space needs a steward.
  if (plan.rows.some((r) => r.status === "create") && scope.owner === null && !scope.steward) {
    throw new AuthoritiesStop(`${actor.email} is not a steward of ${scope.federationSlug}, whose shared authorities a new record joins`);
  }

  let built: BuildResult | null = null;
  if (plan.refusals.length === 0) {
    built = buildAuthorityStatements(plan, state, {
      userId: actor.id, actedAs: changelogActedAsOf(actor), now, tenantId: actor.tenantId, federationId: scope.federationId, file: input.file,
      owner: scope.owner,
    });
    // Who acts is checked once, here; the file opens by checking it again.
    built.sql = [...actorGuards(actor), ...scopeGuards(actor, scope), ...built.sql];
    built.oversized = oversizedStatements(built.sql);
    for (const o of built.oversized) {
      plan.refusals.push({ ref: "sql", reason: `statement ${o.index + 1} is ${o.bytes} bytes, over the ${STATEMENT_BUDGET}-byte budget: ${o.head}` });
    }
  }

  const report = reportOf(plan, state, built, base);
  const writes = hasWrites(plan);
  report.outcome = plan.refusals.length > 0 ? "refused" : !writes ? "nothing to write" : options.apply ? "stopped during the write" : "dry run";
  const t = report.totals;
  log(`Authorities in ${actor.tenantSlug} (federation ${scope.federationSlug}) on ${options.target}, acting as ${actor.email}${actedAsPhrase(reportActorOf(actor))}${options.apply ? "" : " (dry run)"}`);
  log(`  ${t.rows} rows: ${t.keep} keep, ${t.move} move, ${t.copy} copy, ${t.delete} delete, ${t.rename} rename, ${t.update} update, ${t.merge} merge, ${t.cover} cover; ${t.create} create, ${t.link} link, ${t.placeLink} place link, ${t.relate} relation; ${t.alreadyDone} already done, ${t.same} same`);
  log(`  ${t.updateLink} links updated, ${t.dropRelation} relations dropped; ${t.deleteEntity} entities and ${t.deletePlace} places deleted`);
  log(`  ledger: ${t.splitsRecorded} split and ${t.separatesRecorded} separate rows written (${t.recordSplit} and ${t.recordSeparate} of them by backfill rows)`);
  log(`  ${t.moveLink} links moved, ${t.dropLink} dropped; places: ${t.placesCreated} created, ${t.placesUpdated} updated, ${t.placesMerged} merged away, ${t.placeLinksMovedByMerges} links moved and ${t.placeLinksDroppedByMerges} dropped by merges`);
  log(`  function rows: ${t.functionRowsMoved} moved, ${t.functionRowsInserted} inserted, ${t.functionRowsDeleted} deleted, ${t.functionRowsRenamed} renamed, ${t.functionRowsMovedByMerges} moved by merges; ${t.entitiesVersioned} records take a new version`);
  {
    const fold = report.alreadyHas.filter((a) => a.outcome !== "arrives");
    log(`  ${fold.length} land on a target that holds the function (${fold.filter((a) => a.outcome === "filled").length} fill the held row), ` +
      `${report.alreadyHas.length - fold.length} arrive beside a spelling that differs only in accents; ${t.functionRowsFoldedByMerges} rows folded by merges`);
  }
  const toMint = report.minted.filter((m) => m.code === MINTED_ON_APPLY).length;
  if (toMint > 0) log(`  ${toMint} new record${toMint === 1 ? "" : "s"}, whose code${toMint === 1 ? " is" : "s are"} minted on apply`);
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
  }
  if (report.outcome !== "stopped during the write") return finish();

  // The report is written before the apply, so a run stopped there still has it.
  finish();
  // The file applied must be the SQL this run planned: its hash on disk,
  // read just before the apply, is the hash of the SQL held here.
  await applyCheckedSqlFile(providers, sqlFile, sqlText, built!.sql, log, stop);
  report.applied = true;
  // The SQL file is applied whole, so every code it minted is now held.
  report.minted = mintedOf(plan, state, true);
  for (const m of report.minted.filter((x) => x.status === "create")) log(`  minted: line ${m.line} ${m.newKey} → ${m.code}`);

  // Read back: everything again, planned again; nothing may be left to write.
  const again = await planOnce();
  const problems: string[] = [];
  for (const f of again.plan.refusals) problems.push(`refused on read-back: ${f.ref}: ${f.reason}`);
  for (const r of plan.rows) {
    const a = again.plan.rows.find((x) => x.row === r.row)!;
    if (WRITES.includes(a.status)) problems.push(`${r.row.file} line ${r.row.line}: still to ${a.status}`);
    const want = DONE[r.status];
    // A copy whose every target held the function reads back as "same": the targets hold it, and nothing is left to write.
    const sameCopy = r.status === "copy" && a.status === "same";
    if (want && a.status !== want && !sameCopy) problems.push(`${r.row.file} line ${r.row.line}: reads back as ${a.status}, not ${want}`);
  }
  report.problems = [...new Set(problems)];
  report.outcome = report.problems.length === 0 ? "verified" : "not verified";
  if (report.problems.length === 0) log("Verified: everything planned reads back, and a second plan finds nothing to write.");
  else log(report.problems.join("\n"));
  return finish();
}

// @version v0.9.0
