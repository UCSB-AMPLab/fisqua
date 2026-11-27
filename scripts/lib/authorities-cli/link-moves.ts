/**
 * Scripts — moving, dropping and updating description links in the command line's authority changes
 *
 * This module reads, plans and writes the six operations of a change
 * file (`./change-file.ts`) that move a description's link to another
 * record, remove it or change it: `move-place-link` and
 * `drop-place-link` for a place link (`description_places`),
 * `move-link`, `drop-link` and `update-link` for an entity link
 * (`description_entities`), and `drop-relation` for the two links of a
 * relation. `./plan.ts` calls it after the
 * other rows, since a move's target may be a record the file creates;
 * `./statements.ts` places its statements after the creates.
 *
 * A row names the link by `description_code` (one of the tenant's
 * descriptions), the source record (`authority_code`, with its name in
 * `authority_name`: a place's label, an entity's display name) and the
 * `role`; a move names its target in `target_codes`, an existing code
 * or `new:<key>` of a create-place or create-entity row of the file. A
 * source or target is in scope (the federation's, shared or the
 * tenant's own) and not merged away, and named by no merge row of the
 * file. A role must be an approved code of the federation's `place_role`
 * list for a place link, or of its `entity_role` or `relation_role` list
 * for an entity link (`./places.ts`'s `PLACE_LISTS`, read at plan time).
 *
 * The row is refused when the source holds no such link, or more than
 * one (an entity may hold a document link and relation sides in one
 * role); when two rows of the file act on one link, or the link is one
 * another row writes (a merge moves or drops a loser's links and
 * repoints the `related_to` of the links naming one it drops); when a drop names a
 * relation side (a link with `related_to`, or one another link names),
 * since the other side would name a link that is gone; and when the
 * target already holds the same link (the same description and role,
 * and for an entity link the same `related_to`), in D1 or by another row
 * of the file, a move or an addition: the move is refused, not merged.
 * `drop-relation` names no source in `authority_code`; its rows are
 * described below.
 *
 * update-link   changes the link's role (`new_role`, an approved code of
 *               the `entity_role` list) and the fields it gives
 *               (`role_note`, `role_raw`, `honorific`,
 *               `name_as_recorded`, `sequence`, a whole number), each of
 *               which names its stored value in `current_<field>`: blank
 *               or `NULL` for an empty text. The row is refused when a
 *               stated value is not the stored one, when it gives no
 *               field, when the new role is a relation side's (its role
 *               is paired with its partner's), and when the record already
 *               holds the description in the new role, in D1 or by another
 *               row of the file. The role a row names need not still be
 *               approved: it names what is stored. A link that already
 *               holds every value is "same". The fields are checked as the
 *               editor checks them (`descriptionEntitySchema`).
 * drop-relation removes a relation's two sides: `a_entity` and `a_role`
 *               name one side, `b_entity` and `b_role` the other, both
 *               existing records in scope, not merged away and named by
 *               no merge row, both roles approved `relation_role` codes.
 *               The description must hold exactly one such pair, each
 *               naming the other in `related_to`; the row is refused when
 *               it holds none or several, when another link of the
 *               description names either side, or when another row of the
 *               file writes or relies on either.
 *
 * What is written is what the app writes: a move changes the link's
 * `place_id` or `entity_id` and keeps its id and every other column, as
 * a merge moves a link (`composeLinkMoves`), journaled as an `unlink` of
 * the link as read and a `link` of it on its target; a drop deletes the
 * link, journaled as an `unlink` of it; an update changes the fields
 * that differ, its id, record and other columns kept, journaled as an
 * `unlink` of the link as read and a `link` of it as written; a relation
 * drop deletes both sides in one statement (each names the other),
 * journaled as an `unlink` of each. The changelog rows are the
 * description's, with the row's note, as `add-place-link` journals an
 * addition. No record takes a new version: a link is the description's.
 *
 * Rerun. Each changelog row's id is made from the federation, the
 * tenant, the file's name and the row's identity (the operation, the
 * description, the source, the role, and for a move the target and the
 * row kind; for a relation drop, both records, both roles and the side:
 * `newRecordId`). A move is done when the changelog holds both
 * its rows on the description and the link the `unlink` row names is on
 * the target in that role; a drop when the changelog holds its row and
 * no link table holds the link it names, in any description; an update
 * when the changelog holds both its rows, the link their `unlink` row
 * names is on the description under the row's record, it holds every
 * value the row gives, and the `unlink` row records each stated current
 * value and the `link` row each value given; a relation drop when the
 * changelog holds both its rows, neither link they name is in any table,
 * and the description holds no such relation again. A source found holding the link again, or
 * part of a row's changelog rows without the rest, refuses the row. The
 * link again is a link of the source on the description under the same
 * key of the unique index: for an entity link that includes `related_to`,
 * which the `unlink` row records, so a relation side of the same record
 * and role, naming another link, is not the link again.
 *
 * Guards. The SQL file opens with guards that every description named
 * is as read and no other has its code in the tenant; every link of
 * those descriptions, entity and place, holds every column as read and
 * the descriptions hold no other; no link names a link the file drops;
 * no link names either side of a relation the file drops, in any
 * description; every changelog row a rerun found holds its record and diff as read,
 * every link a found drop removed is still in no table, every link the
 * file moves or drops is in a description whose `tenant_id` is the acting
 * tenant's id, a constant in the guard (`tenantLinkGuards` in
 * `./places.ts`), and every changelog id the file writes is still absent. The records the rows name are guarded
 * with the rest (`./statements.ts` and `./places.ts`). It closes with
 * guards that each moved link names its target, each updated link holds
 * the values planned, each dropped link and relation side is gone, and
 * every changelog row is there.
 *
 * @version v0.9.0
 */

