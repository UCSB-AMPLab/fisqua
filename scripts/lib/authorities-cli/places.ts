/**
 * Scripts — the place operations of the command line's authority changes
 *
 * This module reads, plans and writes the three operations of a change
 * file (`./change-file.ts`) that act on place records: `create-place`,
 * `update-place` and `merge-place`. `./plan.ts` calls it for those rows,
 * `./link-moves.ts` resolves the places its rows name through it, and
 * `./statements.ts` places its statements in the one SQL file. The
 * engine's guarantees hold for these rows as for every other: every row
 * read is guarded as read, the file is applied as one unit, and a second
 * plan after the write must find nothing to write.
 *
 * A place row names the place it acts on by `authority_code` (its code)
 * and `authority_name` (its stored `label`, compared after NFC and
 * trimming). A place is in scope when it is the federation's, shared or
 * the tenant's own, and not merged away. Fisqua names no place type or
 * role here: a `place_type` must be an approved code of the federation's
 * `place_type` list, read at plan time, and one the place editor accepts
 * (`PLACE_TYPES`); the lists read are `PLACE_LISTS`, and
 * `./link-moves.ts` checks roles against them too.
 *
 * The fields. `label` and `display_name` (NFC, trimmed; never NULL),
 * `place_type`, `parent` (an existing place code or `new:<key>`, never
 * the place itself), `latitude` and `longitude` (given together or not
 * at all, numbers in range), `coordinate_precision` (one of
 * `COORDINATE_PRECISIONS`), `tgn_id`, `hgis_id`, `whg_id`, `fclass`
 * (one of `GEONAMES_FCLASSES`, written only as the file gives it, never
 * derived from the type) and `notes`. Each is checked by the app's place
 * schema (`placeSchema`), as the place editor's create and save check it.
 *
 * create-place  `new_key` names the place for the file's other rows,
 *               which refer to it as `new:<key>` in any order; a key
 *               defined twice, by two create-place rows or by a
 *               create-place and a create-entity row, or a `new:` key no
 *               create-place row defines, is refused. The record has
 *               the columns the place editor's create writes, variants
 *               from `name_variants_add`, the owner `resolveMintOwner`
 *               gives (as the CLI's `create-entity`: NULL where the
 *               federation shares its authorities, which needs a
 *               steward), a code minted by the app's `generateUniqueCode`
 *               under `resolveAuthorityCodePrefix`'s place prefix and
 *               found free in D1, and a `create` changelog row with the
 *               record's columns (`createSnapshotDiff`).
 * update-place  blank leaves a field, `NULL` clears it (refused on
 *               `label` and `display_name`); latitude and longitude are
 *               set or cleared together; `name_variants_remove` takes
 *               variants off (each must be held) and `name_variants_add`
 *               adds them. Every field given names its stored value in
 *               `current_<field>`, `label` in `authority_name`; a row
 *               that changes nothing is refused. The fields that change
 *               are written with `nextVersion` of the version read and
 *               one `update` changelog row of them. One update row per
 *               place.
 * merge-place   merges the place into its one target as the duplicates
 *               worklist does (`composeLinkMoves` and
 *               `composeMergeStatements` in `app/lib/pair-merge.server.ts`):
 *               the tenant's links move, a link the survivor already
 *               holds in the same description and role is dropped and
 *               kept whole in the ledger's `droppedLinks`, the loser's
 *               name and variants fold into the survivor's (less those
 *               of `name_variants_remove`, each of which some record of
 *               the merge must hold), the loser takes `merged_into`, both
 *               take `nextVersion`, each with its changelog row, and one
 *               `authority_operations` row per pair. The variants the
 *               survivor gains must be those of `name_variants_add`
 *               (across the rows into one survivor). `label_to_keep`
 *               makes the survivor's label and display name (the display
 *               name takes it even when the label already is it); a
 *               changed label's old value joins the variants and the new
 *               one leaves them.
 *               The carried values are the row's `tgn_id`, `hgis_id`,
 *               `whg_id` and the coordinate set (`latitude`, `longitude`
 *               and `coordinate_precision`, blank for none): each must
 *               be the loser's stored value (coordinates to the
 *               decimals the row gives), and is written only into an
 *               empty field of the survivor; a survivor already holding
 *               the same value takes nothing, one holding another value
 *               refuses the row, and so do two rows carrying different
 *               values into one field. Coordinates count as empty only
 *               when latitude, longitude and precision all are. The
 *               survivor's label and carried values are one more update
 *               and changelog row, after its merges.
 *
 * Refused besides: a code not found in the federation, a place owned by
 * another tenant, a place merged away (a merge's loser merged into its
 * target is the rerun below), a target that is the row's own place, a
 * merge with no target or several, a loser named by two merges, a
 * survivor that is also a merge's loser, places in two federations, rows
 * into one survivor naming different labels. A place a `merge-place`
 * row names, as loser or survivor, may be named by no other row of the
 * file but another merge into the same survivor.
 *
 * Rerun. A created place's id is made from the federation, the tenant,
 * the file's name and its `new_key` (`newRecordId`); an update's
 * changelog row from the file's name and the place. A created place is
 * done when D1 holds it under its id with the row's values and its
 * changelog row; an update when the place holds what the row gives and
 * the changelog row of this file records every field the row changes
 * (its value differs from the stated current value) changing from that
 * value to the row's (a restated unchanged field needs only to hold its
 * value, and must not be recorded changing from another; a place that
 * already holds what the row gives without that changelog row is
 * "same", neither done nor pending), every
 * `current_<field>` (and `authority_name`) naming the value the field had
 * before it (every place that changelog row names, a parent before and
 * after, is read so its code resolves); a merge when the loser is merged
 * into the target, holds none of the tenant's links, and the survivor
 * holds `label_to_keep` (label and display name), the variants of
 * `name_variants_add`, none of `name_variants_remove`, and every value
 * carried. A merge ledger row of this file for the pair whose loser is no
 * longer merged into the target (a merge since undone) refuses the row:
 * the file does not merge the pair again. Anything else found under
 * those ids refuses the row.
 *
 * Guards. The SQL file opens with guards that every vocabulary value of
 * the lists read is as read and the lists hold no other; every place
 * read, by code, by id or under a key's id, holds every column read
 * (`PLACE_READ`); every changelog row a rerun relies on holds its record
 * and diff as read; the merge ledger rows of each loser named are as
 * read and no more; every place a merge row names, pending or already
 * merged, holds as many of the tenant's links as read, and every link
 * read of it holds every column as read; every id, code and changelog id
 * the file would write is still absent; and the place code prefix is
 * still the agency's. It closes with guards that each created place, each
 * updated place and each merge holds what was planned.
 *
 * What a merge writes, and the guard that licenses each. A place merge
 * writes exactly: the loser's links of the tenant's descriptions (each
 * moved to the survivor or deleted), the loser's row (`merged_into` and
 * version), the survivor's row (variants, label, display name, carried
 * values, version), and new rows (changelog rows and one ledger row per
 * pair) under ids no row holds. Each link written is guarded positively:
 * it holds its columns as read and it is a link in a description whose
 * `tenant_id` is the acting tenant's id, stated as a constant in the
 * guard (`tenantLinkGuards`), so no read order lets another tenant's link
 * be moved or deleted. The two place rows are guarded on every column as
 * read, and the new rows by their ids being absent. A link of another
 * tenant's description is never written; collisions are found only among
 * the loser's own description and role, which are the tenant's. A link
 * move, drop or update (`./link-moves.ts`) writes one link, and a
 * relation drop its two sides, guarded the same way by the constant
 * tenant guard, and its changelog rows; an entity merge
 * (`merge-entity`, written by `../entity-merges.ts`) is guarded the same
 * way on every link it moves, deletes or repoints (`./statements.ts`).
 * A merge row found already merged writes nothing; its evidence that the
 * loser holds no tenant link is guarded as a constant too: no link of
 * the loser is in a description whose `tenant_id` is the acting
 * tenant's.
 *
 * @version v0.9.0
 */

import { and, eq } from "drizzle-orm";
import { changelog, places, type ChangelogActedAs } from "../../../app/db/schema";
import { generateUniqueCode, resolveAuthorityCodePrefix } from "../../../app/lib/codes.server";
import {
  composeLinkMoves,
  composeMergeStatements,
  heldKey,
  heldLinks,
  parseVariants,
  type AuthorityRecordSnapshot,
  type JunctionRow,
} from "../../../app/lib/pair-merge.server";
import { nextVersion } from "../../../app/lib/record-version.server";
import { composeJournalEntry, createSnapshotDiff } from "../../../app/lib/stewardship.server";
import { COORDINATE_PRECISIONS, GEONAMES_FCLASSES, PLACE_TYPES } from "../../../app/lib/validation/enums";
import { placeSchema } from "../../../app/lib/validation/place";
import { newRecordId, readerDb, type RowReader } from "../authority-links";
import { chunks, composer, guard, idList, inTenantDescriptions, matchingGuards, render, storedValue, typed } from "../authority-merges";
import { blank, sameName, sameNfc, text } from "../entity-splits";
import { escapeSql } from "../sql";
import {
  AuthoritiesStop,
  LINK_MOVE_OPS,
  PLACE_CARRIED,
  PLACE_FIELDS,
  PLACE_OPS,
  targetCodes,
  variantList,
  type ChangeRow,
  type Op,
} from "./change-file";
import { appendAll } from "../arrays";

