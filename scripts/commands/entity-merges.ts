#!/usr/bin/env npx tsx
/**
 * Entity Merges — the Reviewed List of High-Confidence Duplicates
 *
 * This script plans, against a Fisqua D1, the reviewed list of
 * high-confidence duplicates among the Neogranadina entities, which hold
 * people and bodies recorded twice under two spellings. The list
 * `entity-merges-final.csv` pairs them, and was reviewed and ruled on
 * 2026-10-24. The plan covers its MATCH rows, holding those whose merge
 * waits on a cataloguing decision: each loser merges into its survivor as
 * the decisions surface merges a pair, survivors take the labels the list
 * gives, transcription slips stay out of the variants, and every effect is
 * journaled and every pair has its ledger row. Which rows merge or are
 * held, the name rules, the refusals and the SQL are in
 * `scripts/lib/entity-merges.ts`; reading the target, the guards and the
 * size budget are shared with the place command
 * (`scripts/lib/authority-merges.ts`).
 *
 * The dry run is the default: it reads the target's entities in the list
 * and their description links (`wrangler d1 execute --remote --json
 * --command`, in pages), prints the plan and writes a report to
 * `.import/entity-merges_<target>_<timestamp>.{json,md}`. Any refusal,
 * including a statement over the size budget, stops the run before
 * anything is written.
 *
 * `--apply` is refused, before anything is read or written. A merge of
 * two entity records needs a stated independent fact and the
 * descriptions that show it, since a shared name is never evidence, and
 * the rows of this list carry neither. Entity merges are applied as
 * `merge-entity` rows of an authorities change file, with `facts` and
 * `evidence_codes` (`scripts/fisqua.ts authorities`), whose plan checks
 * the evidence and records it in the merge's ledger row. The dry run
 * still reads the target and writes its report.
 *
 * Journal and ledger rows are written under `user_001`; a target without
 * that user is refused.
 * That user acts in `--tenant` as the command line's other nouns resolve
 * the actor (`resolveCommandActor`): a user of it, a platform admin, or
 * the lead's workspace admin, and a steward of the federation when a
 * merge names a shared record. Each journal row records in `acted_as`
 * how they acted (NULL for a user of the tenant); the SQL file opens
 * with the guards that this still holds, and anything else refuses the
 * run. Open duplicate-pair decisions that name a record
 * in the list are reported and left open. The losers keep their
 * `legacy_ids`; the retired-codes command follows `merged_into`, so a
 * rerun of it after the merge records the losers' published codes on
 * their survivors.
 *
 * `--tenant <slug>` is required. A shared record can be linked from
 * several tenants' descriptions; only the named tenant's links are read,
 * moved and counted, and other tenants' links stay on the record merged
 * away, with its `merged_into` naming the survivor. A record of another
 * federation, or owned by another tenant, is refused.
 *
 * Each loser's function rows (`entity_functions`) go to its survivor
 * with the merge: a row of a function the survivor does not hold moves,
 * id and columns kept; a row of one it holds, case and spacing aside,
 * fills the held row's empty fields and is deleted. Its ledger row names
 * the rows moved and gives the rows folded, and the report counts both.
 *
 * The other sides of the losers' relations are read on their own
 * descriptions only. A loser's link named from outside its description is
 * stale data: only its id is read, and the run is refused naming it.
 *
 * Usage (dry run only):
 *   npx tsx scripts/commands/entity-merges.ts --target staging --tenant neogranadina \
 *     --list .import/authority-review/entity-merges-final.csv
 *
 * @version v0.9.0
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { JunctionRow } from "../../app/lib/pair-merge.server";
import type { EntityFunctionRow } from "../../app/lib/entity-functions.server";
import { escapeSql } from "../lib/sql";
import { AuthorityLinksStop, resolveCommandActor } from "../lib/authority-links";
import {
  PAGE,
  STATEMENT_BUDGET,
  applyFile,
  inTenantDescriptions,
  parseMergeArgs,
  query,
  storedValue,
  typed,
  type Target,
} from "../lib/authority-merges";
import {
  ENTITY_GUARDED_COLUMNS,
  FUNCTION_ROW_COLUMNS,
  LINK_COLUMNS,
  functionRowOf,
  junctionRowOf,
  pointingLinksSql,
  staleNamingSql,
  SOURCE_LIST,
  buildEntityStatements,
  planEntityMerges,
  readEntityMergeList,
  type EntityBuildResult,
  type EntityList,
  type EntityPlan,
  type EntityRow,
  type Refusal,
  type StoredEntity,
} from "../lib/entity-merges";
import { maxOf } from "../lib/arrays";

const USER = "user_001";

function readEntities(target: Target, codes: string[]): Map<string, EntityRow[]> {
  const byCode = new Map<string, EntityRow[]>();
  for (let i = 0; i < codes.length; i += 200) {
    const list = codes.slice(i, i + 200).map(escapeSql).join(", ");
    const rows = query<Record<string, unknown>>(
      target,
      `SELECT id, ${typed(ENTITY_GUARDED_COLUMNS)} FROM entities WHERE entity_code IN (${list})`,
    );
    for (const r of rows) {
      const stored = Object.fromEntries(ENTITY_GUARDED_COLUMNS.map((c) => [c, storedValue(r, c)])) as StoredEntity;
      const text = (v: string | number | null): string | null => (v === null || v === "" ? null : String(v));
      const e: EntityRow = {
        id: String(r.id),
        federationId: String(stored.federation_id),
        tenantId: text(stored.tenant_id),
        code: String(stored.entity_code),
        displayName: String(stored.display_name),
        sortName: String(stored.sort_name),
        nameVariants: text(stored.name_variants) ?? "[]",
        mergedInto: text(stored.merged_into),
        wikidataId: text(stored.wikidata_id),
        viafId: text(stored.viaf_id),
        dbeId: text(stored.dbe_id),
        sources: text(stored.sources),
        updatedAt: Number(stored.updated_at),
        stored,
      };
      const list2 = byCode.get(e.code);
      if (list2) list2.push(e);
      else byCode.set(e.code, [e]);
    }
  }
  return byCode;
}

/** Every link from the tenant's descriptions to the given entities, in full, keyed as Drizzle returns the rows. */
function readLinks(target: Target, tenantId: string, entityIds: string[]): Map<string, JunctionRow[]> {
  const out = new Map<string, JunctionRow[]>();
  for (let i = 0; i < entityIds.length; i += 100) {
    const list = entityIds.slice(i, i + 100).map(escapeSql).join(", ");
    let last = "";
    for (;;) {
      const page = query<Record<string, unknown>>(
        target,
        `SELECT ${typed(LINK_COLUMNS)} FROM description_entities ` +
          `WHERE entity_id IN (${list}) AND ${inTenantDescriptions(tenantId)} ` +
          `AND id > ${escapeSql(last)} ORDER BY id LIMIT ${PAGE}`,
      );
      for (const r of page) {
        const v = (c: string) => storedValue(r, c);
        const link: JunctionRow = {
          id: String(v("id")),
          descriptionId: String(v("description_id")),
          entityId: String(v("entity_id")),
          role: v("role") as string,
          roleNote: v("role_note") as string | null,
          roleRaw: v("role_raw") as string | null,
          sequence: v("sequence") as number,
          honorific: v("honorific") as string | null,
          attributes: v("attributes") as string,
          nameAsRecorded: v("name_as_recorded") as string | null,
          createdAt: v("created_at") as number,
          relatedTo: v("related_to") as string | null,
          relationCertainty: v("relation_certainty") as string | null,
        };
        const l = out.get(link.entityId as string);
        if (l) l.push(link);
        else out.set(link.entityId as string, [link]);
      }
      if (page.length < PAGE) break;
      last = String(page[page.length - 1].id);
    }
  }
  return out;
}