import { and, eq } from "drizzle-orm";
import { changelog, descriptionEntities, descriptionPlaces, type ChangelogActedAs } from "../../../app/db/schema";
import { linkDiff, unlinkDiff } from "../../../app/lib/stewardship.server";
import { newRecordId, type RowReader } from "../authority-links";
import { chunks, composer, guard, idList, matchingGuards, render, storedValue, typed } from "../authority-merges";
import { LINK_COLUMNS, junctionRowOf } from "../entity-merges";
import { blank, sameNfc, text } from "../entity-splits";
import { descriptionEntitySchema } from "../../../app/lib/validation/junctions";
import { escapeSql } from "../sql";
import { LINK_MOVE_OPS, LINK_UPDATE_FIELDS, targetCodes, type ChangeRow } from "./change-file";
import { PLACE_LINK_COLUMNS, changedSince, placeVocabularyOf, tenantLinkGuards, type PlaceResolver, type PlacesState, type Stored } from "./places";
import { appendAll } from "../arrays";

export const DESCRIPTION_READ = ["id", "tenant_id", "reference_code"] as const;
export const LINK_MOVE_NAMESPACE = "authorities-link-move-journal";

export type LinkMoveStatus =
  | "move link" | "drop link" | "update link" | "drop relation"
  | "already moved link" | "already dropped link" | "already updated link" | "already dropped relation";

type Kind = "place" | "entity";
const kindOf = (op: string): Kind => (op === "move-place-link" || op === "drop-place-link" ? "place" : "entity");
const isMove = (op: string) => op === "move-place-link" || op === "move-link";
const NEW = "new:";
const where = (r: ChangeRow) => `${r.file} line ${r.line}`;
const stored = (columns: readonly string[]) => (r: Record<string, unknown>): Stored => Object.fromEntries(columns.map((c) => [c, storedValue(r, c)]));
const identity = (...parts: string[]) => JSON.stringify(parts);

// ---------------------------------------------------------------------------
// What is read
// ---------------------------------------------------------------------------

export interface LinkMovesState {
  /** The tenant's descriptions of each code the rows name. */
  descriptions: Map<string, Stored[]>;
  /** Every entity link of those descriptions, as read. */
  entityLinks: Stored[];
  /** Every place link of those descriptions, as read. */
  placeLinks: Stored[];
  /** Identity → the changelog id it makes. */
  journalIds: Map<string, string>;
  /** Of those ids, the rows the changelog holds. */
  journalFound: Map<string, { recordId: string; diff: Record<string, any> | null; raw: string | number | null }>;
  /** The ids of the links those changelog rows name, found in either link table, anywhere. */
  namedLinks: Set<string>;
  /** Of those ids, the ones found in neither table. */
  namedAbsent: string[];
}

/** The ids a row's record and target resolve to before planning, for the changelog ids. */
export interface LinkMoveIds {
  entityId: (code: string) => string;
  entityKeyId: (key: string) => Promise<string>;
  placeId: (code: string) => string;
  placeKeyId: (key: string) => string;
}

/**
 * The changelog identities of a row, from its description, source, role
 * and target: a move's and an update's `unlink` and `link`, a drop's
 * `unlink`.
 */
function identitiesOf(op: string, description: string, source: string, role: string, target: string): string[] {
  if (isMove(op)) return [identity(op, description, source, role, target, "unlink"), identity(op, description, source, role, target, "link")];
  if (op === "update-link") return [identity(op, description, source, role, "unlink"), identity(op, description, source, role, "link")];
  return [identity(op, description, source, role, "unlink")];
}

/** The changelog identities of a `drop-relation` row: the `unlink` of its `a_` side, then of its `b_` side. */
function relationIdentitiesOf(description: string, a: string, aRole: string, b: string, bRole: string): string[] {
  return (["a", "b"] as const).map((side) => identity("drop-relation", description, a, aRole, b, bRole, side));
}

async function readIn(rows: RowReader, ids: string[], query: (part: string) => string): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  for (const part of chunks([...new Set(ids)].filter(Boolean), 100)) appendAll(out, await rows(query(idList(part))));
  return out;
}