export type Stored = Record<string, string | number | null>;

/** The vocabulary lists the place rows and the link moves read. */
export const PLACE_LISTS = ["place_type", "place_role", "entity_role", "relation_role"] as const;
export type PlaceList = (typeof PLACE_LISTS)[number];

export const VOCABULARY_READ = ["id", "federation_id", "list", "code", "status", "inverse_code", "updated_at"] as const;

/** Every place column the plan reads, guarded as read. */
export const PLACE_READ = [
  "id", "federation_id", "tenant_id", "place_code", "label", "display_name", "place_type", "name_variants", "parent_id", "latitude",
  "longitude", "coordinate_precision", "merged_into", "tgn_id", "hgis_id", "whg_id", "fclass", "legacy_ids", "notes", "updated_at",
] as const;

/** Every column of a `description_places` row, as the merge journals it. */
export const PLACE_LINK_COLUMNS = ["id", "description_id", "place_id", "role", "role_note", "role_raw", "created_at"] as const;

/** The namespaces of the ids this module makes (`newRecordId`). */
export const PLACE_NAMESPACES = { place: "authorities-place", journal: "authorities-place-journal" } as const;

/** Each place field's Drizzle key and its column. */
export const PLACE_KEY: Record<(typeof PLACE_FIELDS)[number], string> = {
  label: "label", display_name: "displayName", place_type: "placeType", parent: "parentId", latitude: "latitude", longitude: "longitude",
  coordinate_precision: "coordinatePrecision", tgn_id: "tgnId", hgis_id: "hgisId", whg_id: "whgId", fclass: "fclass", notes: "notes",
};
const COLUMN_OF: Record<string, string> = {
  label: "label", displayName: "display_name", placeType: "place_type", parentId: "parent_id", latitude: "latitude", longitude: "longitude",
  coordinatePrecision: "coordinate_precision", tgnId: "tgn_id", hgisId: "hgis_id", whgId: "whg_id", fclass: "fclass", notes: "notes",
  nameVariants: "name_variants",
};
const NOT_NULL = new Set(["label", "display_name"]);
const NEW = "new:";
const nfc = (v: string) => v.normalize("NFC").trim();
const identity = (...parts: string[]) => JSON.stringify(parts);
const placeIdentity = (file: string, key: string) => identity("place", file, key);
const createJournalIdentity = (id: string) => identity("create-place", id);
const updateJournalIdentity = (placeId: string) => identity("update-place", placeId);
const isPlaceRow = (r: ChangeRow) => (PLACE_OPS as readonly string[]).includes(r.cells.op);
const isPlaceLinkRow = (r: ChangeRow) => r.cells.op === "move-place-link" || r.cells.op === "drop-place-link";
const where = (r: ChangeRow) => `${r.file} line ${r.line}`;
const stored = (columns: readonly string[]) => (r: Record<string, unknown>): Stored => Object.fromEntries(columns.map((c) => [c, storedValue(r, c)]));

// ---------------------------------------------------------------------------
// What is read
// ---------------------------------------------------------------------------

export interface PlacesState {
  /** Whether the file holds a place row or a link move, so the vocabulary was read. */
  read: boolean;
  /** Every value of `PLACE_LISTS`, as read. */
  vocabulary: Stored[];
  /** The federation's places of each code the file names. */
  byCode: Map<string, Stored>;
  /** Every place read, by id: by code, the stored parents of updated places, and under a key's id. */
  byId: Map<string, Stored>;
  /** Each create-place key's id. */
  keyIds: Map<string, string>;
  /** Places found under a key's id. */
  found: Map<string, Stored>;
  /** For each key's place still to make: the code minted for it. */
  minted: Map<string, string>;
  /** The agency whose place prefix the codes are minted under. */
  prefix: { table: "federations" | "tenants"; id: string; prefix: string } | null;
  /** Identity → the changelog id it makes. */
  journalIds: Map<string, string>;
  /** Of those ids, the rows the changelog holds: the record each names, its diff parsed, and its diff as stored. */
  journalFound: Map<string, { recordId: string; diff: Record<string, any> | null; raw: string | number | null }>;
  /** The tenant's links of each place a merge names, in full. */
  links: Map<string, JunctionRow[]>;
  /** Every place a merge row names, loser or target, found by code: their links are read and guarded. */
  mergeRead: string[];
  /** The place merge ledger rows whose loser a merge row names, as read (`LEDGER_READ`). */
  ledger: Stored[];
}

/** The columns of a merge ledger row the plan reads and guards. */
export const LEDGER_READ = ["id", "federation_id", "record_type", "operation", "source_id", "target_id", "detail"] as const;

async function readIn(rows: RowReader, ids: string[], query: (part: string) => string): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  for (const part of chunks([...new Set(ids)].filter(Boolean), 100)) appendAll(out, await rows(query(idList(part))));
  return out;
}

/** The refusal of a row whose effect is partly present: the file changed after it was applied. */
export const changedSince = (r: ChangeRow, detail: string) =>
  `line ${r.line} was applied before and has changed since: put new changes in a new file (${detail})`;

/** The file a merge ledger row's detail names (`detailExtra.file`), or ''. */
const ledgerFile = (x: Stored) => {
  try {
    const d = JSON.parse(text(x.detail));
    return d && typeof d === "object" && typeof d.file === "string" ? d.file : "";
  } catch {
    return "";
  }
};

const parseDiff = (v: unknown): Record<string, any> | null => {
  try {
    const d = JSON.parse(String(v));
    return d && typeof d === "object" ? d : null;
  } catch {
    return null;
  }
};

/** A place link row read with `typed(PLACE_LINK_COLUMNS)`, keyed as Drizzle returns it. */
export function placeLinkRowOf(r: Record<string, unknown>): JunctionRow {
  const v = (c: string) => storedValue(r, c);
  return {
    id: String(v("id")), descriptionId: String(v("description_id")), placeId: String(v("place_id")), role: v("role") as string,
    roleNote: v("role_note"), roleRaw: v("role_raw"), createdAt: v("created_at"),
  };
}

/**
 * Reads what the place rows need, and the places the link moves name:
 * the vocabulary, the places by code, the stored parents of the places
 * updated, whatever an earlier run of the file wrote under the ids it
 * makes, the tenant's links of each merged place, and a free code for
 * each place to make.
 */
