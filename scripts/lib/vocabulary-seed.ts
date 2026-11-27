/**
 * Scripts — seeding one federation's vocabulary
 *
 * This module deals with writing a federation's vocabulary into
 * `vocabulary_values` from a data file under `scripts/data/vocabularies/`.
 * A set is of one of two kinds. A relation set holds relation roles,
 * link attributes, genders and the role groups they add
 * (`neogranadina-relations`). A role set holds document roles
 * (`entity_role`), place roles (`place_role`) and their role groups
 * (`neogranadina-roles`, and `starter-roles`, the minimal set a new
 * federation starts from). Fisqua names none of these values; the data
 * file is the federation's. `scripts/commands/seed-federation-vocabulary.ts`
 * is a thin shell around `runVocabularySeed`; the reads, the writes and
 * the clock are injected, so the tests run it against an in-memory
 * SQLite database (`tests/import/seed-federation-vocabulary.test.ts`,
 * `tests/import/seed-federation-roles.test.ts`).
 *
 * `validateSet` checks the data file before anything is read. For a
 * relation set: codes are unique in each list; every inverse names a
 * relation code of the file; every relation's group is one of the file's
 * new groups or one it names as existing; every relation has its female,
 * male and unrecorded forms and its connector in both languages; every
 * attribute hidden by a group names one of those groups; every group,
 * attribute and gender has both labels. For a role set: codes are unique
 * in each list; positions are whole numbers from 1, unique among the
 * groups, among the place roles and within each group; every entity
 * role's group is one of the file's groups or one it names as existing;
 * every group and role has both labels.
 *
 * `planSeed` reads the columns of `vocabulary_values` (migration 0125
 * must be applied), the federation by slug, and the federation's rows in
 * the set's lists (`relation_role`, `link_attribute`, `gender` and
 * `role_group` for a relation set; `entity_role`, `place_role` and
 * `role_group` for a role set), which the unique index on
 * `(federation_id, list, code)` serves. Each value of the file is then an
 * insert (no row of that list and code), unchanged (a row holding every
 * value the file gives) or a conflict (a row holding other values). A
 * conflict refuses the run: nothing is overwritten. The federation must
 * hold every group the file names as existing; those groups and any
 * other held row are never written.
 *
 * A role set reads two more statements. One reads the codes of the
 * federation's `relation_role` list. The other counts the codes the
 * federation's links hold, one GROUP BY over `description_entities` and
 * one over `description_places`, each joined to the description's
 * tenant; on production the read-load limits apply to it. A code held by
 * a link that is in none of the `entity_role`, `relation_role` or
 * `place_role` lists, counting the rows the set inserts, refuses the run,
 * and the report gives each such code with its table and its count.
 *
 * What the rows hold: a relation's `label_es` and `label_en` are its
 * unrecorded form, so a reader that knows only those columns shows the
 * label used when gender is not recorded; the four forms go in
 * `label_<lang>_female`, `_male`, `_unrecorded` and `_alone` (null where
 * the file gives no alone form). A relation's `position` is its place
 * within its group, as entity roles have theirs; attributes and genders
 * are numbered in file order. A relation set's new groups follow the
 * federation's other groups: their positions start after the highest
 * position held by a group that is not one of them, so a second run
 * computes the same positions. A role set gives every position itself,
 * as the institution-records fill wrote them: groups 1 to 7, so the
 * relation set's groups, which need `legal` and so are seeded after
 * them, follow at 8 to 11; any held group other than the set's new
 * groups, including one the set names as existing, at a position the
 * set gives one of its new groups, refuses the run. A role row sets only its
 * labels, its group (entity roles), its position and its status. Every
 * row is `approved`; `created_at` and `updated_at` are the run's clock in
 * milliseconds, as the fill wrote the existing values.
 *
 * The SQL file opens with guards that the federation is the one read,
 * that the set's lists hold as many rows as were read, and that every row
 * read still holds every column it held (the as-read guards of the
 * authorities command, `matchingGuards`); then the inserts; then guards
 * that the lists hold the rows read plus those inserted, each with the
 * values planned. `runVocabularySeed` plans, writes the report (JSON and
 * Markdown) and the SQL file, and with `apply` hands the file to wrangler
 * once its hash matches the SQL planned, reads everything again and plans
 * again: nothing may be left to insert and nothing may conflict.
 *
 * @version v0.9.0
 */