/** Reads the descriptions the rows name, all their links, and the changelog rows an earlier run of the file wrote. */
export async function readLinkMovesState(
  rows: RowReader,
  input: { file: string; rows: ChangeRow[] },
  scope: { tenantId: string; federationId: string },
  ids: LinkMoveIds,
): Promise<LinkMovesState> {
  const state: LinkMovesState = {
    descriptions: new Map(), entityLinks: [], placeLinks: [], journalIds: new Map(), journalFound: new Map(), namedLinks: new Set(), namedAbsent: [],
  };
  const moves = input.rows.filter((r) => (LINK_MOVE_OPS as readonly string[]).includes(r.cells.op));
  if (moves.length === 0) return state;
  for (const r of await readIn(rows, moves.map((r) => r.cells.description_code), (p) =>
    `SELECT ${typed(DESCRIPTION_READ)} FROM descriptions WHERE tenant_id = ${escapeSql(scope.tenantId)} AND reference_code IN (${p})`,
  )) {
    const d = stored(DESCRIPTION_READ)(r);
    state.descriptions.set(text(d.reference_code), [...(state.descriptions.get(text(d.reference_code)) ?? []), d]);
  }
  const descriptionIds = [...new Set([...state.descriptions.values()].flat().map((d) => text(d.id)))];
  for (const [table, columns, into] of [
    ["description_entities", LINK_COLUMNS, state.entityLinks],
    ["description_places", PLACE_LINK_COLUMNS, state.placeLinks],
  ] as const) {
    for (const part of chunks(descriptionIds, 100)) {
      let last = "";
      for (;;) {
        const page = await rows(`SELECT ${typed(columns)} FROM ${table} WHERE description_id IN (${idList(part)}) AND id > ${escapeSql(last)} ORDER BY id LIMIT 1000`);
        appendAll(into, page.map(stored(columns)));
        if (page.length < 1000) break;
        last = String(page[page.length - 1].id);
      }
    }
  }
  const make = async (k: string) => {
    if (!state.journalIds.has(k)) state.journalIds.set(k, await newRecordId(scope.federationId, scope.tenantId, input.file, k, LINK_MOVE_NAMESPACE));
  };
  for (const r of moves) {
    const found = state.descriptions.get(r.cells.description_code) ?? [];
    if (found.length !== 1) continue;
    if (r.cells.op === "drop-relation") {
      const a = ids.entityId(r.cells.a_entity);
      const b = ids.entityId(r.cells.b_entity);
      if (!a || !b || r.cells.a_role === "" || r.cells.b_role === "") continue;
      for (const k of relationIdentitiesOf(text(found[0].id), a, r.cells.a_role, b, r.cells.b_role)) await make(k);
      continue;
    }
    if (r.cells.role === "") continue;
    const kind = kindOf(r.cells.op);
    const source = kind === "place" ? ids.placeId(r.cells.authority_code) : ids.entityId(r.cells.authority_code);
    if (!source) continue;
    let target = "";
    if (isMove(r.cells.op)) {
      const t = targetCodes(r);
      if (t.length !== 1) continue;
      target = t[0].startsWith(NEW)
        ? kind === "place" ? ids.placeKeyId(t[0].slice(NEW.length)) : await ids.entityKeyId(t[0].slice(NEW.length))
        : kind === "place" ? ids.placeId(t[0]) : ids.entityId(t[0]);
      if (!target) continue;
    }
    for (const k of identitiesOf(r.cells.op, text(found[0].id), source, r.cells.role, target)) await make(k);
  }
  for (const r of await readIn(rows, [...state.journalIds.values()], (p) => `SELECT id, record_id, ${typed(["diff"])} FROM changelog WHERE id IN (${p})`)) {
    let diff: Record<string, any> | null = null;
    try {
      const d = JSON.parse(String(r.diff));
      diff = d && typeof d === "object" ? d : null;
    } catch {
      diff = null;
    }
    state.journalFound.set(String(r.id), { recordId: String(r.record_id), diff, raw: storedValue(r, "diff") });
  }
  // The links those rows name, wherever they are now: a dropped link is gone only when no table holds it.
  const named = [...new Set([...state.journalFound.values()].map((j) => text(j.diff?.id)).filter(Boolean))];
  for (const table of ["description_entities", "description_places"]) {
    for (const r of await readIn(rows, named, (p) => `SELECT id FROM ${table} WHERE id IN (${p})`)) state.namedLinks.add(String(r.id));
  }
  state.namedAbsent = named.filter((id) => !state.namedLinks.has(id));
  return state;
}

// ---------------------------------------------------------------------------
// The plan
// ---------------------------------------------------------------------------

export interface LinkMovePlan {
  row: ChangeRow;
  kind: Kind;
  status: LinkMoveStatus;
  note: string;
  /** The link as read, by Drizzle key; for a relation drop, its `a_` side. */
  link: Record<string, unknown>;
  /** A relation drop's `b_` side, as read, by Drizzle key. */
  pair?: Record<string, unknown>;
  /** An update's values, by Drizzle key: those that change. */
  set?: Record<string, unknown>;
  sourceId: string;
  /** A move's target; a relation drop's `b_` record. */
  targetId: string | null;
  /** The changelog ids: the unlink, then for a move or an update the link; for a relation drop, the unlink of each side. */
  journalIds: string[];
}

export interface LinkMovesPlan {
  rows: LinkMovePlan[];
}

/** A record a row names, resolved, or the reason it is refused. */
type Resolved = { id: string; label: string } | string;

export interface LinkMovesContext {
  tenantId: string;
  tenantSlug?: string;
  places: PlaceResolver;
  /** An existing entity code, in scope and not merged away, or the reason it is refused. */
  entity: (code: string) => Stored | string;
  /** Whether a name a row gives is the entity's, or the one an update row of the file renamed. */
  entityNameHolds: (e: Stored, name: string) => boolean;
  /** The line of a merge-entity row that names the entity, if any. */
  entityMergedBy: (id: string) => number | undefined;
  /** A `new:<key>` of a create-entity row: the record's id, or the reason it is refused. */
  entityKey: (value: string) => string | { id: string };
  /** The links other rows of the file write (a merge moves, drops or repoints them), with what writes each. */
  writtenLinks: Map<string, string>;
  /** The links the file's additions write: `[kind, description id, record id, role, related_to]`. */
  added: Array<[Kind, string, string, string, string]>;
}

/** An update-link field: its column and its Drizzle key. */
const UPDATE_FIELDS: ReadonlyArray<{ field: (typeof LINK_UPDATE_FIELDS)[number]; key: string }> = [
  { field: "role_note", key: "roleNote" }, { field: "role_raw", key: "roleRaw" }, { field: "honorific", key: "honorific" },
  { field: "name_as_recorded", key: "nameAsRecorded" }, { field: "sequence", key: "sequence" },
];
const nfc = (v: string) => v.normalize("NFC").trim();
const STYLING_CHECK = descriptionEntitySchema.pick({ honorific: true, nameAsRecorded: true });