export async function readPlacesState(
  rows: RowReader,
  input: { file: string; rows: ChangeRow[] },
  scope: { tenantId: string; federationId: string; owner: string | null },
): Promise<PlacesState> {
  const F = scope.federationId;
  const state: PlacesState = {
    read: false, vocabulary: [], byCode: new Map(), byId: new Map(), keyIds: new Map(), found: new Map(), minted: new Map(), prefix: null,
    journalIds: new Map(), journalFound: new Map(), links: new Map(), mergeRead: [], ledger: [],
  };
  const placeRows = input.rows.filter(isPlaceRow);
  const linkRows = input.rows.filter((r) => (LINK_MOVE_OPS as readonly string[]).includes(r.cells.op));
  if (placeRows.length === 0 && linkRows.length === 0) return state;
  state.read = true;
  state.vocabulary = (await rows(
    `SELECT ${typed(VOCABULARY_READ)} FROM vocabulary_values WHERE federation_id = ${escapeSql(F)} AND list IN (${idList([...PLACE_LISTS])}) ORDER BY id`,
  )).map(stored(VOCABULARY_READ));

  const codes = [...placeRows, ...linkRows.filter(isPlaceLinkRow)]
    .flatMap((r) => [r.cells.authority_code, ...targetCodes(r), r.cells.parent])
    .filter((c) => c && c !== "NULL" && !c.startsWith(NEW));
  const keep = (p: Stored) => {
    state.byCode.set(text(p.place_code), p);
    state.byId.set(text(p.id), p);
  };
  for (const r of await readIn(rows, codes, (p) => `SELECT ${typed(PLACE_READ)} FROM places WHERE federation_id = ${escapeSql(F)} AND place_code IN (${p})`)) {
    keep(stored(PLACE_READ)(r));
  }
  // The stored parents of the places an update names, for its current_parent.
  const parents = placeRows.filter((r) => r.cells.op === "update-place").map((r) => text(state.byCode.get(r.cells.authority_code)?.parent_id))
    .filter((id) => id && !state.byId.has(id));
  for (const r of await readIn(rows, parents, (p) => `SELECT ${typed(PLACE_READ)} FROM places WHERE id IN (${p})`)) {
    const p = stored(PLACE_READ)(r);
    state.byId.set(text(p.id), p);
  }

  // The places the keys make, found or still to make, and the changelog rows of creates and updates.
  for (const r of placeRows) {
    if (r.cells.op !== "create-place" || r.cells.new_key === "" || state.keyIds.has(r.cells.new_key)) continue;
    state.keyIds.set(r.cells.new_key, await newRecordId(F, scope.tenantId, r.file, r.cells.new_key, PLACE_NAMESPACES.place));
  }
  for (const r of await readIn(rows, [...state.keyIds.values()], (p) => `SELECT ${typed(PLACE_READ)} FROM places WHERE id IN (${p})`)) {
    const p = stored(PLACE_READ)(r);
    state.found.set(text(p.id), p);
    state.byId.set(text(p.id), p);
  }
  const make = async (k: string) => {
    if (!state.journalIds.has(k)) state.journalIds.set(k, await newRecordId(F, scope.tenantId, input.file, k, PLACE_NAMESPACES.journal));
  };
  for (const id of state.keyIds.values()) await make(createJournalIdentity(id));
  for (const r of placeRows) {
    const p = state.byCode.get(r.cells.authority_code);
    if (r.cells.op === "update-place" && p) await make(updateJournalIdentity(text(p.id)));
  }
  for (const r of await readIn(rows, [...state.journalIds.values()], (p) => `SELECT id, record_id, ${typed(["diff"])} FROM changelog WHERE id IN (${p})`)) {
    state.journalFound.set(String(r.id), { recordId: String(r.record_id), diff: parseDiff(r.diff), raw: storedValue(r, "diff") });
  }
  // Every place those changelog rows name (an update's parent before and after), so the evidence resolves to codes.
  const named = [...state.journalFound.values()].flatMap((j) => [j.diff?.parentId?.old, j.diff?.parentId?.new])
    .filter((v): v is string => typeof v === "string" && v !== "" && !state.byId.has(v));
  for (const r of await readIn(rows, named, (p) => `SELECT ${typed(PLACE_READ)} FROM places WHERE id IN (${p})`)) {
    const p = stored(PLACE_READ)(r);
    state.byId.set(text(p.id), p);
  }

  // The tenant's links of each place a merge names, a page at a time.
  const merged = placeRows.filter((r) => r.cells.op === "merge-place")
    .flatMap((r) => [r.cells.authority_code, ...targetCodes(r)]).map((c) => text(state.byCode.get(c)?.id)).filter(Boolean);
  for (const part of chunks([...new Set(merged)], 100)) {
    let last = "";
    for (;;) {
      const page = await rows(
        `SELECT ${typed(PLACE_LINK_COLUMNS)} FROM description_places WHERE place_id IN (${idList(part)}) ` +
          `AND ${inTenantDescriptions(scope.tenantId)} AND id > ${escapeSql(last)} ORDER BY id LIMIT 1000`,
      );
      for (const r of page) {
        const link = placeLinkRowOf(r);
        state.links.set(String(link.placeId), [...(state.links.get(String(link.placeId)) ?? []), link]);
      }
      if (page.length < 1000) break;
      last = String(page[page.length - 1].id);
    }
  }
  state.mergeRead = [...new Set(merged)];
  // The merge ledger rows of each loser a merge row names: a merge of this file since undone is not made again.
  const mergeLosers = placeRows.filter((r) => r.cells.op === "merge-place").map((r) => text(state.byCode.get(r.cells.authority_code)?.id)).filter(Boolean);
  state.ledger = (await readIn(rows, mergeLosers, (p) =>
    `SELECT ${typed(LEDGER_READ)} FROM authority_operations WHERE record_type = 'place' AND operation = 'merge' AND source_id IN (${p}) ORDER BY id`,
  )).map(stored(LEDGER_READ));

  // A free code for each place still to make, minted by the app's
  // generator under the agency's place prefix, then checked in D1.
  const toMake = [...state.keyIds.values()].filter((id) => !state.found.has(id));
  if (toMake.length > 0) {
    const prefix = await resolveAuthorityCodePrefix(readerDb(rows), "place", F, scope.owner).catch((err: Error) => {
      throw new AuthoritiesStop(err.message);
    });
    state.prefix = { table: scope.owner === null ? "federations" : "tenants", id: scope.owner ?? F, prefix };
    const taken = new Set<string>();
    const local = readerDb(async (sql) => {
      const code = /'([^']*)'/.exec(sql)?.[1] ?? "";
      return taken.has(code) ? [{ id: code }] : [];
    });
    let pending = toMake;
    for (let round = 0; pending.length > 0; round++) {
      if (round === 5) throw new AuthoritiesStop(`No free code under ${prefix} was found for ${pending.length} new places`);
      for (const id of pending) {
        const code = await generateUniqueCode(local, prefix, places, places.placeCode);
        taken.add(code);
        state.minted.set(id, code);
      }
      const inD1 = new Set((await readIn(rows, pending.map((id) => state.minted.get(id)!), (p) =>
        `SELECT place_code FROM places WHERE place_code IN (${p})`,
      )).map((r) => String(r.place_code)));
      pending = pending.filter((id) => inD1.has(state.minted.get(id)!));
    }
  }
  return state;
}

/** The approved codes of each list. */
export function placeVocabularyOf(state: PlacesState): Map<PlaceList, Set<string>> {
  const codes = new Map<PlaceList, Set<string>>(PLACE_LISTS.map((l) => [l, new Set<string>()]));
  for (const v of state.vocabulary) if (text(v.status) === "approved") codes.get(text(v.list) as PlaceList)?.add(text(v.code));
  return codes;
}

// ---------------------------------------------------------------------------
// The plan
// ---------------------------------------------------------------------------

export type PlaceStatus = "create" | "update" | "merge" | "already created" | "already updated" | "already merged" | "same";

export interface PlaceCreate {
  row: ChangeRow;
  id: string;
  journalId: string;
  note: string;
  /** The place's columns by Drizzle key, its code, owner, version and clock stamps aside. */
  record: Record<string, unknown>;
}

export interface PlaceUpdate {
  row: ChangeRow;
  id: string;
  journalId: string;
  note: string;
  set: Record<string, unknown>;
  changes: Record<string, { old: unknown; new: unknown }>;
}

/** A value a merge carries into the survivor. */
export interface Carried {
  field: "tgnId" | "hgisId" | "whgId" | "coordinates";
  /** The value as written: the id, or `lat,lon (precision)`. */
  value: string;
  set: Record<string, unknown>;
  line: number;
}

export interface PlaceMergeGroup {
  survivor: Stored;
  pairs: Array<{ row: ChangeRow; loser: Stored; note: string; carried: Carried[] }>;
  /** Whether a row names `label_to_keep`: the survivor's display name then takes it too. */
  labelGiven: boolean;
  labelNew: string;
  exclude: Set<string>;
  finalVariants: string[];
  carried: Carried[];
}

export interface PlacesPlan {
  creates: PlaceCreate[];
  updates: PlaceUpdate[];
  groups: PlaceMergeGroup[];
  /** The places the file changes (updated, merged and survivors), for the steward check. */
  changed: Stored[];
  /** The losers of merge rows found already merged: the evidence that they hold no tenant link is guarded as a constant. */
  doneLosers: string[];
}

export interface PlacesContext {
  tenantId: string;
  tenantSlug?: string;
  federationId: string;
  /** The keys a create-entity row defines, by key, with its line. */
  entityKeys: Map<string, number>;
}

/** The record of a place a row names, and what the plan has decided about it, for `./link-moves.ts`. */
export interface PlaceResolver {
  /** An existing code: the place, in scope and not merged away, or the reason it is refused. */
  resolve: (code: string, what: string) => Stored | string;
  /** A `new:<key>`: the place's id, or the reason it is refused. */
  key: (value: string) => string | { id: string };
  /** The line of a merge row that names the place, if any. */
  mergedBy: (placeId: string) => number | undefined;
  /** Whether a name a row gives is the place's label, or the label an update row of the file renamed. */
  nameHolds: (p: Stored, name: string) => boolean;
}

const describeCoordinates = (lat: unknown, lon: unknown, precision: unknown) =>
  `${text(lat)},${text(lon)} (${blank(precision) ? "no precision" : text(precision)})`;
const coordinatesEmpty = (p: Stored) => blank(p.latitude) && blank(p.longitude) && blank(p.coordinate_precision);

/** Whether a stored coordinate agrees with the one given, to the decimals given. */
function close(given: string, v: unknown): boolean {
  if (blank(v)) return false;
  const decimals = (given.split(".")[1] ?? "").length;
  return Math.abs(Number(v) - Number(given)) <= 0.5 * 10 ** -decimals + 1e-12;
}