import { vocabularyValues } from "../../app/db/schema";
import { NEOGRANADINA_RELATIONS, type RelationVocabularySet } from "../data/vocabularies/neogranadina-relations";
import { NEOGRANADINA_ROLES, type RoleVocabularySet } from "../data/vocabularies/neogranadina-roles";
import { STARTER_ROLES } from "../data/vocabularies/starter-roles";
import { guard, matchingGuards, oversizedStatements, STATEMENT_BUDGET } from "./authority-merges";
import {
  applyCheckedSqlFile,
  exitCodeOfOutcome,
  runNameOf,
  type Outcome,
  type RunProviders,
  type Target,
} from "./cli/run-file";
import { insertStatements, selectOnly } from "./institution-records-fill";
import { escapeSql } from "./sql";
import { appendAll, maxOf } from "./arrays";

export class VocabularyStop extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VocabularyStop";
  }
}

export type VocabularySet = RelationVocabularySet | RoleVocabularySet;

/** Every set `--set` may name. */
export const VOCABULARY_SETS: Record<string, VocabularySet> = {
  [NEOGRANADINA_RELATIONS.name]: NEOGRANADINA_RELATIONS,
  [NEOGRANADINA_ROLES.name]: NEOGRANADINA_ROLES,
  [STARTER_ROLES.name]: STARTER_ROLES,
};

/** The lists a relation set reads and writes. */
export const SEED_LISTS = ["relation_role", "link_attribute", "gender", "role_group"] as const;
/** The lists a role set reads and writes. */
export const ROLE_SEED_LISTS = ["entity_role", "place_role", "role_group"] as const;
export type SeedList = (typeof SEED_LISTS)[number] | (typeof ROLE_SEED_LISTS)[number];

const listsOf = (set: VocabularySet): readonly SeedList[] => (set.kind === "roles" ? ROLE_SEED_LISTS : SEED_LISTS);
const listSql = (lists: readonly string[]) => lists.map((l) => `'${l}'`).join(", ");

export interface SeedOptions {
  target: Target;
  federation: string;
  set: string;
  apply: boolean;
  confirmProduction: boolean;
}

/** `--target staging|production --federation <slug> --set <name> [--apply] [--confirm-production]`. */
export function parseSeedArgs(argv: string[]): SeedOptions {
  let target: string | null = null;
  let federation = "";
  let set = "";
  let apply = false;
  let confirmProduction = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) throw new VocabularyStop(`${a} needs a value`);
      return v;
    };
    if (a === "--apply") apply = true;
    else if (a === "--confirm-production") confirmProduction = true;
    else if (a === "--target") target = value();
    else if (a === "--federation") federation = value();
    else if (a === "--set") set = value();
    else throw new VocabularyStop(`Unknown argument: ${a}`);
  }
  if (target !== "staging" && target !== "production") throw new VocabularyStop("--target is staging or production");
  if (!federation) throw new VocabularyStop("--federation <slug> is required");
  if (!set) throw new VocabularyStop(`--set <name> is required (${Object.keys(VOCABULARY_SETS).join(", ")})`);
  return { target, federation, set, apply, confirmProduction };
}

// ---------------------------------------------------------------------------
// The data file
// ---------------------------------------------------------------------------

const filled = (v: string | undefined) => typeof v === "string" && v.trim().length > 0;

const uniqueCodes = (problems: string[], list: string, codes: string[]) => {
  const seen = new Set<string>();
  for (const c of codes) {
    if (!filled(c)) problems.push(`${list}: a code is blank`);
    else if (seen.has(c)) problems.push(`${list}: ${c} appears twice`);
    seen.add(c);
  }
};

