/**
 * Scripts — applying the reviewed list of entity merges
 *
 * This module deals with the high-confidence entity duplicates of the
 * Neogranadina catalogue (`entity-merges-final.csv`, reviewed and ruled
 * 2026-10-24): which rows merge, which are held, what each survivor ends
 * up called, the names left out of its variants, the refusals that stop
 * a run, and the SQL. The command in `scripts/commands/entity-merges.ts`
 * reads the list and the target D1 and hands both to `planEntityMerges`
 * and `buildEntityStatements` here; the guards, the rendering and the
 * size budget are shared with the place command in `./authority-merges`.
 *
 * Rows merged: MATCH, unless the row is held. A row is held when its
 * `precondition` names a link to detach first (#27, #29, #93: where that
 * link goes is a cataloguing decision) or when the ruling holds it (#2,
 * whose label depends on a split). NOT-MATCH and DOUBTFUL rows are
 * counted and left alone; held rows are reported.
 *
 * A merge is the decisions surface's merge (`rulePairMerge`) for an
 * entity: every link moves, a link the survivor already holds on the
 * same description in the same role is dropped, the loser's display name
 * and variants fold into the survivor's `name_variants`, the loser gets
 * `merged_into` and its provenance line in `sources`, and each effect has
 * its journal row plus one ledger row per pair. The statements come from
 * `composeLinkMoves` and `composeMergeStatements` in
 * `app/lib/pair-merge.server.ts`. The provenance line names the survivor
 * by its label after the merge.
 *
 * Names: everything the loser carries folds in, except transcription
 * slips, which are left out of the survivor's variants, wherever they
 * stand: the strings of the list's `name_variants_remove` column and the
 * slips the review names (`EXCLUDED_SLIPS`). The survivor's label is
 * not kept among its own variants either, as the list has it, so a
 * loser of the same name adds nothing. A survivor whose label
 * changes (`label_to_keep`) takes it as its display name; its old display
 * name joins the variants, unless it is a slip, and the new one leaves them. `sort_name` is not
 * changed. The variants each survivor ends with are checked against the
 * list's `name_variants_add`; a difference refuses the run.
 *
 * Ids: the list carries none (`ids_to_carry` is empty), and a row that
 * names one is refused. A pair holding two different values of
 * `wikidata_id`, `viaf_id` or `dbe_id` is refused; an id only the loser
 * holds is reported and left on the loser.
 *
 * Refused before anything is written: a code not found or found twice,
 * a survivor or loser that is not one of the row's pair, a loser listed
 * twice, a loser already merged, a survivor itself merged or also a
 * loser, records in different federations, rows of one survivor naming
 * different labels, an excluded name the records do not hold, and the
 * name and id checks above.
 *
 * Links: only the named tenant's move. A shared entity can be linked
 * from several tenants' descriptions; the command reads the tenant's
 * links alone, and every link count in the guards is the tenant's, so
 * other tenants' links stay on the record merged away.
 *
 * The SQL opens with guards on every survivor and loser (each column the
 * plan reads or writes, as stored), the link counts, and every link moved
 * or dropped and every survivor link a drop relies on (all its columns,
 * as read); it closes with guards on the result. Journal before-images
 * are the stored values.
 *
 * Versions: each loser and each survivor takes `nextVersion` of the
 * `updated_at` read, the run's `now` or one past the value read when
 * that is at or after `now`, so a save that read either before the file
 * fails its version check after it; the closing guards expect those
 * values.
 *
 * Functions: each loser's `entity_functions` rows go to its survivor
 * in the merge's statements (`composeMergeStatements`). A row of a
 * function the survivor does not hold by then moves, id and columns
 * kept; a row of one it holds, its own or brought by an earlier row or
 * loser of the group (text compared after trimming, collapsing
 * whitespace and case-folding), fills the held row's empty fields and is
 * deleted. Its ledger row names the rows moved (`movedFunctions`) and
 * gives the rows folded (`foldedFunctions`). The command reads every
 * row of each loser and survivor in full (`functionsByEntity`); the file
 * opens with guards that each holds exactly the rows read, every column
 * as read, and closes with guards that each moved row names its
 * survivor, each folded row is gone, each survivor holds exactly the
 * rows planned with the fields planned, and no loser holds any.
 *
 * Relation repoints: a drop's partner names the kept link instead. Only a
 * link on the same description, one of the tenant's, counts as a partner
 * (`pointingLinksSql`); a loser's link named from anywhere else is stale
 * data (`staleNamingSql` reads only its id), and the file is refused
 * naming only that link (`staleNamingMessage`). A
 * file whose repoints would leave two links under one key of the unique
 * index (`mergeLinkCollisions`) is refused by `buildEntityStatements`
 * before any statement is composed, naming the description, the entity
 * and the role by id; the command line's plan refuses the row first, by
 * their codes.
 *
 * Another caller whose merges come from another file passes `source` to
 * `buildEntityStatements` for the reason, the ledger detail and the note
 * of a label change; the command's are the list's. The command line's
 * `merge-entity` (`scripts/lib/authorities-cli/`) does so.
 *
 * @version v0.9.0
 */

import { and, eq } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { entities } from "../../app/db/schema";
import { nextVersion, type EntityFunctionRow, type FoldedFunction } from "../../app/lib/entity-functions.server";
import { decodeAndParseCsv } from "../../app/lib/import/csv";
import { composeJournalEntry } from "../../app/lib/stewardship.server";
import type { ChangelogActedAs } from "../../app/db/schema";
import {
  composeLinkMoves,
  composeMergeStatements,
  composeRepoints,
  heldKey,
  heldLinks,
  linkCollisionMessage,
  linkCollisions,
  parseVariants,
  type AuthorityRecordSnapshot,
  type JunctionRow,
  type LinkCollision,
} from "../../app/lib/pair-merge.server";
import { escapeSql } from "./sql";
import {
  chunks,
  composer,
  guard,
  idList,
  inTenantDescriptions,
  matchingGuards,
  oversizedStatements,
  render,
} from "./authority-merges";
import { appendAll } from "./arrays";