/** Whether a stored link value is the value an update gives: a text by NFC (null for an empty one), the sequence as a number. */
function holdsValue(field: string, stored: unknown, value: string | number | null): boolean {
  if (field === "sequence") return typeof stored === "number" && stored === value;
  return value === null ? blank(stored) : !blank(stored) && sameNfc(stored, value);
}

/** Whether a stored link value is the one a `current_<field>` names: blank or `NULL` for an empty text, digits for the sequence. */
function holdsCurrent(field: string, stored: unknown, current: string): boolean {
  if (field === "sequence") return /^\d+$/.test(current) && typeof stored === "number" && stored === Number(current);
  return current === "" || current === "NULL" ? blank(stored) : !blank(stored) && sameNfc(stored, current);
}

/** Checks the link move, drop and update rows against what was read and plans each. */
export function planLinkMoves(
  input: { file: string; rows: ChangeRow[] },
  state: LinkMovesState,
  placesState: PlacesState,
  ctx: LinkMovesContext,
  refuse: (where: string, reason: string) => void,
): { plan: LinkMovesPlan; statuses: Map<ChangeRow, LinkMoveStatus | "same" | "refused"> } {
  const statuses = new Map<ChangeRow, LinkMoveStatus | "same" | "refused">();
  const plan: LinkMovesPlan = { rows: [] };
  const vocabulary = placeVocabularyOf(placesState);
  const reliedOn = new Map<string, number>();
  const arriving = new Map<string, number>();
  for (const [kind, d, record, role, related] of ctx.added) arriving.set(JSON.stringify([kind, d, record, role, related]), 0);

  for (const r of input.rows) {
    if (!(LINK_MOVE_OPS as readonly string[]).includes(r.cells.op)) continue;
    statuses.set(r, "refused");
    const c = r.cells;
    const no = (reason: string) => refuse(where(r), reason);
    const kind = kindOf(c.op);
    const move = isMove(c.op);
    const update = c.op === "update-link";
    if (c.description_code === "") { no(`${c.op} names no description_code`); continue; }
    if (c.op === "drop-relation") {
      if (c.a_role === "" || c.b_role === "") { no("drop-relation names both a_role and b_role"); continue; }
    } else if (c.role === "") { no(`${c.op} names no role`); continue; }
    const found = state.descriptions.get(c.description_code) ?? [];
    if (found.length !== 1) {
      no(found.length === 0 ? `no description has the code ${c.description_code} in ${ctx.tenantSlug ?? ctx.tenantId}` : `${found.length} descriptions have the code ${c.description_code}`);
      continue;
    }
    const d = text(found[0].id);
    const note = c.changelog_note || `Authorities change file ${r.file}, line ${r.line}`;
    const merged = (id: string, code: string) => {
      const line = kind === "place" ? ctx.places.mergedBy(id) : ctx.entityMergedBy(id);
      return line === undefined ? null : `${code} is merged by line ${line}, so no other row may name it`;
    };
    const links = kind === "place" ? state.placeLinks : state.entityLinks;
    const onDescription = links.filter((l) => text(l.description_id) === d);

    if (c.op === "drop-relation") {
      // Both records exist, in scope, not merged away and named by no merge row; both roles are relation roles.
      const sides: Array<{ id: string; code: string }> = [];
      for (const column of ["a_entity", "b_entity"] as const) {
        const code = c[column];
        if (code === "") { no(`drop-relation names no ${column}`); break; }
        if (code.startsWith(NEW)) { no(`${column} ${code}: drop-relation names records that exist`); break; }
        const e = ctx.entity(code);
        if (typeof e === "string") { no(e); break; }
        const m = merged(text(e.id), code);
        if (m) { no(m); break; }
        sides.push({ id: text(e.id), code });
      }
      if (sides.length !== 2) continue;
      const [a, b] = sides;
      if (a.id === b.id) { no(`a_entity and b_entity are both ${c.a_entity}`); continue; }
      const bad = [c.a_role, c.b_role].find((role) => !vocabulary.get("relation_role")!.has(role));
      if (bad !== undefined) { no(`role ${JSON.stringify(bad)} is not in the federation's relation_role list`); continue; }
      // The relation: a's link in a_role naming b's link in b_role, which names it back.
      const byId = new Map(onDescription.map((l) => [text(l.id), l]));
      const pairs = onDescription.flatMap((x) => {
        if (text(x.entity_id) !== a.id || text(x.role) !== c.a_role || blank(x.related_to)) return [];
        const y = byId.get(text(x.related_to));
        return y && text(y.entity_id) === b.id && text(y.role) === c.b_role && text(y.related_to) === text(x.id) ? [[x, y] as const] : [];
      });
      const journalIds = relationIdentitiesOf(d, a.id, c.a_role, b.id, c.b_role).map((k) => state.journalIds.get(k) ?? "");
      const journaled = journalIds.map((id) => state.journalFound.get(id));
      const what = `${c.a_entity} (${c.a_role}) and ${c.b_entity} (${c.b_role})`;
      if (journaled.some(Boolean)) {
        if (!journaled.every((j) => j && j.recordId === d)) { no(changedSince(r, "part of its effect is present: part of this row's changelog rows is in D1, and part is not")); continue; }
        const ids = journaled.map((j) => text(j!.diff?.id));
        if (pairs.length > 0) {
          no(`the changelog of this file records the removal of the relation between ${what} (links ${ids.join(", ")}), and ${c.description_code} holds it again`);
          continue;
        }
        if (ids.some((id) => id === "" || state.namedLinks.has(id))) {
          no(`the changelog of this file records the removal of links ${ids.join(", ")}, and one is still there`);
          continue;
        }
        statuses.set(r, "already dropped relation");
        continue;
      }
      if (pairs.length === 0) { no(`${c.description_code} holds no relation between ${what}`); continue; }
      if (pairs.length > 1) {
        no(`${c.description_code} holds ${pairs.length} relations between ${what} (${pairs.map(([x, y]) => `${text(x.id)} and ${text(y.id)}`).join("; ")}); the row names one`);
        continue;
      }
      const [x, y] = pairs[0];
      const sideIds = [text(x.id), text(y.id)];
      const taken = sideIds.map((id) => [id, ctx.writtenLinks.get(id) ?? (reliedOn.has(id) ? `line ${reliedOn.get(id)}` : undefined)] as const)
        .find(([, by]) => by !== undefined);
      if (taken) { no(`link ${taken[0]} is written by ${taken[1]}; a link row may name only a link no other row of the file writes`); continue; }
      const naming = onDescription.find((l) => sideIds.includes(text(l.related_to)) && !sideIds.includes(text(l.id)));
      if (naming) { no(`link ${text(naming.id)} names a side of the relation, which would name a link that is gone`); continue; }
      for (const id of sideIds) reliedOn.set(id, r.line);
      statuses.set(r, "drop relation");
      plan.rows.push({
        row: r, kind, status: "drop relation", note, link: junctionRowOf((col) => x[col]), pair: junctionRowOf((col) => y[col]),
        sourceId: a.id, targetId: b.id, journalIds,
      });
      continue;
    }

    // A role identifies the link; an update's old role need not still be approved, since it only names what is stored.
    if (!update && (kind === "place" ? !vocabulary.get("place_role")!.has(c.role) : !vocabulary.get("entity_role")!.has(c.role) && !vocabulary.get("relation_role")!.has(c.role))) {
      no(`role ${JSON.stringify(c.role)} is not in the federation's ${kind === "place" ? "place_role" : "entity_role or relation_role"} list`);
      continue;
    }

    // The source.
    const resolve = (code: string, what: string): Resolved => {
      if (code.startsWith(NEW)) {
        const k = kind === "place" ? ctx.places.key(code) : ctx.entityKey(code);
        if (typeof k === "string") return k;
        return { id: k.id, label: code };
      }
      const x = kind === "place" ? ctx.places.resolve(code, what) : ctx.entity(code);
      if (typeof x === "string") return x;
      return merged(text(x.id), code) ?? { id: text(x.id), label: code };
    };
    const s = kind === "place" ? ctx.places.resolve(c.authority_code, "") : ctx.entity(c.authority_code);
    if (typeof s === "string") { no(s); continue; }
    const holds = kind === "place" ? ctx.places.nameHolds(s, c.authority_name) : ctx.entityNameHolds(s, c.authority_name);
    if (!holds) {
      no(`authority_name ${JSON.stringify(c.authority_name)} is not the stored ${kind === "place" ? "label" : "name"} ${JSON.stringify(text(kind === "place" ? s.label : s.display_name))}`);
      continue;
    }
    const sourceId = text(s.id);
    const sourceMerged = merged(sourceId, c.authority_code);
    if (sourceMerged) { no(sourceMerged); continue; }

    // The target.
    let targetId: string | null = null;
    if (move) {
      const codes = targetCodes(r);
      if (codes.length !== 1) { no(`${c.op} names exactly one target code`); continue; }
      if (codes[0] === c.authority_code) { no(`target ${codes[0]} is the row's own record`); continue; }
      const t = resolve(codes[0], "the target ");
      if (typeof t === "string") { no(t); continue; }
      if (t.id === sourceId) { no(`target ${codes[0]} is the row's own record`); continue; }
      targetId = t.id;
    }

    // An update's values: blank leaves a field, NULL clears a text; each field given names its stored value.
    const given: Array<{ field: string; key: string; value: string | number | null; current: string }> = [];
    let newRole = "";
    if (update) {
      newRole = c.new_role === c.role ? "" : c.new_role;
      if (c.new_role === "NULL") { no("new_role cannot be NULL"); continue; }
      let problem = "";
      for (const { field, key } of UPDATE_FIELDS) {
        const v = c[field];
        if (v === "") {
          if (c[`current_${field}`] !== "") { problem = `current_${field} is given and ${field} is not`; break; }
          continue;
        }
        if (field === "sequence") {
          // The editor's range, within the safe integers, so the SQL file writes it as an INTEGER.
          if (!/^\d+$/.test(v) || !Number.isSafeInteger(Number(v))) { problem = `sequence ${JSON.stringify(v)} is not a whole number from 0 to ${Number.MAX_SAFE_INTEGER}`; break; }
          given.push({ field, key, value: Number(v), current: c[`current_${field}`] });
        } else {
          given.push({ field, key, value: v === "NULL" ? null : nfc(v), current: c[`current_${field}`] });
        }
      }
      if (problem) { no(problem); continue; }
      const styling = STYLING_CHECK.safeParse({
        honorific: given.find((g) => g.key === "honorific")?.value ?? undefined,
        nameAsRecorded: given.find((g) => g.key === "nameAsRecorded")?.value ?? undefined,
      });
      if (!styling.success) { no(styling.error.issues.map((i) => `${i.path[0] === "nameAsRecorded" ? "name_as_recorded" : "honorific"}: ${i.message}`).join("; ")); continue; }
      if (newRole !== "" && !vocabulary.get("entity_role")!.has(newRole)) { no(`new_role ${JSON.stringify(newRole)} is not in the federation's entity_role list`); continue; }
      if (given.length === 0 && c.new_role === "") { no("update-link gives no field to change"); continue; }
    }
    /** Whether a link holds every value the update gives, in the role it leaves the link in. */
    const holdsUpdate = (l: Stored) => text(l.role) === (newRole || c.role) && given.every((g) => holdsValue(g.field, l[g.field], g.value));

    // The link, and the evidence of an earlier run.
    const pointer = kind === "place" ? "place_id" : "entity_id";
    const candidates = onDescription.filter((l) => text(l[pointer]) === sourceId && text(l.role) === c.role);
    const journalIds = identitiesOf(c.op, d, sourceId, c.role, targetId ?? "").map((k) => state.journalIds.get(k) ?? "");
    const journaled = journalIds.map((id) => state.journalFound.get(id));
    if (journaled.some(Boolean)) {
      if (!journaled.every((j) => j && j.recordId === d)) { no(changedSince(r, "part of its effect is present: part of this row's changelog rows is in D1, and part is not")); continue; }
      const linkId = text(journaled[0]!.diff?.id);
      const there = onDescription.find((l) => text(l.id) === linkId);
      if (update) {
        // Done when the link holds what the row gives, and the changelog rows record it as read (each
        // stated current value) and as written (each value the row gives).
        if (!there || text(there.entity_id) !== sourceId) { no(`the changelog of this file records an update of link ${linkId}, which ${c.authority_code} does not hold on ${c.description_code}`); continue; }
        if (!holdsUpdate(there)) {
          no(changedSince(r, `part of its effect is present: the changelog of this file records an update of link ${linkId}, and the row would write more`));
          continue;
        }
        const before = journaled[0]!.diff ?? {};
        const after = journaled[1]!.diff ?? {};
        const stale = given.find((g) => !holdsCurrent(g.field, before[g.key], g.current) || !holdsValue(g.field, after[g.key], g.value))?.field ??
          (text(before.role) !== c.role || text(after.role) !== (newRole || c.role) ? "role" : undefined);
        if (stale) { no(`the changelog of this file for link ${linkId} does not record ${stale} as the row gives it: no evidence the row was applied as it stands`); continue; }
        statuses.set(r, "already updated link");
        continue;
      }
      // The link again is a link under its key in the unique index: for an
      // entity link that takes the link it named, read from the `unlink`
      // row, since a dropped link has no row of its own to read. A
      // relation side of the same record and role names another link and
      // is not the link again.
      const namedThen = kind === "entity" ? text(journaled[0]!.diff?.relatedTo) : "";
      const again = candidates.filter((l) => text(l.id) !== linkId && (kind === "place" || text(l.related_to) === namedThen));
      if (again.length > 0 || (there && text(there[pointer]) === sourceId)) {
        no(`the changelog of this file records the ${move ? "move" : "removal"} of link ${linkId}, and ${c.authority_code} holds a link to ${c.description_code} as ${c.role} again`);
        continue;
      }
      if (move) {
        if (!there || text(there[pointer]) !== targetId || text(there.role) !== c.role) {
          no(`the changelog of this file records the move of link ${linkId}, which is not on its target as ${c.role}`);
          continue;
        }
        statuses.set(r, "already moved link");
      } else {
        if (there || state.namedLinks.has(linkId)) { no(`the changelog of this file records the removal of link ${linkId}, which is still there`); continue; }
        statuses.set(r, "already dropped link");
      }
      continue;
    }
    if (candidates.length === 0) { no(`${c.authority_code} holds no link to ${c.description_code} as ${c.role}`); continue; }
    if (candidates.length > 1) {
      no(`${c.authority_code} holds ${candidates.length} links to ${c.description_code} as ${c.role} (${candidates.map((l) => text(l.id)).join(", ")}); the row names one`);
      continue;
    }
    const l = candidates[0];
    const linkId = text(l.id);
    const written = ctx.writtenLinks.get(linkId);
    if (written) { no(`link ${linkId} is written by ${written}; a link row may name only a link no other row of the file writes`); continue; }
    const taken = reliedOn.get(linkId);
    if (taken !== undefined) { no(`link ${linkId} is relied on by line ${taken}`); continue; }
    const related = kind === "entity" ? text(l.related_to) : "";
    const side = kind === "entity" && (related !== "" || onDescription.some((x) => text(x.related_to) === linkId));
    if (!move && !update && side) {
      no(`link ${linkId} is a side of a relation; drop-link removes document links, and drop-relation removes a relation`);
      continue;
    }

    if (update) {
      if (newRole !== "" && side) { no(`link ${linkId} is a side of a relation, whose role is paired with its partner's; update-link does not change it`); continue; }
      const wrong = given.find((g) => !holdsCurrent(g.field, l[g.field], g.current));
      if (wrong) { no(`current_${wrong.field} ${JSON.stringify(wrong.current)} is not the stored ${JSON.stringify(text(l[wrong.field]))}`); continue; }
      if (newRole !== "") {
        const held = onDescription.find((x) => text(x.entity_id) === sourceId && text(x.role) === newRole && text(x.related_to) === related);
        if (held) { no(`${c.authority_code} already holds ${c.description_code} as ${newRole} (link ${text(held.id)}); the update is refused, not merged`); continue; }
        const key = JSON.stringify([kind, d, sourceId, newRole, related]);
        const other = arriving.get(key);
        if (other !== undefined) {
          no(other === 0 ? `an addition of the file gives ${c.authority_code} the same link` : `line ${other} gives ${c.authority_code} the same link`);
          continue;
        }
        arriving.set(key, r.line);
      }
      reliedOn.set(linkId, r.line);
      const set: Record<string, unknown> = {};
      if (newRole !== "") set.role = newRole;
      for (const g of given) if (!holdsValue(g.field, l[g.field], g.value)) set[g.key] = g.value;
      // Held already, with no changelog row of this file: nothing to write and no evidence needed.
      if (Object.keys(set).length === 0) { statuses.set(r, "same"); continue; }
      statuses.set(r, "update link");
      plan.rows.push({ row: r, kind, status: "update link", note, link: junctionRowOf((col) => l[col]), set, sourceId, targetId: null, journalIds });
      continue;
    }

    if (move) {
      const held = onDescription.find((x) => text(x[pointer]) === targetId && text(x.role) === c.role && (kind === "place" || text(x.related_to) === related));
      if (held) { no(`${targetCodes(r)[0]} already holds ${c.description_code} as ${c.role} (link ${text(held.id)}); the move is refused, not merged`); continue; }
      const key = JSON.stringify([kind, d, targetId, c.role, related]);
      const other = arriving.get(key);
      if (other !== undefined) {
        no(other === 0 ? `an addition of the file gives ${targetCodes(r)[0]} the same link` : `line ${other} gives ${targetCodes(r)[0]} the same link`);
        continue;
      }
      arriving.set(key, r.line);
    }
    reliedOn.set(linkId, r.line);
    const link = kind === "place"
      ? { id: linkId, descriptionId: d, placeId: sourceId, role: l.role, roleNote: l.role_note, roleRaw: l.role_raw, createdAt: l.created_at }
      : junctionRowOf((col) => l[col]);
    statuses.set(r, move ? "move link" : "drop link");
    plan.rows.push({ row: r, kind, status: move ? "move link" : "drop link", note, link, sourceId, targetId, journalIds });
  }
  return { plan, statuses };
}

