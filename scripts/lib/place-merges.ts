/**
 * Scripts — applying a reviewed list of place merges
 *
 * This module deals with the colonial-spelling merge list for the
 * Neogranadina places (`place-merges-final.csv`, reviewed and ruled
 * 2026-10-24): which rows merge, what each survivor ends up called and
 * holding, the refusals that stop a run, and the SQL. The command in
 * `scripts/commands/place-merges.ts` reads the list and the target D1
 * and hands both to `planMerges` and `buildStatements` here.
 *
 * Rows merged: MATCH, and AUTO unless its `auto_flag` starts with
 * "PULL BACK". NOT-MATCH, DOUBTFUL and the pulled-back AUTO rows are
 * counted and left alone. The survivor is `final_survivor_code`, which
 * resolves chains (La Cuchilla → Cuchilla → Cuchillas all end in
 * Cuchillas), so every loser goes straight to its final survivor. The
 * Zipaquira duplicate (Django place 99306 into 96418) is added when the
 * list does not already hold it, and both Django ids are checked
 * against the records' `legacy_ids` either way.
 *
 * A merge is the decisions surface's merge (`rulePairMerge`): every
 * link moves, a link the survivor already holds with the same role is
 * dropped, the loser's display name and variants fold into the
 * survivor's `name_variants`, the loser gets `merged_into`, and each
 * effect has its journal row plus one ledger row per pair. Those
 * statements come from `composeLinkMoves` and `composeMergeStatements`
 * in `app/lib/pair-merge.server.ts`, not from a copy here; `render`
 * turns them into SQL text. The loser's `legacy_ids` stay on the loser.
 *
 * After its losers, a survivor whose label changes or which takes over
 * a loser's ids or coordinates gets one more update and journal row:
 *
 *   - Label: `label_final`, except in the label-exception groups whose basis
 *     names a TGN record differing by article, qualifier or language.
 *     There the TGN record's spelling is taken only when it is the kept
 *     label with a leading La, El, Los or Las; outcomes named in the
 *     ruling stand where they differ from that test (Pereira and Nare
 *     keep their labels). Each of them is reported. `label` and
 *     `display_name` both take the new label; the old label joins
 *     `name_variants`, and the new label leaves it, being the label.
 *   - Ids and coordinates: what `carry_over_ids_coords` names, read from
 *     the loser's own record and checked against the list, written only
 *     into an empty field; coordinates count as empty only when
 *     latitude, longitude and precision are all NULL. Nothing marked "[verify before carrying]" is
 *     carried, nor La Victoria's tgn 1024579 (B099), nor anything from
 *     Huaycho (B019) or Santa Helena (B320); all are reported.
 *
 * The run is refused, before anything is written, when a code is not
 * found or found twice, a loser appears twice, a loser is already
 * merged, a final survivor is itself merged or is also a loser, a chain
 * does not end at `final_survivor_code`, a group's rows disagree on its
 * label, a survivor's current label is not the one the list was
 * reviewed against, a carried value differs from the loser's record or
 * would overwrite a different value, or two losers would carry
 * different values into one field.
 *
 * Links: only the named tenant's move. A shared place can be linked from
 * several tenants' descriptions; the command reads the tenant's links
 * alone, and every link count in the guards is the tenant's, so other
 * tenants' links stay on the record merged away.
 *
 * The SQL opens with guards on what was read: every survivor and loser
 * still unmerged with the `updated_at` and the fields the plan read
 * (label, display name, variants, ids, coordinates), the link counts,
 * and every link moved or dropped, and every survivor link a drop
 * relies on, with the content read. It closes with guards on the result (each
 * loser merged and without links, each survivor's label and variants,
 * the survivors' link count, and, for every link dropped as a
 * collision, the survivor still holding that description in that
 * role), so a record changed between the read and the apply fails the
 * file. Guards are packed by size, and the run is refused when any
 * statement of the file would exceed `STATEMENT_BUDGET` (50,000 bytes,
 * under D1's 100 KB limit). D1 applies a `--file` as one unit: a failing guard leaves
 * nothing written. The opening guard compares each column as it is
 * stored (`PlaceRow.stored`); the planner reads a NULL `name_variants`
 * as `[]` and an empty-string id or precision as empty.
 *
 * @version v0.9.0
 */

