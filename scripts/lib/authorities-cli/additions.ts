/**
 * Scripts — the additions of the command line's authority changes
 *
 * This module reads, plans and writes the four operations of a change
 * file (`./change-file.ts`) that add to the catalogue: `create-entity`,
 * `add-link`, `add-place-link` and `add-relation`. `./plan.ts` calls it
 * for those rows and `./statements.ts` places its statements in the one
 * SQL file; the engine's guarantees hold for them as for every other
 * operation: every row read is guarded as read, the file is applied as
 * one unit, and a second plan after the write must find nothing to write.
 *
 * Fisqua names no code here. Every code a row gives is checked against
 * the tenant's federation's `vocabulary_values`, read at plan time, list
 * by list (`ADDITION_LISTS`), approved values only: `entity_type` for a
 * new record's type, `gender` for its gender, `entity_role` and
 * `place_role` for the role of a document link and a place link,
 * `relation_role` for a relation side and `link_attribute` for every
 * `attr_<key>` column. The federation's lists are the only authority
 * for a role, as they are in the description editor: a code they do
 * not approve is refused, and one they approve is written whether or
 * not Fisqua's role constants hold it. The file guards every
 * vocabulary row it read, so a code deprecated between plan and apply
 * aborts it. An attribute column whose key the federation does not
 * list refuses the file whole.
 *
 * create-entity  `new_key` names the record for the file's other rows,
 *                which refer to it as `new:<key>` in any order; a key
 *                defined twice, or a `new:` key no row defines, is
 *                refused. The record has the columns the description
 *                editor's create writes (`recordValuesOf` in
 *                `../authority-links.ts`), the owner
 *                `resolveMintOwner` gives (NULL where the federation
 *                shares its authorities, which needs a steward), a code
 *                minted by the app's `generateUniqueCode` under
 *                `resolveAuthorityCodePrefix`'s prefix and found free in
 *                D1, and `gender` (blank: NULL; only on a person), `qualified_name`
 *                (blank: NULL) and `known_only_from_relation` (`0`, `1`
 *                or blank for 0). It gets a `create` changelog row with
 *                the record's columns (`createSnapshotDiff`), as an
 *                accepted pending decision's mint writes it; the editor's create
 *                writes no ledger row, and none is written.
 * add-link       a link from `entity` (an existing code, in scope and
 *                not merged away, or `new:<key>`) to the tenant's
 *                description `description_code`, in a document role: a
 *                code of the `relation_role` list that is not also a
 *                document role is refused here.
 *                A code that is a document role is accepted even when
 *                it is also a relation role. The link has no certainty:
 *                a `certainty` on the row refuses it.
 *                `sequence` is a whole number, blank for 0.
 *                `authority_name`, when given, is checked against the
 *                record as the operations on an existing record check
 *                it (its display name, NFC and trimmed, or the one an
 *                update-entity row of the file renames); it must be blank
 *                when `entity` is a `new:<key>`.
 * add-place-link a link from a place to the description: `place` is an
 *                existing code, in scope, not merged away and named by
 *                no merge-place row of the file, or
 *                `new:<key>` of a create-place row of the file, in any
 *                row order (`./places.ts` plans the keys; a key no
 *                create-place row defines, or one refused, refuses the
 *                row). `authority_name`, when given, must be the place's
 *                stored `label` (or the label an update-place row of the
 *                file renames), as the place operations compare it; it
 *                must be blank for a `new:<key>`.
 * add-relation   two links to the description, `a_` and `b_`, each with
 *                `related_to` naming the other. Both roles are
 *                `relation_role` codes. The candidates for the other side
 *                of a role R are R's inverse and every code whose inverse
 *                is R: a filled `b_role` must be one of `a_role`'s, or
 *                the row is refused (Zasqua could not pair the sides); a
 *                blank `b_role` is derived only when `a_role` has one
 *                candidate, and that side's certainty is then `derived`
 *                (candidates are approved codes only: an inverse naming
 *                a code missing or not approved gives none)
 *                unless the row gives one. Each side's `certainty` is its
 *                `relation_certainty`: blank (NULL), `doubtful`,
 *                `inferred` or `derived`. A blank `a_role`, or the same
 *                record on both sides, is refused.
 *
 * Attributes are a JSON object of the row's non-blank attribute columns,
 * in header order, each value as written (NFC, trimmed); `{}` when there
 * are none. Every other text a row writes is NFC and trimmed.
 *
 * Duplicates. A document link (description, entity, role, no
 * `related_to`) or a place link (description, place, role) that D1
 * holds under another id, written by anything but this file, is "same"
 * when it holds every value the row gives (`role_note`, `role_raw`,
 * `sequence`, `honorific`, `name_as_recorded` and the attributes; a
 * place link's `role_note` alone, since the operation has no `role_raw`
 * column and a place link the import made holds one), each by type as
 * well as value: the sequence the integer the row writes, a text column
 * the text it writes, a stored '' or NULL for a blank. Nothing is written for
 * the row, and it is neither done nor pending in the rerun contract.
 * One that holds other values is refused, naming the columns. The link
 * found is guarded as read with every other link of its description,
 * and its id is kept on the row's plan (`held`), so that a move or drop
 * row of the same file naming it is refused (`./plan.ts`). A relation D1
 * holds between the same two records in the same two roles on the
 * description, in either direction, and not written by this file, is
 * refused. Two rows of the file that make the same link, or the same
 * relation, are refused. A `new:<key>` whose
 * record a merge row of the file merges away is refused, as an existing
 * code is, and so is the create-entity row that makes or made it; a
 * record an applied merge took is refused as merged. A document link and a
 * relation side may share a person and a role on one description.
 *
 * Rerun. Every id these rows write is made from the federation, the
 * tenant, the file's name and the row's identifying values
 * (`newRecordId`, in a namespace per kind): a record from its `new_key`;
 * a document link from its description, record and role; a place link
 * from its description, place and role; each relation side from its
 * description, both records and both roles, and its side; each
 * changelog row from the id of what it records. A row is done when D1
 * holds what it writes under those ids, with the values it gives, and
 * the changelog rows it writes under theirs: then it writes nothing and
 * is reported "already created", "already linked", "already
 * place-linked" or "already related". Anything else found under one of
 * those ids, or part of a row's writes without the rest, refuses the row,
 * and so does a link held under another id while this file's id for it
 * or its changelog row is in use.
 *
 * Guards. The SQL file opens with guards that every vocabulary value of
 * the lists read is as read and the lists hold no other; every
 * description the file names is as read and no other has its code in
 * the tenant; every place read is as read; every link of each
 * description the file names, document, relation and place links, is as
 * read and the descriptions hold no other; every record, link and
 * changelog row a rerun found is as read; every id and code the file
 * would write, and every changelog id, is still absent; and the code
 * prefix the codes were minted under is still the agency's. The records
 * the rows name are guarded by `./statements.ts` with every other entity
 * read. The file closes with guards that every record, link and
 * changelog row written holds what was planned, every relation side
 * names the other, and every link and place link written is in a
 * description of the acting tenant (`tenantLinkGuards`, a constant, not
 * a value read).
 *
 * @version v0.9.0
 */