/** Stops on anything in the set that would make a row incomplete or point nowhere. */
export function validateSet(set: VocabularySet): void {
  if (set.kind === "roles") return validateRoleSet(set);
  const problems: string[] = [];
  const unique = (list: string, codes: string[]) => uniqueCodes(problems, list, codes);
  unique("role_group", [...set.existingGroups, ...set.groups.map((g) => g.code)]);
  unique("relation_role", set.relations.map((r) => r.code));
  unique("link_attribute", set.attributes.map((a) => a.code));
  unique("gender", set.genders.map((g) => g.code));

  const groups = new Set([...set.existingGroups, ...set.groups.map((g) => g.code)]);
  const codes = new Set(set.relations.map((r) => r.code));
  for (const g of set.groups) if (!filled(g.es) || !filled(g.en)) problems.push(`role_group ${g.code}: a label is missing`);
  for (const r of set.relations) {
    if (!codes.has(r.inverse)) problems.push(`relation_role ${r.code}: its inverse ${r.inverse} is not a relation code of the set`);
    if (!groups.has(r.group)) problems.push(`relation_role ${r.code}: its group ${r.group} is neither a new group nor an existing one the set names`);
    for (const [lang, label] of [["es", r.es], ["en", r.en]] as const) {
      for (const form of ["female", "male", "unrecorded", "connector"] as const) {
        if (!filled(label?.[form])) problems.push(`relation_role ${r.code}: no ${lang} ${form}`);
      }
      if (label?.alone !== undefined && !filled(label.alone)) problems.push(`relation_role ${r.code}: the ${lang} alone form is blank`);
    }
  }
  for (const a of set.attributes) {
    if (!filled(a.es) || !filled(a.en)) problems.push(`link_attribute ${a.code}: a label is missing`);
    if (a.hideWhenGroup !== undefined && !groups.has(a.hideWhenGroup)) {
      problems.push(`link_attribute ${a.code}: hidden by ${a.hideWhenGroup}, which is not a group of the set`);
    }
  }
  for (const g of set.genders) if (!filled(g.es) || !filled(g.en)) problems.push(`gender ${g.code}: a label is missing`);
  if (problems.length > 0) throw new VocabularyStop(`The set ${set.name} is not complete:\n  ${problems.join("\n  ")}\nNothing was read or written.`);
}

/**
 * The checks of a role set: codes unique in each list; positions whole
 * numbers from 1, unique among the groups, among the place roles and
 * within each group; every entity role's group one of the file's groups
 * or one it names as existing; every label filled.
 */
function validateRoleSet(set: RoleVocabularySet): void {
  const problems: string[] = [];
  uniqueCodes(problems, "role_group", [...set.existingGroups, ...set.groups.map((g) => g.code)]);
  uniqueCodes(problems, "entity_role", set.entityRoles.map((r) => r.code));
  uniqueCodes(problems, "place_role", set.placeRoles.map((r) => r.code));

  const positions = (where: string, items: Array<{ code: string; position: number }>) => {
    const seen = new Map<number, string>();
    for (const i of items) {
      if (!Number.isInteger(i.position) || i.position < 1) problems.push(`${where}: ${i.code} has position ${i.position}, not a whole number from 1`);
      else if (seen.has(i.position)) problems.push(`${where}: ${i.code} and ${seen.get(i.position)} both take position ${i.position}`);
      else seen.set(i.position, i.code);
    }
  };
  positions("role_group", set.groups);
  positions("place_role", set.placeRoles);
  const groups = new Set([...set.existingGroups, ...set.groups.map((g) => g.code)]);
  for (const g of groups) positions(`entity_role in ${g}`, set.entityRoles.filter((r) => r.group === g));

  for (const g of set.groups) if (!filled(g.es) || !filled(g.en)) problems.push(`role_group ${g.code}: a label is missing`);
  for (const r of set.entityRoles) {
    if (!groups.has(r.group)) problems.push(`entity_role ${r.code}: its group ${r.group} is neither a group of the set nor an existing one the set names`);
    if (!filled(r.es) || !filled(r.en)) problems.push(`entity_role ${r.code}: a label is missing`);
  }
  for (const r of set.placeRoles) if (!filled(r.es) || !filled(r.en)) problems.push(`place_role ${r.code}: a label is missing`);
  if (problems.length > 0) throw new VocabularyStop(`The set ${set.name} is not complete:\n  ${problems.join("\n  ")}\nNothing was read or written.`);
}

// ---------------------------------------------------------------------------
// The rows
// ---------------------------------------------------------------------------

/** The columns the file sets on a row, as `vocabulary_values` names them. */
const VALUE_FIELDS = [
  "label_es", "label_en", "group_code", "position", "external_scheme", "external_uri", "external_label", "status",
  "connector_es", "connector_en", "inverse_code", "hide_when_group",
  "label_es_female", "label_es_male", "label_es_unrecorded", "label_es_alone",
  "label_en_female", "label_en_male", "label_en_unrecorded", "label_en_alone",
] as const;
type ValueField = (typeof VALUE_FIELDS)[number];
type Values = Record<ValueField, string | number | null>;