import { and, eq } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { places } from "../../app/db/schema";
import { decodeAndParseCsv } from "../../app/lib/import/csv";
import { composeJournalEntry } from "../../app/lib/stewardship.server";
import type { ChangelogActedAs } from "../../app/db/schema";
import {
  composeLinkMoves,
  composeMergeStatements,
  heldKey,
  heldLinks,
  parseVariants,
  type AuthorityRecordSnapshot,
  type JunctionRow,
} from "../../app/lib/pair-merge.server";
import { escapeSql } from "./sql";
import {
  STATEMENT_BUDGET,
  chunks,
  composer,
  guard,
  idList,
  matchingGuards,
  oversizedStatements,
  render,
  inTenantDescriptions,
} from "./authority-merges";
import { appendAll } from "./arrays";

export { STATEMENT_BUDGET, composer, oversizedStatements, render };

export const SOURCE_LIST = "place-merges-final.csv";
export const DJANGO_PROVIDER = "django-zasqua";

/** The Zipaquira duplicate ruled on 2026-10-24. */
export const ZIPAQUIRA = {
  loserCode: "nl-nstfgb",
  loserDjangoId: "99306",
  survivorCode: "nl-s9z5px",
  survivorDjangoId: "96418",
};

/** The pulled-back AUTO rows the ruling names; the list must flag exactly these. */
export const PULLED_BACK = ["B064", "B125", "B234", "B290"];

/** Carries withheld by the ruling beyond the list's own "[verify before carrying]" marks. */
export const WITHHELD_FIELDS: Record<string, CarryField[]> = { B099: ["tgnId"] };
/** Groups from which nothing is carried (the list already leaves their carry empty). */
export const WITHHELD_ALL = ["B019", "B320"];

/**
 * The kept labels of the label-exception groups: the eleven of the
 * ruling less La Palma, whose only pair (Palma into La Palma) was
 * ruled not a match afterwards, on 2026-10-24.
 */
export const LABEL_EXCEPTION_LABELS = [
  "Habana", "Victoria", "Socorro", "Londres", "Molina", "Punta",
  "Nare", "Florida", "Pereira", "El Tigre",
];
/**
 * Outcomes the ruling names for some of the exception groups, by kept label.
 * Victoria and Florida keep their labels while the TGN ids of the
 * records whose spelling the article test would take are unverified.
 */
export const NAMED_LABEL_OUTCOMES: Record<string, string> = {
  Habana: "La Habana",
  Molina: "La Molina",
  Punta: "La Punta",
  Socorro: "El Socorro",
  Londres: "Londres",
  Pereira: "Pereira",
  Nare: "Nare",
  Victoria: "Victoria",
  Florida: "Florida",
};
const ARTICLES = ["La", "El", "Los", "Las"];

export type CarryField = "tgnId" | "hgisId" | "whgId" | "coords";

export interface MergeRow {
  /** B011, or "row 94" for a reviewed row, or "Zipaquira (ruling)". */
  ref: string;
  decision: string;
  survivorCode: string;
  loserCode: string;
  finalSurvivorCode: string;
  labelCurrent: string;
  labelFinal: string;
  labelBasis: string;
  carry: string;
  idsNotCarried: string;
  autoFlag: string;
}

export interface ListSummary {
  rows: MergeRow[];
  total: number;
  skipped: Record<string, number>;
  pulledBack: string[];
  zipaquiraAdded: boolean;
}

export interface PlaceRow {
  id: string;
  federationId: string;
  tenantId: string | null;
  code: string;
  label: string;
  displayName: string;
  nameVariants: string;
  mergedInto: string | null;
  tgnId: string | null;
  hgisId: string | null;
  whgId: string | null;
  latitude: number | null;
  longitude: number | null;
  coordinatePrecision: string | null;
  legacyIds: string;
  updatedAt: number;
  /**
   * The guarded columns exactly as stored, before the reads normalise
   * them (a NULL `name_variants` read as `[]`, an empty-string id or
   * precision read as null). The opening guard compares these, so a
   * value the planner treats as empty is still matched as it is stored,
   * and the journal records them as the before-image, so a revert puts
   * back NULL or '' as it was. Absent, the normalised fields above stand in.
   */
  stored?: StoredPlace;
}

/** Raw stored values of the columns the opening guard compares, keyed by column. */
export type StoredPlace = Record<(typeof GUARDED_COLUMNS)[number], string | number | null>;

export const GUARDED_COLUMNS = [
  "updated_at", "federation_id", "tenant_id", "place_code", "legacy_ids", "merged_into", "label", "display_name", "name_variants", "tgn_id", "hgis_id", "whg_id",
  "latitude", "longitude", "coordinate_precision",
] as const;