import { changelog, descriptionEntities, descriptionPlaces, entities, type ChangelogActedAs } from "../../../app/db/schema";
import { generateUniqueCode, resolveAuthorityCodePrefix } from "../../../app/lib/codes.server";
import { createSnapshotDiff, linkDiff } from "../../../app/lib/stewardship.server";
import { RELATION_CERTAINTIES, type ENTITY_TYPES } from "../../../app/lib/validation/enums";
import { descriptionEntitySchema } from "../../../app/lib/validation/junctions";
import { newRecordId, readerDb, recordValuesOf, type RowReader } from "../authority-links";
import { chunks, composer, guard, idList, matchingGuards, render, storedValue, typed } from "../authority-merges";
import { blank, sameName, text } from "../entity-splits";
import { escapeSql } from "../sql";
import { ADDITION_OPS, ATTRIBUTE_COLUMN, AuthoritiesStop, type ChangeRow, type Op } from "./change-file";
import { PLACE_NAMESPACES, changedSince, tenantLinkGuards } from "./places";
import { appendAll } from "../arrays";

type Stored = Record<string, string | number | null>;

/** The vocabulary lists the additions read. */
export const ADDITION_LISTS = ["entity_type", "gender", "entity_role", "place_role", "relation_role", "link_attribute"] as const;
type AdditionList = (typeof ADDITION_LISTS)[number];

export const VOCABULARY_READ = ["id", "federation_id", "list", "code", "status", "inverse_code", "updated_at"] as const;
export const DESCRIPTION_READ = ["id", "tenant_id", "reference_code"] as const;
export const PLACE_READ = ["id", "federation_id", "tenant_id", "place_code", "label", "display_name", "merged_into", "updated_at"] as const;
export const LINK_READ = [
  "id", "description_id", "entity_id", "role", "role_note", "role_raw", "sequence", "honorific", "name_as_recorded", "related_to",
  "relation_certainty", "attributes",
] as const;
export const PLACE_LINK_READ = ["id", "description_id", "place_id", "role", "role_note", "role_raw"] as const;

/** The namespaces of the ids the additions make (`newRecordId`). */
export const NAMESPACES = {
  entity: "authorities-entity",
  link: "authorities-link",
  placeLink: "authorities-place-link",
  side: "authorities-relation",
  journal: "authorities-addition-journal",
} as const;

const isAddition = (r: ChangeRow) => (ADDITION_OPS as readonly string[]).includes(r.cells.op);
const nfc = (v: string) => v.normalize("NFC").trim();
const optional = (v: string) => (v === "" ? null : nfc(v));
const NEW = "new:";
/** The one entity type that has a gender: the design gives none to corporate bodies or families. */
export const PERSON: (typeof ENTITY_TYPES)[number] = "person";

// ---------------------------------------------------------------------------
// What is read
// ---------------------------------------------------------------------------

export interface AdditionsState {
  /** Whether the file holds an addition or a gender, so the vocabulary was read. */
  read: boolean;
  /** Every value of `ADDITION_LISTS`, as read. */
  vocabulary: Stored[];
  /** The tenant's descriptions of each code the file names. */
  descriptions: Map<string, Stored[]>;
  /** The federation's places of each code the file names. */
  places: Map<string, Stored>;
  /** Every document and relation link of the descriptions read. */
  links: Stored[];
  /** Every place link of the descriptions read. */
  placeLinks: Stored[];
  /** Identity → the id it makes (records, links, sides, changelog rows). */
  ids: Map<string, string>;
  /** Records found under a key's id, as `recordColumns` reads them. */
  found: Map<string, Stored>;
  /** Links and place links found under an id the file makes. */
  linksById: Map<string, Stored>;
  placeLinksById: Map<string, Stored>;
  /** Changelog rows found under an id the file makes, with the record each names. */
  journalFound: Map<string, string>;
  /** For each key's record still to make: the code minted for it. */
  minted: Map<string, string>;
  /** The agency whose prefix the codes are minted under. */
  prefix: { table: "federations" | "tenants"; id: string; prefix: string } | null;
}

/** Identities, kept as JSON so no two sets of parts share one. */
const identity = (...parts: string[]) => JSON.stringify(parts);
export const entityIdentity = (file: string, key: string) => identity("entity", file, key);
const linkIdentity = (descriptionId: string, entityId: string, role: string) => identity("link", descriptionId, entityId, role);
const placeLinkIdentity = (descriptionId: string, placeId: string, role: string) => identity("place-link", descriptionId, placeId, role);
const sideIdentity = (descriptionId: string, a: string, aRole: string, b: string, bRole: string, side: "a" | "b") =>
  identity("side", descriptionId, a, aRole, b, bRole, side);
const journalIdentity = (id: string) => identity("journal", id);

/** The parsed attribute columns of a header: column, side prefix ('' for a link) and key. */
export function attributeColumns(rows: ChangeRow[]): Array<{ column: string; side: string; key: string }> {
  const columns = new Set(rows.flatMap((r) => Object.keys(r.cells)));
  return [...columns].flatMap((column) => {
    const m = ATTRIBUTE_COLUMN.exec(column);
    return m ? [{ column, side: m[1] ?? "", key: m[2] }] : [];
  });
}

/** The approved codes of each list, and the inverse of each relation code. */
export function vocabularyOf(state: AdditionsState): { codes: Map<AdditionList, Set<string>>; inverse: Map<string, string | null> } {
  const codes = new Map<AdditionList, Set<string>>(ADDITION_LISTS.map((l) => [l, new Set<string>()]));
  const inverse = new Map<string, string | null>();
  for (const v of state.vocabulary) {
    if (text(v.status) !== "approved") continue;
    codes.get(text(v.list) as AdditionList)?.add(text(v.code));
    if (text(v.list) === "relation_role") inverse.set(text(v.code), blank(v.inverse_code) ? null : text(v.inverse_code));
  }
  return { codes, inverse };
}

async function readIn(rows: RowReader, ids: string[], query: (part: string) => string): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  for (const part of chunks([...new Set(ids)].filter(Boolean), 100)) appendAll(out, await rows(query(idList(part))));
  return out;
}

/** The columns whose SQL type a link's comparison needs (`linkDiffers`), the columns not being STRICT. */
const TYPED_COLUMNS = ["sequence", "role_note", "role_raw", "honorific", "name_as_recorded"];

/**
 * A row as read: each column's stored value, and for each of
 * `TYPED_COLUMNS` it holds its SQL type as well (`<column>__type`), since
 * `storedValue` reads an integer and a real alike, and a BLOB as text.
 */
const stored = (columns: readonly string[]) => (r: Record<string, unknown>): Stored => ({
  ...Object.fromEntries(columns.map((c) => [c, storedValue(r, c)])),
  ...Object.fromEntries(TYPED_COLUMNS.filter((c) => columns.includes(c)).map((c) => [`${c}__type`, String(r[`${c}__type`])])),
});

/**
 * A stored text column as the comparison reads it: NULL, and in
 * `EMPTY_AS_NULL` a TEXT '', as null; other text as itself; any other SQL
 * type (a BLOB, a number) as a value no row gives.
 */
function storedText(s: Stored, k: string): string | null | symbol {
  const type = s[`${k}__type`];
  if (s[k] === null || s[k] === undefined || type === "null") return null;
  if (type !== undefined && type !== "text") return OTHER_TYPE;
  return EMPTY_AS_NULL.includes(k) && s[k] === "" ? null : String(s[k]);
}
const OTHER_TYPE = Symbol("a stored value of another SQL type");

/**
 * Reads what the additions need: the vocabulary, the descriptions, the
 * places, the links of those descriptions, whatever an earlier run of the
 * file wrote under the ids it makes, and a free code for each record to
 * make. `entityId` resolves an existing code the file names.
 */