// ---------------------------------------------------------------------------
// The statements
// ---------------------------------------------------------------------------

export interface LinkMovesBuild {
  before: string[];
  writes: string[];
  after: string[];
  moved: number;
  dropped: number;
  /** Links an update-link row changes, and relations a drop-relation row removes. */
  updated: number;
  relationsDropped: number;
}

/** The guards, writes and closing guards of the link moves. */
export function buildLinkMoveStatements(
  plan: LinkMovesPlan,
  state: LinkMovesState,
  opts: { userId: string; now: number; tenantId: string; actedAs?: ChangelogActedAs | null },
): LinkMovesBuild {
  const db = composer();
  const out: LinkMovesBuild = { before: [], writes: [], after: [], moved: 0, dropped: 0, updated: 0, relationsDropped: 0 };
  if (state.descriptions.size === 0) return out;
  const T = escapeSql(opts.tenantId);

  // Opening guards: the descriptions, their links and the changelog rows read.
  for (const part of chunks([...state.descriptions.keys()], 200)) {
    const n = part.reduce((sum, code) => sum + state.descriptions.get(code)!.length, 0);
    out.before.push(guard(`(SELECT count(*) FROM descriptions WHERE tenant_id = ${T} AND reference_code IN (${idList(part)})) = ${n}`,
      "the descriptions of the file's codes have changed since they were read"));
  }
  const descriptions = [...state.descriptions.values()].flat();
  appendAll(out.before, matchingGuards("descriptions", DESCRIPTION_READ, descriptions.map((d) => DESCRIPTION_READ.map((c) => d[c])),
    "a description the file names has changed since it was read"));
  const descriptionIds = [...new Set(descriptions.map((d) => text(d.id)))];
  for (const [table, list] of [["description_entities", state.entityLinks], ["description_places", state.placeLinks]] as const) {
    for (const part of chunks(descriptionIds, 200)) {
      const ids = new Set(part);
      const n = list.filter((l) => ids.has(text(l.description_id))).length;
      out.before.push(guard(`(SELECT count(*) FROM ${table} WHERE description_id IN (${idList(part)})) = ${n}`, "a description's links have changed since they were read"));
    }
  }
  appendAll(out.before, matchingGuards("description_entities", LINK_COLUMNS, state.entityLinks.map((l) => LINK_COLUMNS.map((c) => l[c])),
    "a link of a description the file names has changed since it was read"));
  appendAll(out.before, matchingGuards("description_places", PLACE_LINK_COLUMNS, state.placeLinks.map((l) => PLACE_LINK_COLUMNS.map((c) => l[c])),
    "a place link of a description the file names has changed since it was read"));
  appendAll(out.before, matchingGuards("changelog", ["id", "record_id", "diff"], [...state.journalFound].map(([i, r]) => [i, r.recordId, r.raw]),
    "a changelog row an earlier run of this file wrote has changed since it was read"));
  // The links those rows name: the ones found, as found (their content is guarded with their description's, or
  // they refused the row), and the ones gone, still gone.
  for (const part of chunks(state.namedAbsent, 200)) {
    for (const table of ["description_entities", "description_places"]) {
      out.before.push(guard(`NOT EXISTS (SELECT 1 FROM ${table} WHERE id IN (${idList(part)}))`, "a link an earlier run of this file removed is there again"));
    }
  }
  const journals = plan.rows.flatMap((p) => p.journalIds);
  for (const part of chunks(journals, 200)) out.before.push(guard(`NOT EXISTS (SELECT 1 FROM changelog WHERE id IN (${idList(part)}))`, "a changelog id the file writes is taken"));
  // Every link the file moves or drops is in a description of the acting tenant: a constant, not a value read.
  for (const kind of ["place", "entity"] as const) {
    appendAll(out.before, tenantLinkGuards(kind === "place" ? "description_places" : "description_entities",
      plan.rows.filter((p) => p.kind === kind).flatMap((p) => [String(p.link.id), ...(p.pair ? [String(p.pair.id)] : [])]), opts.tenantId));
  }
  const droppedEntityLinks = plan.rows.filter((p) => p.status === "drop link" && p.kind === "entity").map((p) => String(p.link.id));
  for (const part of chunks(droppedEntityLinks, 200)) {
    out.before.push(guard(`NOT EXISTS (SELECT 1 FROM description_entities WHERE related_to IN (${idList(part)}))`, "a link names a link the file drops"));
  }
  // A relation's two sides name each other and nothing else names them, in any description.
  for (const p of plan.rows.filter((x) => x.status === "drop relation")) {
    const sides = idList([String(p.link.id), String(p.pair!.id)]);
    out.before.push(guard(`NOT EXISTS (SELECT 1 FROM description_entities WHERE related_to IN (${sides}) AND id NOT IN (${sides}))`,
      "a link names a side of a relation the file drops"));
  }

  // Writes, in file order.
  const journal = (id: string, descriptionId: string, kind: "link" | "unlink", diff: unknown, note: string) =>
    render(db.insert(changelog).values({ id, recordId: descriptionId, recordType: "description", userId: opts.userId, note, diff: JSON.stringify(diff), runId: null, kind, createdAt: opts.now, actedAs: opts.actedAs ?? null }));
  const moved: unknown[][] = [];
  const dropped: Array<[string, Kind]> = [];
  const updated: unknown[][] = [];
  for (const p of plan.rows) {
    const id = String(p.link.id);
    const descriptionId = String(p.link.descriptionId);
    if (p.status === "update link") {
      // The link keeps its id, description, record and every column the row does not give.
      out.writes.push(render(db.update(descriptionEntities).set(p.set as never)
        .where(and(eq(descriptionEntities.id, id), eq(descriptionEntities.entityId, p.sourceId), eq(descriptionEntities.role, String(p.link.role) as never)))));
      const after = { ...p.link, ...p.set };
      out.writes.push(journal(p.journalIds[0], descriptionId, "unlink", unlinkDiff(p.link), p.note));
      out.writes.push(journal(p.journalIds[1], descriptionId, "link", linkDiff(after), p.note));
      updated.push([id, p.sourceId, after.role, after.roleNote, after.roleRaw, after.honorific, after.nameAsRecorded, after.sequence]);
      out.updated++;
      continue;
    }
    if (p.status === "drop relation") {
      // Both sides in one statement: each names the other, so neither may go first.
      const pair = p.pair!;
      out.writes.push(
        `DELETE FROM description_entities WHERE (id = ${escapeSql(id)} AND entity_id = ${escapeSql(p.sourceId)}) ` +
          `OR (id = ${escapeSql(String(pair.id))} AND entity_id = ${escapeSql(p.targetId!)});`,
      );
      out.writes.push(journal(p.journalIds[0], descriptionId, "unlink", unlinkDiff(p.link), p.note));
      out.writes.push(journal(p.journalIds[1], descriptionId, "unlink", unlinkDiff(pair), p.note));
      dropped.push([id, "entity"], [String(pair.id), "entity"]);
      out.relationsDropped++;
      continue;
    }
    if (p.status === "move link") {
      if (p.kind === "place") {
        out.writes.push(render(db.update(descriptionPlaces).set({ placeId: p.targetId! })
          .where(and(eq(descriptionPlaces.id, id), eq(descriptionPlaces.placeId, p.sourceId)))));
      } else {
        out.writes.push(render(db.update(descriptionEntities).set({ entityId: p.targetId! })
          .where(and(eq(descriptionEntities.id, id), eq(descriptionEntities.entityId, p.sourceId)))));
      }
      out.writes.push(journal(p.journalIds[0], descriptionId, "unlink", unlinkDiff(p.link), p.note));
      out.writes.push(journal(p.journalIds[1], descriptionId, "link", linkDiff({ ...p.link, [p.kind === "place" ? "placeId" : "entityId"]: p.targetId }), p.note));
      moved.push([id, p.targetId, p.kind]);
      out.moved++;
    } else {
      if (p.kind === "place") {
        out.writes.push(render(db.delete(descriptionPlaces).where(and(eq(descriptionPlaces.id, id), eq(descriptionPlaces.placeId, p.sourceId)))));
      } else {
        out.writes.push(render(db.delete(descriptionEntities).where(and(eq(descriptionEntities.id, id), eq(descriptionEntities.entityId, p.sourceId)))));
      }
      out.writes.push(journal(p.journalIds[0], descriptionId, "unlink", unlinkDiff(p.link), p.note));
      dropped.push([id, p.kind]);
      out.dropped++;
    }
  }

  // Closing guards.
  appendAll(out.after, matchingGuards("description_places", ["id", "place_id"], moved.filter((m) => m[2] === "place").map((m) => [m[0], m[1]]),
    "a moved place link does not name its target"));
  appendAll(out.after, matchingGuards("description_entities", ["id", "entity_id"], moved.filter((m) => m[2] === "entity").map((m) => [m[0], m[1]]),
    "a moved link does not name its target"));
  appendAll(out.after, matchingGuards("description_entities", ["id", "entity_id", "role", "role_note", "role_raw", "honorific", "name_as_recorded", "sequence"], updated,
    "an updated link does not hold the values planned"));
  for (const [table, kind] of [["description_places", "place"], ["description_entities", "entity"]] as const) {
    for (const part of chunks(dropped.filter((x) => x[1] === kind).map((x) => x[0]), 200)) {
      out.after.push(guard(`(SELECT count(*) FROM ${table} WHERE id IN (${idList(part)})) = 0`, "a dropped link is still there"));
    }
  }
  for (const part of chunks(journals, 200)) {
    out.after.push(guard(`(SELECT count(*) FROM changelog WHERE id IN (${idList(part)})) = ${part.length}`, "a changelog row the file writes is missing"));
  }
  return out;
}

/** Whether a row is a link move or drop. */
export const isLinkMoveOp = (op: string) => (LINK_MOVE_OPS as readonly string[]).includes(op);

// @version v0.9.0