export const SOURCE_LIST = "entity-merges-final.csv";

/** MATCH rows held by the ruling beyond those whose precondition names a link to detach. */
export const HELD_BY_RULING: Record<string, string> = {
  "2": "its label (José del Valle y Torres) depends on splitting off the survivor's 1816-1824 links",
};

/** Transcription slips the review names, by pair: left out of the survivor's variants. */
export const EXCLUDED_SLIPS: Record<string, string[]> = {
  "15": ["Gregori0 Paniso"],
  "16": ["Joseph Escavar"],
  "64": ["Jose Antonio Dimas de Acevedop"],
  "126": ["Pedro Hinehilla"],
  "127": ["Bernaro Diaz de Buitrago"],
  "129": ["Juan A Castaño"],
  "145": ["Juan Serano"],
  "150": ["Luicio Martinez"],
};

/** Entity columns the plan reads or the file writes, compared as stored before anything is written. */
export const ENTITY_GUARDED_COLUMNS = [
  "updated_at", "federation_id", "tenant_id", "merged_into", "entity_code", "display_name", "sort_name", "name_variants",
  "wikidata_id", "viaf_id", "dbe_id", "sources",
] as const;

/** Every column of a `description_entities` row, as the journal records it. */
export const LINK_COLUMNS = [
  "id", "description_id", "entity_id", "role", "role_note", "role_raw", "sequence", "honorific", "attributes",
  "name_as_recorded", "created_at", "related_to", "relation_certainty",
] as const;

const ID_COLUMNS = [
  ["wikidataId", "wikidata_id"],
  ["viafId", "viaf_id"],
  ["dbeId", "dbe_id"],
] as const;

export type StoredEntity = Record<(typeof ENTITY_GUARDED_COLUMNS)[number], string | number | null>;

export interface EntityRow {
  id: string;
  federationId: string;
  tenantId: string | null;
  code: string;
  displayName: string;
  sortName: string;
  /** `[]` for a stored NULL or empty string. */
  nameVariants: string;
  mergedInto: string | null;
  wikidataId: string | null;
  viafId: string | null;
  dbeId: string | null;
  sources: string | null;
  updatedAt: number;
  /** The guarded columns as stored; absent, the fields above stand in. */
  stored?: StoredEntity;
}

export function storedOfEntity(e: EntityRow): StoredEntity {
  return e.stored ?? {
    updated_at: e.updatedAt, federation_id: e.federationId, tenant_id: e.tenantId, merged_into: e.mergedInto, entity_code: e.code,
    display_name: e.displayName, sort_name: e.sortName, name_variants: e.nameVariants, wikidata_id: e.wikidataId,
    viaf_id: e.viafId, dbe_id: e.dbeId, sources: e.sources,
  };
}

export interface EntityMergeRow {
  /** "#27": the list's pair number. */
  ref: string;
  pair: string;
  codeA: string;
  codeB: string;
  survivorCode: string;
  loserCode: string;
  labelToKeep: string;
  add: string[];
  /** `name_variants_remove`, each with its annotation stripped. */
  remove: string[];
  idsToCarry: string;
  idsNotCarried: string;
  precondition: string;
}

export interface HeldRow {
  ref: string;
  survivorCode: string;
  loserCode: string;
  why: string;
}

export interface EntityList {
  rows: EntityMergeRow[];
  held: HeldRow[];
  total: number;
  skipped: Record<string, number>;
}

export interface Refusal {
  ref: string;
  reason: string;
}

export interface Exclusion {
  ref: string;
  survivorCode: string;
  name: string;
  why: string;
}

export interface EntityGroup {
  survivor: EntityRow;
  pairs: Array<{ row: EntityMergeRow; loser: EntityRow }>;
  labelNew: string;
  /** Names left out of the survivor's variants. */
  exclude: Set<string>;
  /** The variants the survivor is planned to end with. */
  finalVariants: string[];
}

export interface EntityPlan {
  groups: EntityGroup[];
  refusals: Refusal[];
  exclusions: Exclusion[];
  idsLeftOnLoser: Array<{ ref: string; loserCode: string; what: string }>;
}

const COLUMNS = [
  "pair", "decision", "code_a", "code_b", "survivor_code", "loser_code", "label_to_keep", "name_variants_add",
  "name_variants_remove", "ids_to_carry", "ids_not_carried", "precondition",
];

const split = (text: string) => text.split(" | ").map((s) => s.trim()).filter(Boolean);

/** Read the list: MATCH rows to merge, MATCH rows held, and the rest counted. */
export function readEntityMergeList(bytes: Uint8Array): EntityList {
  const parsed = decodeAndParseCsv(bytes);
  const at = new Map(parsed.headers.map((h, i) => [h, i]));
  for (const c of COLUMNS) if (!at.has(c)) throw new Error(`${SOURCE_LIST} has no ${c} column`);
  const get = (r: string[], c: string) => (r[at.get(c)!] ?? "").trim();
  const rows: EntityMergeRow[] = [];
  const held: HeldRow[] = [];
  const skipped: Record<string, number> = {};
  for (const r of parsed.rows) {
    const decision = get(r, "decision");
    if (decision !== "MATCH") {
      skipped[decision] = (skipped[decision] ?? 0) + 1;
      continue;
    }
    const row: EntityMergeRow = {
      ref: `#${get(r, "pair")}`,
      pair: get(r, "pair"),
      codeA: get(r, "code_a"),
      codeB: get(r, "code_b"),
      survivorCode: get(r, "survivor_code"),
      loserCode: get(r, "loser_code"),
      labelToKeep: get(r, "label_to_keep"),
      add: split(get(r, "name_variants_add")),
      remove: split(get(r, "name_variants_remove")).map((s) => s.replace(/\s*\([^)]*\)$/, "")),
      idsToCarry: get(r, "ids_to_carry"),
      idsNotCarried: get(r, "ids_not_carried"),
      precondition: get(r, "precondition"),
    };
    const why = row.precondition ? `precondition: ${row.precondition}` : HELD_BY_RULING[row.pair];
    if (why) held.push({ ref: row.ref, survivorCode: row.survivorCode, loserCode: row.loserCode, why });
    else rows.push(row);
  }
  return { rows, held, total: parsed.rowCount, skipped };
}