export async function readAdditionsState(
  rows: RowReader,
  input: { file: string; rows: ChangeRow[] },
  scope: { tenantId: string; federationId: string; owner: string | null },
  recordColumns: readonly string[],
  entityId: (code: string) => string,
): Promise<AdditionsState> {
  const F = escapeSql(scope.federationId);
  const T = escapeSql(scope.tenantId);
  const additions = input.rows.filter(isAddition);
  const state: AdditionsState = {
    read: false, vocabulary: [], descriptions: new Map(), places: new Map(), links: [], placeLinks: [], ids: new Map(), found: new Map(),
    linksById: new Map(), placeLinksById: new Map(), journalFound: new Map(), minted: new Map(), prefix: null,
  };
  const genders = input.rows.some((r) => r.cells.op === "update-entity" && r.cells.gender !== "" && r.cells.gender !== "NULL");
  if (additions.length === 0 && !genders && attributeColumns(input.rows).length === 0) return state;
  state.read = true;
  state.vocabulary = (await rows(
    `SELECT ${typed(VOCABULARY_READ)} FROM vocabulary_values WHERE federation_id = ${F} AND list IN (${idList([...ADDITION_LISTS])}) ORDER BY id`,
  )).map(stored(VOCABULARY_READ));
  if (additions.length === 0) return state;

  for (const r of await readIn(rows, additions.map((r) => r.cells.description_code), (p) =>
    `SELECT ${typed(DESCRIPTION_READ)} FROM descriptions WHERE tenant_id = ${T} AND reference_code IN (${p})`,
  )) {
    const d = stored(DESCRIPTION_READ)(r);
    state.descriptions.set(text(d.reference_code), [...(state.descriptions.get(text(d.reference_code)) ?? []), d]);
  }
  for (const r of await readIn(rows, additions.map((r) => r.cells.place).filter((p) => !p.startsWith(NEW)), (p) =>
    `SELECT ${typed(PLACE_READ)} FROM places WHERE federation_id = ${F} AND place_code IN (${p})`,
  )) {
    const p = stored(PLACE_READ)(r);
    state.places.set(text(p.place_code), p);
  }

  // The records the keys make, found or still to make.
  const keyIds = new Map<string, string>();
  for (const r of additions) {
    if (r.cells.op !== "create-entity" || r.cells.new_key === "") continue;
    const k = entityIdentity(r.file, r.cells.new_key);
    if (!state.ids.has(k)) {
      const id = await newRecordId(scope.federationId, scope.tenantId, r.file, r.cells.new_key, NAMESPACES.entity);
      state.ids.set(k, id);
      keyIds.set(r.cells.new_key, id);
    }
  }
  for (const r of await readIn(rows, [...keyIds.values()], (p) => `SELECT ${typed(recordColumns)} FROM entities WHERE id IN (${p})`)) {
    const e = stored(recordColumns)(r);
    state.found.set(text(e.id), e);
  }

  // The ids of the links, the sides and the changelog rows.
  const descriptionOf = (code: string) => {
    const found = state.descriptions.get(code) ?? [];
    return found.length === 1 ? text(found[0].id) : "";
  };
  const ref = (v: string) => (v.startsWith(NEW) ? keyIds.get(v.slice(NEW.length)) ?? "" : entityId(v));
  const make = async (k: string, namespace: string, file: string) => {
    if (!state.ids.has(k)) state.ids.set(k, await newRecordId(scope.federationId, scope.tenantId, file, k, namespace));
    return state.ids.get(k)!;
  };
  const journals: string[] = [];
  const linkIds: string[] = [];
  const placeLinkIds: string[] = [];
  const { inverse } = vocabularyOf(state);
  for (const id of keyIds.values()) journals.push(await make(journalIdentity(id), NAMESPACES.journal, input.file));
  for (const r of additions) {
    const c = r.cells;
    const d = descriptionOf(c.description_code);
    if (!d) continue;
    if (c.op === "add-link" && ref(c.entity) && c.role) {
      linkIds.push(await make(linkIdentity(d, ref(c.entity), c.role), NAMESPACES.link, r.file));
    } else if (c.op === "add-place-link" && c.role && (state.places.has(c.place) || c.place.startsWith(NEW))) {
      // A new place's id is the one `./places.ts` makes for its key.
      const placeId = c.place.startsWith(NEW)
        ? await newRecordId(scope.federationId, scope.tenantId, r.file, c.place.slice(NEW.length), PLACE_NAMESPACES.place)
        : text(state.places.get(c.place)!.id);
      placeLinkIds.push(await make(placeLinkIdentity(d, placeId, c.role), NAMESPACES.placeLink, r.file));
    } else if (c.op === "add-relation" && ref(c.a_entity) && ref(c.b_entity) && c.a_role) {
      // A blank b_role is planned under the role derived for it; the ids are made for every candidate.
      const bRoles = c.b_role ? [c.b_role] : candidatesOf(c.a_role, inverse);
      for (const bRole of bRoles) {
        for (const side of ["a", "b"] as const) {
          linkIds.push(await make(sideIdentity(d, ref(c.a_entity), c.a_role, ref(c.b_entity), bRole, side), NAMESPACES.side, r.file));
        }
      }
    }
  }
  for (const id of [...linkIds, ...placeLinkIds]) journals.push(await make(journalIdentity(id), NAMESPACES.journal, input.file));
  for (const r of await readIn(rows, linkIds, (p) => `SELECT ${typed(LINK_READ)} FROM description_entities WHERE id IN (${p})`)) {
    const l = stored(LINK_READ)(r);
    state.linksById.set(text(l.id), l);
  }
  for (const r of await readIn(rows, placeLinkIds, (p) => `SELECT ${typed(PLACE_LINK_READ)} FROM description_places WHERE id IN (${p})`)) {
    const l = stored(PLACE_LINK_READ)(r);
    state.placeLinksById.set(text(l.id), l);
  }
  for (const r of await readIn(rows, journals, (p) => `SELECT id, record_id FROM changelog WHERE id IN (${p})`)) {
    state.journalFound.set(String(r.id), String(r.record_id));
  }

  // Every link of the descriptions the file names, a page at a time.
  const descriptionIds = [...new Set([...state.descriptions.values()].flat().map((d) => text(d.id)))];
  for (const [table, columns, into] of [
    ["description_entities", LINK_READ, state.links],
    ["description_places", PLACE_LINK_READ, state.placeLinks],
  ] as const) {
    for (const part of chunks(descriptionIds, 100)) {
      let last = "";
      for (;;) {
        const page = await rows(
          `SELECT ${typed(columns)} FROM ${table} WHERE description_id IN (${idList(part)}) AND id > ${escapeSql(last)} ORDER BY id LIMIT 1000`,
        );
        appendAll(into, page.map(stored(columns)));
        if (page.length < 1000) break;
        last = String(page[page.length - 1].id);
      }
    }
  }

  // A free code for each record still to make, minted by the app's
  // generator under the agency's prefix, then checked in D1 all at once
  // (the generator's own check runs against the codes of this run).
  const toMake = [...keyIds.values()].filter((id) => !state.found.has(id));
  if (toMake.length > 0) {
    const prefix = await resolveAuthorityCodePrefix(readerDb(rows), "entity", scope.federationId, scope.owner).catch((err: Error) => {
      throw new AuthoritiesStop(err.message);
    });
    state.prefix = { table: scope.owner === null ? "federations" : "tenants", id: scope.owner ?? scope.federationId, prefix };
    const taken = new Set<string>();
    const local = readerDb(async (sql) => {
      const code = /'([^']*)'/.exec(sql)?.[1] ?? "";
      return taken.has(code) ? [{ id: code }] : [];
    });
    let pending = toMake;
    for (let round = 0; pending.length > 0; round++) {
      if (round === 5) throw new AuthoritiesStop(`No free code under ${prefix} was found for ${pending.length} new records`);
      for (const id of pending) {
        const code = await generateUniqueCode(local, prefix, entities, entities.entityCode);
        taken.add(code);
        state.minted.set(id, code);
      }
      const inD1 = new Set((await readIn(rows, pending.map((id) => state.minted.get(id)!), (p) =>
        `SELECT entity_code FROM entities WHERE entity_code IN (${p})`,
      )).map((r) => String(r.entity_code)));
      pending = pending.filter((id) => inD1.has(state.minted.get(id)!));
    }
  }
  return state;
}