/** Every column a guard compares: identity, the values and the clock. */
const GUARD_COLUMNS = ["id", "federation_id", "list", "code", ...VALUE_FIELDS, "created_at", "updated_at"] as const;
const INTEGER_COLUMNS = new Set<string>(["position", "created_at", "updated_at"]);

/** The 0125 columns the seed writes; a target without them is refused. */
const REQUIRED_COLUMNS = ["connector_es", "inverse_code", "hide_when_group", "label_es_unrecorded", "label_en_alone"];

const blankValues = (): Values =>
  Object.fromEntries(VALUE_FIELDS.map((f) => [f, null])) as Values;

export interface DesiredRow {
  list: SeedList;
  code: string;
  values: Values;
}

/**
 * The rows the set asks for. A relation set's new groups start after
 * `groupStart`; a role set gives every position itself.
 */
export function desiredRows(set: VocabularySet, groupStart: number): DesiredRow[] {
  const out: DesiredRow[] = [];
  const row = (list: SeedList, code: string, over: Partial<Values>) =>
    out.push({ list, code, values: { ...blankValues(), status: "approved", ...over } });
  if (set.kind === "roles") {
    for (const g of set.groups) row("role_group", g.code, { label_es: g.es, label_en: g.en, position: g.position });
    for (const r of set.entityRoles) row("entity_role", r.code, { label_es: r.es, label_en: r.en, group_code: r.group, position: r.position });
    for (const r of set.placeRoles) row("place_role", r.code, { label_es: r.es, label_en: r.en, position: r.position });
    return out;
  }
  set.groups.forEach((g, i) => row("role_group", g.code, { label_es: g.es, label_en: g.en, position: groupStart + i + 1 }));
  const within = new Map<string, number>();
  for (const r of set.relations) {
    const position = (within.get(r.group) ?? 0) + 1;
    within.set(r.group, position);
    row("relation_role", r.code, {
      label_es: r.es.unrecorded,
      label_en: r.en.unrecorded,
      group_code: r.group,
      position,
      inverse_code: r.inverse,
      connector_es: r.es.connector,
      connector_en: r.en.connector,
      label_es_female: r.es.female,
      label_es_male: r.es.male,
      label_es_unrecorded: r.es.unrecorded,
      label_es_alone: r.es.alone ?? null,
      label_en_female: r.en.female,
      label_en_male: r.en.male,
      label_en_unrecorded: r.en.unrecorded,
      label_en_alone: r.en.alone ?? null,
    });
  }
  set.attributes.forEach((a, i) =>
    row("link_attribute", a.code, { label_es: a.es, label_en: a.en, position: i + 1, hide_when_group: a.hideWhenGroup ?? null }),
  );
  set.genders.forEach((g, i) => row("gender", g.code, { label_es: g.es, label_en: g.en, position: i + 1 }));
  return out;
}

const heldValue = (column: string, v: unknown): string | number | null => {
  if (v === null || v === undefined) return null;
  return INTEGER_COLUMNS.has(column) ? Number(v) : String(v);
};

// ---------------------------------------------------------------------------
// The plan
// ---------------------------------------------------------------------------

export type RowStatus = "insert" | "unchanged" | "conflict";

export interface PlannedRow extends DesiredRow {
  status: RowStatus;
  /** The held row's id, for an unchanged row or a conflict. */
  heldId: string | null;
  differences: Record<string, { held: unknown; file: unknown }>;
}

export interface CodeInUse {
  table: "description_entities" | "description_places";
  code: string;
  links: number;
}

export interface SeedPlan {
  federation: { id: string; slug: string };
  /** The lists read, guarded and written. */
  lists: readonly SeedList[];
  held: Record<string, unknown>[];
  rows: PlannedRow[];
  /** Held rows of the set's lists that the set does not name; left alone. */
  others: Array<{ list: string; code: string }>;
  /** A role set only: the codes the federation's links hold, with their counts. */
  codesInUse: CodeInUse[];
  /** Of those, the codes in none of the lists, once the set is written. */
  unlisted: CodeInUse[];
  refusals: string[];
}

/** The codes the federation's links hold, per link table, in one GROUP BY each. */
const codesInUseSql = (federationId: string) =>
  (["description_entities", "description_places"] as const)
    .map(
      (table) =>
        `SELECT '${table}' AS link_table, l.role AS code, count(*) AS links FROM ${table} l ` +
        `JOIN descriptions d ON d.id = l.description_id JOIN tenants t ON t.id = d.tenant_id ` +
        `WHERE t.federation_id = ${escapeSql(federationId)} GROUP BY l.role`,
    )
    .join(" UNION ALL ");