const empty = (v: string | null) => v === null || v === "";

/**
 * Check the list against the target's entities and plan every group.
 * `byCode` maps each entity code to every record holding it.
 */
export function planEntityMerges(rows: EntityMergeRow[], byCode: Map<string, EntityRow[]>): EntityPlan {
  const refusals: Refusal[] = [];
  const refuse = (ref: string, reason: string) => refusals.push({ ref, reason });
  const one = (ref: string, code: string, what: string): EntityRow | null => {
    const found = byCode.get(code) ?? [];
    if (found.length === 0) refuse(ref, `${what} ${code || "(empty)"} not found`);
    else if (found.length > 1) refuse(ref, `${what} ${code} found ${found.length} times`);
    return found.length === 1 ? found[0] : null;
  };

  const loserRows = new Map<string, EntityMergeRow>();
  for (const row of rows) {
    if (loserRows.has(row.loserCode)) refuse(row.ref, `loser ${row.loserCode} appears twice (also ${loserRows.get(row.loserCode)!.ref})`);
    else loserRows.set(row.loserCode, row);
  }

  const groups = new Map<string, EntityGroup>();
  const idsLeftOnLoser: EntityPlan["idsLeftOnLoser"] = [];
  for (const row of rows) {
    const pairCodes = [row.codeA, row.codeB];
    if (!pairCodes.includes(row.survivorCode) || !pairCodes.includes(row.loserCode) || row.survivorCode === row.loserCode) {
      refuse(row.ref, `survivor ${row.survivorCode} and loser ${row.loserCode} are not the pair ${row.codeA} / ${row.codeB}`);
      continue;
    }
    if (row.idsToCarry) refuse(row.ref, `the list carries ids (${row.idsToCarry}); the ruling carries none`);
    const loser = one(row.ref, row.loserCode, "loser");
    const survivor = one(row.ref, row.survivorCode, "survivor");
    if (!loser || !survivor) continue;
    if (loser.mergedInto) refuse(row.ref, `loser ${loser.code} is already merged (into ${loser.mergedInto})`);
    if (survivor.mergedInto) refuse(row.ref, `survivor ${survivor.code} is itself merged (into ${survivor.mergedInto})`);
    if (loserRows.has(survivor.code)) refuse(row.ref, `survivor ${survivor.code} is also a loser in the list`);
    if (loser.federationId !== survivor.federationId) refuse(row.ref, `${loser.code} and ${survivor.code} are in different federations`);
    for (const [field] of ID_COLUMNS) {
      const s = survivor[field];
      const l = loser[field];
      if (!empty(s) && !empty(l) && s !== l) refuse(row.ref, `${survivor.code} and ${loser.code} hold different ${field} (${s} / ${l})`);
      else if (empty(s) && !empty(l)) idsLeftOnLoser.push({ ref: row.ref, loserCode: loser.code, what: `${field} ${l}` });
    }
    let g = groups.get(survivor.id);
    if (!g) {
      g = { survivor, pairs: [], labelNew: survivor.displayName, exclude: new Set(), finalVariants: [] };
      groups.set(survivor.id, g);
    }
    g.pairs.push({ row, loser });
  }

  const exclusions: Exclusion[] = [];
  for (const g of groups.values()) {
    const ref = g.pairs.map((p) => p.row.ref).join(", ");
    const labels = new Set(g.pairs.map((p) => p.row.labelToKeep).filter(Boolean));
    if (labels.size > 1) refuse(ref, `rows for ${g.survivor.code} disagree on the label: ${[...labels].join(" / ")}`);
    if (labels.size === 1) g.labelNew = [...labels][0];

    // Every name the group's records hold, for checking the exclusions against.
    const held = new Set([
      ...parseVariants(g.survivor.nameVariants),
      g.survivor.displayName,
      ...g.pairs.flatMap((p) => [p.loser.displayName, ...parseVariants(p.loser.nameVariants)]),
    ]);
    for (const p of g.pairs) {
      for (const name of p.row.remove) {
        if (name === g.labelNew) continue; // the new label leaves the variants anyway
        if (!held.has(name)) refuse(p.row.ref, `name_variants_remove names "${name}", which no record of the pair holds`);
        g.exclude.add(name);
        exclusions.push({ ref: p.row.ref, survivorCode: g.survivor.code, name, why: "name_variants_remove" });
      }
      for (const name of EXCLUDED_SLIPS[p.row.pair] ?? []) {
        if (!held.has(name)) refuse(p.row.ref, `the slip "${name}" is not held by either record`);
        g.exclude.add(name);
        exclusions.push({ ref: p.row.ref, survivorCode: g.survivor.code, name, why: "transcription slip named in the review" });
      }
    }

    // The variants the survivor ends with: the fold, the exclusions and the
    // survivor's own label (a name it already answers to), then the label change.
    let variants = parseVariants(g.survivor.nameVariants);
    for (const p of g.pairs) {
      variants = Array.from(new Set([...variants, p.loser.displayName, ...parseVariants(p.loser.nameVariants)]))
        .filter((n) => !g.exclude.has(n) && n !== g.labelNew);
    }
    if (g.labelNew !== g.survivor.displayName) {
      variants = Array.from(new Set([...variants, g.survivor.displayName])).filter((n) => n !== g.labelNew && !g.exclude.has(n));
    }
    g.finalVariants = variants;

    // The list's view of what is added.
    const before = new Set(parseVariants(g.survivor.nameVariants));
    const added = variants.filter((n) => !before.has(n)).sort();
    const listed = [...new Set(g.pairs.flatMap((p) => p.row.add))].filter((n) => !g.exclude.has(n) && n !== g.labelNew).sort();
    if (added.join("\u0000") !== listed.join("\u0000")) {
      refuse(ref, `${g.survivor.code} would gain ${JSON.stringify(added)}; the list adds ${JSON.stringify(listed)}`);
    }
  }

  return { groups: [...groups.values()], refusals, exclusions, idsLeftOnLoser };
}