/** Checks the place rows against what was read and plans each. */
export function planPlaces(
  input: { file: string; rows: ChangeRow[] },
  state: PlacesState,
  ctx: PlacesContext,
  refuse: (where: string, reason: string) => void,
): { plan: PlacesPlan; statuses: Map<ChangeRow, PlaceStatus | "refused">; resolver: PlaceResolver } {
  const statuses = new Map<ChangeRow, PlaceStatus | "refused">();
  const plan: PlacesPlan = { creates: [], updates: [], groups: [], changed: [], doneLosers: [] };
  const rowsOf = (op: Op) => input.rows.filter((r) => r.cells.op === op);
  const vocabulary = placeVocabularyOf(state);
  const noteOf = (r: ChangeRow) => r.cells.changelog_note || `Authorities change file ${r.file}, line ${r.line}`;
  const codeOf = (id: string) => text(state.byId.get(id)?.place_code) || id;

  /** An existing code, in scope and not merged away. */
  const resolve = (code: string, what: string): Stored | string => {
    const p = state.byCode.get(code);
    if (!p) return `no place has the code ${code} in the federation`;
    if (text(p.federation_id) !== ctx.federationId) return `${what}${code} is in another federation`;
    if (!blank(p.tenant_id) && text(p.tenant_id) !== ctx.tenantId) return `${what}${code} is owned by another tenant`;
    if (!blank(p.merged_into)) return `${what}${code} is merged into ${text(p.merged_into)}`;
    return p;
  };

  // The update rows by place, for the labels they change.
  const updateOf = new Map<string, ChangeRow>();
  for (const r of rowsOf("update-place")) {
    const p = state.byCode.get(r.cells.authority_code);
    if (p && !updateOf.has(text(p.id))) updateOf.set(text(p.id), r);
  }
  const journalOf = (k: string) => {
    const id = state.journalIds.get(k);
    return id ? state.journalFound.get(id) : undefined;
  };
  const nameHolds = (p: Stored, name: string) => {
    if (sameName(name, text(p.label))) return true;
    const u = updateOf.get(text(p.id));
    const d = u ? journalOf(updateJournalIdentity(text(p.id)))?.diff?.label : undefined;
    return !!u && !!d && sameName(u.cells.authority_name, name) && sameNfc(d.old, name) && sameNfc(d.new, p.label);
  };

  // The places merges name: no other row may name them.
  const mergedBy = new Map<string, number>();
  for (const r of rowsOf("merge-place")) {
    for (const code of [r.cells.authority_code, ...targetCodes(r)]) {
      const p = state.byCode.get(code);
      if (p && !mergedBy.has(text(p.id))) mergedBy.set(text(p.id), r.line);
    }
  }
  const namedByMerge = (p: Stored) => {
    const line = mergedBy.get(text(p.id));
    return line === undefined ? null : `${text(p.place_code)} is merged by line ${line}, so no other row may name it`;
  };

  // The keys.
  const keys = new Map<string, ChangeRow>();
  for (const r of rowsOf("create-place")) {
    statuses.set(r, "refused");
    if (r.cells.new_key === "") { refuse(where(r), "create-place names no new_key"); continue; }
    const first = keys.get(r.cells.new_key);
    if (first) { refuse(where(r), `new_key ${r.cells.new_key} is defined again (line ${first.line})`); continue; }
    const entity = ctx.entityKeys.get(r.cells.new_key);
    if (entity !== undefined) { refuse(where(r), `new_key ${r.cells.new_key} is also defined by the create-entity row of line ${entity}`); continue; }
    keys.set(r.cells.new_key, r);
  }
  const keyState = new Map<string, { id: string; refused: boolean; line: number }>();
  for (const [k, r] of keys) keyState.set(k, { id: state.keyIds.get(k) ?? "", refused: true, line: r.line });
  const keyOf = (value: string): string | { id: string } => {
    const k = keyState.get(value.slice(NEW.length));
    if (!k) return `${value} is not defined by any create-place row of the file`;
    if (k.refused) return `${value} is refused at line ${k.line}`;
    return { id: k.id };
  };

  /**
   * The fields a row gives, by Drizzle key, checked as the place editor
   * checks them; `NULL` gives null. Or the reason they are refused.
   */
  const fieldsOf = (r: ChangeRow, selfId: string | null, creating = false): Record<string, unknown> | string => {
    const c = r.cells;
    const out: Record<string, unknown> = {};
    for (const f of PLACE_FIELDS) {
      const v = c[f];
      if (v === "") continue;
      if (v === "NULL") {
        if (NOT_NULL.has(f)) return `${f} cannot be NULL`;
        out[PLACE_KEY[f]] = null;
      }
    }
    const lat = c.latitude;
    const lon = c.longitude;
    if ((lat === "") !== (lon === "") || (lat === "NULL") !== (lon === "NULL")) return "latitude and longitude are given together or not at all";
    for (const [f, v] of [["latitude", lat], ["longitude", lon]] as const) {
      if (v === "" || v === "NULL") continue;
      const n = Number(v);
      if (!Number.isFinite(n)) return `${f}: ${JSON.stringify(v)} is not a number`;
      out[PLACE_KEY[f]] = n;
    }
    for (const f of ["label", "display_name", "tgn_id", "hgis_id", "whg_id", "notes"] as const) {
      if (c[f] !== "" && c[f] !== "NULL") out[PLACE_KEY[f]] = nfc(c[f]);
    }
    const t = c.place_type;
    if (t !== "" && t !== "NULL") {
      if (!vocabulary.get("place_type")!.has(t)) return `place_type ${JSON.stringify(t)} is not in the federation's place_type list`;
      if (!(PLACE_TYPES as readonly string[]).includes(t)) return `place_type ${JSON.stringify(t)} is not one the place editor accepts`;
      out.placeType = t;
    }
    const precision = c.coordinate_precision;
    if (precision !== "" && precision !== "NULL") {
      if (!(COORDINATE_PRECISIONS as readonly string[]).includes(precision)) {
        return `coordinate_precision ${JSON.stringify(precision)} is not one of ${COORDINATE_PRECISIONS.join(", ")}`;
      }
      out.coordinatePrecision = precision;
    }
    const fclass = c.fclass;
    if (fclass !== "" && fclass !== "NULL") {
      if (!(GEONAMES_FCLASSES as readonly string[]).includes(fclass)) return `fclass ${JSON.stringify(fclass)} is not one of ${GEONAMES_FCLASSES.join(", ")}`;
      out.fclass = fclass;
    }
    const parent = c.parent;
    if (parent !== "" && parent !== "NULL") {
      let id: string;
      if (parent.startsWith(NEW)) {
        // While the creates are planned, a key defined by the file stands;
        // a create whose parent's create is refused is refused after them.
        const defined = keyState.get(parent.slice(NEW.length));
        const k = creating && defined ? { id: defined.id } : keyOf(parent);
        if (typeof k === "string") return k;
        id = k.id;
      } else {
        const p = resolve(parent, "the parent ");
        if (typeof p === "string") return p;
        const merged = namedByMerge(p);
        if (merged) return merged;
        id = text(p.id);
      }
      if (id === selfId) return "a place is not its own parent";
      out.parentId = id;
    }
    // The place schema, on the fields given; the parent is an id the plan resolved.
    const shape = Object.fromEntries(Object.keys(out).filter((k) => k !== "parentId").map((k) => [k, true])) as Record<string, true>;
    const checked = placeSchema.pick(shape as never).safeParse(Object.fromEntries(Object.entries(out).filter(([k]) => k !== "parentId")));
    if (!checked.success) {
      return checked.error.issues.map((i) => `${COLUMN_OF[String(i.path[0])] ?? String(i.path[0])}: ${i.message}`).join("; ");
    }
    return out;
  };

  // create-place
  for (const [k, r] of keys) {
    const c = r.cells;
    const no = (reason: string) => refuse(where(r), reason);
    const id = state.keyIds.get(k)!;
    if (c.label === "" || c.label === "NULL") { no("create-place names no label"); continue; }
    if (c.display_name === "" || c.display_name === "NULL") { no("create-place names no display_name"); continue; }
    const fields = fieldsOf(r, id, true);
    if (typeof fields === "string") { no(fields); continue; }
    const variants = variantList(c.name_variants_add).map(nfc).filter((v, i, a) => a.indexOf(v) === i);
    const record: Record<string, unknown> = {
      label: fields.label, displayName: fields.displayName, placeType: fields.placeType ?? null, nameVariants: JSON.stringify(variants),
      parentId: fields.parentId ?? null, latitude: fields.latitude ?? null, longitude: fields.longitude ?? null,
      coordinatePrecision: fields.coordinatePrecision ?? null, tgnId: fields.tgnId ?? null, hgisId: fields.hgisId ?? null,
      whgId: fields.whgId ?? null, fclass: fields.fclass ?? null, notes: fields.notes ?? null,
    };
    const journalId = state.journalIds.get(createJournalIdentity(id))!;
    const found = state.found.get(id);
    if (mergedBy.has(id)) { no(`${k}'s place is merged by line ${mergedBy.get(id)}, so the file may not also make it`); continue; }
    if (found) {
      const label = `${k}'s place ${id} (${text(found.place_code)})`;
      if (text(found.federation_id) !== ctx.federationId) { no(`${label} is in another federation`); continue; }
      if (!blank(found.tenant_id) && text(found.tenant_id) !== ctx.tenantId) { no(`${label} is owned by another tenant`); continue; }
      if (!blank(found.merged_into)) { no(`${label} has been merged into ${text(found.merged_into)}`); continue; }
      const differ = Object.entries(record).filter(([key, w]) => {
        const s = found[COLUMN_OF[key]];
        return key === "latitude" || key === "longitude" ? (blank(s) ? null : Number(s)) !== w : (blank(s) ? null : s) !== (blank(w) ? null : w);
      }).map(([key]) => COLUMN_OF[key]);
      if (differ.length > 0) { no(`${label}, made by an earlier run of this file, holds other values in ${differ.join(", ")}`); continue; }
      if (state.journalFound.get(journalId)?.recordId !== id) { no(`${label} is there, and no changelog row of this file records its creation`); continue; }
      statuses.set(r, "already created");
    } else {
      if (state.journalFound.has(journalId)) { no(`a changelog row of this file records ${k}'s place, which is not there`); continue; }
      if (!state.minted.has(id)) { no(`no code was minted for ${k}`); continue; }
      statuses.set(r, "create");
      plan.creates.push({ row: r, id, journalId, note: noteOf(r), record });
    }
    keyState.get(k)!.refused = false;
  }
  // A create, or a create found done, whose parent's create is refused: refused too, until none is left.
  for (let again = true; again;) {
    again = false;
    for (const [k, r] of keys) {
      const parent = r.cells.parent;
      if (keyState.get(k)!.refused || !parent.startsWith(NEW)) continue;
      const p = keyOf(parent);
      if (typeof p !== "string") continue;
      refuse(where(r), p);
      statuses.set(r, "refused");
      keyState.get(k)!.refused = true;
      plan.creates = plan.creates.filter((x) => x.row !== r);
      again = true;
    }
  }

  // update-place
  const updated = new Map<string, ChangeRow>();
  for (const r of rowsOf("update-place")) {
    statuses.set(r, "refused");
    const c = r.cells;
    const no = (reason: string) => refuse(where(r), reason);
    const p = resolve(c.authority_code, "");
    if (typeof p === "string") { no(p); continue; }
    const id = text(p.id);
    if (!nameHolds(p, c.authority_name)) { no(`authority_name ${JSON.stringify(c.authority_name)} is not the stored label ${JSON.stringify(text(p.label))}`); continue; }
    const merged = namedByMerge(p);
    if (merged) { no(merged); continue; }
    const twice = updated.get(id);
    if (twice) { no(`${c.authority_code} has another update-place row (line ${twice.line})`); continue; }
    updated.set(id, r);
    const fields = fieldsOf(r, id);
    if (typeof fields === "string") { no(fields); continue; }
    const add = variantList(c.name_variants_add).map(nfc);
    const remove = variantList(c.name_variants_remove).map(nfc);
    const both = add.find((v) => remove.includes(v));
    if (both) { no(`name_variants_add and name_variants_remove both name ${JSON.stringify(both)}`); continue; }
    const journalId = state.journalIds.get(updateJournalIdentity(id))!;
    const journal = state.journalFound.get(journalId);
    if (journal && journal.recordId !== id) { no(`the changelog row ${journalId} of this file records another record`); continue; }
    const diff = journal?.diff ?? {};
    const storedVariants = parseVariants(blank(p.name_variants) ? null : String(p.name_variants));
    let variants = storedVariants;
    if (remove.length > 0) {
      const absent = remove.filter((v) => !storedVariants.includes(v));
      const removedBefore = (v: string) => !!diff.nameVariants &&
        parseVariants(blank(diff.nameVariants.old) ? null : String(diff.nameVariants.old)).includes(v) &&
        !parseVariants(blank(diff.nameVariants.new) ? null : String(diff.nameVariants.new)).includes(v);
      const missing = absent.find((v) => !removedBefore(v));
      if (missing !== undefined) { no(`name_variants_remove names ${JSON.stringify(missing)}, which the stored name_variants do not hold`); continue; }
      variants = variants.filter((v) => !remove.includes(v));
    }
    variants = [...variants, ...add.filter((v, i) => !variants.includes(v) && add.indexOf(v) === i)];
    const after: Record<string, unknown> = { ...fields };
    if (JSON.stringify(variants) !== JSON.stringify(storedVariants)) after.nameVariants = JSON.stringify(variants);
    const set: Record<string, unknown> = {};
    const changes: Record<string, { old: unknown; new: unknown }> = {};
    for (const [key, value] of Object.entries(after)) {
      const s = p[COLUMN_OF[key]];
      const same = value === null ? s === null
        : key === "latitude" || key === "longitude" ? !blank(s) && Number(s) === value
        : key === "nameVariants" ? (blank(s) ? "[]" : String(s)) === value
        : sameNfc(s, value) && !blank(s);
      if (!same) {
        set[key] = value;
        changes[key] = { old: s, new: value };
      }
    }
    // The stored values the row names: as stored, or, on a rerun, as the
    // changelog row of this file records them before.
    const pending = Object.keys(set).length > 0;
    if (pending && journal) { no(changedSince(r, `part of its effect is present: a changelog row of this file records an update of ${c.authority_code}, and the row would write more`)); continue; }
    const shown = (column: string, v: unknown) => (column === "parent_id" ? (blank(v) ? "" : codeOf(String(v))) : text(v));
    const holds = (field: string, named: string, column: string, key: string) => {
      const now = p[column];
      const matches = (v: unknown) => field === "latitude" || field === "longitude"
        ? (named === "" ? blank(v) : !blank(v) && Number(v) === Number(named))
        : sameNfc(named, shown(column, v));
      if (matches(now)) return true;
      const d = diff[key];
      return !pending && !!journal && !!d && matches(d.old);
    };
    const wrong = PLACE_FIELDS.filter((f) => f !== "label" && c[f] !== "").find((f) => !holds(f, c[`current_${f}`], COLUMN_OF[PLACE_KEY[f]], PLACE_KEY[f]));
    if (wrong) {
      no(`current_${wrong} ${JSON.stringify(c[`current_${wrong}`])} is not the stored ${JSON.stringify(shown(COLUMN_OF[PLACE_KEY[wrong]], p[COLUMN_OF[PLACE_KEY[wrong]]]))}`);
      continue;
    }
    // Held already, with no changelog row of this file: nothing to write and no evidence needed ("same").
    if (!pending && !journal) { statuses.set(r, "same"); continue; }
    // Done only on this file's changelog row: every field the row changes (its value differs from the stated
    // current value: `current_<field>`, or `authority_name` for the label) is recorded changing from that
    // current value to the row's value; a restated unchanged field needs only to hold its value now, and
    // the changelog row must not record it changing from another value.
    if (!pending) {
      const fieldOf = Object.fromEntries(PLACE_FIELDS.map((f) => [PLACE_KEY[f], f])) as Record<string, (typeof PLACE_FIELDS)[number]>;
      const statedOf = (f: (typeof PLACE_FIELDS)[number]) => (f === "label" ? c.authority_name : c[`current_${f}`]);
      const sameValue = (key: string, a: unknown, stated: string) => key === "latitude" || key === "longitude"
        ? (stated === "" ? blank(a) : !blank(a) && Number(a) === Number(stated))
        : sameNfc(stated, shown(COLUMN_OF[key], a));
      let problem = "";
      for (const [key, value] of Object.entries(fields)) {
        const stated = statedOf(fieldOf[key]);
        const d = diff[key];
        const changes = !sameValue(key, value, stated);
        if (changes) {
          const sameNew = (x: unknown) => value === null ? x === null
            : key === "latitude" || key === "longitude" ? !blank(x) && Number(x) === value
            : key === "parentId" ? x === value
            : !blank(x) && sameNfc(x, value);
          if (!d || typeof d !== "object" || !sameNew(d.new)) {
            problem = `does not record ${COLUMN_OF[key]} changing to the row's value`;
          } else if (!sameValue(key, d.old, stated)) {
            problem = `records ${COLUMN_OF[key]} changing from ${JSON.stringify(shown(COLUMN_OF[key], d.old))}, not from the row's ${JSON.stringify(stated)}`;
          }
        } else if (d && typeof d === "object" && !sameValue(key, d.old, stated)) {
          problem = `records ${COLUMN_OF[key]} changing from ${JSON.stringify(shown(COLUMN_OF[key], d.old))}, not from the row's ${JSON.stringify(stated)}`;
        }
        if (problem) break;
      }
      const newVariants = diff.nameVariants ? parseVariants(blank(diff.nameVariants.new) ? null : String(diff.nameVariants.new)) : null;
      // Variants have no stated current value: they need only to hold what the row gives (they do, or the row
      // would write), and when this file's changelog row records them, it records them as the row gives them.
      if (!problem && (add.length > 0 || remove.length > 0) && newVariants &&
        (add.some((v) => !newVariants.includes(v)) || remove.some((v) => newVariants.includes(v)))) {
        problem = "does not record name_variants changing as the row gives them";
      }
      if (problem) {
        no(`the changelog row of this file for ${c.authority_code} ${problem}: no evidence the row was applied as it stands`);
        continue;
      }
      statuses.set(r, "already updated");
      continue;
    }
    statuses.set(r, "update");
    plan.updates.push({ row: r, id, journalId, note: noteOf(r), set, changes });
    plan.changed.push(p);
  }

  // merge-place: the rows, then the groups.
  const losers = new Map<string, ChangeRow>();
  const pending: Array<{ row: ChangeRow; loser: Stored; survivor: Stored; carried: Carried[] }> = [];
  for (const r of rowsOf("merge-place")) {
    statuses.set(r, "refused");
    const c = r.cells;
    const no = (reason: string) => refuse(where(r), reason);
    const codes = targetCodes(r);
    if (codes.length !== 1) { no("merge-place names exactly one target code"); continue; }
    if (codes[0] === c.authority_code) { no(`target ${codes[0]} is the row's own place`); continue; }
    const t = resolve(codes[0], "the target ");
    if (typeof t === "string") { no(t); continue; }
    const l = state.byCode.get(c.authority_code);
    const intoTarget = !!l && !blank(l.merged_into) && text(l.merged_into) === text(t.id);
    const loser = intoTarget ? l! : resolve(c.authority_code, "");
    if (typeof loser === "string") { no(loser); continue; }
    if (!blank(loser.tenant_id) && text(loser.tenant_id) !== ctx.tenantId) { no(`${c.authority_code} is owned by another tenant`); continue; }
    if (text(loser.federation_id) !== text(t.federation_id)) { no(`${c.authority_code} and ${codes[0]} are in different federations`); continue; }
    if (!sameName(c.authority_name, text(loser.label))) { no(`authority_name ${JSON.stringify(c.authority_name)} is not the stored label ${JSON.stringify(text(loser.label))}`); continue; }
    const twice = losers.get(text(loser.id));
    if (twice) { no(`loser ${c.authority_code} is named again (line ${twice.line})`); continue; }
    losers.set(text(loser.id), r);
    // The carried values: the row's, checked against the loser.
    const carried: Carried[] = [];
    let bad = "";
    for (const f of ["tgn_id", "hgis_id", "whg_id"] as const) {
      if (c[f] === "") continue;
      if (nfc(c[f]) !== text(loser[f])) { bad = `the row carries ${f} ${JSON.stringify(nfc(c[f]))}; ${c.authority_code} holds ${JSON.stringify(text(loser[f]))}`; break; }
      const key = PLACE_KEY[f] as Carried["field"];
      carried.push({ field: key, value: text(loser[f]), set: { [key]: text(loser[f]) }, line: r.line });
    }
    if (!bad && ((c.latitude === "") !== (c.longitude === ""))) bad = "latitude and longitude are given together or not at all";
    if (!bad && c.latitude === "" && c.coordinate_precision !== "") bad = "coordinate_precision is carried only with latitude and longitude";
    if (!bad && c.latitude !== "") {
      const precision = blank(loser.coordinate_precision) ? null : text(loser.coordinate_precision);
      const given = describeCoordinates(c.latitude, c.longitude, c.coordinate_precision);
      if (!close(c.latitude, loser.latitude) || !close(c.longitude, loser.longitude) || (c.coordinate_precision || null) !== precision) {
        bad = `the row carries coordinates ${given}; ${c.authority_code} holds ${coordinatesEmpty(loser) ? "none" : describeCoordinates(loser.latitude, loser.longitude, loser.coordinate_precision)}`;
      } else {
        carried.push({
          field: "coordinates", value: describeCoordinates(loser.latitude, loser.longitude, precision),
          set: { latitude: Number(loser.latitude), longitude: Number(loser.longitude), coordinatePrecision: precision }, line: r.line,
        });
      }
    }
    if (bad) { no(bad); continue; }
    // label_to_keep becomes the survivor's label and display name, so it is checked as they are.
    if (c.label_to_keep !== "") {
      const v = nfc(c.label_to_keep);
      const checked = placeSchema.pick({ label: true, displayName: true }).safeParse({ label: v, displayName: v });
      if (!v || !checked.success) {
        no(`label_to_keep: ${checked.success ? "blank" : checked.error.issues.map((i) => `${COLUMN_OF[String(i.path[0])] ?? String(i.path[0])} ${i.message}`).join("; ")}`);
        continue;
      }
    }
    // The ledger rows this file's merge of the pair wrote.
    const ledgered = state.ledger.some((x) => text(x.source_id) === text(loser.id) && text(x.target_id) === text(t.id) && ledgerFile(x) === input.file);
    if (!intoTarget && ledgered) { no(`${c.authority_code} was merged into ${codes[0]} by this file and since undone; the file does not merge it again`); continue; }
    if (intoTarget) {
      // Done before: the loser holds none of the tenant's links, and the survivor holds the label, the variants and the values the row asks for.
      const variants = parseVariants(blank(t.name_variants) ? null : String(t.name_variants));
      const exclude = new Set(variantList(c.name_variants_remove).map(nfc));
      const back = state.links.get(text(loser.id)) ?? [];
      if (back.length > 0) { no(`${c.authority_code} is merged into ${codes[0]}, and holds links of the tenant's descriptions again (${back.map((x) => x.id).join(", ")})`); continue; }
      const restored = [...exclude].filter((v) => variants.includes(v));
      if (restored.length > 0) { no(`${c.authority_code} is merged into ${codes[0]}, whose variants hold ${JSON.stringify(restored)}, which the row removes`); continue; }
      const label = nfc(c.label_to_keep);
      if (label && (!sameName(label, text(t.label)) || !sameName(label, text(t.display_name)))) {
        no(`${c.authority_code} is merged into ${codes[0]}, which is labelled ${JSON.stringify(text(t.label))}, not ${JSON.stringify(label)}`);
        continue;
      }
      const missing = variantList(c.name_variants_add).map(nfc).filter((v) => !exclude.has(v) && v !== text(t.label) && !variants.includes(v));
      if (missing.length > 0) { no(`${c.authority_code} is merged into ${codes[0]}, whose variants do not hold ${JSON.stringify(missing)}`); continue; }
      const lacking = carried.find((x) => Object.entries(x.set).some(([k, v]) => {
        const s = t[COLUMN_OF[k]];
        return k === "latitude" || k === "longitude" ? blank(s) || Number(s) !== v : (blank(s) ? null : s) !== v;
      }));
      if (lacking) { no(`${c.authority_code} is merged into ${codes[0]}, which does not hold the ${lacking.field} ${lacking.value} the row carries`); continue; }
      statuses.set(r, "already merged");
      plan.doneLosers.push(text(loser.id));
      continue;
    }
    pending.push({ row: r, loser, survivor: t, carried });
  }
  // A survivor may not also be a loser of the file.
  const groups = new Map<string, PlaceMergeGroup>();
  for (const x of pending) {
    const also = losers.get(text(x.survivor.id));
    if (also) { refuse(where(x.row), `survivor ${text(x.survivor.place_code)} is also a loser in the file (line ${also.line})`); continue; }
    let g = groups.get(text(x.survivor.id));
    if (!g) {
      g = { survivor: x.survivor, pairs: [], labelNew: text(x.survivor.label), labelGiven: false, exclude: new Set(), finalVariants: [], carried: [] };
      groups.set(text(x.survivor.id), g);
    }
    g.pairs.push({ row: x.row, loser: x.loser, note: noteOf(x.row), carried: x.carried });
  }
  for (const g of groups.values()) {
    const s = g.survivor;
    const fail = (r: ChangeRow, reason: string) => {
      refuse(where(r), reason);
      for (const p of g.pairs) statuses.set(p.row, "refused");
      g.pairs = [];
    };
    const labels = new Set(g.pairs.map((p) => nfc(p.row.cells.label_to_keep)).filter(Boolean));
    if (labels.size > 1) { fail(g.pairs[0].row, `rows for ${text(s.place_code)} disagree on the label: ${[...labels].join(" / ")}`); continue; }
    if (labels.size === 1) {
      g.labelNew = [...labels][0];
      g.labelGiven = true;
    }
    const held = new Set([
      text(s.label), text(s.display_name), ...parseVariants(blank(s.name_variants) ? null : String(s.name_variants)),
      ...g.pairs.flatMap((p) => [text(p.loser.display_name), ...parseVariants(blank(p.loser.name_variants) ? null : String(p.loser.name_variants))]),
    ]);
    let refused = false;
    for (const p of g.pairs) {
      for (const name of variantList(p.row.cells.name_variants_remove).map(nfc)) {
        if (!held.has(name)) { fail(p.row, `name_variants_remove names ${JSON.stringify(name)}, which no place of the merge holds`); refused = true; break; }
        g.exclude.add(name);
      }
      if (refused) break;
    }
    if (refused) continue;
    // Two rows into one survivor, one adding a variant the other removes, contradict each other.
    for (const p of g.pairs) {
      const add = new Set(variantList(p.row.cells.name_variants_add).map(nfc));
      const other = g.pairs.find((q) => q !== p && variantList(q.row.cells.name_variants_remove).map(nfc).some((v) => add.has(v)));
      if (other) {
        const name = variantList(other.row.cells.name_variants_remove).map(nfc).find((v) => add.has(v))!;
        fail(p.row, `line ${p.row.line} adds ${JSON.stringify(name)} to ${text(s.place_code)} and line ${other.row.line} removes it; the rows contradict each other`);
        refused = true;
        break;
      }
    }
    if (refused) continue;
    // The values carried: only into an empty field, one value per field.
    const taken = new Map<string, Carried>();
    const problems: Array<[ChangeRow, string]> = [];
    for (const p of g.pairs) {
      for (const x of p.carried) {
        const fieldEmpty = x.field === "coordinates" ? coordinatesEmpty(s) : blank(s[COLUMN_OF[x.field]]);
        if (!fieldEmpty) {
          const has = x.field === "coordinates" ? describeCoordinates(s.latitude, s.longitude, s.coordinate_precision) : text(s[COLUMN_OF[x.field]]);
          if (has !== x.value) {
            problems.push([p.row, x.field === "coordinates"
              ? `${text(s.place_code)} already holds coordinates ${has}; the row carries ${x.value}`
              : `${text(s.place_code)} already holds ${COLUMN_OF[x.field]} ${JSON.stringify(has)}; the row carries ${JSON.stringify(x.value)}`]);
          }
          continue;
        }
        const prior = taken.get(x.field);
        if (prior && prior.value !== x.value) {
          problems.push([p.row, `lines ${prior.line} and ${x.line} would both carry ${x.field} into ${text(s.place_code)} (${prior.value} / ${x.value})`]);
          continue;
        }
        if (!prior) taken.set(x.field, x);
      }
    }
    if (problems.length > 0) {
      for (const [r, reason] of problems) refuse(where(r), reason);
      for (const p of g.pairs) statuses.set(p.row, "refused");
      g.pairs = [];
      continue;
    }
    // The variants the survivor ends with, as the merges and the label change leave them.
    const before = parseVariants(blank(s.name_variants) ? null : String(s.name_variants));
    let variants = before;
    for (const p of g.pairs) {
      variants = Array.from(new Set([...variants, text(p.loser.display_name), ...parseVariants(blank(p.loser.name_variants) ? null : String(p.loser.name_variants))]))
        .filter((n) => !g.exclude.has(n));
    }
    const relabel = g.labelNew !== text(s.label);
    if (relabel) variants = Array.from(new Set([...variants, text(s.label)])).filter((v) => v !== g.labelNew && !g.exclude.has(v));
    g.finalVariants = variants;
    const had = new Set(before);
    const gained = variants.filter((n) => !had.has(n)).sort();
    const listed = [...new Set(g.pairs.flatMap((p) => variantList(p.row.cells.name_variants_add).map(nfc)))]
      .filter((n) => !g.exclude.has(n) && !(relabel && n === g.labelNew)).sort();
    if (gained.join("\u0000") !== listed.join("\u0000")) {
      fail(g.pairs[0].row, `${text(s.place_code)} would gain ${JSON.stringify(gained)}; the file adds ${JSON.stringify(listed)}`);
      continue;
    }
    g.carried = [...taken.values()];
    for (const p of g.pairs) statuses.set(p.row, "merge");
    appendAll(plan.changed, [s, ...g.pairs.map((p) => p.loser)]);
  }
  plan.groups = [...groups.values()].filter((g) => g.pairs.length > 0);

  const resolver: PlaceResolver = {
    resolve,
    key: (value) => keyOf(value),
    mergedBy: (id) => mergedBy.get(id),
    nameHolds,
  };
  return { plan, statuses, resolver };
}