/** Reads the federation and its rows of the set's lists, and plans each value of the set. */
export async function planSeed(
  rows: (sql: string) => Promise<Record<string, unknown>[]>,
  set: VocabularySet,
  options: Pick<SeedOptions, "federation" | "target">,
): Promise<SeedPlan> {
  const columns = new Set((await rows("SELECT name FROM pragma_table_info('vocabulary_values')")).map((r) => String(r.name)));
  const missing = REQUIRED_COLUMNS.filter((c) => !columns.has(c));
  if (missing.length > 0) {
    throw new VocabularyStop(`vocabulary_values on ${options.target} lacks ${missing.join(", ")}: migration 0125 is not applied. Nothing was written.`);
  }
  const fed = (await rows(`SELECT id, slug FROM federations WHERE slug = ${escapeSql(options.federation)}`))[0];
  if (!fed) throw new VocabularyStop(`No federation ${options.federation} on ${options.target}. Nothing was written.`);
  const federation = { id: String(fed.id), slug: String(fed.slug) };
  const lists = listsOf(set);
  const held = await rows(
    `SELECT ${GUARD_COLUMNS.join(", ")} FROM vocabulary_values WHERE federation_id = ${escapeSql(federation.id)} AND list IN (${listSql(lists)}) ORDER BY list, position, code`,
  );

  const refusals: string[] = [];
  const heldGroups = held.filter((h) => h.list === "role_group");
  for (const g of set.existingGroups) {
    if (!heldGroups.some((h) => h.code === g)) refusals.push(`role_group ${g}: the set names it as existing, but ${federation.slug} does not hold it`);
  }
  const newGroups = new Set(set.groups.map((g) => g.code));
  const groupStart = maxOf([0, ...heldGroups.filter((h) => !newGroups.has(String(h.code))).map((h) => Number(h.position))]);
  if (set.kind === "roles") {
    // A role set's groups take the positions it gives; no held group other than the set's own new groups
    // may take one of them, a group the set names as existing included.
    const given = new Map(set.groups.map((g) => [g.position, g.code]));
    for (const h of heldGroups) {
      const code = String(h.code);
      const taker = given.get(Number(h.position));
      if (!newGroups.has(code) && taker !== undefined) {
        refusals.push(`role_group ${code}: held at position ${Number(h.position)}, which the set gives to ${taker}`);
      }
    }
  }

  const planned: PlannedRow[] = desiredRows(set, groupStart).map((d) => {
    const h = held.find((x) => x.list === d.list && x.code === d.code);
    if (!h) return { ...d, status: "insert", heldId: null, differences: {} };
    const differences: PlannedRow["differences"] = {};
    for (const f of VALUE_FIELDS) {
      const was = heldValue(f, h[f]);
      if (was !== d.values[f]) differences[f] = { held: was, file: d.values[f] };
    }
    const status: RowStatus = Object.keys(differences).length === 0 ? "unchanged" : "conflict";
    return { ...d, status, heldId: String(h.id), differences };
  });
  for (const p of planned.filter((x) => x.status === "conflict")) {
    refusals.push(`${p.list} ${p.code}: held with other values (${Object.keys(p.differences).join(", ")}); nothing is overwritten`);
  }
  const named = new Set([...planned.map((p) => `${p.list}:${p.code}`), ...set.existingGroups.map((g) => `role_group:${g}`)]);
  const others = held.filter((h) => !named.has(`${h.list}:${h.code}`)).map((h) => ({ list: String(h.list), code: String(h.code) }));

  // A role set: every code a link of the federation holds must be in one of the three role lists once the set is written.
  let codesInUse: CodeInUse[] = [];
  let unlisted: CodeInUse[] = [];
  if (set.kind === "roles") {
    const relationCodes = await rows(
      `SELECT code FROM vocabulary_values WHERE federation_id = ${escapeSql(federation.id)} AND list = 'relation_role'`,
    );
    const listed = new Set<string>([
      ...relationCodes.map((r) => String(r.code)),
      ...held.filter((h) => h.list === "entity_role" || h.list === "place_role").map((h) => String(h.code)),
      ...planned.filter((p) => p.list === "entity_role" || p.list === "place_role").map((p) => p.code),
    ]);
    codesInUse = (await rows(codesInUseSql(federation.id)))
      .map((r) => ({ table: String(r.link_table) as CodeInUse["table"], code: String(r.code), links: Number(r.links) }))
      .sort((a, b) => (a.table !== b.table ? (a.table < b.table ? -1 : 1) : a.code < b.code ? -1 : a.code > b.code ? 1 : 0));
    unlisted = codesInUse.filter((c) => !listed.has(c.code));
    for (const c of unlisted) {
      refusals.push(`${c.table} ${c.code}: held by ${c.links} ${c.links === 1 ? "link" : "links"}, and in none of entity_role, relation_role or place_role`);
    }
  }
  return { federation, lists, held, rows: planned, others, codesInUse, unlisted, refusals };
}