/** The links naming, in `related_to`, a link of the given entities, keyed by the link named. */
function readPointing(target: Target, tenantId: string, entityIds: string[]): Map<string, JunctionRow[]> {
  const out = new Map<string, JunctionRow[]>();
  for (let i = 0; i < entityIds.length; i += 100) {
    for (const r of query<Record<string, unknown>>(target, pointingLinksSql(entityIds.slice(i, i + 100), tenantId, typed(LINK_COLUMNS)))) {
      const link = junctionRowOf((c) => storedValue(r, c));
      const named = String(link.relatedTo);
      out.set(named, [...(out.get(named) ?? []), link]);
    }
  }
  return out;
}

/** The links of the given entities that a link outside their own description names: only their ids are read. */
function readStaleNamed(target: Target, tenantId: string, entityIds: string[]): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i < entityIds.length; i += 100) {
    for (const r of query<{ id: string }>(target, staleNamingSql(entityIds.slice(i, i + 100), tenantId))) out.add(String(r.id));
  }
  return out;
}

/** Each entity's `entity_functions` rows in full, in entry order. */
function readFunctions(target: Target, entityIds: string[]): Map<string, EntityFunctionRow[]> {
  const out = new Map<string, EntityFunctionRow[]>();
  for (let i = 0; i < entityIds.length; i += 100) {
    const list = entityIds.slice(i, i + 100).map(escapeSql).join(", ");
    const rows = query<Record<string, unknown>>(
      target,
      `SELECT ${FUNCTION_ROW_COLUMNS.join(", ")} FROM entity_functions WHERE entity_id IN (${list}) ORDER BY entity_id, rowid`,
    );
    for (const r of rows) {
      const f = functionRowOf(r);
      const l = out.get(f.entityId) ?? [];
      l.push(f);
      out.set(f.entityId, l);
    }
  }
  return out;
}