/** The stored values a place's normalised fields stand for, when no raw read is at hand. */
export function storedOf(p: PlaceRow): StoredPlace {
  return p.stored ?? {
    updated_at: p.updatedAt, federation_id: p.federationId, tenant_id: p.tenantId, place_code: p.code, legacy_ids: p.legacyIds, merged_into: p.mergedInto, label: p.label, display_name: p.displayName,
    name_variants: p.nameVariants, tgn_id: p.tgnId, hgis_id: p.hgisId, whg_id: p.whgId,
    latitude: p.latitude, longitude: p.longitude, coordinate_precision: p.coordinatePrecision,
  };
}

export interface Refusal {
  ref: string;
  reason: string;
}

export interface CarryItem {
  field: CarryField;
  /** The value as the list gives it ("-11.56,-77.27 (approximate)" for coordinates). */
  listed: string;
  verify: boolean;
}

export interface Carried {
  ref: string;
  loserCode: string;
  field: CarryField;
  value: string;
}

export interface NotCarried {
  ref: string;
  loserCode: string;
  what: string;
  why: string;
}

export interface LabelDecision {
  ref: string;
  survivorCode: string;
  kept: string;
  tgnSpelling: string;
  ruleGives: string;
  named: string | null;
  applied: string;
  note: string;
}

export interface GroupPlan {
  survivor: PlaceRow;
  pairs: Array<{ row: MergeRow; loser: PlaceRow }>;
  labelNew: string;
  carried: Carried[];
}

export interface Plan {
  groups: GroupPlan[];
  refusals: Refusal[];
  labelDecisions: LabelDecision[];
  notCarried: NotCarried[];
}

const COLUMNS = [
  "decision", "review_no", "bucket", "survivor_code", "loser_code", "final_survivor_code",
  "label_current", "label_final", "label_basis", "carry_over_ids_coords", "loser_ids_not_carried", "auto_flag",
];

/** Read the list, keep the rows the ruling merges, and add the Zipaquira pair if absent. */
export function readMergeList(bytes: Uint8Array): ListSummary {
  const parsed = decodeAndParseCsv(bytes);
  const at = new Map(parsed.headers.map((h, i) => [h, i]));
  for (const c of COLUMNS) if (!at.has(c)) throw new Error(`${SOURCE_LIST} has no ${c} column`);
  const get = (r: string[], c: string) => (r[at.get(c)!] ?? "").trim();
  const rows: MergeRow[] = [];
  const skipped: Record<string, number> = {};
  const pulledBack: string[] = [];
  for (const r of parsed.rows) {
    const decision = get(r, "decision");
    const autoFlag = get(r, "auto_flag");
    const reviewNo = get(r, "review_no");
    const ref = reviewNo ? `row ${reviewNo}` : get(r, "bucket");
    const pulled = decision === "AUTO" && autoFlag.startsWith("PULL BACK");
    if (pulled) pulledBack.push(get(r, "bucket"));
    if (!(decision === "MATCH" || (decision === "AUTO" && !pulled))) {
      const key = pulled ? "AUTO (PULL BACK)" : decision;
      skipped[key] = (skipped[key] ?? 0) + 1;
      continue;
    }
    rows.push({
      ref,
      decision,
      survivorCode: get(r, "survivor_code"),
      loserCode: get(r, "loser_code"),
      finalSurvivorCode: get(r, "final_survivor_code"),
      labelCurrent: get(r, "label_current"),
      labelFinal: get(r, "label_final"),
      labelBasis: get(r, "label_basis"),
      carry: get(r, "carry_over_ids_coords"),
      idsNotCarried: get(r, "loser_ids_not_carried"),
      autoFlag,
    });
  }
  const zipaquiraAdded = !rows.some((r) => r.loserCode === ZIPAQUIRA.loserCode);
  if (zipaquiraAdded) {
    rows.push({
      ref: "Zipaquira (ruling)",
      decision: "RULING",
      survivorCode: ZIPAQUIRA.survivorCode,
      loserCode: ZIPAQUIRA.loserCode,
      finalSurvivorCode: ZIPAQUIRA.survivorCode,
      labelCurrent: "",
      labelFinal: "",
      labelBasis: "",
      carry: "",
      idsNotCarried: "",
      autoFlag: "",
    });
  }
  return { rows, total: parsed.rowCount, skipped, pulledBack, zipaquiraAdded };
}