// ---------------------------------------------------------------------------
// The SQL file
// ---------------------------------------------------------------------------

/** The guards, the inserts and the guards after them; `ids` gives each inserted row its id. */
export function seedStatements(plan: SeedPlan, now: number, newId: () => string): string[] {
  const fedId = escapeSql(plan.federation.id);
  const inserts = plan.rows.filter((r) => r.status === "insert");
  const scope = `federation_id = ${fedId} AND list IN (${listSql(plan.lists)})`;
  const sql: string[] = [];
  sql.push(guard(`(SELECT count(*) FROM federations WHERE id = ${fedId} AND slug = ${escapeSql(plan.federation.slug)}) = 1`, "the federation has changed since it was read"));
  sql.push(guard(`(SELECT count(*) FROM vocabulary_values WHERE ${scope}) = ${plan.held.length}`, "the federation's vocabulary values have changed since they were read"));
  if (plan.held.length > 0) {
    appendAll(sql, matchingGuards(
      "vocabulary_values",
      GUARD_COLUMNS,
      plan.held.map((h) => GUARD_COLUMNS.map((c) => heldValue(c, h[c]))),
      "the federation's vocabulary values have changed since they were read",
    ));
  }
  const rows = inserts.map((r) => ({ id: newId(), list: r.list, code: r.code, values: r.values }));
  appendAll(sql, insertStatements(vocabularyValues, rows.map((r) => ({
    id: r.id,
    federationId: plan.federation.id,
    list: r.list,
    code: r.code,
    labelEs: r.values.label_es,
    labelEn: r.values.label_en,
    groupCode: r.values.group_code,
    position: r.values.position,
    externalScheme: r.values.external_scheme,
    externalUri: r.values.external_uri,
    externalLabel: r.values.external_label,
    status: r.values.status,
    createdAt: now,
    updatedAt: now,
    connectorEs: r.values.connector_es,
    connectorEn: r.values.connector_en,
    inverseCode: r.values.inverse_code,
    hideWhenGroup: r.values.hide_when_group,
    labelEsFemale: r.values.label_es_female,
    labelEsMale: r.values.label_es_male,
    labelEsUnrecorded: r.values.label_es_unrecorded,
    labelEsAlone: r.values.label_es_alone,
    labelEnFemale: r.values.label_en_female,
    labelEnMale: r.values.label_en_male,
    labelEnUnrecorded: r.values.label_en_unrecorded,
    labelEnAlone: r.values.label_en_alone,
  }))).map((s) => s.sql));
  sql.push(guard(`(SELECT count(*) FROM vocabulary_values WHERE ${scope}) = ${plan.held.length + rows.length}`, "the federation's vocabulary values are not all there"));
  appendAll(sql, matchingGuards(
    "vocabulary_values",
    GUARD_COLUMNS,
    rows.map((r) => GUARD_COLUMNS.map((c) => {
      if (c === "id") return r.id;
      if (c === "federation_id") return plan.federation.id;
      if (c === "list") return r.list;
      if (c === "code") return r.code;
      if (c === "created_at" || c === "updated_at") return now;
      return r.values[c];
    })),
    "a value inserted does not hold what was planned",
  ));
  return sql;
}

// ---------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------

export interface SeedReport {
  stamp: string;
  target: Target;
  federation: { id: string; slug: string };
  set: string;
  applied: boolean;
  outcome: Outcome;
  problems: string[];
  refusals: string[];
  /** Per list of the set. */
  totals: Record<string, Record<RowStatus, number>>;
  statements: number;
  conflicts: Array<{ list: string; code: string; heldId: string; differences: PlannedRow["differences"] }>;
  others: Array<{ list: string; code: string }>;
  codesInUse: CodeInUse[];
  unlisted: CodeInUse[];
  rows: Array<{ list: string; code: string; status: RowStatus; values: Values }>;
}