/**
 * The candidates for the other side of `role`: its inverse and every code
 * whose inverse is `role`, sorted. `inverse` holds the approved relation
 * codes only, so a candidate is always an approved code.
 */
export function candidatesOf(role: string, inverse: Map<string, string | null>): string[] {
  const out = new Set<string>();
  const own = inverse.get(role);
  // An inverse names a candidate only when it is itself an approved code of the list.
  if (own && inverse.has(own)) out.add(own);
  for (const [code, inv] of inverse) if (inv === role) out.add(code);
  return [...out].sort();
}

// ---------------------------------------------------------------------------
// The plan
// ---------------------------------------------------------------------------

export type AdditionStatus =
  | "create" | "link" | "place-link" | "relate"
  | "already created" | "already linked" | "already place-linked" | "already related" | "same";

/** A link to write, by Drizzle key, without its `createdAt`. */
export interface LinkValues {
  id: string;
  descriptionId: string;
  entityId: string;
  role: string;
  roleNote: string | null;
  roleRaw: string | null;
  sequence: number;
  honorific: string | null;
  nameAsRecorded: string | null;
  relatedTo: string | null;
  relationCertainty: string | null;
  attributes: string;
}

export interface PlaceLinkValues {
  id: string;
  descriptionId: string;
  placeId: string;
  role: string;
  roleNote: string | null;
  roleRaw: null;
}

export interface AdditionPlan {
  row: ChangeRow;
  status: AdditionStatus;
  note: string;
  /** create-entity: the record's columns by Drizzle key, `createdAt` and `updatedAt` aside. */
  record?: Record<string, unknown>;
  /** add-link: one link; add-relation: the two sides, a then b. */
  links: LinkValues[];
  placeLink?: PlaceLinkValues;
  /** The changelog id of each record or link written, by the id it records. */
  journal: Map<string, string>;
  /** A "same" row: the id of the link D1 holds with the row's values. */
  held?: string;
}

export interface AdditionsPlan {
  rows: AdditionPlan[];
}

/** The context the rest of the plan gives. */
export interface AdditionsContext {
  tenantId: string;
  tenantSlug?: string;
  federationId: string;
  /** An existing code, in scope and not merged away: its record, or the reason it is refused. */
  resolve: (code: string, what: string) => Stored | string;
  /** The line of a merge row that names the record, if any. */
  mergedBy: (entityId: string) => number | undefined;
  /** Whether an `authority_name` is the record's display name, or the one an update row of the file renamed. */
  nameHolds?: (e: Stored, name: string) => boolean;
  /** A place's `new:<key>`: the id of the place a create-place row makes, or the reason it is refused. */
  placeKey?: (value: string) => string | { id: string };
  /** The line of a merge-place row that names the place, as loser or survivor, if any. */
  placeMergedBy?: (placeId: string) => number | undefined;
  /** Whether an `authority_name` is the place's label, or the one an update-place row of the file renamed. */
  placeNameHolds?: (p: Stored, name: string) => boolean;
}

/** What a link to a record a merge of the file names should do instead. */
const MERGED_HINT = "link to the survivor in a separate file, or after the merge";

const SIDE_CHECK = descriptionEntitySchema.pick({ honorific: true, nameAsRecorded: true });

/** Two attributes objects, the same keys and values in any order. */
function sameAttributes(a: unknown, b: unknown): boolean {
  const canonical = (v: unknown) => {
    try {
      const o = JSON.parse(blank(v) ? "{}" : String(v));
      return o && typeof o === "object" && !Array.isArray(o) ? JSON.stringify(Object.entries(o).sort(([x], [y]) => (x < y ? -1 : 1))) : String(v);
    } catch {
      return String(v);
    }
  };
  return canonical(a) === canonical(b);
}

/** The text columns of a link in which a stored '' and NULL both mean no value. */
const EMPTY_AS_NULL = ["role_note", "role_raw", "honorific", "name_as_recorded"];

/**
 * The columns of a stored link that differ from the link planned, by type
 * as well as value: the sequence must be the integer the row writes, and
 * each text column the text it writes (a number is not its digits); in
 * `EMPTY_AS_NULL` a stored TEXT '' or NULL matches a blank, and a value
 * of another SQL type (an empty BLOB among them) matches nothing.
 */
function linkDiffers(s: Stored, v: LinkValues): string[] {
  const want: Record<string, unknown> = {
    description_id: v.descriptionId, entity_id: v.entityId, role: v.role, role_note: v.roleNote, role_raw: v.roleRaw, sequence: v.sequence,
    honorific: v.honorific, name_as_recorded: v.nameAsRecorded, related_to: v.relatedTo, relation_certainty: v.relationCertainty,
  };
  const integer = (x: unknown) => typeof x === "number" && Number.isInteger(x) && (s.sequence__type === undefined || s.sequence__type === "integer");
  // In the text columns a link may leave empty, a stored TEXT '' is no value, as NULL is.
  const value = (k: string) => (EMPTY_AS_NULL.includes(k) ? storedText(s, k) : (s[k] ?? null));
  const out = Object.entries(want).filter(([k, w]) => (k === "sequence" ? !(integer(s[k]) && s[k] === w) : value(k) !== (w ?? null))).map(([k]) => k);
  if (!sameAttributes(s.attributes, v.attributes)) out.push("attributes");
  return out;
}