export interface EntityBuildOptions {
  userId: string;
  /** How a command line actor acted (`changelog.acted_as`): null for a member. */
  actedAs?: ChangelogActedAs | null;
  now: number;
  /** The tenant whose description links move; `linksByEntity` holds only its links. */
  tenantId: string;
  /** Each loser's and survivor's `entity_functions` rows in full, in entry order; a record absent here holds none. */
  functionsByEntity?: Map<string, EntityFunctionRow[]>;
  /**
   * The links naming each link of `linksByEntity` in `related_to` (the
   * other sides of its relations), keyed by the link named, in full, as
   * `pointingLinksSql` reads them; absent, none is read and a drop that
   * one names fails the file's guards.
   */
  pointing?: Map<string, JunctionRow[]>;
  /**
   * The links of `linksByEntity` that a link outside their own
   * description names, as `staleNamingSql` reads them. A loser holding
   * one refuses the file.
   */
  staleNamed?: ReadonlySet<string>;
  /**
   * The reason and ledger detail of a row's merge, and the note of a
   * survivor's label change, for a caller whose rows come from another
   * file; absent, those of the reviewed list.
   */
  source?: {
    reason: (row: EntityMergeRow) => string;
    detail: (row: EntityMergeRow) => Record<string, unknown>;
    labelNote: (rows: EntityMergeRow[]) => string;
  };
}

export interface EntityBuildResult {
  composed: any[];
  sql: string[];
  oversized: Array<{ index: number; bytes: number; head: string }>;
  movedLinks: number;
  droppedLinks: number;
  /** Function rows moved from losers to survivors. */
  movedFunctions: number;
  /** Function rows of losers folded into a row of the same function on their survivor, with the codes of both records. */
  foldedFunctions: Array<FoldedFunction & { loserCode: string; survivorCode: string; conflicts: Array<{ field: string; held: string; incoming: string }> }>;
  /** `oldKept`: whether the old label stays as a variant (not when it is a slip). */
  labelChanges: Array<{ survivorCode: string; old: string; new: string; sortName: string; oldKept: boolean }>;
  /** Survivor id → the `name_variants` the file leaves it with. */
  finalVariants: Map<string, string>;
}

const raw = (v: string | number | null) => (v === null ? null : String(v));

/** Every column of an `entity_functions` row, as the guards compare it. */
export const FUNCTION_ROW_COLUMNS = [
  "id", "entity_id", "honorific", "function", "date_start", "date_end", "date_note", "certainty", "source", "notes", "created_at", "updated_at",
] as const;

/** The columns a survivor's row is checked on after the file: its owner, text and the fields a fold fills. */
const FILLED_CHECK_COLUMNS = ["id", "entity_id", "function", "honorific", "date_start", "date_end", "date_note", "source", "notes"];

/** A row's values in `FUNCTION_ROW_COLUMNS` order. */
const functionRowValues = (f: EntityFunctionRow) => [
  f.id, f.entityId, f.honorific, f.function, f.dateStart, f.dateEnd, f.dateNote, f.certainty, f.source, f.notes, f.createdAt, f.updatedAt,
];

/** An `entity_functions` row read through wrangler (column names), as the app's row. */
export function functionRowOf(r: Record<string, unknown>): EntityFunctionRow {
  const t = (c: string) => (r[c] === null || r[c] === undefined ? null : String(r[c]));
  return {
    id: String(r.id), entityId: String(r.entity_id), honorific: t("honorific"), function: String(r.function ?? ""), dateStart: t("date_start"),
    dateEnd: t("date_end"), dateNote: t("date_note"), certainty: t("certainty") as EntityFunctionRow["certainty"], source: t("source"),
    notes: t("notes"), createdAt: Number(r.created_at), updatedAt: Number(r.updated_at),
  };
}

/**
 * The condition, on a `description_entities` row read as `alias`, that the
 * link it names in `related_to` is on the same description and that the
 * description is the tenant's: only such a link is a relation side of it.
 */
const namesOnItsDescription = (alias: string, tenantId: string) =>
  `${alias}.description_id IN (SELECT id FROM descriptions WHERE tenant_id = ${escapeSql(tenantId)}) ` +
  `AND ${alias}.description_id = (SELECT named.description_id FROM description_entities AS named WHERE named.id = ${alias}.related_to)`;

/** The ids of the links of `entityIds` on the tenant's descriptions, as a subquery. */
const linksOf = (entityIds: string[], tenantId: string) =>
  `SELECT id FROM description_entities WHERE entity_id IN (${entityIds.map(escapeSql).join(", ")}) AND ${inTenantDescriptions(tenantId)}`;

/**
 * The query for the links naming, in `related_to`, a link of `entityIds`
 * on the tenant's descriptions: the other sides of their relations. A
 * link counts only when it is on the same description as the link it
 * names; one elsewhere is stale data, never read here
 * (`staleNamingSql` reports it by the link it names).
 */