/** Parse `carry_over_ids_coords`: `tgn_id=…; hgis_id=…; whg_id=…; coords=lat,lon (precision)`. */
export function parseCarry(text: string): CarryItem[] {
  const out: CarryItem[] = [];
  for (const part of text.split(";").map((p) => p.trim()).filter(Boolean)) {
    const m = /^(tgn_id|hgis_id|whg_id|coords)=(.+)$/.exec(part);
    if (!m) throw new Error(`unreadable carry item: ${part}`);
    const verify = m[2].includes("[verify before carrying]");
    const listed = m[2].replace("[verify before carrying]", "").trim();
    const field = ({ tgn_id: "tgnId", hgis_id: "hgisId", whg_id: "whgId", coords: "coords" } as const)[
      m[1] as "tgn_id" | "hgis_id" | "whg_id" | "coords"
    ];
    out.push({ field, listed, verify });
  }
  return out;
}

/** The coordinate tuple is empty only when latitude, longitude and precision are all NULL. */
const coordsEmpty = (p: PlaceRow) => p.latitude === null && p.longitude === null && p.coordinatePrecision === null;
const describeCoords = (p: PlaceRow) =>
  coordsEmpty(p) ? "none" : `${p.latitude},${p.longitude} (${p.coordinatePrecision ?? "no precision"})`;

/** Do the loser's coordinates agree with the list's, to the list's decimals and precision? */
function coordsMatch(listed: string, p: PlaceRow): boolean {
  const m = /^(-?[\d.]+),(-?[\d.]+) \(([^)]+)\)$/.exec(listed);
  if (!m || p.latitude === null || p.longitude === null) return false;
  const close = (s: string, v: number) => {
    const decimals = (s.split(".")[1] ?? "").length;
    return Math.abs(v - Number(s)) <= 0.5 * 10 ** -decimals + 1e-12;
  };
  const precision = m[3] === "no precision" ? null : m[3];
  return close(m[1], p.latitude) && close(m[2], p.longitude) && precision === (p.coordinatePrecision ?? null);
}

function djangoIds(legacyIds: string): string[] {
  try {
    const list = JSON.parse(legacyIds || "[]") as Array<{ provider?: string; id?: unknown }>;
    return list.filter((e) => e && e.provider === DJANGO_PROVIDER).map((e) => String(e.id));
  } catch {
    return [];
  }
}

/** The label-exception rule: the TGN spelling only when it is the kept label with a leading article. */
export function articleRule(kept: string, tgnSpelling: string): string {
  return ARTICLES.some((a) => tgnSpelling === `${a} ${kept}`) ? tgnSpelling : kept;
}

/**
 * Check the list against the target's places and plan every group.
 * `byCode` maps each place code to every record holding it.
 */
