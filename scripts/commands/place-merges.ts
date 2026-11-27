#!/usr/bin/env npx tsx
/**
 * Place Merges — the Reviewed Colonial-Spelling Merge List
 *
 * This script applies the reviewed colonial-spelling merge list to a
 * Fisqua D1. The Neogranadina places hold many records that are one place
 * under two spellings (Guachipa and Huachipa, Cuchilla and Cuchillas). The
 * list `place-merges-final.csv` pairs them, and was reviewed and ruled on
 * 2026-10-24. Each loser merges into its final survivor as the decisions
 * surface merges a pair, survivors take the labels and the ids or
 * coordinates the ruling allows, and every effect is journaled and every
 * pair has its ledger row. Which rows merge, the label and carry rules,
 * the refusals and the SQL are in `scripts/lib/place-merges.ts`; the merge
 * statements themselves come from `app/lib/pair-merge.server.ts`.
 *
 * The dry run is the default: it reads the target's places in the list
 * and their description links (`wrangler d1 execute --remote --json
 * --command`, in pages), prints the plan and writes a report to
 * `.import/place-merges_<target>_<timestamp>.{json,md}`. Any refusal
 * stops the run before anything is written. `--apply` writes the
 * statements to one SQL file, applies it with `--file`, then reads the
 * records back and prints the counts. Production also needs
 * `--confirm-production`, and waits for an explicit go on the staging
 * and production dry-run reports.
 *
 * Journal and ledger rows are written under `user_001`; the ledger's
 * user is required, so a target without that user is refused.
 * That user acts in `--tenant` as the command line's other nouns resolve
 * the actor (`resolveCommandActor`): a user of it, a platform admin, or
 * the lead's workspace admin, and a steward of the federation when a
 * merge names a shared record. Each journal row records in `acted_as`
 * how they acted (NULL for a user of the tenant); the SQL file opens
 * with the guards that this still holds, and anything else refuses the
 * run. Open
 * duplicate-pair decisions that name a record in the list are reported
 * and left open.
 *
 * `--tenant <slug>` is required. A shared record can be linked from
 * several tenants' descriptions; only the named tenant's links are read,
 * moved and counted, and other tenants' links stay on the record merged
 * away, with its `merged_into` naming the survivor. A record of another
 * federation, or owned by another tenant, is refused.
 *
 * Usage:
 *   npx tsx scripts/commands/place-merges.ts --target staging --tenant neogranadina \
 *     --list .import/authority-review/place-merges-final.csv
 *   ... --target staging --apply
 *   ... --target production --apply --confirm-production
 *
 * @version v0.9.0
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { JunctionRow } from "../../app/lib/pair-merge.server";
import { escapeSql } from "../lib/sql";
import { AuthorityLinksStop, resolveCommandActor } from "../lib/authority-links";
import {
  PAGE,
  applyFile,
  inTenantDescriptions,
  parseMergeArgs,
  query,
  storedValue,
  typed,
  type Target,
} from "../lib/authority-merges";
import {
  GUARDED_COLUMNS,
  PULLED_BACK,
  SOURCE_LIST,
  STATEMENT_BUDGET,
  buildStatements,
  planMerges,
  readMergeList,
  type BuildResult,
  type ListSummary,
  type Plan,
  type PlaceRow,
  type Refusal,
  type StoredPlace,
} from "../lib/place-merges";

const USER = "user_001";

function readPlaces(target: Target, codes: string[]): Map<string, PlaceRow[]> {
  const byCode = new Map<string, PlaceRow[]>();
  for (let i = 0; i < codes.length; i += 200) {
    const list = codes.slice(i, i + 200).map(escapeSql).join(", ");
    const rows = query<Record<string, unknown>>(
      target,
      `SELECT id, ${typed(GUARDED_COLUMNS)} ` +
        `FROM places WHERE place_code IN (${list})`,
    );
    for (const r of rows) {
      const stored = Object.fromEntries(GUARDED_COLUMNS.map((c) => [c, storedValue(r, c)])) as StoredPlace;
      const text = (v: string | number | null): string | null => (v === null || v === "" ? null : String(v));
      const number = (v: string | number | null): number | null => (typeof v === "number" ? v : null);
      const p: PlaceRow = {
        id: String(r.id),
        federationId: String(stored.federation_id),
        tenantId: text(stored.tenant_id),
        code: String(stored.place_code),
        label: String(stored.label),
        displayName: String(stored.display_name),
        nameVariants: text(stored.name_variants) ?? "[]",
        mergedInto: text(stored.merged_into),
        tgnId: text(stored.tgn_id),
        hgisId: text(stored.hgis_id),
        whgId: text(stored.whg_id),
        latitude: number(stored.latitude),
        longitude: number(stored.longitude),
        coordinatePrecision: text(stored.coordinate_precision),
        legacyIds: String(stored.legacy_ids),
        updatedAt: Number(stored.updated_at),
        stored,
      };
      const list2 = byCode.get(p.code);
      if (list2) list2.push(p);
      else byCode.set(p.code, [p]);
    }
  }
  return byCode;
}

/** Every link from the tenant's descriptions to the given places, in full, keyed as Drizzle returns the rows. */
function readLinks(target: Target, tenantId: string, placeIds: string[]): Map<string, JunctionRow[]> {
  const out = new Map<string, JunctionRow[]>();
  for (let i = 0; i < placeIds.length; i += 100) {
    const list = placeIds.slice(i, i + 100).map(escapeSql).join(", ");
    let last = "";
    for (;;) {
      const page = query<Record<string, unknown>>(
        target,
        `SELECT id, description_id, place_id, ${typed(["role", "role_note", "role_raw", "created_at"])} FROM description_places ` +
          `WHERE place_id IN (${list}) AND ${inTenantDescriptions(tenantId)} ` +
          `AND id > ${escapeSql(last)} ORDER BY id LIMIT ${PAGE}`,
      );
      for (const r of page) {
        const link: JunctionRow = {
          id: String(r.id),
          descriptionId: String(r.description_id),
          placeId: String(r.place_id),
          role: storedValue(r, "role") as string,
          roleNote: storedValue(r, "role_note") as string | null,
          roleRaw: storedValue(r, "role_raw") as string | null,
          createdAt: storedValue(r, "created_at") as number,
        };
        const l = out.get(link.placeId as string);
        if (l) l.push(link);
        else out.set(link.placeId as string, [link]);
      }
      if (page.length < PAGE) break;
      last = String(page[page.length - 1].id);
    }
  }
  return out;
}