// ---------------------------------------------------------------------------
// The statements
// ---------------------------------------------------------------------------

export interface PlacesBuild {
  before: string[];
  /** The merges' statements, guards of their own aside. */
  merges: string[];
  writes: string[];
  after: string[];
  created: number;
  updated: number;
  merged: number;
  linksMoved: number;
  linksDropped: number;
  /** Place id → its version as read and the version the file leaves it with. */
  versions: Map<string, { from: number; to: number }>;
}

/** The guards, merges, writes and closing guards of the place rows. */
export function buildPlaceStatements(
  plan: PlacesPlan,
  state: PlacesState,
  opts: { userId: string; now: number; tenantId: string; federationId: string; owner: string | null; file: string; actedAs?: ChangelogActedAs | null },
): PlacesBuild {
  const db = composer();
  const out: PlacesBuild = { before: [], merges: [], writes: [], after: [], created: 0, updated: 0, merged: 0, linksMoved: 0, linksDropped: 0, versions: new Map() };
  if (!state.read) return out;
  const F = escapeSql(opts.federationId);
  const scope = eq(places.federationId, opts.federationId);
  const version = (p: Stored) => nextVersion(Number(p.updated_at), opts.now);

  // Opening guards: the vocabulary, as read and no more; every place read, as read.
  out.before.push(guard(
    `(SELECT count(*) FROM vocabulary_values WHERE federation_id = ${F} AND list IN (${idList([...PLACE_LISTS])})) = ${state.vocabulary.length}`,
    "the federation's place and role vocabulary has changed since it was read",
  ));
  appendAll(out.before, matchingGuards("vocabulary_values", VOCABULARY_READ, state.vocabulary.map((v) => VOCABULARY_READ.map((c) => v[c])),
    "a vocabulary value has changed since it was read"));
  appendAll(out.before, matchingGuards("places", PLACE_READ, [...state.byId.values()].map((p) => PLACE_READ.map((c) => p[c])),
    "a place the file reads has changed since it was read"));
  appendAll(out.before, matchingGuards("changelog", ["id", "record_id", "diff"], [...state.journalFound].map(([i, r]) => [i, r.recordId, r.raw]),
    "a changelog row an earlier run of this file wrote has changed since it was read"));
  // The merge ledger rows of the losers named, as read and no more.
  const mergeLosers = [...new Set(state.ledger.map((x) => text(x.source_id)))];
  appendAll(out.before, matchingGuards("authority_operations", LEDGER_READ, state.ledger.map((x) => LEDGER_READ.map((c) => x[c])),
    "a place merge ledger row has changed since it was read"));
  const ledgerLosers = [...new Set(plan.groups.flatMap((g) => g.pairs.map((p) => text(p.loser.id))))];
  for (const part of chunks([...new Set([...mergeLosers, ...ledgerLosers])], 200)) {
    const n = state.ledger.filter((x) => part.includes(text(x.source_id))).length;
    out.before.push(guard(
      `(SELECT count(*) FROM authority_operations WHERE record_type = 'place' AND operation = 'merge' AND source_id IN (${idList(part)})) = ${n}`,
      "a place merge ledger row has been added since they were read",
    ));
  }

  // What the file writes is still absent.
  const ids = plan.creates.map((p) => p.id);
  const codes = ids.map((i) => state.minted.get(i)!);
  const journals = [...plan.creates.map((p) => p.journalId), ...plan.updates.map((p) => p.journalId)];
  for (const [table, column, list, what] of [
    ["places", "id", ids, "a place id the file makes"],
    ["places", "place_code", codes, "a code minted for a new place"],
    ["changelog", "id", journals, "a changelog id the file writes"],
  ] as const) {
    for (const part of chunks([...list], 200)) out.before.push(guard(`NOT EXISTS (SELECT 1 FROM ${table} WHERE ${column} IN (${idList(part)}))`, `${what} is taken`));
  }
  if (state.prefix && ids.length > 0) {
    out.before.push(guard(
      `EXISTS (SELECT 1 FROM ${state.prefix.table} WHERE id = ${escapeSql(state.prefix.id)} AND trim(place_code_prefix) = ${escapeSql(state.prefix.prefix)})`,
      "the agency's place code prefix has changed since the codes were minted",
    ));
  }

  // Creates.
  const journal = (id: string, recordId: string, kind: "create" | "update", diff: unknown, note: string) =>
    render(db.insert(changelog).values({ id, recordId, recordType: "place", userId: opts.userId, note, diff: JSON.stringify(diff), runId: null, kind, createdAt: opts.now, actedAs: opts.actedAs ?? null }));
  const created: unknown[][] = [];
  for (const p of plan.creates) {
    const values: Record<string, unknown> = {
      federationId: opts.federationId, tenantId: opts.owner, id: p.id, placeCode: state.minted.get(p.id)!, ...p.record, legacyIds: "[]",
      internalNotes: null, mergedInto: null, createdAt: opts.now, updatedAt: opts.now,
    };
    out.writes.push(render(db.insert(places).values(values as never)));
    out.writes.push(journal(p.journalId, p.id, "create", createSnapshotDiff(values), p.note));
    created.push([p.id, opts.federationId, opts.owner, values.placeCode, values.label, values.displayName, null, values.parentId, opts.now]);
    out.created++;
  }

  // Updates.
  const updated: unknown[][] = [];
  for (const p of plan.updates) {
    const s = state.byId.get(p.id)!;
    const to = version(s);
    out.versions.set(p.id, { from: Number(s.updated_at), to });
    out.writes.push(render(db.update(places).set({ ...p.set, updatedAt: to } as never).where(and(scope, eq(places.id, p.id)))));
    out.writes.push(journal(p.journalId, p.id, "update", p.changes, p.note));
    updated.push([p.id, "label" in p.set ? p.set.label : s.label, "displayName" in p.set ? p.set.displayName : s.display_name, to]);
    out.updated++;
  }

  // Merges, as the duplicates worklist composes them.
  const collisions: Array<{ survivorId: string; descriptionId: string; role: string | null }> = [];
  const movedInto = new Map<string, number>();
  const moved: Array<[string, string]> = [];
  const dropped: string[] = [];
  const finals: unknown[][] = [];
  const mergedPairs: unknown[][] = [];
  const linksOf = (id: string) => state.links.get(id) ?? [];
  for (const g of plan.groups) {
    const s = g.survivor;
    const sid = text(s.id);
    const to = version(s);
    out.versions.set(sid, { from: Number(s.updated_at), to });
    const snapshot: AuthorityRecordSnapshot = {
      id: sid, displayName: text(s.display_name), code: text(s.place_code), nameVariants: s.name_variants === null ? null : String(s.name_variants),
      mergedInto: null, sources: null, updatedAt: Number(s.updated_at),
    };
    const holds = heldLinks(linksOf(sid));
    for (const { row, loser, note } of g.pairs) {
      const lid = text(loser.id);
      out.versions.set(lid, { from: Number(loser.updated_at), to: version(loser) });
      const links = linksOf(lid);
      const linkPlan = composeLinkMoves(db, "place", sid, links, holds, opts.userId, opts.now, new Map(), opts.actedAs ?? null);
      for (const l of links) if (!holds.has(heldKey(l))) holds.set(heldKey(l), l.id);
      out.linksMoved += linkPlan.movedLinks;
      out.linksDropped += linkPlan.droppedLinks.length;
      movedInto.set(sid, (movedInto.get(sid) ?? 0) + linkPlan.movedLinks);
      const droppedIds = new Set((linkPlan.droppedLinks as JunctionRow[]).map((d) => d.id));
      for (const l of links) (droppedIds.has(l.id) ? dropped.push(l.id) : moved.push([l.id, sid]));
      for (const d of linkPlan.droppedLinks as JunctionRow[]) {
        collisions.push({ survivorId: sid, descriptionId: d.descriptionId, role: d.role });
      }
      const carried = g.carried.filter((c) => c.line === row.line);
      const { statements, survivorVariants } = composeMergeStatements(db, {
        recordType: "place",
        scope,
        federationId: opts.federationId,
        survivor: snapshot,
        loser: {
          id: lid, displayName: text(loser.display_name), code: text(loser.place_code),
          nameVariants: loser.name_variants === null ? null : String(loser.name_variants), mergedInto: null, sources: null,
          updatedAt: Number(loser.updated_at),
        },
        linkPlan,
        userId: opts.userId,
        actedAs: opts.actedAs ?? null,
        reason: note,
        now: opts.now,
        excludeVariants: g.exclude,
        detailExtra: {
          file: opts.file, line: row.line,
          ...(carried.length > 0 ? { carried: Object.fromEntries(carried.map((c) => [c.field, c.value])) } : {}),
        },
      });
      appendAll(out.merges, statements.map(render));
      snapshot.nameVariants = survivorVariants;
      mergedPairs.push([lid, sid, version(loser)]);
      out.merged++;
    }
    // The survivor's own update: the label, then the carried values.
    const set: Record<string, unknown> = {};
    const diff: Record<string, { old: unknown; new: unknown }> = {};
    let variants = parseVariants(snapshot.nameVariants);
    if (g.labelNew !== text(s.label)) {
      variants = Array.from(new Set([...variants, text(s.label)])).filter((v) => v !== g.labelNew && !g.exclude.has(v));
      set.label = g.labelNew;
      diff.label = { old: s.label, new: g.labelNew };
    }
    // The display name takes the label whenever the label changes or a row names it.
    if (g.labelNew !== text(s.label) || g.labelGiven) {
      if (text(s.display_name) !== g.labelNew) {
        set.displayName = g.labelNew;
        diff.displayName = { old: s.display_name, new: g.labelNew };
      }
    }
    const nextVariants = JSON.stringify(variants);
    if (nextVariants !== snapshot.nameVariants) {
      set.nameVariants = nextVariants;
      diff.nameVariants = { old: snapshot.nameVariants, new: nextVariants };
    }
    for (const c of g.carried) {
      for (const [k, v] of Object.entries(c.set)) {
        set[k] = v;
        diff[k] = { old: s[COLUMN_OF[k]], new: v };
      }
    }
    if (Object.keys(set).length > 0) {
      out.merges.push(
        render(db.update(places).set({ ...set, updatedAt: to } as never).where(and(scope, eq(places.id, sid)))),
        render(composeJournalEntry(db, {
          recordId: sid, recordType: "place", userId: opts.userId, actedAs: opts.actedAs ?? null, kind: "update", diff,
          note: [...new Set(g.pairs.map((p) => p.note))].join("\n"), now: opts.now,
        }) as unknown as { toSQL(): { sql: string; params: unknown[] } }),
      );
    }
    finals.push([sid, (set.label as string | undefined) ?? s.label, (set.displayName as string | undefined) ?? s.display_name, (set.nameVariants as string | undefined) ?? snapshot.nameVariants ?? "[]", null, to]);
  }

  // The merges' guards, on every place a merge row names, pending or already merged: the tenant's links
  // of each by count, and every link read on all its columns.
  const survivors = plan.groups.map((g) => text(g.survivor.id));
  const losers = plan.groups.flatMap((g) => g.pairs.map((p) => text(p.loser.id)));
  const own = inTenantDescriptions(opts.tenantId);
  for (const part of chunks(state.mergeRead, 200)) {
    const n = part.reduce((sum, id) => sum + linksOf(id).length, 0);
    out.before.push(guard(`(SELECT count(*) FROM description_places WHERE place_id IN (${idList(part)}) AND ${own}) = ${n}`, "a merged place's links have changed since they were read"));
  }
  const values = (l: JunctionRow) => [l.id, l.descriptionId, l.placeId, l.role, l.roleNote, l.roleRaw, l.createdAt];
  const read = [...new Map(state.mergeRead.flatMap(linksOf).map((l) => [l.id, l])).values()];
  appendAll(out.before, matchingGuards("description_places", PLACE_LINK_COLUMNS, read.map(values),
    "a link of a merged place has changed since it was read"));
  // Every loser found already merged holds no link of a description of the acting tenant: a constant, not a count read.
  for (const part of chunks([...new Set(plan.doneLosers)], 200)) {
    out.before.push(guard(
      `(SELECT count(*) FROM description_places l JOIN descriptions d ON d.id = l.description_id WHERE l.place_id IN (${idList(part)}) AND d.tenant_id = ${escapeSql(opts.tenantId)}) = 0`,
      "a place merged before holds a link of the acting tenant's descriptions",
    ));
  }
  // Every link a merge writes is in a description of the acting tenant: a constant, not a value read.
  appendAll(out.before, tenantLinkGuards("description_places", [...moved.map((m) => String(m[0])), ...dropped], opts.tenantId));

  // Closing guards: what was written holds what was planned.
  appendAll(out.after, matchingGuards("places", ["id", "federation_id", "tenant_id", "place_code", "label", "display_name", "merged_into", "parent_id", "updated_at"],
    created, "a place the file makes is not as planned"));
  appendAll(out.after, matchingGuards("places", ["id", "label", "display_name", "updated_at"], updated, "a place the file updates is not as planned"));
  appendAll(out.after, matchingGuards("places", ["id", "label", "display_name", "COALESCE(name_variants, '[]')", "merged_into", "updated_at"], finals,
    "a survivor does not hold its planned label and variants"));
  appendAll(out.after, matchingGuards("places", ["id", "merged_into", "updated_at"], mergedPairs, "a loser is not merged into its survivor"));
  appendAll(out.after, matchingGuards("description_places", ["id", "place_id"], moved, "a moved link does not name its survivor"));
  for (const part of chunks(dropped, 200)) out.after.push(guard(`(SELECT count(*) FROM description_places WHERE id IN (${idList(part)})) = 0`, "a dropped link is still there"));
  const kept = [...new Map(collisions.map((c) => [`${c.survivorId}|${c.descriptionId}|${c.role ?? ""}`, c])).values()];
  appendAll(out.after, matchingGuards("description_places", ["place_id", "description_id", "role"], kept.map((c) => [c.survivorId, c.descriptionId, c.role]),
    "a survivor does not hold a link that a collision dropped"));
  for (const part of chunks(losers, 200)) {
    out.after.push(guard(`(SELECT count(*) FROM description_places WHERE place_id IN (${idList(part)}) AND ${own}) = 0`, "a loser still holds links"));
  }
  for (const part of chunks(survivors, 200)) {
    const n = part.reduce((sum, id) => sum + linksOf(id).length + (movedInto.get(id) ?? 0), 0);
    out.after.push(guard(`(SELECT count(*) FROM description_places WHERE place_id IN (${idList(part)}) AND ${own}) = ${n}`,
      "the survivors do not hold the planned number of links"));
  }
  for (const part of chunks(journals, 200)) {
    out.after.push(guard(`(SELECT count(*) FROM changelog WHERE id IN (${idList(part)})) = ${part.length}`, "a changelog row the file writes is missing"));
  }
  return out;
}

/**
 * Guards that every one of `ids` is a link of `table` in a description
 * whose `tenant_id` is `tenantId`, the acting tenant: the positive
 * condition every link the file moves or deletes must meet when it is
 * written, whatever was read before.
 */
export function tenantLinkGuards(table: "description_places" | "description_entities", ids: string[], tenantId: string): string[] {
  return chunks([...new Set(ids)], 200).map((part) => guard(
    `(SELECT count(*) FROM ${table} l JOIN descriptions d ON d.id = l.description_id WHERE l.id IN (${idList(part)}) AND d.tenant_id = ${escapeSql(tenantId)}) = ${part.length}`,
    `a link the file writes is not in a description of the acting tenant`,
  ));
}

/** Whether a row is a place operation. */
export const isPlaceOp = (op: string) => (PLACE_OPS as readonly string[]).includes(op);

// @version v0.9.0