export function planMerges(
  rows: MergeRow[],
  byCode: Map<string, PlaceRow[]>,
  exceptionLabels: readonly string[] = LABEL_EXCEPTION_LABELS,
): Plan {
  const refusals: Refusal[] = [];
  const refuse = (ref: string, reason: string) => refusals.push({ ref, reason });
  const one = (ref: string, code: string, what: string): PlaceRow | null => {
    const found = byCode.get(code) ?? [];
    if (found.length === 0) refuse(ref, `${what} ${code || "(empty)"} not found`);
    else if (found.length > 1) refuse(ref, `${what} ${code} found ${found.length} times`);
    return found.length === 1 ? found[0] : null;
  };

  // Losers appear once; the chain map follows survivor_code through the merged rows.
  const loserRows = new Map<string, MergeRow>();
  for (const row of rows) {
    if (loserRows.has(row.loserCode)) refuse(row.ref, `loser ${row.loserCode} appears twice (also ${loserRows.get(row.loserCode)!.ref})`);
    else loserRows.set(row.loserCode, row);
  }
  for (const row of rows) {
    const seen = new Set<string>([row.loserCode]);
    let code = row.survivorCode;
    while (loserRows.has(code) && !seen.has(code)) {
      seen.add(code);
      code = loserRows.get(code)!.survivorCode;
    }
    if (seen.has(code)) refuse(row.ref, `chain from ${row.loserCode} loops at ${code}`);
    else if (code !== row.finalSurvivorCode) {
      refuse(row.ref, `chain from ${row.loserCode} ends at ${code}, not at final_survivor_code ${row.finalSurvivorCode || "(empty)"}`);
    }
  }

  const groups = new Map<string, GroupPlan>();
  for (const row of rows) {
    const loser = one(row.ref, row.loserCode, "loser");
    const survivor = one(row.ref, row.finalSurvivorCode, "survivor");
    one(row.ref, row.survivorCode, "listed survivor");
    if (!loser || !survivor) continue;
    if (loser.id === survivor.id) {
      refuse(row.ref, `${row.loserCode} would merge into itself`);
      continue;
    }
    if (loser.mergedInto) refuse(row.ref, `loser ${loser.code} is already merged (into ${loser.mergedInto})`);
    if (survivor.mergedInto) refuse(row.ref, `survivor ${survivor.code} is itself merged (into ${survivor.mergedInto})`);
    if (loserRows.has(survivor.code)) refuse(row.ref, `survivor ${survivor.code} is also a loser in the list`);
    if (loser.federationId !== survivor.federationId) refuse(row.ref, `${loser.code} and ${survivor.code} are in different federations`);
    let g = groups.get(survivor.id);
    if (!g) {
      g = { survivor, pairs: [], labelNew: survivor.label, carried: [] };
      groups.set(survivor.id, g);
    }
    g.pairs.push({ row, loser });
  }

  // Zipaquira: the Django ids the ruling names must be the records' own.
  const zip = rows.find((r) => r.loserCode === ZIPAQUIRA.loserCode);
  if (zip) {
    for (const [code, django] of [
      [ZIPAQUIRA.loserCode, ZIPAQUIRA.loserDjangoId],
      [ZIPAQUIRA.survivorCode, ZIPAQUIRA.survivorDjangoId],
    ]) {
      const rec = (byCode.get(code) ?? [])[0];
      if (rec && !djangoIds(rec.legacyIds).includes(django)) refuse(zip.ref, `${code} does not hold Django place ${django}`);
    }
    if (zip.finalSurvivorCode !== ZIPAQUIRA.survivorCode) refuse(zip.ref, `Zipaquira's survivor in the list is ${zip.finalSurvivorCode}, not ${ZIPAQUIRA.survivorCode}`);
  }

  const labelDecisions: LabelDecision[] = [];
  const notCarried: NotCarried[] = [];
  for (const g of groups.values()) {
    const ref = g.pairs.map((p) => p.row.ref).join(", ");
    // The list's view of the survivor's label, from the rows whose listed survivor is the final one.
    for (const p of g.pairs) {
      if (p.row.survivorCode === g.survivor.code && p.row.labelCurrent && p.row.labelCurrent !== g.survivor.label) {
        refuse(p.row.ref, `survivor ${g.survivor.code} is labelled "${g.survivor.label}", the list was reviewed against "${p.row.labelCurrent}"`);
      }
    }
    const finals = new Set(g.pairs.map((p) => p.row.labelFinal).filter(Boolean));
    if (finals.size > 1) refuse(ref, `rows for ${g.survivor.code} disagree on the label: ${[...finals].join(" / ")}`);
    let labelNew = finals.size === 1 ? [...finals][0] : g.survivor.label;

    // Ids and coordinates.
    const taken = new Map<CarryField, Carried>();
    for (const p of g.pairs) {
      const items = parseCarry(p.row.carry);
      if (WITHHELD_ALL.includes(p.row.ref)) {
        const held: string[] = [];
        if (!coordsEmpty(p.loser)) held.push(`coords ${describeCoords(p.loser)}`);
        for (const f of ["tgnId", "hgisId", "whgId"] as const) if (p.loser[f]) held.push(`${f} ${p.loser[f]}`);
        if (held.length > 0) notCarried.push({ ref: p.row.ref, loserCode: p.loser.code, what: held.join("; "), why: "the list says to leave this loser's point and ids out" });
        if (items.length > 0) refuse(p.row.ref, `the list carries from ${p.loser.code}, which the ruling withholds`);
        continue;
      }
      if (p.row.idsNotCarried) {
        notCarried.push({ ref: p.row.ref, loserCode: p.loser.code, what: p.row.idsNotCarried, why: "conflicts with the survivor's own ids (loser_ids_not_carried)" });
      }
      for (const item of items) {
        if (item.verify) {
          notCarried.push({ ref: p.row.ref, loserCode: p.loser.code, what: `${item.field} ${item.listed}`, why: "marked [verify before carrying]" });
          continue;
        }
        if ((WITHHELD_FIELDS[p.row.ref] ?? []).includes(item.field)) {
          notCarried.push({ ref: p.row.ref, loserCode: p.loser.code, what: `${item.field} ${item.listed}`, why: "withheld by the ruling" });
          continue;
        }
        let value: string;
        let survivorHas: string | null;
        if (item.field === "coords") {
          if (!coordsMatch(item.listed, p.loser)) {
            refuse(p.row.ref, `listed coordinates ${item.listed} differ from ${p.loser.code}'s ${describeCoords(p.loser)}`);
            continue;
          }
          value = describeCoords(p.loser);
          survivorHas = coordsEmpty(g.survivor) ? null : describeCoords(g.survivor);
        } else {
          value = p.loser[item.field] ?? "";
          if (value !== item.listed) {
            refuse(p.row.ref, `listed ${item.field} ${item.listed} differs from ${p.loser.code}'s ${value || "(none)"}`);
            continue;
          }
          survivorHas = g.survivor[item.field];
        }
        if (survivorHas !== null) {
          if (survivorHas !== value) refuse(p.row.ref, `${g.survivor.code} already holds ${item.field} ${survivorHas}; the list carries ${value}`);
          continue;
        }
        const prior = taken.get(item.field);
        if (prior && prior.value !== value) {
          refuse(p.row.ref, `${prior.loserCode} and ${p.loser.code} would both carry ${item.field} into ${g.survivor.code} (${prior.value} / ${value})`);
          continue;
        }
        if (!prior) taken.set(item.field, { ref: p.row.ref, loserCode: p.loser.code, field: item.field, value });
      }
    }
    g.carried = [...taken.values()];

    const exception = g.pairs
      .map((p) => /tgn record "([^"]+)"/.exec(p.row.labelBasis))
      .find((m): m is RegExpExecArray => m !== null);
    if (exception) {
      const kept = labelNew;
      const tgnSpelling = exception[1];
      const ruleGives = articleRule(kept, tgnSpelling);
      const named = NAMED_LABEL_OUTCOMES[kept] ?? null;
      const applied = named ?? ruleGives;
      const notes: string[] = [];
      if (named !== null && named !== ruleGives) {
        notes.push(`the article test gives "${ruleGives}"; the ruling names "${named}", which is applied`);
      }
      const holder = g.pairs.find((p) => p.loser.label === tgnSpelling);
      if (applied !== kept && holder?.loser.tgnId && !g.carried.some((c) => c.loserCode === holder.loser.code && c.field === "tgnId")) {
        notes.push(`the new label is ${holder.loser.code}'s, whose tgn ${holder.loser.tgnId} is not carried`);
      }
      labelDecisions.push({
        ref, survivorCode: g.survivor.code, kept, tgnSpelling, ruleGives, named, applied,
        note: notes.join("; "),
      });
      labelNew = applied;
    }
    g.labelNew = labelNew;
  }

  // The exception groups are the ones the ruling lists, no more and no fewer.
  const keptLabels = labelDecisions.map((d) => d.kept).sort();
  if (keptLabels.join("|") !== [...exceptionLabels].sort().join("|")) {
    refuse("labels", `the label-exception groups are ${keptLabels.join(", ") || "none"}, not the ones the ruling lists`);
  }

  return { groups: [...groups.values()], refusals, labelDecisions, notCarried };
}