/** Checks the addition rows against what was read and plans each. */
export function planAdditions(
  input: { file: string; rows: ChangeRow[] },
  state: AdditionsState,
  ctx: AdditionsContext,
  refuse: (where: string, reason: string) => void,
  /** Every row of the file, whose columns are its header; the addition rows when not given. */
  header?: ChangeRow[],
): { plan: AdditionsPlan; statuses: Map<ChangeRow, AdditionStatus | "refused"> } {
  const statuses = new Map<ChangeRow, AdditionStatus | "refused">();
  const plans: AdditionPlan[] = [];
  const additions = input.rows.filter(isAddition);
  const { codes, inverse } = vocabularyOf(state);
  const where = (r: ChangeRow) => `${r.file} line ${r.line}`;
  const id = (k: string) => state.ids.get(k) ?? "";

  // Attribute columns: every key of the header must be the federation's, whatever operations the file holds.
  for (const a of attributeColumns(header ?? input.rows)) {
    if (!codes.get("link_attribute")!.has(a.key)) refuse(input.file, `${a.column}: ${a.key} is not a key of the federation's link_attribute list`);
  }
  if (additions.length === 0) return { plan: { rows: plans }, statuses };
  const attrs = attributeColumns(additions);
  const attributesOf = (r: ChangeRow, side: string) =>
    JSON.stringify(Object.fromEntries(attrs.filter((a) => a.side === side && r.cells[a.column] !== "").map((a) => [a.key, nfc(r.cells[a.column])])));

  // The keys.
  const keys = new Map<string, ChangeRow>();
  for (const r of additions) {
    if (r.cells.op !== "create-entity") continue;
    statuses.set(r, "refused");
    if (r.cells.new_key === "") { refuse(where(r), "create-entity names no new_key"); continue; }
    const first = keys.get(r.cells.new_key);
    if (first) { refuse(where(r), `new_key ${r.cells.new_key} is defined again (line ${first.line})`); continue; }
    keys.set(r.cells.new_key, r);
  }
  // Each key's record, once planned: its id, or the reason a row naming it is refused.
  const keyRecords = new Map<string, { id: string; refused: boolean; line: number }>();

  for (const r of [...keys.values()]) {
    const c = r.cells;
    const no = (reason: string) => refuse(where(r), reason);
    const recordId = id(entityIdentity(r.file, c.new_key));
    keyRecords.set(c.new_key, { id: recordId, refused: true, line: r.line });
    const cells: Record<string, string> = {
      display_name: nfc(c.display_name), sort_name: nfc(c.sort_name), surname: nfc(c.surname), given_name: nfc(c.given_name),
      entity_type: c.entity_type, name_variants: "", honorific: "", primary_function: "", dates_of_existence: "", date_start: "", date_end: "",
      label: "", place_type: "", latitude: "", longitude: "",
    };
    if (c.entity_type !== "" && !codes.get("entity_type")!.has(c.entity_type)) { no(`entity_type ${JSON.stringify(c.entity_type)} is not in the federation's entity_type list`); continue; }
    if (c.gender !== "" && !codes.get("gender")!.has(c.gender)) { no(`gender ${JSON.stringify(c.gender)} is not in the federation's gender list`); continue; }
    if (c.gender !== "" && c.entity_type !== PERSON) { no(`a ${c.entity_type || "untyped"} record has no gender; only a person has one`); continue; }
    if (!["", "0", "1"].includes(c.known_only_from_relation)) { no("known_only_from_relation is 0, 1 or blank"); continue; }
    const values = recordValuesOf("entity", cells as never);
    if (typeof values === "string") { no(values); continue; }
    const record: Record<string, unknown> = {
      ...values, gender: optional(c.gender), knownOnlyFromRelation: c.known_only_from_relation === "1", qualifiedName: optional(c.qualified_name),
    };
    const journalId = id(journalIdentity(recordId));
    const found = state.found.get(recordId);
    const plan: AdditionPlan = { row: r, status: "create", note: c.changelog_note || `Authorities change file ${r.file}, line ${r.line}`, record, links: [], journal: new Map([[recordId, journalId]]) };
    // A record the file makes, or made, may not also be merged away by a row of it.
    const mergedAt = ctx.mergedBy(recordId);
    if (mergedAt !== undefined) {
      no(`${c.new_key}'s record ${recordId}${found ? ` (${text(found.entity_code)})` : ""} is merged by line ${mergedAt}, so the file may not also make it`);
      continue;
    }
    if (found) {
      const label = `${c.new_key}'s record ${recordId} (${text(found.entity_code)})`;
      if (text(found.federation_id) !== ctx.federationId) { no(`${label} is in another federation`); continue; }
      if (!blank(found.tenant_id) && text(found.tenant_id) !== ctx.tenantId) { no(`${label} is owned by another tenant`); continue; }
      if (!blank(found.merged_into)) { no(`${label} has been merged into ${text(found.merged_into)}`); continue; }
      const want: Record<string, unknown> = {
        display_name: record.displayName, sort_name: record.sortName, surname: record.surname, given_name: record.givenName,
        entity_type: record.entityType, gender: record.gender, qualified_name: record.qualifiedName,
        known_only_from_relation: record.knownOnlyFromRelation ? 1 : 0,
      };
      const differ = Object.entries(want).filter(([k, w]) =>
        k === "known_only_from_relation" ? Number(found[k]) !== w : (blank(found[k]) ? null : found[k]) !== (blank(w) ? null : w),
      ).map(([k]) => k);
      if (differ.length > 0) { no(`${label}, made by an earlier run of this file, holds other values in ${differ.join(", ")}`); continue; }
      if (state.journalFound.get(journalId) !== recordId) { no(`${label} is there, and no changelog row of this file records its creation`); continue; }
      plan.status = "already created";
    } else {
      if (state.journalFound.has(journalId)) { no(`a changelog row of this file records ${c.new_key}'s record, which is not there`); continue; }
      if (!state.minted.has(recordId)) { no(`no code was minted for ${c.new_key}`); continue; }
    }
    keyRecords.get(c.new_key)!.refused = false;
    statuses.set(r, plan.status);
    plans.push(plan);
  }

  /** A record a row names: an existing code or `new:<key>`. */
  const entityOf = (value: string, column: string): { id: string; code: string } | string => {
    if (value === "") return `the row names no ${column}`;
    if (value.startsWith(NEW)) {
      const key = value.slice(NEW.length);
      const k = keyRecords.get(key);
      if (!k) return `${value} is not defined by any create-entity row of the file`;
      if (k.refused) return `${value} is refused at line ${k.line}`;
      // A key's record that a merge row of the file merges away is named by no other row, as an existing code is.
      const line = ctx.mergedBy(k.id);
      if (line !== undefined) return `${value} is merged by line ${line}, so no other row may name it; ${MERGED_HINT}`;
      return { id: k.id, code: value };
    }
    const e = ctx.resolve(value, "");
    if (typeof e === "string") return e;
    const line = ctx.mergedBy(text(e.id));
    if (line !== undefined) return `${value} is merged by line ${line}, so no other row may name it; ${MERGED_HINT}`;
    return { id: text(e.id), code: value };
  };
  const descriptionOf = (r: ChangeRow): string => {
    const found = state.descriptions.get(r.cells.description_code) ?? [];
    if (r.cells.description_code === "") return "";
    if (found.length === 1) return text(found[0].id);
    refuse(where(r), found.length === 0
      ? `no description has the code ${r.cells.description_code} in ${ctx.tenantSlug ?? ctx.tenantId}`
      : `${found.length} descriptions have the code ${r.cells.description_code}`);
    return "";
  };
  /** A side's fields, or the reason they are refused. */
  const fieldsOf = (r: ChangeRow, p: string): Omit<LinkValues, "id" | "descriptionId" | "entityId" | "role" | "relatedTo" | "relationCertainty"> | string => {
    const c = r.cells;
    const sequence = c[`${p}sequence`];
    // The editor's range (`descriptionEntitySchema`: an integer, 0 or more), within the safe integers, so
    // the SQL file writes it as an INTEGER and not as a REAL such as 1e+21.
    if (sequence !== "" && (!/^\d+$/.test(sequence) || !Number.isSafeInteger(Number(sequence)))) {
      return `${p}sequence ${JSON.stringify(sequence)} is not a whole number from 0 to ${Number.MAX_SAFE_INTEGER}`;
    }
    const checked = SIDE_CHECK.safeParse({ honorific: optional(c[`${p}honorific`]) ?? undefined, nameAsRecorded: optional(c[`${p}name_as_recorded`]) ?? undefined });
    if (!checked.success) return checked.error.issues.map((i) => `${p}${i.path[0] === "nameAsRecorded" ? "name_as_recorded" : "honorific"}: ${i.message}`).join("; ");
    return {
      roleNote: optional(c[`${p}role_note`]), roleRaw: optional(c[`${p}role_raw`]), sequence: sequence === "" ? 0 : Number(sequence),
      honorific: optional(c[`${p}honorific`]), nameAsRecorded: optional(c[`${p}name_as_recorded`]), attributes: attributesOf(r, p),
    };
  };

  const fileLinks = new Map<string, number>();
  const fileRelations = new Map<string, number>();
  const filePlaceLinks = new Map<string, number>();
  const docLinks = (d: string) => state.links.filter((l) => text(l.description_id) === d);

  for (const r of additions) {
    if (r.cells.op === "create-entity") continue;
    statuses.set(r, "refused");
    const c = r.cells;
    const no = (reason: string) => refuse(where(r), reason);
    const note = c.changelog_note || `Authorities change file ${r.file}, line ${r.line}`;
    if (c.description_code === "") { no(`${c.op} names no description_code`); continue; }
    const d = descriptionOf(r);
    if (!d) continue;

    if (c.op === "add-place-link") {
      if (c.place === "") { no("add-place-link names no place"); continue; }
      let placeId: string;
      if (c.place.startsWith(NEW)) {
        if (c.authority_name !== "") { no(`authority_name must be blank when the row names ${c.place}`); continue; }
        const k = ctx.placeKey ? ctx.placeKey(c.place) : `${c.place} is not defined by any create-place row of the file`;
        if (typeof k === "string") { no(k); continue; }
        placeId = k.id;
      } else {
        const p = state.places.get(c.place);
        if (!p) { no(`no place has the code ${c.place}`); continue; }
        if (!blank(p.tenant_id) && text(p.tenant_id) !== ctx.tenantId) { no(`${c.place} is owned by another tenant`); continue; }
        if (!blank(p.merged_into)) { no(`${c.place} is merged into ${text(p.merged_into)}`); continue; }
        const line = ctx.placeMergedBy?.(text(p.id));
        if (line !== undefined) { no(`${c.place} is merged by line ${line}, so no other row may name it; ${MERGED_HINT}`); continue; }
        const holds = ctx.placeNameHolds ?? ((x: Stored, name: string) => sameName(name, text(x.label)));
        if (c.authority_name !== "" && !holds(p, c.authority_name)) {
          no(`authority_name ${JSON.stringify(c.authority_name)} is not the stored label ${JSON.stringify(text(p.label))}`);
          continue;
        }
        placeId = text(p.id);
      }
      if (!codes.get("place_role")!.has(c.role)) { no(`role ${JSON.stringify(c.role)} is not a place role`); continue; }
      const key = placeLinkIdentity(d, placeId, c.role);
      if (filePlaceLinks.has(key)) { no(`line ${filePlaceLinks.get(key)} makes the same link`); continue; }
      filePlaceLinks.set(key, r.line);
      const linkId = id(key);
      const values: PlaceLinkValues = { id: linkId, descriptionId: d, placeId, role: c.role, roleNote: optional(c.role_note), roleRaw: null };
      const other = state.placeLinks.find((l) => text(l.description_id) === d && text(l.place_id) === placeId && text(l.role) === c.role && text(l.id) !== linkId);
      const journalId = id(journalIdentity(linkId));
      const plan: AdditionPlan = { row: r, status: "place-link", note, links: [], placeLink: values, journal: new Map([[linkId, journalId]]) };
      if (other) {
        // Held under another id: same when it holds the row's note, refused otherwise. The row has no
        // role_raw column, so a role_raw the import stored is not compared.
        const note = storedText(other, "role_note");
        const differ = note === values.roleNote ? [] : ["role_note"];
        if (differ.length > 0) { no(`${c.description_code} is already linked to ${c.place} as ${c.role} (link ${text(other.id)}), not by this file, with other values in ${differ.join(", ")}`); continue; }
        if (state.placeLinksById.has(linkId) || state.journalFound.has(journalId)) { no(`${c.description_code} holds this place link as ${text(other.id)}, and this file's id for it is in use as well`); continue; }
        statuses.set(r, "same");
        plans.push({ ...plan, status: "same", placeLink: undefined, journal: new Map(), held: text(other.id) });
        continue;
      }
      const there = state.placeLinksById.get(linkId);
      if (there) {
        const want = { description_id: d, place_id: placeId, role: c.role, role_note: values.roleNote, role_raw: null };
        const differ = Object.entries(want).filter(([k, w]) => (there[k] ?? null) !== w).map(([k]) => k);
        if (differ.length > 0) { no(`the place link ${linkId} this row makes holds other values in ${differ.join(", ")}`); continue; }
        if (state.journalFound.get(journalId) !== d) { no(`the place link ${linkId} is there, and no changelog row of this file records it`); continue; }
        plan.status = "already place-linked";
      } else if (state.journalFound.has(journalId)) { no(`a changelog row of this file records the place link ${linkId}, which is not there`); continue; }
      statuses.set(r, plan.status);
      plans.push(plan);
      continue;
    }

    if (c.op === "add-link") {
      if (c.authority_name !== "" && c.entity.startsWith(NEW)) { no(`authority_name must be blank when the row names ${c.entity}`); continue; }
      const e = entityOf(c.entity, "entity");
      if (typeof e === "string") { no(e); continue; }
      if (c.authority_name !== "") {
        // The check the operations on an existing record make of authority_name.
        const record = ctx.resolve(c.entity, "") as Stored;
        const holds = ctx.nameHolds ?? ((x: Stored, name: string) => sameName(name, text(x.display_name)));
        if (!holds(record, c.authority_name)) {
          no(`authority_name ${JSON.stringify(c.authority_name)} is not the stored name ${JSON.stringify(text(record.display_name))}`);
          continue;
        }
      }
      // A document role is accepted even when the same code is also a relation role.
      if (!codes.get("entity_role")!.has(c.role)) {
        no(codes.get("relation_role")!.has(c.role)
          ? `${c.role} is a relation role of the federation and not a document role; add-relation carries it`
          : `role ${JSON.stringify(c.role)} is not a document role`);
        continue;
      }
      const fields = fieldsOf(r, "");
      if (typeof fields === "string") { no(fields); continue; }
      const key = linkIdentity(d, e.id, c.role);
      if (fileLinks.has(key)) { no(`line ${fileLinks.get(key)} makes the same link`); continue; }
      fileLinks.set(key, r.line);
      const linkId = id(key);
      const values: LinkValues = { id: linkId, descriptionId: d, entityId: e.id, role: c.role, relatedTo: null, relationCertainty: null, ...fields };
      const other = docLinks(d).find((l) => text(l.entity_id) === e.id && text(l.role) === c.role && blank(l.related_to) && text(l.id) !== linkId);
      const journalId = id(journalIdentity(linkId));
      const plan: AdditionPlan = { row: r, status: "link", note, links: [values], journal: new Map([[linkId, journalId]]) };
      if (other) {
        // Held under another id: same when it holds the row's values, refused otherwise.
        const differ = linkDiffers(other, values);
        if (differ.length > 0) { no(`${c.description_code} is already linked to ${c.entity} as ${c.role} (link ${text(other.id)}), not by this file, with other values in ${differ.join(", ")}`); continue; }
        if (state.linksById.has(linkId) || state.journalFound.has(journalId)) { no(`${c.description_code} holds this link as ${text(other.id)}, and this file's id for it is in use as well`); continue; }
        statuses.set(r, "same");
        plans.push({ ...plan, status: "same", links: [], journal: new Map(), held: text(other.id) });
        continue;
      }
      const there = state.linksById.get(linkId);
      if (there) {
        const differ = linkDiffers(there, values);
        if (differ.length > 0) { no(`the link ${linkId} this row makes holds other values in ${differ.join(", ")}`); continue; }
        if (state.journalFound.get(journalId) !== d) { no(`the link ${linkId} is there, and no changelog row of this file records it`); continue; }
        plan.status = "already linked";
      } else if (state.journalFound.has(journalId)) { no(`a changelog row of this file records the link ${linkId}, which is not there`); continue; }
      statuses.set(r, plan.status);
      plans.push(plan);
      continue;
    }

    // add-relation
    if (c.a_role === "") { no("add-relation names no a_role"); continue; }
    if (!codes.get("relation_role")!.has(c.a_role)) { no(`a_role ${JSON.stringify(c.a_role)} is not in the federation's relation_role list`); continue; }
    const candidates = candidatesOf(c.a_role, inverse);
    let bRole = c.b_role;
    let derived = false;
    if (bRole !== "") {
      if (!codes.get("relation_role")!.has(bRole)) { no(`b_role ${JSON.stringify(bRole)} is not in the federation's relation_role list`); continue; }
      if (!candidates.includes(bRole)) {
        no(`${c.a_role} pairs with ${candidates.join(", ") || "no code"}, not ${bRole}, so the two sides could not be paired`);
        continue;
      }
    } else if (candidates.length === 1) {
      bRole = candidates[0];
      derived = true;
    } else {
      no(`b_role is blank and ${c.a_role} pairs with ${candidates.join(", ") || "no code"}; the file must name one`);
      continue;
    }
    const certainties = ["a", "b"].map((s) => {
      const v = c[`${s}_certainty`];
      if (v === "") return s === "b" && derived ? "derived" : null;
      return (RELATION_CERTAINTIES as readonly string[]).includes(v) ? v : { bad: `${s}_certainty ${JSON.stringify(v)} is not blank, doubtful, inferred or derived` };
    });
    const bad = certainties.find((x): x is { bad: string } => typeof x === "object" && x !== null);
    if (bad) { no(bad.bad); continue; }
    const a = entityOf(c.a_entity, "a_entity");
    if (typeof a === "string") { no(a); continue; }
    const b = entityOf(c.b_entity, "b_entity");
    if (typeof b === "string") { no(b); continue; }
    if (a.id === b.id) { no(`a_entity and b_entity are both ${c.a_entity}`); continue; }
    const fa = fieldsOf(r, "a_");
    if (typeof fa === "string") { no(fa); continue; }
    const fb = fieldsOf(r, "b_");
    if (typeof fb === "string") { no(fb); continue; }
    // One relation, whichever side the file puts first.
    const pair = [[a.id, c.a_role], [b.id, bRole]].map((x) => x.join("|")).sort().join("||");
    const relKey = `${d}||${pair}`;
    if (fileRelations.has(relKey)) { no(`line ${fileRelations.get(relKey)} makes the same relation`); continue; }
    fileRelations.set(relKey, r.line);
    const idA = id(sideIdentity(d, a.id, c.a_role, b.id, bRole, "a"));
    const idB = id(sideIdentity(d, a.id, c.a_role, b.id, bRole, "b"));
    const sideA: LinkValues = { id: idA, descriptionId: d, entityId: a.id, role: c.a_role, relatedTo: idB, relationCertainty: certainties[0] as string | null, ...fa };
    const sideB: LinkValues = { id: idB, descriptionId: d, entityId: b.id, role: bRole, relatedTo: idA, relationCertainty: certainties[1] as string | null, ...fb };
    // The same relation in D1, written by anything but this row.
    const links = docLinks(d);
    const byId = new Map(links.map((l) => [text(l.id), l]));
    const held = links.find((l) => {
      if (blank(l.related_to) || text(l.id) === idA || text(l.id) === idB) return false;
      const o = byId.get(text(l.related_to));
      if (!o) return false;
      return (text(l.entity_id) === a.id && text(l.role) === c.a_role && text(o.entity_id) === b.id && text(o.role) === bRole) ||
        (text(l.entity_id) === b.id && text(l.role) === bRole && text(o.entity_id) === a.id && text(o.role) === c.a_role);
    });
    if (held) {
      no(`${c.description_code} already holds this relation between ${c.a_entity} (${c.a_role}) and ${c.b_entity} (${bRole}), not written by this file (link ${text(held.id)})`);
      continue;
    }
    const journalA = id(journalIdentity(idA));
    const journalB = id(journalIdentity(idB));
    const plan: AdditionPlan = { row: r, status: "relate", note, links: [sideA, sideB], journal: new Map([[idA, journalA], [idB, journalB]]) };
    const there = [state.linksById.get(idA), state.linksById.get(idB)];
    const journaled = [journalA, journalB].map((j) => state.journalFound.get(j) === d);
    if (there[0] || there[1] || journaled[0] || journaled[1] || state.journalFound.has(journalA) || state.journalFound.has(journalB)) {
      if (!there[0] || !there[1] || !journaled[0] || !journaled[1]) { no(changedSince(r, "part of its effect is present: part of this relation is in D1 under the ids this row makes, and part is not")); continue; }
      const differ = [...linkDiffers(there[0], sideA).map((k) => `a ${k}`), ...linkDiffers(there[1], sideB).map((k) => `b ${k}`)];
      if (differ.length > 0) { no(`the relation's links in D1 hold other values in ${differ.join(", ")}`); continue; }
      plan.status = "already related";
    }
    statuses.set(r, plan.status);
    plans.push(plan);
  }
  return { plan: { rows: plans }, statuses };
}