interface Report {
  target: Target;
  generatedAt: string;
  apply: boolean;
  list: string;
  listSummary: Omit<EntityList, "rows"> & { merging: number };
  counts: {
    merges: number;
    survivors: number;
    held: number;
    linksMoved: number;
    linksDropped: number;
    functionsMoved: number;
    functionsFolded: number;
    labelsChanged: number;
    namesExcluded: number;
    idsLeftOnLoser: number;
    refusals: number;
    statements: number;
    sqlBytes: number;
    largestStatement: number;
  };
  refusals: Refusal[];
  held: EntityList["held"];
  exclusions: EntityPlan["exclusions"];
  labelChanges: EntityBuildResult["labelChanges"];
  idsLeftOnLoser: EntityPlan["idsLeftOnLoser"];
  openDecisions: Array<{ id: string; sourceRef: string | null }>;
  merges: Array<{ ref: string; loser: string; loserName: string; survivor: string; survivorName: string }>;
}

function formatMarkdown(r: Report): string {
  const lines: string[] = [];
  lines.push(`# Entity merges — ${r.target}${r.apply ? "" : " (dry run)"}`, "");
  lines.push(`Generated ${r.generatedAt} from \`${r.list}\`.`, "");
  const c = r.counts;
  lines.push("| Count | |", "|---|---|");
  lines.push(`| List rows | ${r.listSummary.total} |`);
  for (const [k, v] of Object.entries(r.listSummary.skipped)) lines.push(`| Skipped: ${k} | ${v} |`);
  lines.push(`| MATCH held | ${c.held} |`, `| Merges | ${c.merges} |`, `| Survivors | ${c.survivors} |`);
  lines.push(`| Links moved | ${c.linksMoved} |`, `| Links dropped (survivor already held them) | ${c.linksDropped} |`);
  lines.push(`| Function rows moved to survivors | ${c.functionsMoved} |`);
  lines.push(`| Function rows folded into a survivor's row of the same function | ${c.functionsFolded} |`);
  lines.push(`| Labels changed | ${c.labelsChanged} |`, `| Names left out of variants | ${c.namesExcluded} |`);
  lines.push(`| Ids left on the loser | ${c.idsLeftOnLoser} |`, `| Refusals | ${c.refusals} |`);
  lines.push(`| Statements | ${c.statements} (${(c.sqlBytes / 1_048_576).toFixed(2)} MiB; largest ${c.largestStatement} bytes) |`, "");
  lines.push("## Refusals", "");
  if (r.refusals.length === 0) lines.push("None.");
  for (const f of r.refusals) lines.push(`- ${f.ref}: ${f.reason}`);
  lines.push("", "## Held for the cataloguer", "");
  if (r.held.length === 0) lines.push("None.");
  for (const h of r.held) lines.push(`- ${h.ref} (${h.survivorCode} ← ${h.loserCode}): ${h.why}`);
  lines.push("", "## Names left out of the survivors' variants", "");
  if (r.exclusions.length === 0) lines.push("None.");
  for (const x of r.exclusions) lines.push(`- ${x.ref} (${x.survivorCode}): "${x.name}" — ${x.why}`);
  lines.push("", "## Label changes", "");
  if (r.labelChanges.length === 0) lines.push("None.");
  for (const l of r.labelChanges) {
    const old = l.oldKept ? "the old label joins name_variants" : "the old label, a slip, is left out of name_variants";
    lines.push(`- ${l.survivorCode}: ${l.old} → ${l.new} (${old}; sort_name stays "${l.sortName}")`);
  }
  lines.push("", "## Ids only the loser holds (left on the loser)", "");
  if (r.idsLeftOnLoser.length === 0) lines.push("None.");
  for (const x of r.idsLeftOnLoser) lines.push(`- ${x.ref} (${x.loserCode}): ${x.what}`);
  lines.push("", "## Open duplicate-pair decisions naming a record in the list", "");
  if (r.openDecisions.length === 0) lines.push("None.");
  for (const d of r.openDecisions) lines.push(`- ${d.id} (${d.sourceRef ?? "no source_ref"}) — left open`);
  lines.push("", "## Merges", "", "| Row | Loser | Survivor |", "|---|---|---|");
  for (const m of r.merges) lines.push(`| ${m.ref} | ${m.loserName} (${m.loser}) | ${m.survivorName} (${m.survivor}) |`);
  return lines.join("\n") + "\n";
}