interface Report {
  target: Target;
  generatedAt: string;
  apply: boolean;
  list: string;
  listSummary: Omit<ListSummary, "rows"> & { merging: number };
  counts: {
    merges: number;
    survivors: number;
    linksMoved: number;
    linksDropped: number;
    labelsChanged: number;
    idsCarried: number;
    notCarried: number;
    refusals: number;
    statements: number;
    sqlBytes: number;
  };
  refusals: Refusal[];
  labelDecisions: Plan["labelDecisions"];
  labelChanges: BuildResult["labelChanges"];
  carried: Array<{ survivorCode: string } & Plan["groups"][number]["carried"][number]>;
  notCarried: Plan["notCarried"];
  openDecisions: Array<{ id: string; sourceRef: string | null }>;
  merges: Array<{ ref: string; loser: string; loserLabel: string; survivor: string; survivorLabel: string }>;
}

function formatMarkdown(r: Report): string {
  const lines: string[] = [];
  lines.push(`# Place merges — ${r.target}${r.apply ? "" : " (dry run)"}`, "");
  lines.push(`Generated ${r.generatedAt} from \`${r.list}\`.`, "");
  const c = r.counts;
  lines.push("| Count | |", "|---|---|");
  lines.push(`| List rows | ${r.listSummary.total} |`);
  for (const [k, v] of Object.entries(r.listSummary.skipped)) lines.push(`| Skipped: ${k} | ${v} |`);
  lines.push(`| Zipaquira pair added by the ruling | ${r.listSummary.zipaquiraAdded ? "yes" : "no (in the list)"} |`);
  lines.push(`| Merges | ${c.merges} |`, `| Survivors | ${c.survivors} |`, `| Links moved | ${c.linksMoved} |`);
  lines.push(`| Links dropped (survivor already held them) | ${c.linksDropped} |`, `| Labels changed | ${c.labelsChanged} |`);
  lines.push(`| Ids or coordinates carried | ${c.idsCarried} |`, `| Listed and not carried | ${c.notCarried} |`);
  lines.push(`| Refusals | ${c.refusals} |`, `| Statements | ${c.statements} (${(c.sqlBytes / 1_048_576).toFixed(2)} MiB) |`, "");
  lines.push("## Refusals", "");
  if (r.refusals.length === 0) lines.push("None.");
  for (const f of r.refusals) lines.push(`- ${f.ref}: ${f.reason}`);
  lines.push("", "## The eleven label exceptions", "");
  lines.push("| Rows | Survivor | Kept label | TGN record | Article test | Named in ruling | Applied | Note |");
  lines.push("|---|---|---|---|---|---|---|---|");
  for (const d of r.labelDecisions) {
    lines.push(`| ${d.ref} | ${d.survivorCode} | ${d.kept} | ${d.tgnSpelling} | ${d.ruleGives} | ${d.named ?? "—"} | **${d.applied}** | ${d.note || ""} |`);
  }
  lines.push("", "## Label changes", "");
  if (r.labelChanges.length === 0) lines.push("None.");
  for (const l of r.labelChanges) lines.push(`- ${l.survivorCode}: ${l.old} → ${l.new} (the old label joins name_variants)`);
  lines.push("", "## Ids and coordinates carried", "");
  if (r.carried.length === 0) lines.push("None.");
  for (const x of r.carried) lines.push(`- ${x.ref}: ${x.field} ${x.value} from ${x.loserCode} to ${x.survivorCode}`);
  lines.push("", "## Listed or held, and not carried", "");
  if (r.notCarried.length === 0) lines.push("None.");
  for (const x of r.notCarried) lines.push(`- ${x.ref} (${x.loserCode}): ${x.what} — ${x.why}`);
  lines.push("", "## Open duplicate-pair decisions naming a record in the list", "");
  if (r.openDecisions.length === 0) lines.push("None.");
  for (const d of r.openDecisions) lines.push(`- ${d.id} (${d.sourceRef ?? "no source_ref"}) — left open`);
  lines.push("", "## Merges", "", "| Row | Loser | Survivor |", "|---|---|---|");
  for (const m of r.merges) lines.push(`| ${m.ref} | ${m.loserLabel} (${m.loser}) | ${m.survivorLabel} (${m.survivor}) |`);
  return lines.join("\n") + "\n";
}