export function pointingLinksSql(entityIds: string[], tenantId: string, typedColumns: string): string {
  return (
    `SELECT ${typedColumns} FROM description_entities AS pointing WHERE pointing.related_to IN (${linksOf(entityIds, tenantId)}) ` +
    `AND ${namesOnItsDescription("pointing", tenantId)}`
  );
}

/**
 * The query for the links of `entityIds` on the tenant's descriptions that
 * a link outside their own description names: stale data. It gives only
 * the ids of the links named, which are the tenant's; nothing of the
 * naming links is read.
 */
export function staleNamingSql(entityIds: string[], tenantId: string): string {
  return (
    `SELECT DISTINCT n.related_to AS id FROM description_entities AS n WHERE n.related_to IN (${linksOf(entityIds, tenantId)}) ` +
    `AND NOT (${namesOnItsDescription("n", tenantId)}) ORDER BY id`
  );
}

/** The refusal of a merge whose loser holds a link that a link outside its description names. */
export function staleNamingMessage(linkId: string, loserCode: string): string {
  return `link ${linkId} of ${loserCode} is named by a link outside its description, which is stale data: the merge is refused`;
}

/** A stored link row, read with `typed(LINK_COLUMNS)`, keyed as Drizzle returns it. */
export function junctionRowOf(v: (column: string) => unknown): JunctionRow {
  return {
    id: String(v("id")), descriptionId: String(v("description_id")), entityId: String(v("entity_id")), role: v("role") as string,
    roleNote: v("role_note"), roleRaw: v("role_raw"), sequence: v("sequence"), honorific: v("honorific"), attributes: v("attributes"),
    nameAsRecorded: v("name_as_recorded"), createdAt: v("created_at"), relatedTo: v("related_to"), relationCertainty: v("relation_certainty"),
  };
}

/** A link row's values in `LINK_COLUMNS` order. */
const linkValues = (l: JunctionRow) => [
  l.id, l.descriptionId, l.entityId, l.role, l.roleNote, l.roleRaw, l.sequence, l.honorific, l.attributes,
  l.nameAsRecorded, l.createdAt, l.relatedTo, l.relationCertainty,
];

/**
 * The losers' links that a link outside their own description names:
 * those `staleNamed` lists, and those a row of `pointing` names from
 * another description (a caller whose read was not scoped).
 */
export function staleLoserLinks(
  plan: EntityPlan,
  linksByEntity: Map<string, JunctionRow[]>,
  pointing: Map<string, JunctionRow[]>,
  staleNamed: ReadonlySet<string>,
): Array<{ linkId: string; loserId: string; loserCode: string }> {
  const out: Array<{ linkId: string; loserId: string; loserCode: string }> = [];
  for (const g of plan.groups) {
    for (const { loser } of g.pairs) {
      for (const l of linksByEntity.get(loser.id) ?? []) {
        const elsewhere = (pointing.get(l.id) ?? []).some((p) => p.descriptionId !== l.descriptionId);
        if (staleNamed.has(l.id) || elsewhere) out.push({ linkId: l.id, loserId: loser.id, loserCode: loser.code });
      }
    }
  }
  return out;
}

/** What the plan's merges do to the links read: the moves, the repoints and the drops, each with the loser that causes it. */
export interface MergeLinkChanges {
  /** Each moved loser link and the survivor it takes. */
  entityOf: Map<string, string>;
  /** Each repointed link and the kept link it comes to name. */
  relatedToOf: Map<string, string>;
  dropped: Set<string>;
  /** Each moved or repointed link and the loser whose merge changes it. */
  causeOf: Map<string, string>;
  /** The rows the changes act on, and those a changed link can share a key with. */
  rows: JunctionRow[];
}

/**
 * What the plan's merges do to the links read. The drops are decided as
 * `buildEntityStatements` decides them, survivor by survivor in the
 * plan's order; each link naming a dropped link, and not itself dropped,
 * comes to name the kept one. A link counts as naming another only when
 * both are on the same description: a link elsewhere that names one is
 * no relation side of it, and the file's guards refuse a drop it names.
 * `pointing` must hold the links naming any link of the survivors and
 * losers, as `pointingLinksSql` reads them for both: a repointed link can
 * share a key only with a link of the survivor or one naming the kept
 * link, and both are among the rows read.
 */
export function mergeLinkChanges(
  plan: EntityPlan,
  linksByEntity: Map<string, JunctionRow[]>,
  pointing: Map<string, JunctionRow[]>,
): MergeLinkChanges {
  const entityOf = new Map<string, string>();
  const relatedToOf = new Map<string, string>();
  const dropped = new Set<string>();
  const causeOf = new Map<string, string>();
  const repointed: Array<{ droppedId: string; keptId: string; loserId: string; descriptionId: string }> = [];
  for (const g of plan.groups) {
    const holds = heldLinks(linksByEntity.get(g.survivor.id) ?? []);
    for (const { loser } of g.pairs) {
      for (const l of linksByEntity.get(loser.id) ?? []) {
        const kept = holds.get(heldKey(l));
        if (kept !== undefined) {
          dropped.add(l.id);
          repointed.push({ droppedId: l.id, keptId: kept, loserId: loser.id, descriptionId: l.descriptionId });
        } else {
          holds.set(heldKey(l), l.id);
          entityOf.set(l.id, g.survivor.id);
          causeOf.set(l.id, loser.id);
        }
      }
    }
  }
  const named = new Map([...linksByEntity.values()].flat().map((l) => [l.id, l.descriptionId]));
  const local = [...pointing.values()].flat().filter((p) => named.get(String(p.relatedTo)) === p.descriptionId);
  for (const { droppedId, keptId, loserId, descriptionId } of repointed) {
    for (const p of pointing.get(droppedId) ?? []) {
      if (dropped.has(p.id) || p.descriptionId !== descriptionId) continue;
      relatedToOf.set(p.id, keptId);
      causeOf.set(p.id, loserId);
    }
  }
  return { entityOf, relatedToOf, dropped, causeOf, rows: [...[...linksByEntity.values()].flat(), ...local] };
}