function totalsOf(plan: SeedPlan): SeedReport["totals"] {
  const out: SeedReport["totals"] = {};
  for (const l of plan.lists) {
    const of = (s: RowStatus) => plan.rows.filter((r) => r.list === l && r.status === s).length;
    out[l] = { insert: of("insert"), unchanged: of("unchanged"), conflict: of("conflict") };
  }
  return out;
}

function markdownOf(r: SeedReport): string {
  const cell = (v: unknown) => (v === null || v === undefined ? "" : String(v).replace(/\|/g, "\\|"));
  const outcome: Record<Outcome, string> = {
    verified: "**Verified: everything inserted reads back as planned, and a second plan finds nothing to write.**",
    "not verified": `**Not verified.** ${r.problems.join(" ")}`,
    refused: `**Refused: ${r.refusals.length} refusals. Nothing was written.**`,
    "dry run": "**Dry run: nothing was written.**",
    "nothing to write": "**Nothing to write: every value of the set is held as the file gives it.**",
    "stopped during the write": "**Stopped during the write: run the command again, and read what it reports.**",
  };
  const label = (row: SeedReport["rows"][number]) => {
    const v = row.values;
    if (row.list !== "relation_role") return `${cell(v.label_es)} / ${cell(v.label_en)}`;
    const alone = (a: unknown) => (a ? `, alone ${cell(a)}` : "");
    return `${cell(v.label_es_female)} · ${cell(v.label_es_male)} · ${cell(v.label_es_unrecorded)}${alone(v.label_es_alone)} (${cell(v.connector_es)}) / ` +
      `${cell(v.label_en_female)} · ${cell(v.label_en_male)} · ${cell(v.label_en_unrecorded)}${alone(v.label_en_alone)} (${cell(v.connector_en)})`;
  };
  return [
    `# Vocabulary: ${r.set}, ${r.federation.slug}, ${r.target}, ${r.stamp}`,
    "",
    outcome[r.outcome],
    "",
    "| List | Insert | Unchanged | Conflict |",
    "|---|---|---|---|",
    ...Object.entries(r.totals).map(([l, t]) => `| ${l} | ${t.insert} | ${t.unchanged} | ${t.conflict} |`),
    "",
    `Statements: ${r.statements}.`,
    "",
    "## Refusals",
    "",
    ...(r.refusals.length === 0 ? ["None."] : r.refusals.map((f) => `- ${f}`)),
    "",
    "## Conflicts",
    "",
    ...(r.conflicts.length === 0 ? ["None."] : r.conflicts.flatMap((c) => [
      `- ${c.list} ${c.code} (held as ${c.heldId})`,
      ...Object.entries(c.differences).map(([k, d]) => `  - ${k}: held ${JSON.stringify(d.held)}, file ${JSON.stringify(d.file)}`),
    ])),
    "",
    ...(r.codesInUse.length === 0 && r.unlisted.length === 0 ? [] : [
      "## Codes held by links",
      "",
      "| Table | Code | Links | In a list |",
      "|---|---|---|---|",
      ...r.codesInUse.map((c) => `| ${c.table} | ${cell(c.code)} | ${c.links} | ${r.unlisted.includes(c) ? "no" : "yes"} |`),
      "",
    ]),
    "## Held and not in the set (left alone)",
    "",
    ...(r.others.length === 0 ? ["None."] : r.others.map((o) => `- ${o.list} ${o.code}`)),
    "",
    "## Rows",
    "",
    "| List | Code | Group | Inverse | Position | Labels (es / en) | Hidden when | Status |",
    "|---|---|---|---|---|---|---|---|",
    ...r.rows.map((x) =>
      `| ${x.list} | ${x.code} | ${cell(x.values.group_code)} | ${cell(x.values.inverse_code)} | ${cell(x.values.position)} | ${label(x)} | ${cell(x.values.hide_when_group)} | ${x.status} |`),
  ].join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

export function exitCodeOf(report: SeedReport): number {
  return exitCodeOfOutcome(report.outcome);
}

/**
 * Checks the confirmation and the set, plans, writes the report and the
 * SQL file, and with `apply` and no refusal applies the file, reads
 * again and plans again. Returns the report.
 */
export async function runVocabularySeed(
  options: SeedOptions,
  providers: RunProviders,
  log: (line: string) => void,
  sets: Record<string, VocabularySet> = VOCABULARY_SETS,
): Promise<SeedReport> {
  // Before anything is read.
  if (options.apply && options.target === "production" && !options.confirmProduction) {
    throw new VocabularyStop("Applying to production also needs --confirm-production");
  }
  const set = sets[options.set];
  if (!set) throw new VocabularyStop(`No set ${options.set}; the sets are ${Object.keys(sets).join(", ")}`);
  validateSet(set);

  const rows = selectOnly(providers.rows);
  const now = providers.now();
  const { stamp, name } = runNameOf(`vocabulary_${options.federation}`, options.target, providers, now);
  const plan = await planSeed(rows, set, options);

  let sql: string[] = [];
  const inserts = plan.rows.filter((r) => r.status === "insert").length;
  if (plan.refusals.length === 0 && inserts > 0) {
    sql = seedStatements(plan, now, providers.newId);
    for (const o of oversizedStatements(sql)) {
      plan.refusals.push(`statement ${o.index + 1} is ${o.bytes} bytes, over the ${STATEMENT_BUDGET}-byte budget: ${o.head}`);
    }
  }

  const report: SeedReport = {
    stamp,
    target: options.target,
    federation: plan.federation,
    set: set.name,
    applied: false,
    outcome: plan.refusals.length > 0 ? "refused" : inserts === 0 ? "nothing to write" : options.apply ? "stopped during the write" : "dry run",
    problems: [],
    refusals: plan.refusals,
    totals: totalsOf(plan),
    statements: plan.refusals.length > 0 ? 0 : sql.length,
    conflicts: plan.rows.filter((r) => r.status === "conflict").map((r) => ({ list: r.list, code: r.code, heldId: r.heldId!, differences: r.differences })),
    others: plan.others,
    codesInUse: plan.codesInUse,
    unlisted: plan.unlisted,
    rows: plan.rows.map((r) => ({ list: r.list, code: r.code, status: r.status, values: r.values })),
  };

  log(`Vocabulary ${set.name} for ${plan.federation.slug} on ${options.target}${options.apply ? "" : " (dry run)"}`);
  for (const [l, t] of Object.entries(report.totals)) {
    log(`  ${l}: ${t.insert} to insert, ${t.unchanged} unchanged, ${t.conflict} in conflict`);
  }
  if (set.kind === "roles") log(`  ${plan.codesInUse.length} codes held by links, ${plan.unlisted.length} in no list`);
  if (plan.others.length > 0) log(`  ${plan.others.length} held rows the set does not name, left alone`);
  for (const f of plan.refusals) log(`  refused: ${f}`);

  const finish = () => {
    providers.writeFile(`${name}.json`, JSON.stringify(report, null, 2) + "\n");
    providers.writeFile(`${name}.md`, markdownOf(report));
    log(`Report: ${name}.json, ${name}.md`);
    return report;
  };
  const sqlFile = `${name}.sql`;
  const sqlText = sql.join("\n") + "\n";
  if (report.outcome === "dry run" || report.outcome === "stopped during the write") {
    providers.createFile(sqlFile, sqlText);
    log(`SQL: ${sqlFile} (${sql.length} statements)`);
  }
  if (report.outcome !== "stopped during the write") return finish();

  // The report is written before the apply, so a run stopped there still has it.
  finish();
  await applyCheckedSqlFile(providers, sqlFile, sqlText, sql, log, (m) => new VocabularyStop(m));
  report.applied = true;

  // Read back: everything again, planned again; nothing may be left to write.
  const again = await planSeed(rows, set, options);
  const problems = [...again.refusals.map((f) => `refused on read-back: ${f}`)];
  for (const r of again.rows) if (r.status !== "unchanged") problems.push(`${r.list} ${r.code}: reads back as ${r.status}`);
  if (again.held.length !== plan.held.length + inserts) {
    problems.push(`the set's lists hold ${again.held.length} rows, not ${plan.held.length + inserts}`);
  }
  report.problems = problems;
  report.outcome = problems.length === 0 ? "verified" : "not verified";
  if (problems.length === 0) log("Verified: every value reads back, and a second plan finds nothing to write.");
  else log(problems.join("\n"));
  return finish();
}

// @version v0.9.0