// ---------------------------------------------------------------------------
// The statements
// ---------------------------------------------------------------------------

export interface AdditionsBuild {
  before: string[];
  writes: string[];
  after: string[];
  created: number;
  linked: number;
  placeLinked: number;
  related: number;
}

/** The statuses that write nothing: done by an earlier run of the file, or held already. */
const DONE: readonly AdditionStatus[] = ["already created", "already linked", "already place-linked", "already related", "same"];

/** The guards, writes and closing guards of the additions. */
export function buildAdditionStatements(
  plan: AdditionsPlan,
  state: AdditionsState,
  opts: { userId: string; now: number; tenantId: string; federationId: string; owner: string | null; recordColumns: readonly string[]; actedAs?: ChangelogActedAs | null },
): AdditionsBuild {
  const db = composer();
  const out: AdditionsBuild = { before: [], writes: [], after: [], created: 0, linked: 0, placeLinked: 0, related: 0 };
  if (!state.read) return out;
  const F = escapeSql(opts.federationId);
  const T = escapeSql(opts.tenantId);

  // Opening guards: the vocabulary, as read and no more.
  out.before.push(guard(
    `(SELECT count(*) FROM vocabulary_values WHERE federation_id = ${F} AND list IN (${idList([...ADDITION_LISTS])})) = ${state.vocabulary.length}`,
    "the federation's vocabulary has changed since it was read",
  ));
  appendAll(out.before, matchingGuards("vocabulary_values", VOCABULARY_READ, state.vocabulary.map((v) => VOCABULARY_READ.map((c) => v[c])),
    "a vocabulary value has changed since it was read"));
  if (plan.rows.length === 0 && state.descriptions.size === 0) return out;

  // The descriptions, places and links read.
  const codes = [...state.descriptions.keys()];
  for (const part of chunks(codes, 200)) {
    const n = part.reduce((s, code) => s + state.descriptions.get(code)!.length, 0);
    out.before.push(guard(`(SELECT count(*) FROM descriptions WHERE tenant_id = ${T} AND reference_code IN (${idList(part)})) = ${n}`,
      "the descriptions of the file's codes have changed since they were read"));
  }
  const descriptions = [...state.descriptions.values()].flat();
  appendAll(out.before, matchingGuards("descriptions", DESCRIPTION_READ, descriptions.map((d) => DESCRIPTION_READ.map((c) => d[c])),
    "a description the file names has changed since it was read"));
  appendAll(out.before, matchingGuards("places", PLACE_READ, [...state.places.values()].map((p) => PLACE_READ.map((c) => p[c])),
    "a place the file names has changed since it was read"));
  const descriptionIds = [...new Set(descriptions.map((d) => text(d.id)))];
  for (const [table, list] of [["description_entities", state.links], ["description_places", state.placeLinks]] as const) {
    for (const part of chunks(descriptionIds, 200)) {
      const ids = new Set(part);
      const n = list.filter((l) => ids.has(text(l.description_id))).length;
      out.before.push(guard(`(SELECT count(*) FROM ${table} WHERE description_id IN (${idList(part)})) = ${n}`,
        "a description's links have changed since they were read"));
    }
  }
  appendAll(out.before, matchingGuards("description_entities", LINK_READ, state.links.map((l) => LINK_READ.map((c) => l[c])),
    "a link of a description the file names has changed since it was read"));
  appendAll(out.before, matchingGuards("description_places", PLACE_LINK_READ, state.placeLinks.map((l) => PLACE_LINK_READ.map((c) => l[c])),
    "a place link of a description the file names has changed since it was read"));

  // What a rerun found under the file's ids, as read.
  appendAll(out.before, matchingGuards("entities", opts.recordColumns, [...state.found.values()].map((e) => opts.recordColumns.map((c) => e[c])),
    "a record an earlier run of this file made has changed since it was read"));
  appendAll(out.before, matchingGuards("description_entities", LINK_READ, [...state.linksById.values()].map((l) => LINK_READ.map((c) => l[c])),
    "a link an earlier run of this file made has changed since it was read"));
  appendAll(out.before, matchingGuards("description_places", PLACE_LINK_READ, [...state.placeLinksById.values()].map((l) => PLACE_LINK_READ.map((c) => l[c])),
    "a place link an earlier run of this file made has changed since it was read"));
  appendAll(out.before, matchingGuards("changelog", ["id", "record_id"], [...state.journalFound].map(([i, r]) => [i, r]),
    "a changelog row an earlier run of this file wrote has changed since it was read"));

  // What the file writes is still absent.
  const writing = plan.rows.filter((p) => !DONE.includes(p.status));
  const recordIds = writing.filter((p) => p.status === "create").map((p) => [...p.journal.keys()][0]);
  const mintedCodes = recordIds.map((i) => state.minted.get(i)!);
  const linkIds = writing.flatMap((p) => p.links.map((l) => l.id));
  const placeLinkIds = writing.flatMap((p) => (p.placeLink ? [p.placeLink.id] : []));
  const journalIds = writing.flatMap((p) => [...p.journal.values()]);
  for (const [table, column, ids, what] of [
    ["entities", "id", recordIds, "a record id the file makes"],
    ["entities", "entity_code", mintedCodes, "a code minted for a new record"],
    ["description_entities", "id", linkIds, "a link id the file makes"],
    ["description_places", "id", placeLinkIds, "a place link id the file makes"],
    ["changelog", "id", journalIds, "a changelog id the file writes"],
  ] as const) {
    for (const part of chunks([...ids], 200)) out.before.push(guard(`NOT EXISTS (SELECT 1 FROM ${table} WHERE ${column} IN (${idList(part)}))`, `${what} is taken`));
  }
  if (state.prefix && recordIds.length > 0) {
    out.before.push(guard(
      `EXISTS (SELECT 1 FROM ${state.prefix.table} WHERE id = ${escapeSql(state.prefix.id)} AND trim(entity_code_prefix) = ${escapeSql(state.prefix.prefix)})`,
      "the agency's code prefix has changed since the codes were minted",
    ));
  }

  // Writes: records first, since the links name them.
  const journal = (id: string, recordId: string, recordType: string, kind: "create" | "link", diff: unknown, note: string) =>
    render(db.insert(changelog).values({ id, recordId, recordType, userId: opts.userId, note, diff: JSON.stringify(diff), runId: null, kind, createdAt: opts.now, actedAs: opts.actedAs ?? null }));
  const created: unknown[][] = [];
  for (const p of writing.filter((x) => x.status === "create")) {
    const [recordId, journalId] = [...p.journal][0];
    const values: Record<string, unknown> = {
      federationId: opts.federationId, tenantId: opts.owner, id: recordId, entityCode: state.minted.get(recordId)!, ...p.record,
      primaryFunctionId: null, createdAt: opts.now, updatedAt: opts.now,
    };
    out.writes.push(render(db.insert(entities).values(values as never)));
    out.writes.push(journal(journalId, recordId, "entity", "create", createSnapshotDiff(values), p.note));
    created.push([recordId, opts.federationId, opts.owner, values.entityCode, values.displayName, null, values.gender, values.knownOnlyFromRelation ? 1 : 0, values.qualifiedName]);
    out.created++;
  }
  const linked: unknown[][] = [];
  const linkContent = (l: LinkValues) => ({ ...l, createdAt: opts.now });
  for (const p of writing.filter((x) => x.status === "link" || x.status === "relate")) {
    if (p.status === "link") {
      const l = p.links[0];
      out.writes.push(render(db.insert(descriptionEntities).values(linkContent(l) as never)));
      out.linked++;
    } else {
      // Each side names the other: the first is written naming itself,
      // the second naming the first, and the first then the second, so
      // the foreign key holds at every statement.
      const [a, b] = p.links;
      out.writes.push(render(db.insert(descriptionEntities).values({ ...linkContent(a), relatedTo: a.id } as never)));
      out.writes.push(render(db.insert(descriptionEntities).values(linkContent(b) as never)));
      out.writes.push(`UPDATE description_entities SET related_to = ${escapeSql(b.id)} WHERE id = ${escapeSql(a.id)} AND related_to = ${escapeSql(a.id)};`);
      out.related++;
    }
    for (const l of p.links) {
      out.writes.push(journal(p.journal.get(l.id)!, l.descriptionId, "description", "link", linkDiff(linkContent(l)), p.note));
      linked.push(LINK_READ.map((c) => ({
        id: l.id, description_id: l.descriptionId, entity_id: l.entityId, role: l.role, role_note: l.roleNote, role_raw: l.roleRaw,
        sequence: l.sequence, honorific: l.honorific, name_as_recorded: l.nameAsRecorded, related_to: l.relatedTo,
        relation_certainty: l.relationCertainty, attributes: l.attributes,
      } as Record<string, unknown>)[c]));
    }
  }
  const placeLinked: unknown[][] = [];
  for (const p of writing.filter((x) => x.status === "place-link")) {
    const l = p.placeLink!;
    const content = { ...l, createdAt: opts.now };
    out.writes.push(render(db.insert(descriptionPlaces).values(content as never)));
    out.writes.push(journal(p.journal.get(l.id)!, l.descriptionId, "description", "link", linkDiff(content), p.note));
    placeLinked.push([l.id, l.descriptionId, l.placeId, l.role, l.roleNote, null]);
    out.placeLinked++;
  }

  // Closing guards: what was written holds what was planned.
  appendAll(out.after, matchingGuards("entities",
    ["id", "federation_id", "tenant_id", "entity_code", "display_name", "merged_into", "gender", "known_only_from_relation", "qualified_name"],
    created, "a record the file makes is not as planned"));
  appendAll(out.after, matchingGuards("description_entities", LINK_READ, linked, "a link the file makes is not as planned"));
  appendAll(out.after, matchingGuards("description_places", PLACE_LINK_READ, placeLinked, "a place link the file makes is not as planned"));
  for (const part of chunks(journalIds, 200)) {
    out.after.push(guard(`(SELECT count(*) FROM changelog WHERE id IN (${idList(part)})) = ${part.length}`, "a changelog row the file writes is missing"));
  }
  // Every link written is in a description of the acting tenant: a constant, not a value read.
  appendAll(out.after, tenantLinkGuards("description_entities", linkIds, opts.tenantId));
  appendAll(out.after, tenantLinkGuards("description_places", placeLinkIds, opts.tenantId));
  return out;
}

/** Whether a row is an addition. */
export const isAdditionOp = (op: string): op is Op => (ADDITION_OPS as readonly string[]).includes(op);

// @version v0.9.0