/**
 * The pairs of links the plan's merges would leave under one key of the
 * unique index on `description_entities` (`linkCollisions`), each with
 * the loser whose merge makes it (`mergeLinkChanges`).
 */
export function mergeLinkCollisions(
  plan: EntityPlan,
  linksByEntity: Map<string, JunctionRow[]>,
  pointing: Map<string, JunctionRow[]>,
): Array<LinkCollision & { loserId: string }> {
  const { rows, causeOf, ...change } = mergeLinkChanges(plan, linksByEntity, pointing);
  return linkCollisions(rows, change).map((c) => ({
    ...c,
    loserId: causeOf.get(c.linkIds[1]) ?? causeOf.get(c.linkIds[0]) ?? "",
  }));
}

/**
 * Compose every group's statements. `linksByEntity` holds the full
 * `description_entities` rows of every survivor and loser whose
 * description is `opts.tenantId`'s; every link-count guard counts that
 * tenant's links only, so another tenant's links on a shared record are
 * neither moved nor counted, and stay on the loser.
 */
export function buildEntityStatements(
  plan: EntityPlan,
  linksByEntity: Map<string, JunctionRow[]>,
  opts: EntityBuildOptions,
  db: DrizzleD1Database<any> = composer(),
): EntityBuildResult {
  // A loser link named from outside its description is stale data: the
  // file would repoint or carry it, so the merge is refused, naming only
  // the loser's link.
  const stale = staleLoserLinks(plan, linksByEntity, opts.pointing ?? new Map(), opts.staleNamed ?? new Set())[0];
  if (stale) throw new Error(staleNamingMessage(stale.linkId, stale.loserCode));
  // A file whose repoints would leave two links under one key of the
  // unique index would fail whole when applied, with no word of which
  // links; it is refused here instead. The ids name the description and
  // the entity: a caller with their codes refuses before this, by them.
  const collision = mergeLinkCollisions(plan, linksByEntity, opts.pointing ?? new Map())[0];
  if (collision) {
    throw new Error(linkCollisionMessage({ referenceCode: collision.descriptionId, entityCode: collision.entityId, role: collision.role }));
  }
  const composed: any[] = [];
  let movedLinks = 0;
  let droppedLinks = 0;
  const collisions: Array<{ survivorId: string; descriptionId: string; role: string | null }> = [];
  const reliedOn = new Map<string, JunctionRow>();
  const movedInto = new Map<string, number>();
  const moved: Array<{ id: string; survivorId: string }> = [];
  const dropped: Array<{ id: string; survivorId: string }> = [];
  const labelChanges: EntityBuildResult["labelChanges"] = [];
  const finals: Array<{ id: string; mergedInto: string | number | null; displayName: string; nameVariants: string; version: number }> = [];
  const finalVariants = new Map<string, string>();
  const functionsOf = (id: string) => opts.functionsByEntity?.get(id) ?? [];
  const movedFunctionRows: Array<{ id: string; survivorId: string }> = [];
  const foldedFunctions: EntityBuildResult["foldedFunctions"] = [];
  // Each survivor's rows as the file leaves them, folds' fills applied.
  const survivorRowsAfter = new Map<string, EntityFunctionRow[]>();
  // The drops, decided first on the links as read, so the repoints they
  // need can be composed ahead of every move and drop of the file, and
  // each move journaled from its link as the repoints leave it: every
  // link's entries form one chain ending at the stored row.
  const repointed: Array<{ droppedId: string; keptId: string }> = [];
  for (const g of plan.groups) {
    const holds = heldLinks(linksByEntity.get(g.survivor.id) ?? []);
    for (const { loser } of g.pairs) {
      const links = linksByEntity.get(loser.id) ?? [];
      appendAll(repointed, composeLinkMoves(db, "entity", g.survivor.id, links, holds, opts.userId, opts.now).repointed);
      for (const l of links) if (!holds.has(heldKey(l))) holds.set(heldKey(l), l.id);
    }
  }
  const pointing = opts.pointing ?? new Map<string, JunctionRow[]>();
  const droppedSet = new Set(repointed.map((r) => r.droppedId));
  // They go first: the foreign key on `related_to` refuses the delete of
  // a link that is still named, so each link naming a dropped one names
  // the kept one before the drop.
  const repoints = composeRepoints(db, repointed, pointing, droppedSet, opts.userId, opts.now, new Map(), opts.actedAs ?? null);
  appendAll(composed, repoints.statements);

  for (const g of plan.groups) {
    const s = g.survivor;
    const st = storedOfEntity(s);
    // The provenance line names the survivor as it will be called.
    const snapshot: AuthorityRecordSnapshot = {
      id: s.id, displayName: g.labelNew, code: s.code, nameVariants: raw(st.name_variants), mergedInto: null, sources: null,
      updatedAt: s.updatedAt,
    };
    const holds = heldLinks(linksByEntity.get(s.id) ?? []);
    const ownLinks = new Map((linksByEntity.get(s.id) ?? []).map((l) => [heldKey(l), l]));
    const scope = eq(entities.federationId, s.federationId);
    let held = functionsOf(s.id);
    for (const { row, loser } of g.pairs) {
      const links = linksByEntity.get(loser.id) ?? [];
      const linkPlan = composeLinkMoves(db, "entity", s.id, links, holds, opts.userId, opts.now, repoints.after, opts.actedAs ?? null);
      for (const l of links) if (!holds.has(heldKey(l))) holds.set(heldKey(l), l.id);
      movedLinks += linkPlan.movedLinks;
      movedInto.set(s.id, (movedInto.get(s.id) ?? 0) + linkPlan.movedLinks);
      droppedLinks += linkPlan.droppedLinks.length;
      const droppedIds = new Set((linkPlan.droppedLinks as JunctionRow[]).map((d) => d.id));
      for (const l of links) (droppedIds.has(l.id) ? dropped : moved).push({ id: l.id, survivorId: s.id });
      for (const d of linkPlan.droppedLinks as JunctionRow[]) {
        collisions.push({ survivorId: s.id, descriptionId: d.descriptionId, role: d.role });
        const own = ownLinks.get(heldKey(d));
        if (own) reliedOn.set(own.id, own);
      }
      const lst = storedOfEntity(loser);
      const { statements, survivorVariants, functions } = composeMergeStatements(db, {
        recordType: "entity",
        scope,
        federationId: s.federationId,
        survivor: snapshot,
        loser: {
          id: loser.id, displayName: loser.displayName, code: loser.code, nameVariants: raw(lst.name_variants),
          mergedInto: raw(lst.merged_into), sources: raw(lst.sources), updatedAt: loser.updatedAt,
        },
        linkPlan,
        userId: opts.userId,
        actedAs: opts.actedAs ?? null,
        reason: opts.source ? opts.source.reason(row) : `Entity merge list ${SOURCE_LIST}, ruled 2026-10-24 (${row.ref})`,
        now: opts.now,
        detailExtra: opts.source ? opts.source.detail(row) : { list: SOURCE_LIST, listRef: row.ref },
        excludeVariants: new Set([...g.exclude, g.labelNew]),
        loserFunctions: functionsOf(loser.id),
        survivorFunctions: held,
      });
      for (const id of functions.moved) movedFunctionRows.push({ id, survivorId: s.id });
      for (const f of functions.folded) {
        foldedFunctions.push({ ...f, loserCode: loser.code, survivorCode: s.code, conflicts: functions.conflicts.get(f.row.id) ?? [] });
      }
      held = functions.after;
      appendAll(composed, statements);
      snapshot.nameVariants = survivorVariants;
    }

    // The survivor's own update: the label.
    const set: Record<string, unknown> = {};
    const diff: Record<string, { old: unknown; new: unknown }> = {};
    if (g.labelNew !== s.displayName) {
      const variants = Array.from(new Set([...parseVariants(snapshot.nameVariants), s.displayName]))
        .filter((n) => n !== g.labelNew && !g.exclude.has(n));
      set.displayName = g.labelNew;
      diff.displayName = { old: st.display_name, new: g.labelNew };
      const next = JSON.stringify(variants);
      if (next !== snapshot.nameVariants) {
        set.nameVariants = next;
        diff.nameVariants = { old: snapshot.nameVariants, new: next };
      }
      labelChanges.push({ survivorCode: s.code, old: s.displayName, new: g.labelNew, sortName: s.sortName, oldKept: variants.includes(s.displayName) });
      composed.push(
        db.update(entities).set({ ...set, updatedAt: nextVersion(s.updatedAt, opts.now) }).where(and(scope, eq(entities.id, s.id))),
        composeJournalEntry(db, {
          recordId: s.id,
          recordType: "entity",
          userId: opts.userId,
          actedAs: opts.actedAs ?? null,
          kind: "update",
          diff,
          note: opts.source
            ? opts.source.labelNote(g.pairs.map((p) => p.row))
            : `Entity merge list ${SOURCE_LIST}, ruled 2026-10-24 (${g.pairs.map((p) => p.row.ref).join(", ")}): label`,
          now: opts.now,
        }),
      );
    }
    survivorRowsAfter.set(s.id, held);
    const finalNames = (set.nameVariants as string | undefined) ?? snapshot.nameVariants!;
    finalVariants.set(s.id, finalNames);
    finals.push({
      id: s.id, mergedInto: st.merged_into, displayName: g.labelNew, nameVariants: finalNames, version: nextVersion(s.updatedAt, opts.now),
    });
  }

  // The repoints were composed ahead of the groups; each drop the file
  // makes is one they planned.
  if (dropped.length !== droppedSet.size || dropped.some((d) => !droppedSet.has(d.id))) {
    throw new Error("the drops composed are not those the repoints were planned for");
  }

  // Guards on what was read, and on what the file leaves.
  const survivors = plan.groups.map((g) => g.survivor);
  const losers = plan.groups.flatMap((g) => g.pairs.map((p) => p.loser));
  const involved = [...survivors, ...losers].map((e) => e.id);
  const linkCount = (ids: string[]) => ids.reduce((n, id) => n + (linksByEntity.get(id)?.length ?? 0), 0);
  const before: string[] = [];
  const after: string[] = [];
  const own = inTenantDescriptions(opts.tenantId);
  appendAll(before, matchingGuards(
    "entities",
    ["id", ...ENTITY_GUARDED_COLUMNS],
    [...survivors, ...losers].map((e) => { const st = storedOfEntity(e); return [e.id, ...ENTITY_GUARDED_COLUMNS.map((c) => st[c])]; }),
    "an entity in the list has changed since it was read",
  ));
  for (const ids of chunks(involved, 200)) {
    before.push(guard(`(SELECT count(*) FROM description_entities WHERE entity_id IN (${idList(ids)}) AND ${own}) = ${linkCount(ids)}`, "the links have changed since they were read"));
  }
  // Every row of each loser and survivor, as read: what moves and what folds depends on all of them.
  for (const ids of chunks(involved, 200)) {
    const n = ids.reduce((sum, id) => sum + functionsOf(id).length, 0);
    before.push(guard(`(SELECT count(*) FROM entity_functions WHERE entity_id IN (${idList(ids)})) = ${n}`, "a loser's functions have changed since they were read"));
  }
  appendAll(before, matchingGuards(
    "entity_functions",
    FUNCTION_ROW_COLUMNS,
    involved.flatMap((id) => functionsOf(id).map(functionRowValues)),
    "a loser's functions have changed since they were read",
  ));
  // The links naming a dropped link are those read, as read.
  const pointingRead = [...droppedSet].flatMap((id) => pointing.get(id) ?? []);
  for (const ids of chunks([...droppedSet], 200)) {
    const n = ids.reduce((sum, id) => sum + (pointing.get(id)?.length ?? 0), 0);
    before.push(guard(`(SELECT count(*) FROM description_entities WHERE related_to IN (${idList(ids)})) = ${n}`, "the links naming a dropped link have changed since they were read"));
  }
  const guarded = [...losers.flatMap((l) => linksByEntity.get(l.id) ?? []), ...reliedOn.values(), ...pointingRead.filter((p) => !droppedSet.has(p.id))];
  appendAll(before, matchingGuards("description_entities", LINK_COLUMNS, guarded.map(linkValues), "a link has changed since it was read"));
  appendAll(after, matchingGuards(
    "entities",
    ["id", "display_name", "COALESCE(name_variants, '[]')", "merged_into", "updated_at"],
    finals.map((f) => [f.id, f.displayName, f.nameVariants, f.mergedInto, f.version]),
    "a survivor does not hold its planned label and variants",
  ));
  // Every UPDATE touched its row: each moved link now names its survivor, and each dropped link is gone.
  appendAll(after, matchingGuards("description_entities", ["id", "entity_id"], moved.map((m) => [m.id, m.survivorId]), "a moved link does not name its survivor"));
  for (const ids of chunks(dropped.map((d) => d.id), 200)) {
    after.push(guard(`(SELECT count(*) FROM description_entities WHERE id IN (${idList(ids)})) = 0`, "a dropped link is still there"));
    // A relation side that named a dropped link now names the kept one.
    after.push(guard(`NOT EXISTS (SELECT 1 FROM description_entities WHERE related_to IN (${idList(ids)}))`, "a link still names a dropped link"));
  }
  appendAll(after, matchingGuards("description_entities", ["id", "related_to"], repoints.rows.map((r) => [r.id, r.relatedTo]), "a repointed link does not name the kept link"));
  const held = [...new Map(collisions.map((c) => [`${c.survivorId}|${c.descriptionId}|${c.role ?? ""}`, c])).values()];
  appendAll(after, matchingGuards(
    "description_entities",
    ["entity_id", "description_id", "role"],
    held.map((c) => [c.survivorId, c.descriptionId, c.role]),
    "a survivor does not hold a link that a collision dropped",
  ));
  const pairs = plan.groups.flatMap((g) => g.pairs.map((p) => ({ loser: p.loser, survivor: g.survivor.id })));
  appendAll(after, matchingGuards(
    "entities",
    ["id", "merged_into", "updated_at"],
    pairs.map((p) => [p.loser.id, p.survivor, nextVersion(p.loser.updatedAt, opts.now)]),
    "a loser is not merged into its survivor",
  ));
  for (const ids of chunks(losers.map((l) => l.id), 200)) {
    after.push(guard(`(SELECT count(*) FROM description_entities WHERE entity_id IN (${idList(ids)}) AND ${own}) = 0`, "a loser still holds links"));
  }
  appendAll(after, matchingGuards("entity_functions", ["id", "entity_id"], movedFunctionRows.map((m) => [m.id, m.survivorId]), "a moved function does not name its survivor"));
  for (const ids of chunks(foldedFunctions.map((f) => f.row.id), 200)) {
    after.push(guard(`(SELECT count(*) FROM entity_functions WHERE id IN (${idList(ids)})) = 0`, "a folded function is still there"));
  }
  // Each survivor holds exactly the rows planned, fills applied.
  for (const ids of chunks(survivors.map((s) => s.id), 200)) {
    const n = ids.reduce((sum, id) => sum + (survivorRowsAfter.get(id)?.length ?? 0), 0);
    after.push(guard(`(SELECT count(*) FROM entity_functions WHERE entity_id IN (${idList(ids)})) = ${n}`, "a survivor does not hold the planned function rows"));
  }
  appendAll(after, matchingGuards(
    "entity_functions",
    FILLED_CHECK_COLUMNS,
    survivors.flatMap((sv) => (survivorRowsAfter.get(sv.id) ?? []).map((f) => [f.id, sv.id, f.function, f.honorific, f.dateStart, f.dateEnd, f.dateNote, f.source, f.notes])),
    "a survivor's function row does not hold the planned fields",
  ));
  for (const ids of chunks(losers.map((l) => l.id), 200)) {
    after.push(guard(`(SELECT count(*) FROM entity_functions WHERE entity_id IN (${idList(ids)})) = 0`, "a loser still holds functions"));
  }
  for (const ids of chunks(survivors.map((s) => s.id), 200)) {
    const expected = ids.reduce((n, id) => n + (linksByEntity.get(id)?.length ?? 0) + (movedInto.get(id) ?? 0), 0);
    after.push(guard(
      `(SELECT count(*) FROM description_entities WHERE entity_id IN (${idList(ids)}) AND ${own}) = ${expected}`,
      "the survivors do not hold the planned number of links",
    ));
  }

  const sql = [...before, ...composed.map(render), ...after];
  return {
    composed, sql, oversized: oversizedStatements(sql), movedLinks, droppedLinks, movedFunctions: movedFunctionRows.length, foldedFunctions,
    labelChanges, finalVariants,
  };
}


// @version v0.9.0