export interface BuildOptions {
  userId: string;
  /** How the user acted (`changelog.acted_as`): null for a member. */
  actedAs?: ChangelogActedAs | null;
  now: number;
  /** The tenant whose description links move; `linksByPlace` holds only its links. */
  tenantId: string;
}

export interface BuildResult {
  /** Composed Drizzle statements in order, guards excluded. */
  composed: any[];
  /** The SQL file's statements, guards included. */
  sql: string[];
  /** Statements over `STATEMENT_BUDGET`; the command refuses the run when there are any. */
  oversized: Array<{ index: number; bytes: number; head: string }>;
  movedLinks: number;
  droppedLinks: number;
  labelChanges: Array<{ survivorCode: string; old: string; new: string }>;
  expected: { losersMerged: number; linksOnLosersAfter: number };
}

/**
 * Compose every group's statements. `linksByPlace` holds the full
 * `description_places` rows of every survivor and loser whose
 * description is `opts.tenantId`'s; every link-count guard counts that
 * tenant's links only, so another tenant's links on a shared place are
 * neither moved nor counted, and stay on the loser.
 */
export function buildStatements(
  plan: Plan,
  linksByPlace: Map<string, JunctionRow[]>,
  opts: BuildOptions,
  db: DrizzleD1Database<any> = composer(),
): BuildResult {
  const composed: any[] = [];
  let movedLinks = 0;
  let droppedLinks = 0;
  const collisions: Array<{ survivorId: string; descriptionId: string; role: string | null }> = [];
  const reliedOn = new Map<string, JunctionRow>();
  const movedInto = new Map<string, number>();
  const moved: Array<{ id: string; survivorId: string }> = [];
  const dropped: Array<{ id: string; survivorId: string }> = [];
  const labelChanges: BuildResult["labelChanges"] = [];
  const finals: Array<{ id: string; mergedInto: string | number | null; label: string; nameVariants: string; mergedFrom: string[] }> = [];

  for (const g of plan.groups) {
    const s = g.survivor;
    // Before-images are the stored values, not the normalised ones.
    const st = storedOf(s);
    const raw = (v: string | number | null) => (v === null ? null : String(v));
    const snapshot: AuthorityRecordSnapshot = {
      id: s.id, displayName: s.displayName, code: s.code, nameVariants: raw(st.name_variants), mergedInto: null, sources: null,
    };
    const holds = heldLinks(linksByPlace.get(s.id) ?? []);
    const ownLinks = new Map((linksByPlace.get(s.id) ?? []).map((l) => [heldKey(l), l]));
    const scope = eq(places.federationId, s.federationId);
    for (const { row, loser } of g.pairs) {
      const links = linksByPlace.get(loser.id) ?? [];
      const linkPlan = composeLinkMoves(db, "place", s.id, links, holds, opts.userId, opts.now, new Map(), opts.actedAs ?? null);
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
      const carried = g.carried.filter((c) => c.loserCode === loser.code);
      const reason = `Place merge list ${SOURCE_LIST}, ruled 2026-10-24 (${row.ref})`;
      const { statements, survivorVariants } = composeMergeStatements(db, {
        recordType: "place",
        scope,
        federationId: s.federationId,
        survivor: snapshot,
        loser: {
          id: loser.id, displayName: loser.displayName, code: loser.code,
          nameVariants: raw(storedOf(loser).name_variants), mergedInto: raw(storedOf(loser).merged_into), sources: null,
        },
        linkPlan,
        userId: opts.userId,
        actedAs: opts.actedAs ?? null,
        reason,
        now: opts.now,
        detailExtra: {
          list: SOURCE_LIST,
          listRef: row.ref,
          ...(carried.length > 0 ? { carried: Object.fromEntries(carried.map((c) => [c.field, c.value])) } : {}),
        },
      });
      appendAll(composed, statements);
      snapshot.nameVariants = survivorVariants;
    }

    // The survivor's own update: label, then ids and coordinates.
    const set: Record<string, unknown> = {};
    const diff: Record<string, { old: unknown; new: unknown }> = {};
    let variants = parseVariants(snapshot.nameVariants);
    if (g.labelNew !== s.label) {
      variants = Array.from(new Set([...variants, s.label])).filter((v) => v !== g.labelNew);
      set.label = g.labelNew;
      diff.label = { old: st.label, new: g.labelNew };
      if (s.displayName !== g.labelNew) {
        set.displayName = g.labelNew;
        diff.displayName = { old: st.display_name, new: g.labelNew };
      }
      labelChanges.push({ survivorCode: s.code, old: s.label, new: g.labelNew });
    }
    const newVariants = JSON.stringify(variants);
    if (newVariants !== snapshot.nameVariants) {
      set.nameVariants = newVariants;
      diff.nameVariants = { old: snapshot.nameVariants, new: newVariants };
    }
    for (const c of g.carried) {
      const loser = g.pairs.find((p) => p.loser.code === c.loserCode)!.loser;
      const column = { latitude: "latitude", longitude: "longitude", coordinatePrecision: "coordinate_precision", tgnId: "tgn_id", hgisId: "hgis_id", whgId: "whg_id" } as const;
      if (c.field === "coords") {
        for (const f of ["latitude", "longitude", "coordinatePrecision"] as const) {
          set[f] = loser[f];
          diff[f] = { old: st[column[f]], new: loser[f] };
        }
      } else {
        set[c.field] = c.value;
        diff[c.field] = { old: st[column[c.field]], new: c.value };
      }
    }
    if (Object.keys(set).length > 0) {
      const refs = g.pairs.map((p) => p.row.ref).join(", ");
      composed.push(
        db.update(places).set({ ...set, updatedAt: opts.now }).where(and(scope, eq(places.id, s.id))),
        composeJournalEntry(db, {
          recordId: s.id,
          recordType: "place",
          userId: opts.userId,
          actedAs: opts.actedAs ?? null,
          kind: "update",
          diff,
          note: `Place merge list ${SOURCE_LIST}, ruled 2026-10-24 (${refs}): label and carried ids`,
          now: opts.now,
        }),
      );
    }
    finals.push({
      id: s.id,
      mergedInto: storedOf(s).merged_into,
      label: (set.label as string | undefined) ?? s.label,
      nameVariants: (set.nameVariants as string | undefined) ?? snapshot.nameVariants!,
      mergedFrom: g.pairs.map((p) => p.loser.id),
    });
  }

  // Guards on what was read, and on what the file leaves.
  const survivors = plan.groups.map((g) => g.survivor);
  const losers = plan.groups.flatMap((g) => g.pairs.map((p) => p.loser));
  const involved = [...survivors, ...losers].map((p) => p.id);
  const linkCount = (ids: string[]) => ids.reduce((n, id) => n + (linksByPlace.get(id)?.length ?? 0), 0);
  const before: string[] = [];
  const after: string[] = [];
  const own = inTenantDescriptions(opts.tenantId);
  // Every place the file touches still holds what was read: its clock stamp
  // and every field the plan reads, as stored. Not every write to places
  // moves updated_at (a tenant claim does not), so the fields are compared too.
  appendAll(before, matchingGuards(
    "places",
    ["id", ...GUARDED_COLUMNS],
    [...survivors, ...losers].map((p) => { const st = storedOf(p); return [p.id, ...GUARDED_COLUMNS.map((c) => st[c])]; }),
    "a place in the list has changed since it was read",
  ));
  for (const ids of chunks(involved, 200)) {
    before.push(guard(`(SELECT count(*) FROM description_places WHERE place_id IN (${idList(ids)}) AND ${own}) = ${linkCount(ids)}`, "the links have changed since they were read"));
  }
  // Every link the plan moves or drops, and every survivor link a drop relies
  // on, still holds the content that was read (the collision key and the
  // journalled columns).
  const guarded = [...losers.flatMap((l) => linksByPlace.get(l.id) ?? []), ...reliedOn.values()];
  appendAll(before, matchingGuards(
    "description_places",
    ["id", "place_id", "description_id", "role", "role_note", "role_raw", "created_at"],
    guarded.map((l) => [l.id, l.placeId, l.descriptionId, l.role, l.roleNote, l.roleRaw, l.createdAt]),
    "a link has changed since it was read",
  ));
  appendAll(after, matchingGuards(
    "places",
    ["id", "label", "COALESCE(name_variants, '[]')", "merged_into", "updated_at"],
    finals.map((f) => [f.id, f.label, f.nameVariants, f.mergedInto, opts.now]),
    "a survivor does not hold its planned label and variants",
  ));
  // Every UPDATE touched its row: each moved link now names its survivor, and each dropped link is gone.
  appendAll(after, matchingGuards("description_places", ["id", "place_id"], moved.map((m) => [m.id, m.survivorId]), "a moved link does not name its survivor"));
  for (const ids of chunks(dropped.map((d) => d.id), 200)) {
    after.push(guard(`(SELECT count(*) FROM description_places WHERE id IN (${idList(ids)})) = 0`, "a dropped link is still there"));
  }
  // A link dropped as a collision is dropped only while the survivor still holds its description in that role.
  const held = [...new Map(collisions.map((c) => [`${c.survivorId}|${c.descriptionId}|${c.role ?? ""}`, c])).values()];
  appendAll(after, matchingGuards(
    "description_places",
    ["place_id", "description_id", "role"],
    held.map((c) => [c.survivorId, c.descriptionId, c.role]),
    "a survivor does not hold a link that a collision dropped",
  ));
  const pairs = plan.groups.flatMap((g) => g.pairs.map((p) => ({ loser: p.loser.id, survivor: g.survivor.id })));
  appendAll(after, matchingGuards(
    "places",
    ["id", "merged_into", "updated_at"],
    pairs.map((p) => [p.loser, p.survivor, opts.now]),
    "a loser is not merged into its survivor",
  ));
  for (const ids of chunks(losers.map((l) => l.id), 200)) {
    after.push(guard(`(SELECT count(*) FROM description_places WHERE place_id IN (${idList(ids)}) AND ${own}) = 0`, "a loser still holds links"));
  }
  for (const ids of chunks(survivors.map((s) => s.id), 200)) {
    const expected = ids.reduce((n, id) => n + (linksByPlace.get(id)?.length ?? 0) + (movedInto.get(id) ?? 0), 0);
    after.push(guard(
      `(SELECT count(*) FROM description_places WHERE place_id IN (${idList(ids)}) AND ${own}) = ${expected}`,
      "the survivors do not hold the planned number of links",
    ));
  }

  const sql = [...before, ...composed.map(render), ...after];
  return {
    composed,
    sql,
    oversized: oversizedStatements(sql),
    movedLinks,
    droppedLinks,
    labelChanges,
    expected: { losersMerged: pairs.length, linksOnLosersAfter: 0 },
  };
}

// @version v0.9.0