async function main(): Promise<void> {
  const args = parseMergeArgs(process.argv.slice(2), "place-merges-final.csv");
  const { target } = args;
  const tenantRows = query<{ id: string; federation_id: string }>(
    target,
    `SELECT id, federation_id FROM tenants WHERE slug = ${escapeSql(args.tenant)}`,
  );
  if (tenantRows.length !== 1) throw new Error(`No tenant ${args.tenant} on ${target}. Nothing read or written.`);
  const tenant = { id: tenantRows[0].id, federationId: tenantRows[0].federation_id };

  const summary = readMergeList(readFileSync(args.list));
  const pulled = [...summary.pulledBack].sort().join(",");
  if (pulled !== [...PULLED_BACK].sort().join(",")) {
    throw new Error(`The list pulls back ${pulled || "nothing"}; the ruling names ${PULLED_BACK.join(", ")}. Nothing read or written.`);
  }
  console.log(`${SOURCE_LIST}: ${summary.total} rows, ${summary.rows.length} to merge; skipped ${JSON.stringify(summary.skipped)}`);

  console.log(`Reading ${target}…`);
  const codes = [...new Set(summary.rows.flatMap((r) => [r.survivorCode, r.loserCode, r.finalSurvivorCode]).filter(Boolean))];
  const byCode = readPlaces(target, codes);
  const plan = planMerges(summary.rows, byCode);
  const placeIds = plan.groups.flatMap((g) => [g.survivor.id, ...g.pairs.map((p) => p.loser.id)]);
  // The tenant may merge only records it can see: its federation's
  // shared records and its own.
  for (const g of plan.groups) {
    for (const r of [g.survivor, ...g.pairs.map((p) => p.loser)]) {
      if (r.federationId !== tenant.federationId || (r.tenantId !== null && r.tenantId !== tenant.id)) {
        plan.refusals.push({ ref: r.code, reason: `this place is not one ${args.tenant} can merge (another federation's, or another tenant's own)` });
      }
    }
  }
  const links = readLinks(target, tenant.id, placeIds);
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

  const involved = new Set(placeIds);
  const openDecisions = query<{ id: string; source_ref: string | null; payload: string }>(
    target,
    `SELECT id, source_ref, payload FROM pending_decisions WHERE status = 'open' AND kind = 'duplicate-pair'`,
  )
    .filter((d) => [...involved].some((id) => (d.source_ref ?? "").includes(id) || (d.payload ?? "").includes(id)))
    .map((d) => ({ id: d.id, sourceRef: d.source_ref }));

  const now = Date.now();
  const built = buildStatements(plan, links, { userId: USER, actedAs: acting?.actedAs ?? null, now, tenantId: tenant.id });
  // Who acts is checked once, here; the file opens by checking it again.
  if (acting && built.sql.length > 0) built.sql = [...acting.guards, ...built.sql];
  const sql = built.sql.join("\n") + "\n";
  for (const o of built.oversized) {
    plan.refusals.push({ ref: "sql", reason: `statement ${o.index + 1} is ${o.bytes} bytes, over the ${STATEMENT_BUDGET}-byte budget: ${o.head}` });
  }
  const carried = plan.groups.flatMap((g) => g.carried.map((c) => ({ survivorCode: g.survivor.code, ...c })));

  const report: Report = {
    target,
    generatedAt: new Date(now).toISOString(),
    apply: args.apply,
    list: args.list,
    listSummary: {
      total: summary.total, skipped: summary.skipped, pulledBack: summary.pulledBack,
      zipaquiraAdded: summary.zipaquiraAdded, merging: summary.rows.length,
    },
    counts: {
      merges: plan.groups.reduce((n, g) => n + g.pairs.length, 0),
      survivors: plan.groups.length,
      linksMoved: built.movedLinks,
      linksDropped: built.droppedLinks,
      labelsChanged: built.labelChanges.length,
      idsCarried: carried.length,
      notCarried: plan.notCarried.length,
      refusals: plan.refusals.length,
      statements: built.sql.length,
      sqlBytes: Buffer.byteLength(sql),
    },
    refusals: plan.refusals,
    labelDecisions: plan.labelDecisions,
    labelChanges: built.labelChanges,
    carried,
    notCarried: plan.notCarried,
    openDecisions,
    merges: plan.groups.flatMap((g) =>
      g.pairs.map((p) => ({
        ref: p.row.ref, loser: p.loser.code, loserLabel: p.loser.label, survivor: g.survivor.code, survivorLabel: g.labelNew,
      })),
    ),
  };

  const stamp = new Date(now).toISOString().replace(/:/g, "-").replace(/\.\d+Z$/, "Z");
  const dir = join(process.cwd(), ".import");
  mkdirSync(dir, { recursive: true });
  const base = join(dir, `place-merges_${target}_${stamp}`);
  writeFileSync(`${base}.json`, JSON.stringify(report, null, 2) + "\n");
  writeFileSync(`${base}.md`, formatMarkdown(report));

  const c = report.counts;
  console.log(`\nPlace merges for ${target}${args.apply ? "" : " (dry run)"}`);
  console.log(`  ${c.merges} merge(s) into ${c.survivors} survivor(s); ${c.linksMoved} link(s) moved, ${c.linksDropped} dropped`);
  console.log(`  ${c.labelsChanged} label(s) changed; ${c.idsCarried} id/coordinate carry(ies); ${c.notCarried} listed and not carried`);
  for (const d of plan.labelDecisions) {
    console.log(`  label ${d.kept} [${d.ref}]: TGN "${d.tgnSpelling}", article test "${d.ruleGives}", ruling ${d.named ? `"${d.named}"` : "—"} → ${d.applied}${d.note ? ` (${d.note})` : ""}`);
  }
  for (const l of built.labelChanges) console.log(`  relabel ${l.survivorCode}: ${l.old} → ${l.new}`);
  if (openDecisions.length > 0) console.log(`  ${openDecisions.length} open duplicate-pair decision(s) name a record in the list (left open)`);
  console.log(`  ${c.statements} statement(s), ${(c.sqlBytes / 1_048_576).toFixed(2)} MiB`);
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
    const list = loserIds.slice(i, i + 200).map(escapeSql).join(", ");
    merged += query<{ n: number }>(target, `SELECT count(*) AS n FROM places WHERE merged_into IS NOT NULL AND id IN (${list})`)[0]?.n ?? 0;
    stillLinked += query<{ n: number }>(
      target,
      `SELECT count(*) AS n FROM description_places WHERE place_id IN (${list}) AND ${inTenantDescriptions(tenant.id)}`,
    )[0]?.n ?? 0;
  }
  const ledger = query<{ n: number }>(
    target,
    `SELECT count(*) AS n FROM authority_operations WHERE operation = 'merge' AND record_type = 'place' AND created_at = ${now}`,
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