/** Why `--apply` is refused: this list carries no evidence for its merges. */
export const APPLY_REFUSED =
  "entity-merges --apply is refused: a merge of two entity records needs evidence, a stated fact and the descriptions " +
  "that show it, and this list carries none. Merge entities with merge-entity rows in an authorities file " +
  "(scripts/fisqua.ts authorities), giving facts and evidence_codes. Nothing was read or written.";

/** No entity is merged without evidence on any path; this list has none to give, so only its dry run runs. */
export function refuseApply(args: { apply: boolean }): void {
  if (args.apply) throw new Error(APPLY_REFUSED);
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const args = parseMergeArgs(argv, SOURCE_LIST);
  refuseApply(args);
  const { target } = args;
  const tenantRows = query<{ id: string; federation_id: string }>(
    target,
    `SELECT id, federation_id FROM tenants WHERE slug = ${escapeSql(args.tenant)}`,
  );
  if (tenantRows.length !== 1) throw new Error(`No tenant ${args.tenant} on ${target}. Nothing read or written.`);
  const tenant = { id: tenantRows[0].id, federationId: tenantRows[0].federation_id };

  const list = readEntityMergeList(readFileSync(args.list));
  console.log(
    `${SOURCE_LIST}: ${list.total} rows, ${list.rows.length} to merge, ${list.held.length} MATCH held; skipped ${JSON.stringify(list.skipped)}`,
  );

  console.log(`Reading ${target}…`);
  const codes = [...new Set(list.rows.flatMap((r) => [r.survivorCode, r.loserCode]).filter(Boolean))];
  const byCode = readEntities(target, codes);
  const plan = planEntityMerges(list.rows, byCode);
  const entityIds = plan.groups.flatMap((g) => [g.survivor.id, ...g.pairs.map((p) => p.loser.id)]);
  // The tenant may merge only records it can see: its federation's
  // shared records and its own.
  for (const g of plan.groups) {
    for (const r of [g.survivor, ...g.pairs.map((p) => p.loser)]) {
      if (r.federationId !== tenant.federationId || (r.tenantId !== null && r.tenantId !== tenant.id)) {
        plan.refusals.push({ ref: r.code, reason: `this entity is not one ${args.tenant} can merge (another federation's, or another tenant's own)` });
      }
    }
  }
  const links = readLinks(target, tenant.id, entityIds);
  console.log(`  ${byCode.size} of ${codes.length} codes found; ${[...links.values()].reduce((n, l) => n + l.length, 0)} links on them`);

  const users = query<{ id: string }>(target, `SELECT id FROM users WHERE id = ${escapeSql(USER)}`);
  if (users.length !== 1) plan.refusals.push({ ref: "target", reason: `no ${USER} on ${target}; the ledger needs a user` });
  // The user acts in the tenant as the command line's other nouns resolve
  // the actor; a merge of a shared record needs a steward of the federation.
  const shared = plan.groups.some((g) => [g.survivor, ...g.pairs.map((p) => p.loser)].some((r) => r.tenantId === null));
  let acting: Awaited<ReturnType<typeof resolveCommandActor>> | null = null;
  if (users.length === 1) {
    try {
      acting = await resolveCommandActor(async (q) => query<Record<string, unknown>>(target, q), USER, args.tenant, { shared });
    } catch (err) {
      if (!(err instanceof AuthorityLinksStop)) throw err;
      plan.refusals.push({ ref: "actor", reason: err.message });
    }
  }

  const involved = new Set(entityIds);
  const openDecisions = query<{ id: string; source_ref: string | null; payload: string }>(
    target,
    `SELECT id, source_ref, payload FROM pending_decisions WHERE status = 'open' AND kind = 'duplicate-pair'`,
  )
    .filter((d) => [...involved].some((id) => (d.source_ref ?? "").includes(id) || (d.payload ?? "").includes(id)))
    .map((d) => ({ id: d.id, sourceRef: d.source_ref }));

  const now = Date.now();
  const functionsByEntity = readFunctions(target, plan.groups.flatMap((g) => [g.survivor.id, ...g.pairs.map((p) => p.loser.id)]));
  const pointing = readPointing(target, tenant.id, entityIds);
  const staleNamed = readStaleNamed(target, tenant.id, entityIds);
  const built = buildEntityStatements(plan, links, {
    userId: USER, actedAs: acting?.actedAs ?? null, now, tenantId: tenant.id, functionsByEntity, pointing, staleNamed,
  });
  // Who acts is checked once, here; the file opens by checking it again.
  if (acting && built.sql.length > 0) built.sql = [...acting.guards, ...built.sql];
  const sql = built.sql.join("\n") + "\n";
  for (const o of built.oversized) {
    plan.refusals.push({ ref: "sql", reason: `statement ${o.index + 1} is ${o.bytes} bytes, over the ${STATEMENT_BUDGET}-byte budget: ${o.head}` });
  }

  const report: Report = {
    target,
    generatedAt: new Date(now).toISOString(),
    apply: args.apply,
    list: args.list,
    listSummary: { total: list.total, skipped: list.skipped, held: list.held, merging: list.rows.length },
    counts: {
      merges: plan.groups.reduce((n, g) => n + g.pairs.length, 0),
      survivors: plan.groups.length,
      held: list.held.length,
      linksMoved: built.movedLinks,
      linksDropped: built.droppedLinks,
      functionsMoved: built.movedFunctions,
      functionsFolded: built.foldedFunctions.length,
      labelsChanged: built.labelChanges.length,
      namesExcluded: plan.exclusions.length,
      idsLeftOnLoser: plan.idsLeftOnLoser.length,
      refusals: plan.refusals.length,
      statements: built.sql.length,
      sqlBytes: Buffer.byteLength(sql),
      largestStatement: maxOf([0, ...built.sql.map((s) => Buffer.byteLength(s))]),
    },
    refusals: plan.refusals,
    held: list.held,
    exclusions: plan.exclusions,
    labelChanges: built.labelChanges,
    idsLeftOnLoser: plan.idsLeftOnLoser,
    openDecisions,
    merges: plan.groups.flatMap((g) =>
      g.pairs.map((p) => ({
        ref: p.row.ref, loser: p.loser.code, loserName: p.loser.displayName, survivor: g.survivor.code, survivorName: g.labelNew,
      })),
    ),
  };

  const stamp = new Date(now).toISOString().replace(/:/g, "-").replace(/\.\d+Z$/, "Z");
  const dir = join(process.cwd(), ".import");
  mkdirSync(dir, { recursive: true });
  const base = join(dir, `entity-merges_${target}_${stamp}`);
  writeFileSync(`${base}.json`, JSON.stringify(report, null, 2) + "\n");
  writeFileSync(`${base}.md`, formatMarkdown(report));

  const c = report.counts;
  console.log(`\nEntity merges for ${target}${args.apply ? "" : " (dry run)"}`);
  console.log(`  ${c.merges} merge(s) into ${c.survivors} survivor(s); ${c.held} held; ${c.linksMoved} link(s) moved, ${c.linksDropped} dropped; ${c.functionsMoved} function row(s) moved, ${c.functionsFolded} folded`);
  console.log(`  ${c.labelsChanged} label(s) changed; ${c.namesExcluded} name(s) left out of variants; ${c.idsLeftOnLoser} id(s) left on the loser`);
  for (const h of list.held) console.log(`  held ${h.ref}: ${h.why}`);
  for (const x of plan.exclusions) console.log(`  excluded ${x.ref}: "${x.name}" (${x.why})`);
  for (const l of built.labelChanges) console.log(`  relabel ${l.survivorCode}: ${l.old} → ${l.new}`);
  if (openDecisions.length > 0) console.log(`  ${openDecisions.length} open duplicate-pair decision(s) name a record in the list (left open)`);
  console.log(`  ${c.statements} statement(s), ${(c.sqlBytes / 1_048_576).toFixed(2)} MiB, largest ${c.largestStatement} bytes`);
  console.log(`Report: ${base}.md`);

  if (plan.refusals.length > 0) {
    for (const f of plan.refusals.slice(0, 50)) console.error(`  refused ${f.ref}: ${f.reason}`);
    throw new Error(`${plan.refusals.length} refusal(s); nothing written.`);
  }
  if (!args.apply) {
    console.log("\nRun with --apply to write.");
    return;
  }

  const sqlPath = `${base}.sql`;
  writeFileSync(sqlPath, sql);
  applyFile(target, sqlPath);
  console.log("\nRead back:");
  const loserIds = plan.groups.flatMap((g) => g.pairs.map((p) => p.loser.id));
  let merged = 0;
  let stillLinked = 0;
  for (let i = 0; i < loserIds.length; i += 200) {
    const ids = loserIds.slice(i, i + 200).map(escapeSql).join(", ");
    merged += query<{ n: number }>(target, `SELECT count(*) AS n FROM entities WHERE merged_into IS NOT NULL AND id IN (${ids})`)[0]?.n ?? 0;
    stillLinked += query<{ n: number }>(
      target,
      `SELECT count(*) AS n FROM description_entities WHERE entity_id IN (${ids}) AND ${inTenantDescriptions(tenant.id)}`,
    )[0]?.n ?? 0;
  }
  const ledger = query<{ n: number }>(
    target,
    `SELECT count(*) AS n FROM authority_operations WHERE operation = 'merge' AND record_type = 'entity' AND created_at = ${now}`,
  )[0]?.n ?? 0;
  console.log(`  losers merged: ${merged} of ${loserIds.length}`);
  console.log(`  ${args.tenant}'s links left on losers: ${stillLinked}`);
  console.log(`  ledger rows written: ${ledger}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error((err as Error).message);
    process.exit(1);
  });
}

// @version v0.9.0
